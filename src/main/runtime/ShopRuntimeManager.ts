import type { PlatformEvent } from '../../shared/platform'
import type { HookTransport } from '@platform-hub/core-transport'
import type { HookEvent } from '@platform-hub/core-sdk'

export type ShopRuntimeState = 'stopped' | 'starting' | 'running' | 'error'

export interface ShopReplyTransfer {
  reason?: string
  source?: string
  target?: unknown
  messages: string[]
  sendGreetingBeforeHandoff: boolean
  confidence?: number
}

export interface ShopReplyLifecycleAction {
  kind: string
  actionId?: string
  messages: string[]
  actionCode?: number
  payload?: Record<string, unknown>
}

export type ReplyDecision =
  | {
      type: 'reply'
      /** Kept for simple local test adapters; production responses use texts. */
      text?: string
      texts?: string[]
      fileUrls?: string[]
      transfer?: ShopReplyTransfer
      lifecycleAction?: ShopReplyLifecycleAction
      turn?: Record<string, unknown>
      warnings?: string[]
    }
  | { type: 'human_required'; reason?: string; turn?: Record<string, unknown>; warnings?: string[] }
  | { type: 'ignore'; reason?: string; turn?: Record<string, unknown>; warnings?: string[] }

export interface ShopReplyApi {
  reply(input: {
    accountId: string
    platform: string
    shopId: string
    shopName: string
    conversationId: string
    content: string
    customerId: string
    customerName: string
    message: unknown
  }): Promise<ReplyDecision>
}

export type ShopHookEvent = HookEvent

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

interface AutomationOutboundRecord {
  id?: string
  conversationId: string
  type: string
  content: string
  createdAt: number
}

interface ManagedRuntime {
  accountId: string
  platform: string
  shopName: string
  shopId: string
  transport: HookTransport
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

const MESSAGE_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_MESSAGE_CLAIMS = 100_000
const AUTOMATION_OUTBOUND_TTL_MS = 30_000
const MAX_AUTOMATION_OUTBOUNDS = 500

export type ReplyFile = { dataUrl: string; name: string; mimeType: string }
export type ReplyFileLoader = (url: string) => Promise<ReplyFile>

/**
 * Main-process owner for one runtime per shop. Active UI selection never
 * enters this class: online shops continue listening and replying in the
 * background until explicitly taken offline or stopped.
 */
export class ShopRuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>()
  /**
   * Message delivery is shared by all account runtimes for the same shop.
   * Douyin can replay a conversation's existing messages after handoff; the
   * per-page/per-account listener watermarks cannot dedupe those deliveries.
   */
  private readonly messageClaims = new Map<string, number>()
  private readonly automationOutbounds = new Map<string, AutomationOutboundRecord[]>()
  private readonly listeners = new Set<(event: ShopRuntimeEvent) => void>()
  private readonly replyApi: ShopReplyApi
  private readonly fileLoader: ReplyFileLoader

  constructor(replyApi: ShopReplyApi, options: { fileLoader?: ReplyFileLoader } = {}) {
    this.replyApi = replyApi
    this.fileLoader = options.fileLoader || loadReplyFile
  }

  register(accountId: string, transport: HookTransport, context: { platform?: string; shopName?: string } = {}): void {
    if (this.runtimes.has(accountId)) return
    const runtime: ManagedRuntime = {
      accountId,
      platform: context.platform || 'unknown',
      shopName: context.shopName || accountId,
      // Use the account id as a stable mock-routing fallback until auth.state
      // supplies the platform's real shop id.
      shopId: accountId,
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
    this.automationOutbounds.delete(accountId)
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
      this.emit(runtime, 'runtime', { online: false, runtimeState: runtime.runtimeState, messageListening: runtime.messageListening })
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
    await runtime.transport.stop()
    runtime.unsubscribe?.()
    runtime.unsubscribe = undefined
    this.runtimes.delete(accountId)
    this.automationOutbounds.delete(accountId)
  }

  async setAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void> {
    const runtime = this.require(accountId)
    const result = await runtime.transport.invoke('conversation.attention.set', { conversationId, state })
    if (!result.ok) {
      // Attention is an optional platform capability. A platform that cannot
      // map it to native UI must still complete the Reply API decision path.
      if (result.error.code === 'NOT_SUPPORTED') {
        this.emit(runtime, 'attention', { conversationId, requestedState: state, supported: false })
        return
      }
      throw new Error(result.error.message)
    }
    runtime.attention.set(conversationId, state)
    this.emit(runtime, 'attention', { conversationId, state })
  }

  onEvent(listener: (event: ShopRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Feed a native/legacy event into the same account-scoped pipeline. */
  pushEvent(accountId: string, event: HookEvent): void {
    const runtime = this.runtimes.get(accountId)
    if (runtime) this.handleEvent(runtime, event)
  }

  /**
   * The Electron compatibility shell can receive an official outbound echo
   * without the Page Hook origin metadata. Attribute only messages that were
   * sent through this account's Reply API path, using a short-lived record and
   * an exact platform message id whenever one is available.
   */
  annotateEvent(accountId: string, event: PlatformEvent): PlatformEvent {
    if (event.type !== 'message') return event
    const payload = asRecord(event.payload)
    const message = asRecord(payload.message || event.payload)
    const raw = asRecord(message.raw)
    const attribution = asRecord(raw.attributionMetadata)
    if (message.direction !== 'outbound' || message.origin === 'human' || message.origin === 'automation' || attribution.manualSendCheck === true) return event
    const records = this.automationOutbounds.get(accountId)
    if (!records?.length) return event
    const now = Date.now()
    while (records.length && now - records[0].createdAt > AUTOMATION_OUTBOUND_TTL_MS) records.shift()
    const id = scalarString(message.id ?? message.serverId ?? message.messageId)
    const conversationId = scalarString(message.conversationId ?? message.sessionId)
    const type = scalarString(message.type ?? message.messageType) || 'text'
    const content = scalarString(message.content ?? message.text)
    const matched = records.find((record) => Boolean(record.id && id && record.id === id))
      || records.find((record) => {
        const timestamp = Number(message.timestamp) || event.timestamp || now
        return record.conversationId === conversationId
          && record.type === type
          && record.content === content
          && timestamp >= record.createdAt - 5_000
          && timestamp <= record.createdAt + AUTOMATION_OUTBOUND_TTL_MS
      })
    if (!matched) return event
    const index = records.indexOf(matched)
    if (index >= 0) records.splice(index, 1)
    const annotatedMessage = { ...message, origin: 'automation' }
    return {
      ...event,
      payload: Object.prototype.hasOwnProperty.call(payload, 'message')
        ? { ...payload, message: annotatedMessage }
        : annotatedMessage,
    }
  }

  private async start(runtime: ManagedRuntime): Promise<void> {
    if (runtime.runtimeState === 'running') return
    if (runtime.startPromise) return runtime.startPromise
    runtime.runtimeState = 'starting'
    runtime.startPromise = (async () => {
      try {
        await runtime.transport.start()
        const auth = await runtime.transport.invoke<Record<string, unknown>>('auth.state', {})
        if (!auth.ok) throw new Error(auth.error.message)
        const authData = asRecord(auth.data)
        const shopId = scalarString(authData.shopId ?? authData.shop_id)
        const userId = scalarString(authData.userId ?? authData.user_id)
        const authFlag = [authData.authenticated, authData.isLogin, authData.loggedIn].find((value) => typeof value === 'boolean')
        const authenticated = typeof authFlag === 'boolean' ? authFlag : Boolean(shopId || userId)
        if (!authenticated) throw new Error('LOGIN_REQUIRED: 店铺尚未登录，暂不启动 Reply API 自动处理')
        if (shopId) runtime.shopId = shopId
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
    const message = (event as HookEvent<'message.created'>).payload.message as unknown as Record<string, unknown> | undefined
    if (!message) return
    const conversationId = String(message.conversationId || message.sessionId || '')
    if (!conversationId) return
    // Reply is a business decision for confirmed buyer messages only. Missing
    // attribution must fail closed: system/runtime notices can also arrive as
    // inbound messages, and must never consume a Reply API scenario.
    const direction = message.direction
    const origin = message.origin
    if (direction === 'outbound') {
      if (origin === 'human') void this.setAttention(runtime.accountId, conversationId, 'resolved').catch(() => undefined)
      return
    }
    if (direction !== 'inbound' || origin !== 'customer' || message.type === 'system' || message.type === 'order') return
    runtime.lastIncomingAt = timestamp
    const key = String(message.id || `${conversationId}:${timestamp}`)
    if (!runtime.online || runtime.runtimeState !== 'running' || !runtime.messageListening || runtime.processing.has(key)) return
    if (!this.claimShopMessage(runtime, conversationId, message)) return
    runtime.processing.add(key)
    void this.processCustomerMessage(runtime, conversationId, message).finally(() => runtime.processing.delete(key))
  }

  private claimShopMessage(runtime: ManagedRuntime, conversationId: string, message: Record<string, unknown>): boolean {
    const messageId = scalarString(message.id)
    // HookMessage requires an id, but keep the account-local fallback behavior
    // for imperfect platform events instead of risking a false cross-shop hit.
    if (!messageId) return true

    const now = Date.now()
    // Map insertion order is claim order (including refreshed duplicates), so
    // expired entries can be removed from the front without scanning the full
    // cache on every message.
    for (const [key, expiresAt] of this.messageClaims) {
      if (expiresAt > now) break
      this.messageClaims.delete(key)
    }

    const claimKey = JSON.stringify([runtime.platform, runtime.shopId, conversationId, messageId])
    if (this.messageClaims.has(claimKey)) {
      // Keep a replayed history item suppressed for a full retention window.
      this.messageClaims.delete(claimKey)
      this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS)
      return false
    }

    this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS)
    while (this.messageClaims.size > MAX_MESSAGE_CLAIMS) {
      const oldest = this.messageClaims.keys().next().value
      if (oldest === undefined) break
      this.messageClaims.delete(oldest)
    }
    return true
  }

  private async processCustomerMessage(runtime: ManagedRuntime, conversationId: string, message: Record<string, unknown>): Promise<void> {
    try {
      const decision = await this.replyApi.reply({
        accountId: runtime.accountId,
        platform: runtime.platform,
        shopId: runtime.shopId,
        shopName: runtime.shopName,
        conversationId,
        content: String(message.content || ''),
        customerId: String(message.senderId || message.userId || ''),
        customerName: String(message.senderName || message.name || ''),
        message,
      })
      // A response may arrive after the operator takes this shop offline or
      // disposes its runtime. Do not let an in-flight business request cause
      // platform-side effects in that case.
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) {
        this.emit(runtime, 'reply', { decision, conversationId, deliverySkipped: 'shop-offline' })
        return
      }
      if (decision.type === 'reply') {
        const effects: Record<string, unknown> = {}
        if (decision.warnings?.length) effects.warnings = decision.warnings
        if (decision.turn) effects.turn = decision.turn
        if (decision.lifecycleAction) {
          const action = decision.lifecycleAction
          const mapCard = action.payload?.map_card
          if (action.kind === 'map-card' || action.actionCode === 2 || mapCard) {
            // No shared Hook operation currently sends a native map/location
            // card. Keep the requested action observable instead of pretending
            // that a text message is an equivalent delivery.
            effects.unsupportedLifecycleAction = 'map-card'
            if (action.messages.length) await this.sendTexts(runtime, conversationId, action.messages)
          } else if (action.kind === 'greeting' || action.kind === 'farewell') {
            await this.sendTexts(runtime, conversationId, action.messages)
          }
          effects.lifecycleAction = action
        } else {
          const texts = decision.texts || (decision.text ? [decision.text] : [])
          await this.sendTexts(runtime, conversationId, texts)
          for (const fileUrl of decision.fileUrls || []) {
            try {
              if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) break
              const file = await this.fileLoader(fileUrl)
              const correlation = this.trackAutomation(runtime.accountId, conversationId, 'image', file.name)
              try {
                const result = await runtime.transport.invoke('messages.send.file', {
                  conversationId,
                  data: file.dataUrl,
                  dataUrl: file.dataUrl,
                  name: file.name,
                  mimeType: file.mimeType,
                })
                if (!result.ok) throw new Error(result.error.message)
                this.completeAutomation(correlation, result.data)
              } catch (error) {
                this.removeAutomation(runtime.accountId, correlation)
                throw error
              }
            } catch (error) {
              const failures = Array.isArray(effects.fileErrors) ? effects.fileErrors as string[] : []
              failures.push(errorMessage(error))
              effects.fileErrors = failures
            }
          }
          if (decision.transfer) {
            await this.sendTexts(runtime, conversationId, decision.transfer.messages)
            if (decision.transfer.sendGreetingBeforeHandoff && decision.transfer.messages.length === 0) {
              await this.sendTexts(runtime, conversationId, ['您好，为您转接人工客服'])
            }
            effects.handoff = await this.transferToOfficialTarget(runtime, conversationId, decision.transfer)
          }
        }
        this.emit(runtime, 'reply', { decision, conversationId, ...effects })
      } else if (decision.type === 'human_required') {
        await this.setAttention(runtime.accountId, conversationId, 'pending')
        this.emit(runtime, 'reply', { decision, conversationId, ...(decision.turn ? { turn: decision.turn } : {}), ...(decision.warnings?.length ? { warnings: decision.warnings } : {}) })
      } else {
        this.emit(runtime, 'reply', { decision, conversationId, ...(decision.turn ? { turn: decision.turn } : {}), ...(decision.warnings?.length ? { warnings: decision.warnings } : {}) })
      }
      runtime.lastReplyAt = Date.now()
      runtime.lastReplyType = decision.type
    } catch (error) {
      this.emit(runtime, 'runtime', {
        replyError: errorMessage(error),
        ...(error instanceof ReplyApiError ? { replyErrorCode: error.code } : {}),
        conversationId,
      })
    }
  }

  private async sendTexts(runtime: ManagedRuntime, conversationId: string, texts: string[]): Promise<void> {
    for (const text of texts) {
      if (!text.trim()) continue
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return
      const correlation = this.trackAutomation(runtime.accountId, conversationId, 'text', text)
      try {
        const result = await runtime.transport.invoke('messages.send.text', { conversationId, text })
        if (!result.ok) throw new Error(result.error.message)
        this.completeAutomation(correlation, result.data)
      } catch (error) {
        this.removeAutomation(runtime.accountId, correlation)
        throw error
      }
    }
  }

  private trackAutomation(accountId: string, conversationId: string, type: string, content: string): AutomationOutboundRecord {
    const record: AutomationOutboundRecord = { conversationId, type, content, createdAt: Date.now() }
    const records = this.automationOutbounds.get(accountId) || []
    records.push(record)
    while (records.length > MAX_AUTOMATION_OUTBOUNDS) records.shift()
    this.automationOutbounds.set(accountId, records)
    return record
  }

  private completeAutomation(record: AutomationOutboundRecord, value: unknown): void {
    const wrapper = asRecord(value)
    const message = asRecord(wrapper.message || value)
    record.id = scalarString(message.id ?? message.serverId ?? message.messageId) || undefined
    record.content = scalarString(message.content ?? message.text ?? message.name) || record.content
  }

  private removeAutomation(accountId: string, record: AutomationOutboundRecord): void {
    const records = this.automationOutbounds.get(accountId)
    if (!records) return
    const index = records.indexOf(record)
    if (index >= 0) records.splice(index, 1)
    if (!records.length) this.automationOutbounds.delete(accountId)
  }

  private async transferToOfficialTarget(runtime: ManagedRuntime, conversationId: string, transfer: ShopReplyTransfer): Promise<Record<string, unknown>> {
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: 'shop-offline' }
    const requested = transferTargetReference(transfer.target)
    if (!requested) {
      await this.setAttention(runtime.accountId, conversationId, 'pending')
      return { transferred: false, reason: 'official-target-required' }
    }
    const listed = await runtime.transport.invoke<unknown[]>('handoff.targets.list', {})
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: 'shop-offline' }
    if (!listed.ok || !Array.isArray(listed.data)) {
      await this.setAttention(runtime.accountId, conversationId, 'pending')
      return { transferred: false, reason: 'official-target-list-unavailable' }
    }
    const target = listed.data.map((value: unknown) => asRecord(value)).find((item: Record<string, unknown>) =>
      (requested.id && scalarString(item.id) === requested.id)
      || (requested.name && scalarString(item.name) === requested.name),
    )
    const targetId = target && scalarString(target.id)
    const targetName = target && scalarString(target.name)
    if (!target || !targetId) {
      await this.setAttention(runtime.accountId, conversationId, 'pending')
      return { transferred: false, reason: 'requested-target-not-in-official-list' }
    }
    const transferred = await runtime.transport.invoke('handoff.transfer', {
      conversationId,
      targetId,
      targetName,
      reason: transfer.reason,
    })
    if (!transferred.ok) {
      await this.setAttention(runtime.accountId, conversationId, 'pending')
      return { transferred: false, reason: transferred.error.message, target: { id: targetId, name: targetName } }
    }
    return { transferred: true, target: { id: targetId, name: targetName }, reason: transfer.reason }
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
  private readonly endpoint: string
  private readonly endpointError?: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly waitBeforeRetry: (ms: number) => Promise<void>

  constructor(options: { endpoint?: string; fetcher?: typeof fetch; timeoutMs?: number; waitBeforeRetry?: (ms: number) => Promise<void> } = {}) {
    const configuredEndpoint = options.endpoint || process.env.PLATFORM_HUB_REPLY_API_URL || DEFAULT_REPLY_API_URL
    try { this.endpoint = normalizeReplyEndpoint(configuredEndpoint) } catch (error) {
      this.endpoint = configuredEndpoint
      this.endpointError = errorMessage(error)
    }
    this.fetcher = options.fetcher || fetch
    this.timeoutMs = positiveInteger(options.timeoutMs) || positiveInteger(Number(process.env.PLATFORM_HUB_REPLY_API_TIMEOUT_MS)) || 15_000
    this.waitBeforeRetry = options.waitBeforeRetry || wait
  }

  async reply(input: Parameters<ShopReplyApi['reply']>[0]): Promise<ReplyDecision> {
    if (this.endpointError) throw new ReplyApiError('INVALID_ENDPOINT', `Reply API 地址无效: ${this.endpointError}`)
    const message = asRecord(input.message)
    const messageType = scalarString(message.type) || scalarString(message.message_type) || 'unknown'
    const body = {
      platform_data: {
        platform_en: input.platform,
        shop_id: input.shopId,
        shop_name: input.shopName,
        customer_name: input.customerName,
        customer_id: input.customerId,
        messages: [{
          user_id: input.customerId,
          name: input.customerName,
          content: input.content,
          message_type: messageType,
          type: messageType,
          from: { id: input.customerId, name: input.customerName },
        }],
        extra_context: {
          account_id: input.accountId,
          conversation_id: input.conversationId,
          message_id: scalarString(message.id),
        },
      },
    }
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250)
          continue
        }
        throw new ReplyApiError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? 'Reply API 请求超时' : `Reply API 网络失败: ${errorMessage(error)}`)
      }

      let responseText: string
      try { responseText = await response.text() } catch (error) {
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250)
          continue
        }
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new ReplyApiError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', `读取 Reply API 响应失败: ${errorMessage(error)}`)
      }

      if (response.status < 200 || response.status >= 300) {
        const detail = safeErrorDetail(responseText)
        const retryable = response.status === 429 || [500, 502, 503].includes(response.status)
        const delayMs = retryable ? retryDelay(response.headers.get('retry-after'), attempt) : undefined
        if (retryable && attempt < maxAttempts && delayMs !== undefined) {
          await this.waitBeforeRetry(delayMs)
          continue
        }
        throw new ReplyApiError(`HTTP_${response.status}`, detail || `Reply API HTTP ${response.status}`)
      }
      return parseReplyApiBody(responseText)
    }
    throw new ReplyApiError('NETWORK_ERROR', 'Reply API 请求失败')
  }
}

export const DEFAULT_REPLY_API_URL = 'http://192.168.5.3:18021/api/v1/chats/reply'

export class ReplyApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ReplyApiError' }
}

export function parseReplyApiBody(bodyText: string): ReplyDecision {
  if (!bodyText) throw new ReplyApiError('EMPTY_BODY', 'Reply API 返回空 body')
  let parsed: unknown
  try { parsed = JSON.parse(bodyText) } catch { throw new ReplyApiError('INVALID_JSON', 'Reply API 返回非法 JSON') }
  const root = asRecord(parsed)
  const data = asRecord(root.data)
  const turn = Object.keys(asRecord(data.turn)).length ? asRecord(data.turn) : undefined
  if (turn?.should_process === false) return { type: 'ignore', reason: 'turn-should-not-process', turn }

  const lifecycle = asRecord(data.lifecycle)
  const actionValue = asRecord(lifecycle.action)
  if (Object.keys(actionValue).length) {
    const messages = stringArray(actionValue.messages)
    const warnings = Array.isArray(actionValue.messages) && messages.length !== actionValue.messages.length
      ? ['lifecycle.action.messages 包含非字符串，已丢弃']
      : undefined
    return {
      type: 'reply',
      texts: [],
      lifecycleAction: {
        kind: scalarString(actionValue.kind) || 'unknown',
        actionId: scalarString(actionValue.action_id),
        messages,
        actionCode: finiteNumber(actionValue.action_code),
        payload: Object.keys(asRecord(actionValue.payload)).length ? asRecord(actionValue.payload) : undefined,
      },
      ...(turn ? { turn } : {}),
      ...(warnings ? { warnings } : {}),
    }
  }

  if (!Object.prototype.hasOwnProperty.call(data, 'ai_reply')) {
    return { type: 'ignore', reason: 'unrecognized-response', ...(turn ? { turn } : {}), warnings: ['响应缺少 data.ai_reply 与 lifecycle.action'] }
  }
  const ai = data.ai_reply
  if (ai === null) return { type: 'ignore', reason: 'no-ai-reply', ...(turn ? { turn } : {}) }
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return { type: 'ignore', reason: 'unrecognized-ai-reply', ...(turn ? { turn } : {}), warnings: ['data.ai_reply 类型错误，已忽略'] }
  const aiReply = asRecord(ai)
  const rawParts = aiReply.reply_parts
  const texts = stringArray(rawParts)
  const rawFiles = aiReply.file_urls
  const fileUrls = stringArray(rawFiles).filter(isHttpUrl)
  const transferRaw = asRecord(aiReply.transfer)
  const transfer = transferRaw.is_transfer === true ? {
    reason: scalarString(transferRaw.transfer_reason),
    source: scalarString(transferRaw.transfer_source),
    target: transferRaw.transfer_person,
    messages: stringArray(transferRaw.transfer_messages),
    sendGreetingBeforeHandoff: transferRaw.send_greeting_before_handoff === true,
    confidence: finiteNumber(transferRaw.confidence),
  } : undefined
  const warnings: string[] = []
  if (rawParts != null && !Array.isArray(rawParts)) warnings.push('ai_reply.reply_parts 类型错误，已丢弃')
  else if (Array.isArray(rawParts) && texts.length !== rawParts.length) warnings.push('ai_reply.reply_parts 含非字符串，已丢弃')
  if (rawFiles != null && !Array.isArray(rawFiles)) warnings.push('ai_reply.file_urls 类型错误，已丢弃')
  else if (Array.isArray(rawFiles) && fileUrls.length !== rawFiles.length) warnings.push('ai_reply.file_urls 含无效 URL，已丢弃')
  if (transferRaw.transfer_messages != null && !Array.isArray(transferRaw.transfer_messages)) warnings.push('transfer.transfer_messages 类型错误，已丢弃')
  if (!texts.length && !fileUrls.length && !transfer) return { type: 'ignore', reason: 'empty-ai-reply', ...(turn ? { turn } : {}), ...(warnings.length ? { warnings } : {}) }
  return {
    type: 'reply',
    texts,
    fileUrls,
    ...(transfer ? { transfer } : {}),
    ...(turn ? { turn } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

function transferTargetReference(value: unknown): { id?: string; name?: string } | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const target = String(value).trim()
    return target ? { id: target, name: target } : undefined
  }
  const item = asRecord(value)
  const id = scalarString(item.id || item.target_id || item.staff_id)
  const name = scalarString(item.name || item.target_name || item.staff_name)
  return id || name ? { id, name } : undefined
}

async function loadReplyFile(url: string): Promise<{ dataUrl: string; name: string; mimeType: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || isPrivateHostname(parsed.hostname)) throw new Error('Reply API 附件必须使用公网 HTTPS URL')
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok) throw new Error(`读取 Reply API 附件失败: HTTP ${response.status}`)
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream'
  if (!mimeType.startsWith('image/')) throw new Error(`当前 Douyin Hook 暂不支持此附件类型: ${mimeType}`)
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > 8 * 1024 * 1024) throw new Error('Reply API 附件超过 8 MB 限制')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Reply API 附件超过 8 MB 限制')
  const base64 = Buffer.from(bytes).toString('base64')
  const leaf = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) || 'reply-attachment').slice(0, 180)
  return { dataUrl: `data:${mimeType};base64,${base64}`, name: leaf, mimeType }
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return true
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
}

function normalizeReplyEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 HTTP / HTTPS')
  if (url.pathname === '/' || !url.pathname) url.pathname = '/api/v1/chats/reply'
  return url.toString()
}

function safeErrorDetail(bodyText: string): string | undefined {
  try {
    const value = asRecord(JSON.parse(bodyText))
    return scalarString(value.detail) || scalarString(value.message)
  } catch { return bodyText.trim().slice(0, 400) || undefined }
}

function retryDelay(retryAfter: string | null, attempt: number): number | undefined {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) {
      const delayMs = Math.max(0, seconds * 1_000)
      return delayMs <= 30_000 ? delayMs : undefined
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      const delayMs = Math.max(0, date - Date.now())
      return delayMs <= 30_000 ? delayMs : undefined
    }
  }
  return Math.min(2_000, 250 * (2 ** (attempt - 1)))
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
function positiveInteger(value: number | undefined): number | undefined { return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function scalarString(value: unknown): string | undefined { return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined }
function finiteNumber(value: unknown): number | undefined { const number = Number(value); return value !== undefined && Number.isFinite(number) ? number : undefined }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [] }
function isHttpUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
