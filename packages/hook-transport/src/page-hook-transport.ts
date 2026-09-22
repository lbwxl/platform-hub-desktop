import type { HookSession } from '@platform-hub/hook-host'
import { fail, hookError, type HookEvent, type HookOperation, type HookResult } from '@platform-hub/hook-sdk'
import type { HookTransport } from './types.js'

type PageHookSession = Pick<HookSession, 'start' | 'invoke' | 'subscribe'>

export interface PageHookTransportOptions {
  session: PageHookSession
  /**
   * The owning HookHost removes the session from its registry before
   * disposing it. The transport never owns or shuts down that shared host.
   */
  disposeSession: () => Promise<unknown>
}

/**
 * Thin Page Hook adapter. Routing, recovery, scheduling, and page lifecycle
 * remain owned by the existing HookSession and HookHost foundation.
 */
export class PageHookTransport implements HookTransport {
  private readonly listeners = new Set<(event: HookEvent) => void>()
  private sessionUnsubscribe?: () => void
  private startPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private started = false
  private stopped = false

  constructor(private readonly options: PageHookTransportOptions) {}

  async start(): Promise<void> {
    if (this.stopped) throw new Error('PageHookTransport 已停止，不能重新启动')
    if (this.started) return
    if (!this.startPromise) {
      this.startPromise = this.options.session.start().then(
        () => { this.started = true },
        (error) => {
          this.startPromise = undefined
          throw error
        },
      )
    }
    await this.startPromise
  }

  invoke<T = unknown>(operation: HookOperation, input: unknown): Promise<HookResult<T>> {
    if (this.stopped) return Promise.resolve(fail(hookError('RUNTIME_NOT_READY', 'PageHookTransport 已停止')))
    return this.options.session.invoke<T>(operation, input)
  }

  subscribe(listener: (event: HookEvent) => void): () => void {
    if (this.stopped) return () => {}
    this.listeners.add(listener)
    this.ensureSessionSubscription()
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopped = true
      this.listeners.clear()
      this.sessionUnsubscribe?.()
      this.sessionUnsubscribe = undefined
      this.stopPromise = (async () => {
        try {
          await this.startPromise
        } catch {
          // A failed start still leaves session ownership with the host.
        }
        await this.options.disposeSession()
      })()
    }
    await this.stopPromise
  }

  private ensureSessionSubscription(): void {
    if (this.sessionUnsubscribe) return
    this.sessionUnsubscribe = this.options.session.subscribe((event) => {
      if (this.stopped) return
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          // One consumer must not block delivery to the remaining consumers.
        }
      }
    })
  }
}
