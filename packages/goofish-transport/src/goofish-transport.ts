import {
  OutboundCorrelationTracker,
  fail,
  hookError,
  ok,
  type HookAuthState,
  type HookEvent,
  type HookMessage,
  type HookOperation,
  type HookProduct,
  type HookResult,
  type HookSessionSummary,
} from '@platform-hub/hook-sdk'
import {
  array,
  asRow,
  normalizeGoofishAuth,
  normalizeGoofishMessage,
  normalizeGoofishProduct,
  normalizeGoofishSession,
  text,
  timestamp,
} from './normalize.js'

export const GOOFISH_OPERATIONS: HookOperation[] = [
  'auth.state',
  'sessions.list',
  'messages.listen',
  'messages.history',
  'messages.send.text',
  'messages.send.file',
  'products.list',
  'products.detail',
]

export interface GoofishMessagingClientLike {
  listAccounts(): unknown[]
  snapshot(accountId: string): Promise<unknown>
  listSessions(accountId: string): Promise<unknown>
  listMessages(accountId: string, sessionId: string, options?: Record<string, unknown>): Promise<unknown>
  sendText(accountId: string, sessionId: string, text: string, options?: Record<string, unknown>): Promise<unknown>
  sendImage(accountId: string, sessionId: string, image: Record<string, unknown>): Promise<unknown>
  listOnSaleProducts(accountId: string, options?: Record<string, unknown>): Promise<unknown>
  on(event: 'event', listener: (event: GoofishClientEvent) => void): unknown
  off?(event: 'event', listener: (event: GoofishClientEvent) => void): unknown
  removeListener?(event: 'event', listener: (event: GoofishClientEvent) => void): unknown
}

export interface GoofishClientEvent {
  accountId: string
  eventType: string
  payload?: unknown
}

export interface GoofishTransportOptions {
  /** Stable Platform Hub account identity; never changes during migration. */
  accountId: string
  /** Legacy client key. It is re-keyed in place when Goofish discovers shop_id. */
  clientAccountId: string
  client: GoofishMessagingClientLike
  now?: () => number
}

/**
 * Adapts the mature Electron Goofish client to the shared Hook Transport
 * contract. It owns no BrowserWindow, WebContents or Electron partition.
 */
export class GoofishTransport {
  readonly accountId: string
  private clientAccountId: string
  private readonly client: GoofishMessagingClientLike
  private readonly now: () => number
  private readonly outbound = new OutboundCorrelationTracker()
  private readonly listeners = new Set<(event: HookEvent) => void>()
  private readonly seenMessages = new Map<string, number>()
  private clientListener?: (event: GoofishClientEvent) => void
  private listening = false
  private started = false
  private stopped = false
  private listenWatermark?: number
  private selfId = ''
  private shopId = ''

  constructor(options: GoofishTransportOptions) {
    this.accountId = options.accountId
    this.clientAccountId = options.clientAccountId
    this.client = options.client
    this.now = options.now ?? Date.now
  }

  get underlyingAccountId(): string { return this.clientAccountId }
  get capabilities(): readonly HookOperation[] { return GOOFISH_OPERATIONS }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('GoofishTransport 已停止')
    if (this.started) return
    this.clientListener = (event) => this.onClientEvent(event)
    this.client.on('event', this.clientListener)
    this.started = true
  }

  subscribe(listener: (event: HookEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async invoke<T = unknown>(operation: HookOperation | string, input: unknown = {}): Promise<HookResult<T>> {
    if (this.stopped || !this.started) return fail(hookError('RUNTIME_NOT_READY', 'GoofishTransport 尚未启动或已停止', undefined, true))
    if (!GOOFISH_OPERATIONS.includes(operation as HookOperation)) return fail(hookError('NOT_SUPPORTED', `闲鱼不支持 ${operation}`))
    const args = asRow(input)
    try {
      const result = await this.invokeOperation(operation as HookOperation, args)
      return result as HookResult<T>
    } catch (error) {
      return fail(mapError(error))
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.listening = false
    this.started = false
    if (this.clientListener) {
      if (this.client.off) this.client.off('event', this.clientListener)
      else this.client.removeListener?.('event', this.clientListener)
    }
    this.clientListener = undefined
    this.listeners.clear()
    this.seenMessages.clear()
    this.outbound.clear()
  }

  private async invokeOperation(operation: HookOperation, input: Record<string, unknown>): Promise<HookResult<unknown>> {
    if (operation === 'auth.state') return ok(await this.readAuth())
    if (operation === 'messages.listen') {
      const auth = await this.readAuth()
      if (!auth.authenticated) return fail(hookError('LOGIN_REQUIRED', '请在闲鱼官方页面完成登录'))
      this.listening = true
      this.listenWatermark = this.now()
      return ok({ listening: true, watermark: this.listenWatermark })
    }
    if (operation === 'sessions.list') {
      const rows = array(await this.client.listSessions(this.clientAccountId))
      return ok(rows.map(normalizeGoofishSession).filter((item): item is HookSessionSummary => Boolean(item)))
    }
    if (operation === 'messages.history') {
      const conversationId = text(input.conversationId)
      if (!conversationId) return fail(hookError('INVALID_INPUT', 'conversationId 必填'))
      const rows = array(await this.client.listMessages(this.clientAccountId, conversationId))
      const messages = rows.map((row) => normalizeGoofishMessage(row, { conversationId, selfId: this.selfId }))
        .filter((message): message is HookMessage => Boolean(message))
      return ok(messages)
    }
    if (operation === 'messages.send.text') return this.sendText(input)
    if (operation === 'messages.send.file') return this.sendImage(input)
    if (operation === 'products.list' || operation === 'products.detail') {
      const rows = array(await this.client.listOnSaleProducts(this.clientAccountId))
      const byId = new Map<string, HookProduct>()
      for (const row of rows) {
        const product = normalizeGoofishProduct(row, this.shopId)
        if (product?.status === 'on_sale') byId.set(product.externalId, product)
      }
      const products = [...byId.values()]
      if (operation === 'products.list') return ok(products)
      const id = text(input.id ?? input.externalId)
      if (!id) return fail(hookError('INVALID_INPUT', '商品 id 必填'))
      const product = products.find((item) => item.externalId === id || item.id === id)
      return product ? ok(product) : fail(hookError('INVALID_INPUT', `未找到当前在售商品: ${id}`))
    }
    return fail(hookError('NOT_SUPPORTED', `闲鱼不支持 ${operation}`))
  }

  private async readAuth(): Promise<HookAuthState> {
    const snapshot = await this.client.snapshot(this.clientAccountId)
    const metadata = this.client.listAccounts().find((account) => String(asRow(account).id) === this.clientAccountId)
    const auth = normalizeGoofishAuth(snapshot, metadata, this.now())
    this.selfId = auth.userId || ''
    this.shopId = auth.shopId || ''
    const actualId = text(asRow(snapshot).accountId)
    if (actualId && actualId !== this.clientAccountId) this.clientAccountId = actualId
    return auth
  }

  private async sendText(input: Record<string, unknown>): Promise<HookResult<HookMessage>> {
    const conversationId = text(input.conversationId)
    const content = text(input.text ?? input.content)
    if (!conversationId || !content) return fail(hookError('INVALID_INPUT', 'conversationId 和 text 必填'))
    const correlation = this.outbound.register({
      conversationId: normalizeConversationId(conversationId),
      messageType: 'text',
      fingerprint: fingerprint('text', content),
      createdAt: this.now(),
    })
    try {
      const response = await this.client.sendText(this.clientAccountId, conversationId, content)
      const raw = asRow(response)
      const message = asRow(raw.message ?? response)
      const id = text(message.serverId ?? message.messageId ?? message.msgId ?? message.id)
      const result: HookMessage = {
        id: id || `goofish-hook-${correlation.operationId}`,
        conversationId: normalizeConversationId(conversationId),
        ...(this.selfId ? { senderId: this.selfId } : {}),
        content,
        type: 'text',
        direction: 'outbound',
        origin: 'automation',
        deliveryStatus: 'sent',
        timestamp: this.now(),
        raw: { source: 'goofish-messaging', operationId: correlation.operationId },
      }
      return ok(result)
    } catch (error) {
      this.outbound.remove(correlation.operationId)
      throw error
    }
  }

  private async sendImage(input: Record<string, unknown>): Promise<HookResult<HookMessage>> {
    const conversationId = text(input.conversationId)
    if (!conversationId) return fail(hookError('INVALID_INPUT', 'conversationId 必填'))
    const mimeType = text(input.mimeType ?? input.mime) || 'application/octet-stream'
    if (!mimeType.toLowerCase().startsWith('image/')) return fail(hookError('NOT_SUPPORTED', '闲鱼 Hook 当前只支持图片发送'))
    const source = text(input.dataUrl ?? input.data ?? input.url)
    if (!source) return fail(hookError('INVALID_INPUT', '图片 data 必填'))
    const match = source.match(/^data:([^;,]+)?;base64,(.*)$/s)
    const data = match ? match[2] : source
    const name = text(input.name ?? input.fileName) || 'image'
    const sentAt = this.now()
    const response = await this.client.sendImage(this.clientAccountId, conversationId, { data, name, mime: mimeType })
    const row = asRow(response)
    const image = asRow(row.image)
    const message: HookMessage = {
      id: text(row.serverId ?? row.messageId ?? row.id) || `goofish-image-${sentAt}`,
      conversationId: normalizeConversationId(conversationId),
      ...(this.selfId ? { senderId: this.selfId } : {}),
      content: name,
      type: 'image',
      direction: 'outbound',
      origin: 'automation',
      deliveryStatus: 'sent',
      timestamp: sentAt,
      attachments: [{ ...(text(image.url) ? { url: text(image.url) } : {}), name, mimeType }],
      raw: { source: 'goofish-messaging' },
    }
    return ok(message)
  }

  private onClientEvent(event: GoofishClientEvent): void {
    if (this.stopped) return
    const payload = asRow(event.payload)
    if (event.eventType === 'account-migrated') {
      const previousId = text(payload.previousAccountId)
      const nextId = text(payload.accountId ?? event.accountId)
      if (previousId === this.clientAccountId && nextId) this.clientAccountId = nextId
      const account = asRow(payload.account)
      if (this.clientAccountId === nextId) this.emitAuthChanged(normalizeGoofishAuth({
        authenticated: account.status === 'authenticated',
        userId: account.userId ?? nextId,
        accountId: nextId,
      }, account, this.now()))
      return
    }
    if (event.accountId !== this.clientAccountId) return
    if (event.eventType === 'official-login-page') {
      this.selfId = ''
      this.shopId = ''
      this.emitAuthChanged({ authenticated: false, checkedAt: this.now() })
      return
    }
    if (event.eventType === 'bridge-ready' || event.eventType === 'account-updated') {
      const account = asRow(payload)
      const auth = normalizeGoofishAuth({
        authenticated: event.eventType === 'bridge-ready' || account.status === 'authenticated',
        userId: account.userId,
        accountId: account.id,
      }, account, this.now())
      this.selfId = auth.userId || this.selfId
      this.shopId = auth.shopId || this.shopId
      this.emitAuthChanged(auth)
      return
    }
    if (event.eventType === 'message-added') {
      if (!this.listening) return
      const receivedAt = this.now()
      const preliminary = normalizeGoofishMessage(event.payload, { selfId: this.selfId, receivedAt })
      if (!preliminary) return
      if (this.listenWatermark !== undefined && preliminary.timestamp < this.listenWatermark) return
      const key = preliminary.id
      if (this.seenMessages.has(key)) return
      this.seenMessages.set(key, receivedAt)
      this.pruneSeenMessages(receivedAt)
      const receivedTime = preliminary.timestamp || receivedAt
      const match = preliminary.direction === 'outbound' && preliminary.origin !== 'human'
        ? this.outbound.match({
          conversationId: preliminary.conversationId,
          messageType: preliminary.type,
          fingerprint: fingerprint(preliminary.type, preliminary.content),
          receivedAt: Math.max(receivedAt, receivedTime),
        })
        : undefined
      const message = normalizeGoofishMessage(event.payload, {
        selfId: this.selfId,
        receivedAt,
        sentByHook: Boolean(match),
      })
      if (message) this.emit({ type: 'message.created', payload: { message }, timestamp: receivedAt, id: `${this.accountId}:${message.id}` })
      return
    }
    if (['connection-error', 'connection-closed', 'bridge-error', 'load-error'].includes(event.eventType)) {
      this.emit({ type: 'runtime.error', payload: { message: text(payload.message ?? payload.description) || `闲鱼 Runtime: ${event.eventType}`, error: { eventType: event.eventType } }, timestamp: this.now() })
    }
  }

  private emitAuthChanged(auth: HookAuthState): void {
    this.emit({ type: 'auth.changed', payload: { auth }, timestamp: auth.checkedAt ?? this.now() })
  }

  private emit(event: HookEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* isolate transport subscribers */ }
    }
  }

  private pruneSeenMessages(now: number): void {
    for (const [id, seenAt] of this.seenMessages) {
      if (now - seenAt > 30 * 60_000) this.seenMessages.delete(id)
    }
    while (this.seenMessages.size > 10_000) {
      const oldest = this.seenMessages.keys().next().value as string | undefined
      if (!oldest) break
      this.seenMessages.delete(oldest)
    }
  }
}

function mapError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const source = `${(error as { code?: unknown })?.code || ''} ${message}`
  if (/LOGIN_REQUIRED|login required|尚未登录|尚未登录|完成登录|登录已?过期|unauth|未登录/i.test(source)) return hookError('LOGIN_REQUIRED', message, undefined, true)
  if (/CHALLENGE|captcha|验证码|滑块|安全验证|risk control|风控/i.test(source)) return hookError('CHALLENGE_REQUIRED', message, undefined, true)
  if (/RATE_LIMITED|频繁|限流|too many requests/i.test(source)) return hookError('RATE_LIMITED', message, undefined, true)
  if (/timeout|超时/i.test(source)) return hookError('TIMEOUT', message, undefined, true)
  if (/NOT_SUPPORTED|不支持|未暴露.*接口/i.test(source)) return hookError('NOT_SUPPORTED', message)
  if (/INVALID_INPUT|缺少.*ID|不能为空|必填/i.test(source)) return hookError('INVALID_INPUT', message)
  if (/RUNTIME_NOT_READY|正在初始化|页面.*关闭|页面.*加载/i.test(source)) return hookError('RUNTIME_NOT_READY', message, undefined, true)
  return hookError('PLATFORM_ERROR', message, undefined, true)
}

function fingerprint(type: string, content: string): string { return `${type}:${content.trim()}` }
function normalizeConversationId(value: string): string { return value.trim().replace(/@goofish$/i, '') }
