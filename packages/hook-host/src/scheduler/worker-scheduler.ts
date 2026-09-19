import { hookError, type HookErrorCode } from '@platform-hub/hook-sdk'
import type { HookPageDefinition } from '@platform-hub/hook-sdk'
import type { WorkerPageLease } from '../pages/types.js'
import { WorkerPageManager } from '../pages/worker-page-manager.js'

export type WorkerPriority = 'auth' | 'message' | 'order' | 'product' | number

const PRIORITY: Record<string, number> = { message: 300, order: 200, product: 100 }

export class WorkerSchedulerError extends Error {
  readonly code: HookErrorCode
  constructor(code: HookErrorCode, message: string) {
    super(message)
    this.name = 'WorkerSchedulerError'
    this.code = code
  }
}

export interface WorkerTaskOptions<T> {
  manager: WorkerPageManager
  page: HookPageDefinition
  priority?: WorkerPriority
  timeoutMs?: number
  signal?: AbortSignal
  run: (lease: WorkerPageLease, signal: AbortSignal) => Promise<T>
}

interface QueueItem<T> {
  sequence: number
  priority: number
  options: WorkerTaskOptions<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export class WorkerScheduler {
  private readonly queue: QueueItem<unknown>[] = []
  private active = 0
  private sequence = 0
  private stopped = false

  constructor(private readonly maxConcurrency = 4) {}

  get activeCount(): number { return this.active }
  get queuedCount(): number { return this.queue.length }

  schedule<T>(options: WorkerTaskOptions<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new WorkerSchedulerError('RUNTIME_NOT_READY', 'WorkerScheduler 已停止'))
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        sequence: this.sequence++,
        priority: this.priorityOf(options.priority),
        options,
        resolve,
        reject,
      }
      if (options.signal?.aborted) {
        reject(new WorkerSchedulerError('TIMEOUT', '任务在排队时已取消'))
        return
      }
      this.queue.push(item as QueueItem<unknown>)
      this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
      this.pump()
    })
  }

  stop(): void {
    this.stopped = true
    const error = new WorkerSchedulerError('RUNTIME_NOT_READY', 'WorkerScheduler 已停止')
    while (this.queue.length) this.queue.shift()?.reject(error)
  }

  private priorityOf(priority: WorkerPriority | undefined): number {
    if (typeof priority === 'number') return priority
    return PRIORITY[priority || 'product'] || 0
  }

  private pump(): void {
    while (!this.stopped && this.active < this.maxConcurrency && this.queue.length) {
      const item = this.queue.shift()!
      this.active += 1
      void this.run(item).finally(() => {
        this.active -= 1
        this.pump()
      })
    }
  }

  private async run(item: QueueItem<unknown>): Promise<void> {
    const { options } = item
    if (options.signal?.aborted) {
      item.reject(new WorkerSchedulerError('TIMEOUT', '任务已取消'))
      return
    }
    let lease: WorkerPageLease | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const abortForwarder = () => controller.abort()
    options.signal?.addEventListener('abort', abortForwarder, { once: true })
    try {
      lease = await options.manager.acquire(options.page, controller.signal)
      const operation = options.run(lease, controller.signal)
      const timeout = options.timeoutMs && options.timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new WorkerSchedulerError('TIMEOUT', `Worker 操作超过 ${options.timeoutMs}ms`))
            }, options.timeoutMs)
            timer.unref?.()
          })
        : undefined
      item.resolve(await (timeout ? Promise.race([operation, timeout]) : operation))
    } catch (error) {
      if (error instanceof WorkerSchedulerError) item.reject(error)
      else item.reject(error)
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortForwarder)
      lease?.release()
    }
  }
}

export function schedulerErrorResult(error: unknown) {
  if (error instanceof WorkerSchedulerError) return hookError(error.code, error.message, undefined, error.code === 'TIMEOUT')
  return hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true)
}
