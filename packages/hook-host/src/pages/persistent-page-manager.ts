import { assertPageHookRuntime, noopHookLogger, type HookEvent, type HookLogger, type HookManifest, type HookPageDefinition, type PageHookRuntime } from '@platform-hub/hook-sdk'
import type { HookPageAdapter, HookPageContext, HookPageFactory } from './types.js'

interface PersistentEntry {
  page: HookPageAdapter
  runtime?: PageHookRuntime
  unsubscribeEvents?: () => void
}

export interface PersistentPageManagerOptions {
  sessionId: string
  shopId: string
  partition: string
  manifest: HookManifest
  factory: HookPageFactory
  logger?: HookLogger
  onEvent?: (event: HookEvent) => void
  onEventError?: (error: unknown) => void
}

/** Owns pages which stay alive for the lifetime of one HookSession. */
export class PersistentPageManager {
  private readonly pages = new Map<string, PersistentEntry>()
  private readonly pending = new Map<string, Promise<PersistentPageHandle>>()
  private disposed = false
  private started = false
  private readonly logger: HookLogger

  constructor(private readonly options: PersistentPageManagerOptions) {
    this.logger = options.logger ?? noopHookLogger
  }

  get size(): number { return this.pages.size }
  get ids(): string[] { return [...this.pages.keys()] }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('PersistentPageManager 已停止')
    this.started = true
  }

  async ensure(definition: HookPageDefinition): Promise<PersistentPageHandle> {
    if (definition.kind !== 'persistent') throw new Error(`页面 ${definition.id} 不是 Persistent Page`)
    if (this.disposed) throw new Error('PersistentPageManager 已停止')
    if (!this.started) throw new Error('PersistentPageManager 尚未启动')
    const current = this.pages.get(definition.id)
    if (current?.runtime && current.page.isAlive()) return this.handleFor(definition.id, current)
    if (current) await this.disposeEntry(definition.id, current)

    const pending = this.pending.get(definition.id)
    if (pending) return pending

    const creation = this.create(definition)
    this.pending.set(definition.id, creation)
    try {
      return await creation
    } finally {
      if (this.pending.get(definition.id) === creation) this.pending.delete(definition.id)
    }
  }

  private async create(definition: HookPageDefinition): Promise<PersistentPageHandle> {
    const page = await this.options.factory.create(this.contextFor(definition))
    let runtime: PageHookRuntime | undefined
    try {
      runtime = await page.installRuntime()
      assertPageHookRuntime(runtime, this.options.manifest, definition)
      if (this.disposed) throw new Error('PersistentPageManager 已停止')
      const entry: PersistentEntry = { page, runtime }
      entry.unsubscribeEvents = await this.subscribeToPage(page)
      this.pages.set(definition.id, entry)
      return this.handleFor(definition.id, entry)
    } catch (error) {
      try { await runtime?.dispose() } catch { /* creation failure cleanup */ }
      try { await page.close() } catch { /* creation failure cleanup */ }
      throw error
    }
  }

  async show(pageId: string): Promise<void> {
    const entry = this.pages.get(pageId)
    if (entry) await entry.page.show()
  }

  async drainEvents(): Promise<HookEvent[]> {
    const events: HookEvent[] = []
    for (const [pageId, entry] of this.pages) {
      if (entry.unsubscribeEvents || !entry.runtime) continue
      try { events.push(...await entry.runtime.drainEvents()) } catch (error) {
        this.options.onEventError?.(error)
        this.logger.warn('Persistent event drain failed', { pageId, error: errorMessage(error) })
      }
    }
    return events
  }

  private async refreshRuntime(pageId: string, entry: PersistentEntry): Promise<PageHookRuntime> {
    if (this.disposed || this.pages.get(pageId) !== entry) throw new Error('PersistentPageManager 已停止')
    const previous = entry.runtime
    entry.runtime = undefined
    try { entry.unsubscribeEvents?.() } catch (error) { this.logger.warn('Persistent event subscription cleanup failed', { pageId, error: errorMessage(error) }) }
    entry.unsubscribeEvents = undefined
    if (previous) {
      try { await previous.dispose() } catch (error) { this.logger.warn('Previous persistent runtime dispose failed during refresh', { pageId, error: errorMessage(error) }) }
    }

    let next: PageHookRuntime | undefined
    try {
      next = await entry.page.installRuntime()
      assertPageHookRuntime(next, this.options.manifest, entry.page.definition)
      if (this.disposed || this.pages.get(pageId) !== entry || !entry.page.isAlive()) throw new Error('PersistentPageManager 已停止')
      entry.runtime = next
      entry.unsubscribeEvents = await this.subscribeToPage(entry.page)
      return next
    } catch (error) {
      try { await next?.dispose() } catch (disposeError) { this.logger.warn('Invalid persistent runtime dispose failed', { pageId, error: errorMessage(disposeError) }) }
      await this.disposeEntry(pageId, entry)
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    await Promise.all([...this.pages.entries()].map(([id, entry]) => this.disposeEntry(id, entry)))
    this.pages.clear()
  }

  private handleFor(id: string, entry: PersistentEntry): PersistentPageHandle {
    return {
      page: entry.page,
      get runtime() {
        if (!entry.runtime) throw new Error(`Persistent Runtime 不可用: ${id}`)
        return entry.runtime
      },
      refreshRuntime: () => this.refreshRuntime(id, entry),
    }
  }

  private async disposeEntry(id: string, entry: PersistentEntry): Promise<void> {
    this.pages.delete(id)
    try { entry.unsubscribeEvents?.() } catch (error) { this.logger.warn('Persistent event subscription cleanup failed', { pageId: id, error: errorMessage(error) }) }
    entry.unsubscribeEvents = undefined
    const runtime = entry.runtime
    entry.runtime = undefined
    try { await runtime?.dispose() } catch (error) { this.logger.warn('Persistent runtime dispose failed', { pageId: id, error: errorMessage(error) }) }
    try { await entry.page.close() } catch (error) { this.logger.warn('Persistent page close failed', { pageId: id, error: errorMessage(error) }) }
  }

  private async subscribeToPage(page: HookPageAdapter): Promise<(() => void) | undefined> {
    if (!page.subscribeEvents || !this.options.onEvent) return undefined
    try { return await page.subscribeEvents(this.options.onEvent) } catch (error) {
      this.logger.warn('Persistent push event subscription failed; polling fallback remains active', { pageId: page.id, error: errorMessage(error) })
      return undefined
    }
  }

  private contextFor(definition: HookPageDefinition): HookPageContext {
    return {
      sessionId: this.options.sessionId,
      shopId: this.options.shopId,
      partition: this.options.partition,
      manifest: this.options.manifest,
      definition,
    }
  }
}

export interface PersistentPageHandle {
  readonly page: HookPageAdapter
  readonly runtime: PageHookRuntime
  refreshRuntime(): Promise<PageHookRuntime>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
