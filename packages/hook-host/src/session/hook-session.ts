import {
  assertPageHookRuntime,
  fail,
  hookError,
  HOOK_OPERATION_PRIORITIES,
  noopHookLogger,
  type HookEvent,
  type HookLogger,
  type HookManifest,
  type HookOperation,
  type HookPageDefinition,
  type HookResult,
  type PageHookRuntime,
} from '@platform-hub/hook-sdk'
import type { HookPageAdapter, HookPageFactory } from '../pages/types.js'
import { PersistentPageManager } from '../pages/persistent-page-manager.js'
import { WorkerPageManager } from '../pages/worker-page-manager.js'
import { schedulerErrorResult, WorkerScheduler, WorkerSchedulerError } from '../scheduler/worker-scheduler.js'

export interface HookEventPollingOptions {
  initialIntervalMs?: number
  activeIntervalMs?: number
  idleIntervalMs?: number
  backoffMultiplier?: number
}

export interface HookSessionOptions {
  sessionId: string
  shopId: string
  manifest: HookManifest
  factory: HookPageFactory
  scheduler: WorkerScheduler
  partition?: string
  maxWorkers?: number
  workerIdleTtlMs?: number
  eventPolling?: false | HookEventPollingOptions
  challengeTimeoutMs?: number
  logger?: HookLogger
}

export type HookEventListener = (event: HookEvent) => void

export class HookSession {
  readonly partition: string
  readonly workerPages: WorkerPageManager
  readonly persistentPages: PersistentPageManager
  private primaryPage?: HookPageAdapter
  private primaryRuntime?: PageHookRuntime
  private primaryRuntimeUncertain = false
  private readonly persistentRuntimeUncertain = new Set<string>()
  private primaryPushUnsubscribe?: () => void
  private readonly listeners = new Set<HookEventListener>()
  private readonly lifecycleController = new AbortController()
  private eventTimer?: ReturnType<typeof setTimeout>
  private eventPollBusy = false
  private started = false
  private disposed = false
  private readonly polling: Required<HookEventPollingOptions> | false
  private eventPollDelayMs: number
  private readonly challengeTimeoutMs: number
  private readonly logger: HookLogger

  constructor(private readonly options: HookSessionOptions) {
    this.partition = options.partition || partitionFor(options.manifest.platform, options.shopId)
    this.polling = options.eventPolling === false ? false : normalizePolling(options.eventPolling)
    this.eventPollDelayMs = this.polling ? this.polling.initialIntervalMs : 0
    this.challengeTimeoutMs = Math.max(1, options.challengeTimeoutMs ?? 120_000)
    this.logger = options.logger ?? noopHookLogger
    this.workerPages = new WorkerPageManager({
      sessionId: options.sessionId,
      shopId: options.shopId,
      partition: this.partition,
      manifest: options.manifest,
      factory: options.factory,
      maxWorkers: options.maxWorkers,
      defaultIdleTtlMs: options.workerIdleTtlMs,
      logger: this.logger,
      onEvent: (event) => this.emit(event),
      onEventError: (error) => this.emit(this.runtimeError(error)),
    })
    this.persistentPages = new PersistentPageManager({
      sessionId: options.sessionId,
      shopId: options.shopId,
      partition: this.partition,
      manifest: options.manifest,
      factory: options.factory,
      logger: this.logger,
      onEvent: (event) => this.emit(event),
      onEventError: (error) => this.emit(this.runtimeError(error)),
    })
  }

  get isStarted(): boolean { return this.started && !this.disposed }
  get isDisposed(): boolean { return this.disposed }
  get sessionId(): string { return this.options.sessionId }
  get shopId(): string { return this.options.shopId }
  get manifest(): HookManifest { return this.options.manifest }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('HookSession 已销毁')
    if (this.started) return
    const definition = this.primaryDefinition()
    let page: HookPageAdapter | undefined
    let runtime: PageHookRuntime | undefined
    let unsubscribe: (() => void) | undefined
    try {
      page = await this.options.factory.create({
        sessionId: this.options.sessionId,
        shopId: this.options.shopId,
        partition: this.partition,
        manifest: this.options.manifest,
        definition,
      })
      runtime = await page.installRuntime()
      assertPageHookRuntime(runtime, this.options.manifest, definition)
      if (page.subscribeEvents) {
        try {
          unsubscribe = await page.subscribeEvents((event) => this.emit(event))
        } catch (error) {
          this.logger.warn('Primary push event subscription failed; polling fallback remains active', { error: errorMessage(error) })
        }
      }
      this.primaryPage = page
      this.primaryRuntime = runtime
      this.primaryRuntimeUncertain = false
      this.primaryPushUnsubscribe = unsubscribe
      await this.persistentPages.start()
      this.started = true
      this.scheduleEventPoll()
      this.logger.info('Hook session started')
    } catch (error) {
      try { unsubscribe?.() } catch { /* start cleanup */ }
      try { await runtime?.dispose() } catch { /* start cleanup */ }
      try { await page?.close() } catch { /* start cleanup */ }
      await this.persistentPages.dispose()
      this.logger.error('Hook session start failed', { error: errorMessage(error) })
      throw error
    }
  }

  async invoke<T>(
    operation: HookOperation | string,
    input: unknown = {},
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<HookResult<T>> {
    if (!this.isStarted) return fail(hookError('RUNTIME_NOT_READY', 'HookSession 尚未启动'))
    if (options?.signal?.aborted) return fail(hookError('TIMEOUT', 'Operation 已取消', undefined, true))
    const definition = this.definitionFor(operation)
    if (!definition) return fail(hookError('NOT_SUPPORTED', `Manifest 未声明 Operation: ${operation}`))
    const linked = linkAbortSignals(this.lifecycleController.signal, options?.signal)
    try {
      if (definition.kind === 'primary') {
        return await this.invokePrimary<T>(operation, input, linked.signal, options?.timeoutMs)
      }
      if (definition.kind === 'persistent') {
        return await this.invokePersistent<T>(definition, operation, input, linked.signal, options?.timeoutMs)
      }
      return await this.options.scheduler.schedule<HookResult<T>>({
        manager: this.workerPages,
        page: definition,
        priority: HOOK_OPERATION_PRIORITIES[operation as HookOperation],
        timeoutMs: options?.timeoutMs,
        signal: linked.signal,
        run: async (lease, signal) => this.invokeWithRecovery<T>(
          lease.page, lease.runtime, operation, input, signal, lease.refreshRuntime, options?.timeoutMs,
        ),
      })
    } catch (error) {
      if (error instanceof WorkerSchedulerError) return fail(schedulerErrorResult(error))
      this.logger.warn('Hook operation failed', { operation, error: errorMessage(error) })
      return fail(hookError('PLATFORM_ERROR', errorMessage(error), undefined, true))
    } finally {
      linked.cleanup()
    }
  }

  subscribe(listener: HookEventListener): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async pollEvents(): Promise<number> {
    if (!this.isStarted || this.eventPollBusy) return 0
    this.eventPollBusy = true
    let count = 0
    try {
      if (!this.primaryPushUnsubscribe && this.primaryRuntime) {
        try {
          const events = await this.primaryRuntime.drainEvents()
          count += events.length
          for (const event of events) this.emit(event)
        } catch (error) {
          this.emit(this.runtimeError(error))
        }
      }
      const workerEvents = await this.workerPages.drainEvents()
      count += workerEvents.length
      for (const event of workerEvents) this.emit(event)
      const persistentEvents = await this.persistentPages.drainEvents()
      count += persistentEvents.length
      for (const event of persistentEvents) this.emit(event)
      return count
    } finally {
      this.eventPollBusy = false
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    this.lifecycleController.abort()
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.eventTimer = undefined
    try { this.primaryPushUnsubscribe?.() } catch (error) { this.logger.warn('Primary event subscription cleanup failed', { error: errorMessage(error) }) }
    this.primaryPushUnsubscribe = undefined
    await this.persistentPages.dispose()
    this.persistentRuntimeUncertain.clear()
    await this.workerPages.dispose()
    const runtime = this.primaryRuntime
    this.primaryRuntime = undefined
    try { await runtime?.dispose() } catch (error) { this.logger.warn('Primary runtime dispose failed', { error: errorMessage(error) }) }
    try { await this.primaryPage?.close() } catch (error) { this.logger.warn('Primary page close failed', { error: errorMessage(error) }) }
    this.primaryPage = undefined
    this.listeners.clear()
    this.logger.info('Hook session disposed')
  }

  private async invokePrimary<T>(
    operation: string,
    input: unknown,
    parentSignal: AbortSignal,
    timeoutMs?: number,
  ): Promise<HookResult<T>> {
    const deadline = operationSignal(parentSignal, timeoutMs)
    let invocationStarted = false
    const pending = (async (): Promise<HookResult<T>> => {
      if (this.primaryRuntimeUncertain) await this.refreshPrimaryRuntime()
      if (deadline.signal.aborted) return fail(hookError('TIMEOUT', 'Primary operation 已取消', undefined, true))
      const page = this.primaryPage
      const runtime = this.primaryRuntime
      if (!page || !runtime) return fail(hookError('RUNTIME_NOT_READY', 'Primary Runtime 不可用'))
      invocationStarted = true
      return this.invokeWithRecovery<T>(
        page,
        runtime,
        operation,
        input,
        deadline.signal,
        () => this.refreshPrimaryRuntime(),
        timeoutMs,
      )
    })()

    const interrupted = Symbol('primary-operation-interrupted')
    let onAbort: (() => void) | undefined
    const interruption = new Promise<typeof interrupted>((resolve) => {
      onAbort = () => resolve(interrupted)
      if (deadline.signal.aborted) onAbort()
      else deadline.signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      const outcome = await Promise.race([pending, interruption])
      if (outcome !== interrupted) return outcome
      if (invocationStarted) this.primaryRuntimeUncertain = true
      void pending.catch((error) => {
        this.logger.warn('Interrupted primary operation settled with an error', { operation, error: errorMessage(error) })
      })
      return fail(hookError(
        'TIMEOUT',
        deadline.timedOut() ? `Primary operation 超过 ${timeoutMs}ms` : 'Primary operation 已取消',
        undefined,
        true,
      ))
    } finally {
      if (onAbort) deadline.signal.removeEventListener('abort', onAbort)
      deadline.cleanup()
    }
  }

  private async invokePersistent<T>(
    definition: HookPageDefinition,
    operation: string,
    input: unknown,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<HookResult<T>> {
    const deadline = operationSignal(signal, timeoutMs)
    let invocationStarted = false
    try {
      const handle = await this.persistentPages.ensure(definition)
      if (this.persistentRuntimeUncertain.has(definition.id)) {
        await handle.refreshRuntime()
        this.persistentRuntimeUncertain.delete(definition.id)
      }
      if (deadline.signal.aborted) return fail(hookError('TIMEOUT', 'Persistent operation 已取消', undefined, true))
      invocationStarted = true
      const pending = this.invokeWithRecovery<T>(
        handle.page,
        handle.runtime,
        operation,
        input,
        deadline.signal,
        handle.refreshRuntime,
        timeoutMs,
      )
      const interrupted = Symbol('persistent-operation-interrupted')
      let onAbort: (() => void) | undefined
      const interruption = new Promise<typeof interrupted>((resolve) => {
        onAbort = () => resolve(interrupted)
        if (deadline.signal.aborted) onAbort()
        else deadline.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const outcome = await Promise.race([pending, interruption])
        if (outcome !== interrupted) return outcome
        if (invocationStarted) this.persistentRuntimeUncertain.add(definition.id)
        void pending.catch((error) => this.logger.warn('Interrupted persistent operation settled with an error', { operation, pageId: definition.id, error: errorMessage(error) }))
        return fail(hookError('TIMEOUT', deadline.timedOut() ? `Persistent operation 超过 ${timeoutMs}ms` : 'Persistent operation 已取消', undefined, true))
      } finally {
        if (onAbort) deadline.signal.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      this.logger.warn('Persistent operation failed', { operation, pageId: definition.id, error: errorMessage(error) })
      return fail(hookError('PLATFORM_ERROR', errorMessage(error), undefined, true))
    } finally {
      deadline.cleanup()
    }
  }

  private async refreshPrimaryRuntime(): Promise<PageHookRuntime> {
    const page = this.primaryPage
    if (!page) throw new Error('Primary Page 不可用')
    const previous = this.primaryRuntime
    this.primaryRuntime = undefined
    if (previous) {
      try { await previous.dispose() } catch (error) { this.logger.warn('Previous primary runtime dispose failed during refresh', { error: errorMessage(error) }) }
    }

    let next: PageHookRuntime | undefined
    try {
      next = await page.installRuntime()
      assertPageHookRuntime(next, this.options.manifest, page.definition)
      this.primaryRuntime = next
      this.primaryRuntimeUncertain = false
      return next
    } catch (error) {
      try { await next?.dispose() } catch (disposeError) { this.logger.warn('Invalid primary runtime dispose failed', { error: errorMessage(disposeError) }) }
      try { this.primaryPushUnsubscribe?.() } catch { /* refresh failure cleanup */ }
      this.primaryPushUnsubscribe = undefined
      try { await page.close() } catch (closeError) { this.logger.warn('Primary page close failed after refresh failure', { error: errorMessage(closeError) }) }
      this.primaryPage = undefined
      this.started = false
      throw error
    }
  }

  private async invokeWithRecovery<T>(
    page: HookPageAdapter,
    runtime: PageHookRuntime,
    operation: string,
    input: unknown,
    signal: AbortSignal,
    refresh: () => Promise<PageHookRuntime>,
    timeoutMs?: number,
  ): Promise<HookResult<T>> {
    if (signal.aborted) return fail(hookError('TIMEOUT', 'Operation 已取消', undefined, true))
    let result = await runtime.invoke(operation, input) as HookResult<T>
    if (signal.aborted) return fail(hookError('TIMEOUT', 'Operation 已取消', undefined, true))
    if (result.ok || result.error.code !== 'CHALLENGE_REQUIRED') return result

    await page.show()
    const recovery = challengeSignal(signal, timeoutMs ?? this.challengeTimeoutMs)
    try {
      await page.waitForRuntimeReady(recovery.signal)
      if (recovery.signal.aborted) return fail(hookError('TIMEOUT', recovery.timedOut() ? 'Challenge Recovery 超时' : 'Challenge Recovery 已取消', undefined, true))
      result = await (await refresh()).invoke(operation, input) as HookResult<T>
      return result
    } catch (error) {
      if (recovery.signal.aborted) {
        return fail(hookError('TIMEOUT', recovery.timedOut() ? 'Challenge Recovery 超时' : 'Challenge Recovery 已取消', undefined, true))
      }
      throw error
    } finally {
      recovery.cleanup()
    }
  }

  private emit(event: HookEvent): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { this.logger.warn('Hook event listener failed', { eventType: event.type, error: errorMessage(error) }) }
    }
  }

  private scheduleEventPoll(): void {
    if (this.disposed || !this.polling) return
    this.eventTimer = setTimeout(async () => {
      const eventCount = await this.pollEvents()
      if (!this.polling || this.disposed) return
      this.eventPollDelayMs = eventCount > 0
        ? this.polling.activeIntervalMs
        : Math.min(this.polling.idleIntervalMs, Math.max(this.polling.activeIntervalMs, this.eventPollDelayMs * this.polling.backoffMultiplier))
      this.scheduleEventPoll()
    }, this.eventPollDelayMs)
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
    return { type: 'runtime.error', timestamp: Date.now(), payload: { message: errorMessage(error), error } }
  }
}

function normalizePolling(options: HookEventPollingOptions | undefined): Required<HookEventPollingOptions> {
  const activeIntervalMs = Math.max(25, options?.activeIntervalMs ?? 250)
  const idleIntervalMs = Math.max(activeIntervalMs, options?.idleIntervalMs ?? 5_000)
  return {
    initialIntervalMs: Math.max(25, options?.initialIntervalMs ?? 1_000),
    activeIntervalMs,
    idleIntervalMs,
    backoffMultiplier: Math.max(1, options?.backoffMultiplier ?? 1.8),
  }
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  const abort = () => controller.abort()
  for (const signal of active) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => active.forEach((signal) => signal.removeEventListener('abort', abort)),
  }
}

function challengeSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timeoutReached = false
  const abort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    timeoutReached = true
    controller.abort()
  }, Math.max(1, timeoutMs))
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

function operationSignal(parent: AbortSignal, timeoutMs?: number): {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timeoutReached = false
  const abort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = timeoutMs !== undefined && timeoutMs > 0
    ? setTimeout(() => {
        timeoutReached = true
        controller.abort()
      }, timeoutMs)
    : undefined
  timer?.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function partitionFor(platform: string, shopId: string): string {
  return `persist:platform-hook-${platform}-${shopId.replace(/[^a-z0-9_-]/gi, '_')}`
}
