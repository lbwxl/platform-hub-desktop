export type ShopRuntimeState = 'stopped' | 'starting' | 'running' | 'error'

export type ReplyDecision =
  | { type: 'reply'; text: string }
  | { type: 'human_required'; reason?: string }
  | { type: 'ignore'; reason?: string }

export interface ShopReplyApi {
  reply(input: {
    accountId: string
    conversationId: string
    content: string
    message: unknown
  }): Promise<ReplyDecision>
}

export interface ShopTransportLike {
  start(): Promise<void>
  invoke<T = unknown>(operation: string, input: unknown): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string; retryable?: boolean } }>
  subscribe(listener: (event: ShopHookEvent) => void): () => void
  stop(): Promise<void>
}

export interface ShopHookEvent {
  id?: string
  type: string
  payload?: Record<string, unknown>
  timestamp?: number
}

export interface ShopRuntimeSnapshot {
  accountId: string
  online: boolean
  runtimeState: ShopRuntimeState
  messageListening: boolean
  lastIncomingAt?: number
  lastReplyAt?: number
  lastReplyType?: ReplyDecision['type']
  attention: Record<string, 'pending' | 'opened' | 'resolved'>
}

export interface ShopRuntimeEvent {
  accountId: string
  type: 'hook' | 'reply' | 'attention' | 'runtime'
  timestamp: number
  payload: Record<string, unknown>
}

interface ManagedRuntime {
  accountId: string
  transport: ShopTransportLike
  online: boolean
  runtimeState: ShopRuntimeState
  messageListening: boolean
  unsubscribe?: () => void
  startPromise?: Promise<void>
  lastIncomingAt?: number
  lastReplyAt?: number
  lastReplyType?: ReplyDecision['type']
  attention: Map<string, 'pending' | 'opened' | 'resolved'>
  processing: Set<string>
}

/**
 * Main-process owner for one runtime per shop. Active UI selection never
 * enters this class: online shops continue listening and replying in the
 * background until explicitly taken offline or stopped.
 */
export class ShopRuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>()
  private readonly listeners = new Set<(event: ShopRuntimeEvent) => void>()

  constructor(private readonly replyApi: ShopReplyApi) {}

  register(accountId: string, transport: ShopTransportLike): void {
    if (this.runtimes.has(accountId)) return
    const runtime: ManagedRuntime = {
      accountId,
      transport,
      online: false,
      runtimeState: 'stopped',
      messageListening: false,
      attention: new Map(),
      processing: new Set(),
    }
    runtime.unsubscribe = transport.subscribe((event) => this.handleEvent(runtime, event))
    this.runtimes.set(accountId, runtime)
  }

  unregister(accountId: string): void {
    const runtime = this.runtimes.get(accountId)
    if (!runtime) return
    runtime.unsubscribe?.()
    runtime.unsubscribe = undefined
    this.runtimes.delete(accountId)
  }

  has(accountId: string): boolean { return this.runtimes.has(accountId) }

  snapshot(accountId: string): ShopRuntimeSnapshot | undefined {
    const runtime = this.runtimes.get(accountId)
    if (!runtime) return undefined
    return this.toSnapshot(runtime)
  }

  snapshots(): ShopRuntimeSnapshot[] { return [...this.runtimes.values()].map((runtime) => this.toSnapshot(runtime)) }

  async setOnline(accountId: string, online: boolean): Promise<ShopRuntimeSnapshot> {
    const runtime = this.require(accountId)
    runtime.online = online
    if (!online) {
      this.emit(runtime, 'runtime', { online: false, runtimeState: runtime.runtimeState })
      return this.toSnapshot(runtime)
    }
    await this.start(runtime)
    return this.toSnapshot(runtime)
  }

  async stop(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId)
    if (!runtime) return
    runtime.online = false
    runtime.messageListening = false
    runtime.runtimeState = 'stopped'
    runtime.unsubscribe?.()
    runtime.unsubscribe = undefined
    await runtime.transport.stop()
    this.runtimes.delete(accountId)
  }

  async setAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void> {
    const runtime = this.require(accountId)
    const result = await runtime.transport.invoke('conversation.attention.set', { conversationId, state })
    if (!result.ok) throw new Error(result.error.message)
    runtime.attention.set(conversationId, state)
    this.emit(runtime, 'attention', { conversationId, state })
  }

  onEvent(listener: (event: ShopRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Feed a native/legacy event into the same account-scoped pipeline. */
  pushEvent(accountId: string, event: ShopHookEvent): void {
    const runtime = this.runtimes.get(accountId)
    if (runtime) this.handleEvent(runtime, event)
  }

  private async start(runtime: ManagedRuntime): Promise<void> {
    if (runtime.runtimeState === 'running') return
    if (runtime.startPromise) return runtime.startPromise
    runtime.runtimeState = 'starting'
    runtime.startPromise = (async () => {
      try {
        await runtime.transport.start()
        const listening = await runtime.transport.invoke('messages.listen', {})
        if (!listening.ok) throw new Error(listening.error.message)
        runtime.messageListening = true
        runtime.runtimeState = 'running'
        this.emit(runtime, 'runtime', { online: runtime.online, runtimeState: runtime.runtimeState, messageListening: true })
      } catch (error) {
        runtime.runtimeState = 'error'
        this.emit(runtime, 'runtime', { online: runtime.online, runtimeState: 'error', message: errorMessage(error) })
        throw error
      } finally {
        runtime.startPromise = undefined
      }
    })()
    return runtime.startPromise
  }

  private handleEvent(runtime: ManagedRuntime, event: ShopHookEvent): void {
    const timestamp = event.timestamp || Date.now()
    this.emit(runtime, 'hook', { event })
    if (event.type !== 'message.created') return
    const message = (event.payload?.message || event.payload) as Record<string, unknown> | undefined
    if (!message) return
    const conversationId = String(message.conversationId || message.sessionId || '')
    if (!conversationId) return
    const direction = String(message.direction || (message.isMine ? 'outbound' : 'inbound'))
    const origin = String(message.origin || (direction === 'outbound' ? 'unknown' : 'customer'))
    if (direction === 'outbound') {
      if (origin === 'human') void this.setAttention(runtime.accountId, conversationId, 'resolved').catch(() => undefined)
      return
    }
    if (direction !== 'inbound' || origin !== 'customer') return
    runtime.lastIncomingAt = timestamp
    if (!runtime.online || runtime.processing.has(String(message.id || `${conversationId}:${timestamp}`))) return
    const key = String(message.id || `${conversationId}:${timestamp}`)
    runtime.processing.add(key)
    void this.processCustomerMessage(runtime, conversationId, message).finally(() => runtime.processing.delete(key))
  }

  private async processCustomerMessage(runtime: ManagedRuntime, conversationId: string, message: Record<string, unknown>): Promise<void> {
    try {
      const decision = await this.replyApi.reply({
        accountId: runtime.accountId,
        conversationId,
        content: String(message.content || ''),
        message,
      })
      runtime.lastReplyAt = Date.now()
      runtime.lastReplyType = decision.type
      this.emit(runtime, 'reply', { decision, conversationId })
      if (decision.type === 'reply') {
        const result = await runtime.transport.invoke('messages.send.text', { conversationId, text: decision.text })
        if (!result.ok) throw new Error(result.error.message)
      } else if (decision.type === 'human_required') {
        await this.setAttention(runtime.accountId, conversationId, 'pending')
      }
    } catch (error) {
      this.emit(runtime, 'runtime', { replyError: errorMessage(error), conversationId })
    }
  }

  private emit(runtime: ManagedRuntime, type: ShopRuntimeEvent['type'], payload: Record<string, unknown>): void {
    const event = { accountId: runtime.accountId, type, timestamp: Date.now(), payload }
    for (const listener of [...this.listeners]) listener(event)
  }

  private toSnapshot(runtime: ManagedRuntime): ShopRuntimeSnapshot {
    return {
      accountId: runtime.accountId,
      online: runtime.online,
      runtimeState: runtime.runtimeState,
      messageListening: runtime.messageListening,
      lastIncomingAt: runtime.lastIncomingAt,
      lastReplyAt: runtime.lastReplyAt,
      lastReplyType: runtime.lastReplyType,
      attention: Object.fromEntries(runtime.attention),
    }
  }

  private require(accountId: string): ManagedRuntime {
    const runtime = this.runtimes.get(accountId)
    if (!runtime) throw new Error(`店铺 Runtime 不存在: ${accountId}`)
    return runtime
  }
}

/**
 * Thin client for the already-running local Reply API. Its endpoint belongs to
 * the local test environment rather than the platform Hook. No fallback Echo
 * mock is created here: an unavailable API means no automation send.
 */
export class HttpShopReplyApi implements ShopReplyApi {
  constructor(private readonly endpoint = process.env.PLATFORM_HUB_REPLY_API_URL || '') {}

  async reply(input: { accountId: string; conversationId: string; content: string; message: unknown }): Promise<ReplyDecision> {
    if (!this.endpoint) return { type: 'ignore', reason: 'reply-api-not-configured' }
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`Reply API HTTP ${response.status}`)
    const value = await response.json() as Record<string, unknown>
    const type = String(value.type || value.action || '')
    if (type === 'reply') {
      const text = String(value.text || value.reply || '')
      if (!text) throw new Error('Reply API 返回 reply 但缺少 text')
      return { type: 'reply', text }
    }
    if (type === 'human_required' || type === 'human') return { type: 'human_required', reason: stringValue(value.reason) }
    return { type: 'ignore', reason: stringValue(value.reason) || 'reply-api-ignore' }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
