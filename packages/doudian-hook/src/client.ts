import { doudianHookScript } from './hook.js'
import type {
  AuthState,
  ChatSession,
  HookEvent,
  OperationResult,
  OrderEventPayload,
  OrderRecord,
  OrderSyncResult,
  PlatformMessage,
  ProductRecord,
} from './types.js'

export type CdpEvaluate = <T>(expression: string) => Promise<T>

export interface DoudianClient {
  install(): Promise<void>
  getAuthState(): Promise<AuthState>
  waitForLogin(options?: { timeoutMs?: number; intervalMs?: number }): Promise<AuthState>
  collectProducts(): Promise<ProductRecord[]>
  getProductDetail(goodsId: string): Promise<ProductRecord>
  listSessions(): Promise<ChatSession[]>
  listMessages(sessionId: string): Promise<PlatformMessage[]>
  sendMessage(sessionId: string, content: string): Promise<OperationResult>
  sendFile(sessionId: string, dataUrl: string, fileName?: string): Promise<OperationResult>
  getOrders(userId?: string): Promise<OrderRecord[] | OperationResult>
  syncOrders(sessionId?: string, userId?: string): Promise<OrderSyncResult>
  transferSession(sessionId: string, target: string): Promise<OperationResult>
  drainEvents(): Promise<HookEvent[]>
  subscribe(listener: (event: HookEvent) => void, options?: { intervalMs?: number }): () => void
  subscribeOrders(listener: (event: OrderEventPayload) => void, options?: { intervalMs?: number }): () => void
  diagnose(): Promise<Array<{ path: string; methods: string[]; score: number }>>
  dispose(): Promise<void>
}

function invocation(method: string, args: unknown[]): string {
  return `(() => {
    const api = globalThis.__platformHub
    if (!api || typeof api[${JSON.stringify(method)}] !== 'function') {
      throw new Error(${JSON.stringify(`抖店 Hook 方法不可用: ${method}`)})
    }
    return api[${JSON.stringify(method)}](...${JSON.stringify(args)})
  })()`
}

/** Creates a typed client over any CDP Runtime.evaluate implementation. */
export function createDoudianClient(evaluate: CdpEvaluate): DoudianClient {
  const invoke = <T>(method: string, ...args: unknown[]) => evaluate<T>(invocation(method, args))
  const getAuthState = () => invoke<AuthState>('getAuthState')
  const listeners = new Set<(event: HookEvent) => void>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let pollInterval = 800
  let draining = false

  const drain = async () => {
    if (draining || !listeners.size) return
    draining = true
    try {
      const events = await invoke<HookEvent[]>('drainEvents')
      for (const event of events) for (const listener of [...listeners]) listener(event)
    } catch (error) {
      const event: HookEvent = { type: 'error', payload: { error: String(error) }, timestamp: Date.now() }
      for (const listener of [...listeners]) listener(event)
    } finally {
      draining = false
    }
  }

  const restartPolling = (intervalMs: number) => {
    const nextInterval = Math.min(pollInterval, intervalMs)
    if (pollTimer && nextInterval === pollInterval) return
    pollInterval = nextInterval
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => void drain(), pollInterval)
    void drain()
  }

  const subscribe = (listener: (event: HookEvent) => void, options: { intervalMs?: number } = {}) => {
    listeners.add(listener)
    restartPolling(options.intervalMs ?? 800)
    return () => {
      listeners.delete(listener)
      if (!listeners.size && pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
        pollInterval = 800
      }
    }
  }

  return {
    install: () => evaluate<void>(doudianHookScript),
    getAuthState,
    async waitForLogin(options = {}) {
      const timeoutMs = options.timeoutMs ?? 15 * 60_000
      const intervalMs = options.intervalMs ?? 1000
      const started = Date.now()
      let state = await getAuthState()
      while (!state.authenticated && Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        state = await getAuthState()
      }
      if (!state.authenticated) throw new Error('等待抖店登录超时，请完成登录后重试')
      return state
    },
    collectProducts: () => invoke<ProductRecord[]>('collectProducts'),
    getProductDetail: (goodsId) => invoke<ProductRecord>('getProductDetail', goodsId),
    listSessions: () => invoke<ChatSession[]>('listSessions'),
    listMessages: (sessionId) => invoke<PlatformMessage[]>('listMessages', sessionId),
    sendMessage: (sessionId, content) => invoke<OperationResult>('sendMessage', sessionId, content),
    sendFile: (sessionId, dataUrl, fileName) => invoke<OperationResult>('sendFile', sessionId, dataUrl, fileName),
    getOrders: (userId) => invoke<OrderRecord[] | OperationResult>('getOrders', userId),
    syncOrders: (sessionId, userId) => invoke<OrderSyncResult>('syncOrders', sessionId, userId),
    transferSession: (sessionId, target) => invoke<OperationResult>('transferSession', sessionId, target),
    drainEvents: () => invoke<HookEvent[]>('drainEvents'),
    subscribe,
    subscribeOrders(listener, options = {}) {
      return subscribe((event) => {
        if (event.type === 'order') listener(event.payload as OrderEventPayload)
      }, options)
    },
    diagnose: () => invoke<Array<{ path: string; methods: string[]; score: number }>>('diagnose'),
    async dispose() {
      listeners.clear()
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      await invoke<void>('dispose')
    },
  }
}
