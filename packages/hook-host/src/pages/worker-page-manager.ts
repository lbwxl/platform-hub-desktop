import type { HookManifest, HookPageDefinition, PageHookRuntime } from '@platform-hub/hook-sdk'
import type { HookPageAdapter, HookPageContext, HookPageFactory, WorkerPageLease } from './types.js'

interface WorkerEntry {
  page: HookPageAdapter
  runtime: PageHookRuntime
  inUse: boolean
  lastUsedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
}

export interface WorkerPageManagerOptions {
  sessionId: string
  shopId: string
  partition: string
  manifest: HookManifest
  factory: HookPageFactory
  maxWorkers?: number
  defaultIdleTtlMs?: number
}

export class WorkerPageManager {
  private readonly workers = new Map<string, WorkerEntry>()
  private readonly waiters: Array<() => void> = []
  private disposed = false
  private readonly maxWorkers: number
  private readonly defaultIdleTtlMs: number

  constructor(private readonly options: WorkerPageManagerOptions) {
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 2)
    this.defaultIdleTtlMs = Math.max(1, options.defaultIdleTtlMs ?? 30_000)
  }

  get size(): number { return this.workers.size }
  get ids(): string[] { return [...this.workers.keys()] }

  async acquire(definition: HookPageDefinition, signal?: AbortSignal): Promise<WorkerPageLease> {
    if (definition.kind !== 'worker') throw new Error(`页面 ${definition.id} 不是 Worker Page`)
    while (!this.disposed) {
      if (signal?.aborted) throw new Error('Worker 获取已取消')
      const existing = this.workers.get(definition.id)
      if (existing && existing.page.isAlive() && !existing.inUse) {
        existing.inUse = true
        existing.lastUsedAt = Date.now()
        this.clearIdleTimer(existing)
        return this.leaseFor(definition.id, existing)
      }
      if (!existing && this.workers.size < this.maxWorkers) {
        const page = await this.options.factory.create(this.contextFor(definition))
        const runtime = await page.installRuntime()
        const entry: WorkerEntry = { page, runtime, inUse: true, lastUsedAt: Date.now() }
        this.workers.set(definition.id, entry)
        return this.leaseFor(definition.id, entry)
      }
      const idle = [...this.workers.entries()].find(([, value]) => !value.inUse)
      if (idle) {
        await this.disposeEntry(idle[0], idle[1])
        continue
      }
      await this.waitForAvailability(signal)
    }
    throw new Error('WorkerPageManager 已停止')
  }

  async show(pageId: string): Promise<void> {
    const entry = this.workers.get(pageId)
    if (entry) await entry.page.show()
  }

  async drainEvents(): Promise<ReturnType<PageHookRuntime['drainEvents']>> {
    const events = [] as ReturnType<PageHookRuntime['drainEvents']>
    for (const entry of this.workers.values()) {
      try { events.push(...entry.runtime.drainEvents()) } catch { /* session reports runtime errors */ }
    }
    return events
  }

  async dispose(): Promise<void> {
    this.disposed = true
    while (this.waiters.length) this.waiters.shift()?.()
    await Promise.all([...this.workers.entries()].map(([id, entry]) => this.disposeEntry(id, entry)))
    this.workers.clear()
  }

  private leaseFor(id: string, entry: WorkerEntry): WorkerPageLease {
    return {
      page: entry.page,
      get runtime() { return entry.runtime },
      refreshRuntime: async () => {
        entry.runtime = await entry.page.installRuntime()
        return entry.runtime
      },
      release: () => {
        if (!entry.inUse) return
        entry.inUse = false
        entry.lastUsedAt = Date.now()
        this.scheduleIdleDispose(id, entry)
        this.notifyAvailability()
      },
    }
  }

  private scheduleIdleDispose(id: string, entry: WorkerEntry): void {
    this.clearIdleTimer(entry)
    const ttl = entry.page.definition.idleTtlMs ?? this.defaultIdleTtlMs
    entry.idleTimer = setTimeout(() => {
      if (!entry.inUse && Date.now() - entry.lastUsedAt >= ttl) void this.disposeEntry(id, entry)
    }, ttl)
    entry.idleTimer.unref?.()
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  private async disposeEntry(id: string, entry: WorkerEntry): Promise<void> {
    this.clearIdleTimer(entry)
    this.workers.delete(id)
    try { await entry.runtime.dispose() } catch { /* renderer teardown is already complete */ }
    try { await entry.page.close() } catch { /* renderer teardown is already complete */ }
    this.notifyAvailability()
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

  private waitForAvailability(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => { cleanup(); resolve() }
      const onAbort = () => { cleanup(); reject(new Error('Worker 获取已取消')) }
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(wake)
        if (index >= 0) this.waiters.splice(index, 1)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(wake)
    })
  }

  private notifyAvailability(): void { this.waiters.splice(0).forEach((wake) => wake()) }
}
