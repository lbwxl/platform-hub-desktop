import {
  fail,
  hookError,
  HOOK_OPERATION_PRIORITIES,
  ok,
  type HookEvent,
  type HookManifest,
  type HookOperation,
  type HookPageDefinition,
  type HookResult,
  type PageHookRuntime,
} from '@platform-hub/hook-sdk'
import type { HookPageAdapter, HookPageFactory } from '../pages/types.js'
import { WorkerPageManager } from '../pages/worker-page-manager.js'
import { schedulerErrorResult, WorkerScheduler, WorkerSchedulerError } from '../scheduler/worker-scheduler.js'

export interface HookSessionOptions {
  sessionId: string
  shopId: string
  manifest: HookManifest
  factory: HookPageFactory
  scheduler: WorkerScheduler
  partition?: string
  maxWorkers?: number
  workerIdleTtlMs?: number
  eventPollMs?: number
}

export type HookEventListener = (event: HookEvent) => void

export class HookSession {
  readonly partition: string
  readonly workerPages: WorkerPageManager
  private primaryPage?: HookPageAdapter
  private primaryRuntime?: PageHookRuntime
  private readonly listeners = new Set<HookEventListener>()
  private eventTimer?: ReturnType<typeof setTimeout>
  private eventPollBusy = false
  private started = false
  private disposed = false
  private readonly eventPollMs: number

  constructor(private readonly options: HookSessionOptions) {
    this.partition = options.partition || partitionFor(options.manifest.platform, options.shopId)
    this.eventPollMs = Math.max(50, options.eventPollMs ?? 500)
    this.workerPages = new WorkerPageManager({
      sessionId: options.sessionId,
      shopId: options.shopId,
      partition: this.partition,
      manifest: options.manifest,
      factory: options.factory,
      maxWorkers: options.maxWorkers,
      defaultIdleTtlMs: options.workerIdleTtlMs,
    })
  }

  get isStarted(): boolean { return this.started && !this.disposed }
  get sessionId(): string { return this.options.sessionId }
  get shopId(): string { return this.options.shopId }
  get manifest(): HookManifest { return this.options.manifest }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('HookSession 已销毁')
    if (this.started) return
    const definition = this.primaryDefinition()
    this.primaryPage = await this.options.factory.create({
      sessionId: this.options.sessionId,
      shopId: this.options.shopId,
      partition: this.partition,
      manifest: this.options.manifest,
      definition,
    })
    this.primaryRuntime = await this.primaryPage.installRuntime()
    this.started = true
    this.scheduleEventPoll()
  }

  async invoke<T>(operation: HookOperation | string, input: unknown = {}, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<HookResult<T>> {
    if (!this.isStarted) return fail(hookError('RUNTIME_NOT_READY', 'HookSession 尚未启动'))
    const definition = this.definitionFor(operation)
    if (!definition) return fail(hookError('NOT_SUPPORTED', `Manifest 未声明 Operation: ${operation}`))
    if (definition.kind === 'primary') {
      try {
        return await this.invokeWithRecovery<T>(this.primaryPage!, this.primaryRuntime!, operation, input, options?.signal, async () => {
          this.primaryRuntime = await this.primaryPage!.installRuntime()
          return this.primaryRuntime
        })
      } catch (error) {
        return fail(hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true))
      }
    }
    try {
      return await this.options.scheduler.schedule<HookResult<T>>({
        manager: this.workerPages,
        page: definition,
        priority: HOOK_OPERATION_PRIORITIES[operation as HookOperation],
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        run: async (lease, signal) => this.invokeWithRecovery<T>(lease.page, lease.runtime, operation, input, signal, lease.refreshRuntime),
      })
    } catch (error) {
      if (error instanceof WorkerSchedulerError) return fail(schedulerErrorResult(error))
      return fail(hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true))
    }
  }

  subscribe(listener: HookEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async pollEvents(): Promise<void> {
    if (!this.isStarted || this.eventPollBusy) return
    this.eventPollBusy = true
    try {
      const events: HookEvent[] = []
      try { events.push(...(this.primaryRuntime?.drainEvents() || [])) } catch (error) { events.push(this.runtimeError(error)) }
      try { events.push(...await this.workerPages.drainEvents()) } catch (error) { events.push(this.runtimeError(error)) }
      for (const event of events) this.emit(event)
    } finally {
      this.eventPollBusy = false
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.eventTimer = undefined
    await this.workerPages.dispose()
    try { await this.primaryRuntime?.dispose() } catch { /* renderer teardown */ }
    try { await this.primaryPage?.close() } catch { /* renderer teardown */ }
    this.primaryRuntime = undefined
    this.primaryPage = undefined
    this.listeners.clear()
  }

  private async invokeWithRecovery<T>(
    page: HookPageAdapter,
    runtime: PageHookRuntime,
    operation: string,
    input: unknown,
    signal: AbortSignal | undefined,
    refresh: () => Promise<PageHookRuntime>,
  ): Promise<HookResult<T>> {
    let result = await runtime.invoke(operation, input) as HookResult<T>
    if (result.ok && result.data !== undefined) return result
    if (!result.ok && result.error.code === 'CHALLENGE_REQUIRED') {
      await page.show()
      await page.waitForRuntimeReady(signal)
      result = await (await refresh()).invoke(operation, input) as HookResult<T>
    }
    return result
  }

  private emit(event: HookEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* subscriber failures cannot stop the host */ }
    }
  }

  private scheduleEventPoll(): void {
    if (this.disposed) return
    this.eventTimer = setTimeout(async () => {
      await this.pollEvents()
      this.scheduleEventPoll()
    }, this.eventPollMs)
    this.eventTimer.unref?.()
  }

  private primaryDefinition(): HookPageDefinition {
    const definition = this.options.manifest.pages.find((page) => page.kind === 'primary')
    if (!definition) throw new Error('HookManifest 必须声明一个 primary page')
    return definition
  }

  private definitionFor(operation: string): HookPageDefinition | undefined {
    const route = this.options.manifest.operations[operation as HookOperation]
    return route ? this.options.manifest.pages.find((page) => page.id === route.page) : undefined
  }

  private runtimeError(error: unknown): HookEvent<'runtime.error'> {
    return { type: 'runtime.error', timestamp: Date.now(), payload: { message: String(error instanceof Error ? error.message : error), error } }
  }
}

export function partitionFor(platform: string, shopId: string): string {
  return `persist:platform-hook-${platform}-${shopId.replace(/[^a-z0-9_-]/gi, '_')}`
}
