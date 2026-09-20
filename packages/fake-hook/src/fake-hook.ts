import { HookHost, HookSession, type HookPageAdapter, type HookPageContext, type HookPageFactory } from '@platform-hub/hook-host'
import {
  fail,
  hookError,
  ok,
  OutboundCorrelationTracker,
  type HookEvent,
  type HookHandoffTarget,
  type HookHandoffTransferInput,
  type HookHandoffTransferResult,
  type HookMessage,
  type HookMessageType,
  type HookOperation,
  type HookOrder,
  type HookProduct,
  type HookResult,
  type HookRuntimeDescription,
  type PageHookRuntime,
} from '@platform-hub/hook-sdk'
import { fakeHookManifest } from './manifest.js'

interface FakeShopState {
  authenticated: boolean
  messages: HookMessage[]
  products: HookProduct[]
  orders: Map<string, HookOrder>
  pageEvents: Map<string, HookEvent[]>
  pageListeners: Map<string, Set<(event: HookEvent) => void>>
  challengeOperations: Set<string>
  challengeWaiters: Set<() => void>
  failNextOperations: Set<string>
  operationDelays: Map<string, number>
  ordersListening: boolean
  outbound: OutboundCorrelationTracker
  handoffTargets: HookHandoffTarget[]
  handoffs: HookHandoffTransferResult[]
  failStart: boolean
  failStop: boolean
}

export interface FakeHookPageFactoryOptions {
  pushEvents?: boolean
  drainDelayMs?: number
}

const defaultProducts = (): HookProduct[] => [{
  id: 'product-1',
  externalId: 'external-product-1',
  title: 'Fake 商品',
  description: 'FakeHook contract product',
  status: 'on_sale',
  price: { amount: 19.9, currency: 'CNY' },
  stockQuantity: 8,
  images: ['fake://product-1.png'],
  skus: [{ id: 'sku-1', externalId: 'external-sku-1', name: '默认', price: { amount: 19.9, currency: 'CNY' }, stockQuantity: 8 }],
  url: 'fake://products/product-1',
}]

export class FakeHookPageFactory implements HookPageFactory {
  private readonly shops = new Map<string, FakeShopState>()
  readonly pages: FakeHookPageAdapter[] = []
  readonly pushEvents: boolean
  readonly drainDelayMs: number
  createCount = 0
  closeCount = 0
  installCount = 0
  drainCount = 0
  subscriptionCount = 0
  activeDrains = 0
  maxActiveDrains = 0

  constructor(options: FakeHookPageFactoryOptions = {}) {
    this.pushEvents = options.pushEvents ?? true
    this.drainDelayMs = Math.max(0, options.drainDelayMs ?? 0)
  }

  async create(context: HookPageContext): Promise<HookPageAdapter> {
    const page = new FakeHookPageAdapter(context, this.stateFor(context.shopId), this)
    this.pages.push(page)
    this.createCount += 1
    return page
  }

  setAuthenticated(shopId: string, authenticated: boolean): void {
    const state = this.stateFor(shopId)
    if (state.authenticated === authenticated) return
    state.authenticated = authenticated
    this.pushEvent(state, 'primary', { type: 'auth.changed', timestamp: Date.now(), payload: { auth: { authenticated, shopId } } })
  }

  emitIncomingMessage(shopId: string, message: Partial<HookMessage> = {}): HookMessage {
    const state = this.stateFor(shopId)
    const value: HookMessage = {
      id: message.id || `message-${state.messages.length + 1}`,
      conversationId: message.conversationId || 'conversation-1',
      senderId: message.senderId || 'buyer-1',
      senderName: message.senderName || 'Fake 买家',
      content: message.content || '你好',
      type: message.type || 'text',
      direction: 'inbound',
      origin: 'customer',
      deliveryStatus: 'sent',
      timestamp: message.timestamp || Date.now(),
      attachments: message.attachments,
      raw: message.raw,
    }
    this.appendMessage(state, value)
    return value
  }

  emitHumanOutgoingMessage(shopId: string, input: { conversationId?: string; content?: string; type?: HookMessageType } = {}): HookMessage {
    const state = this.stateFor(shopId)
    return this.emitPlatformOutgoing(state, {
      conversationId: input.conversationId || 'conversation-1',
      content: input.content || '人工回复',
      type: input.type || 'text',
    })
  }

  emitOrder(shopId: string, order: HookOrder): boolean {
    const state = this.stateFor(shopId)
    const previous = state.orders.get(order.id)
    const changedFields = previous ? orderChangedFields(previous, order) : []
    if (previous && changedFields.length === 0) return false
    state.orders.set(order.id, order)
    if (state.ordersListening) {
      this.pushEvent(state, 'orders', previous
        ? { type: 'order.updated', timestamp: Date.now(), payload: { order, previous, changedFields } }
        : { type: 'order.created', timestamp: Date.now(), payload: { order } })
    }
    return true
  }

  requireChallenge(shopId: string, pageId: string, operation: HookOperation): void {
    this.stateFor(shopId).challengeOperations.add(`${pageId}:${operation}`)
  }

  solveChallenge(shopId: string, pageId: string, operation: HookOperation): void {
    const state = this.stateFor(shopId)
    state.challengeOperations.delete(`${pageId}:${operation}`)
    for (const wake of [...state.challengeWaiters]) wake()
    state.challengeWaiters.clear()
  }

  failNext(shopId: string, pageId: string, operation: HookOperation): void {
    this.stateFor(shopId).failNextOperations.add(`${pageId}:${operation}`)
  }

  setOperationDelay(shopId: string, pageId: string, operation: HookOperation, delayMs: number): void {
    this.stateFor(shopId).operationDelays.set(`${pageId}:${operation}`, Math.max(0, delayMs))
  }

  failNextStart(shopId: string): void { this.stateFor(shopId).failStart = true }
  failNextStop(shopId: string): void { this.stateFor(shopId).failStop = true }

  stateFor(shopId: string): FakeShopState {
    let state = this.shops.get(shopId)
    if (!state) {
      state = {
        authenticated: true,
        messages: [],
        products: defaultProducts(),
        orders: new Map(),
        pageEvents: new Map(),
        pageListeners: new Map(),
        challengeOperations: new Set(),
        challengeWaiters: new Set(),
        failNextOperations: new Set(),
        operationDelays: new Map(),
        ordersListening: false,
        outbound: new OutboundCorrelationTracker(),
        handoffTargets: [{ id: 'agent-1', name: 'Fake 客服' }],
        handoffs: [],
        failStart: false,
        failStop: false,
      }
      this.shops.set(shopId, state)
    }
    return state
  }

  subscribe(state: FakeShopState, pageId: string, listener: (event: HookEvent) => void): () => void {
    const listeners = state.pageListeners.get(pageId) || new Set()
    listeners.add(listener)
    state.pageListeners.set(pageId, listeners)
    this.subscriptionCount += 1
    const queued = state.pageEvents.get(pageId) || []
    state.pageEvents.set(pageId, [])
    for (const event of queued) listener(event)
    return () => {
      if (listeners.delete(listener)) this.subscriptionCount -= 1
      if (listeners.size === 0) state.pageListeners.delete(pageId)
    }
  }

  pushEvent(state: FakeShopState, pageId: string, event: HookEvent): void {
    const listeners = state.pageListeners.get(pageId)
    if (listeners?.size) {
      for (const listener of listeners) listener(event)
      return
    }
    const events = state.pageEvents.get(pageId) || []
    events.push(event)
    state.pageEvents.set(pageId, events)
  }

  private appendMessage(state: FakeShopState, message: HookMessage): void {
    state.messages.push(message)
    this.pushEvent(state, 'primary', { type: 'message.created', timestamp: message.timestamp, payload: { message } })
  }

  private emitPlatformOutgoing(
    state: FakeShopState,
    input: { conversationId: string; content: string; type: HookMessageType; attachments?: HookMessage['attachments'] },
  ): HookMessage {
    const matched = state.outbound.match({
      conversationId: input.conversationId,
      messageType: input.type,
      fingerprint: outboundFingerprint(input.type, input.content),
    })
    const message: HookMessage = {
      id: `message-${state.messages.length + 1}`,
      conversationId: input.conversationId,
      senderId: 'seller',
      content: input.content,
      type: input.type,
      direction: 'outbound',
      origin: matched ? 'automation' : 'human',
      deliveryStatus: 'sent',
      timestamp: Date.now(),
      attachments: input.attachments,
    }
    this.appendMessage(state, message)
    return message
  }

  sendAutomation(
    state: FakeShopState,
    input: { conversationId: string; content: string; type: HookMessageType; attachments?: HookMessage['attachments'] },
  ): HookMessage {
    state.outbound.register({
      conversationId: input.conversationId,
      messageType: input.type,
      fingerprint: outboundFingerprint(input.type, input.content),
    })
    return this.emitPlatformOutgoing(state, input)
  }
}

export class FakeHook {
  readonly factory: FakeHookPageFactory
  readonly host: HookHost
  readonly session: HookSession

  constructor(
    readonly shopId = 'fake-shop-1',
    options: { sessionId?: string; maxWorkerConcurrency?: number; pushEvents?: boolean; challengeTimeoutMs?: number } = {},
  ) {
    this.factory = new FakeHookPageFactory({ pushEvents: options.pushEvents })
    this.host = new HookHost({ pageFactory: this.factory, maxWorkerConcurrency: options.maxWorkerConcurrency ?? 2 })
    this.session = this.host.createSession(fakeHookManifest, {
      sessionId: options.sessionId || `fake-session-${shopId}`,
      shopId,
      maxWorkers: 2,
      workerIdleTtlMs: 40,
      challengeTimeoutMs: options.challengeTimeoutMs,
    })
  }

  async start(): Promise<void> { await this.session.start() }
  async stop(): Promise<void> { await this.host.dispose() }
  login(): void { this.factory.setAuthenticated(this.shopId, true) }
  logout(): void { this.factory.setAuthenticated(this.shopId, false) }
  receiveMessage(message?: Partial<HookMessage>): HookMessage { return this.factory.emitIncomingMessage(this.shopId, message) }
  sendHumanMessage(input?: { conversationId?: string; content?: string; type?: HookMessageType }): HookMessage { return this.factory.emitHumanOutgoingMessage(this.shopId, input) }
  createOrder(order: HookOrder): boolean { return this.factory.emitOrder(this.shopId, order) }
  updateOrder(order: HookOrder): boolean { return this.factory.emitOrder(this.shopId, order) }
  requireChallenge(operation: HookOperation, pageId = pageForOperation(operation)): void { this.factory.requireChallenge(this.shopId, pageId, operation) }
  completeChallenge(operation: HookOperation, pageId = pageForOperation(operation)): void { this.factory.solveChallenge(this.shopId, pageId, operation) }
  failNext(operation: HookOperation, pageId = pageForOperation(operation)): void { this.factory.failNext(this.shopId, pageId, operation) }
  setOperationDelay(operation: HookOperation, delayMs: number, pageId = pageForOperation(operation)): void { this.factory.setOperationDelay(this.shopId, pageId, operation, delayMs) }
  failNextStart(): void { this.factory.failNextStart(this.shopId) }
  failNextStop(): void { this.factory.failNextStop(this.shopId) }
  workerPageCount(): number { return this.session.workerPages.size }
  workerPageIds(): string[] { return this.session.workerPages.ids }
}

export class FakeHookPageAdapter implements HookPageAdapter {
  readonly id: string
  readonly partition: string
  readonly definition: HookPageContext['definition']
  readonly subscribeEvents?: (listener: (event: HookEvent) => void) => () => void
  visible = false
  private alive = true

  constructor(
    private readonly context: HookPageContext,
    private readonly state: FakeShopState,
    private readonly owner: FakeHookPageFactory,
  ) {
    this.id = context.definition.id
    this.partition = context.partition
    this.definition = context.definition
    if (owner.pushEvents) this.subscribeEvents = (listener) => owner.subscribe(state, this.id, listener)
  }

  async installRuntime(): Promise<PageHookRuntime> {
    if (!this.alive) throw new Error('Fake page 已关闭')
    if (this.definition.kind === 'primary' && this.state.failStart) {
      this.state.failStart = false
      throw new Error('Fake start failure')
    }
    this.owner.installCount += 1
    return new FakePageRuntime(this.context, this.state, this.owner)
  }

  async show(): Promise<void> { this.visible = true }

  async waitForRuntimeReady(signal?: AbortSignal): Promise<void> {
    if (![...this.state.challengeOperations].some((key) => key.startsWith(`${this.id}:`))) return
    await new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(new Error('Challenge Recovery 已取消')) }
      const cleanup = () => {
        this.state.challengeWaiters.delete(done)
        signal?.removeEventListener('abort', abort)
      }
      this.state.challengeWaiters.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async close(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.owner.closeCount += 1
  }

  isAlive(): boolean { return this.alive }
}

class FakePageRuntime implements PageHookRuntime {
  readonly protocolVersion = 1
  private disposed = false

  constructor(
    private readonly context: HookPageContext,
    private readonly state: FakeShopState,
    private readonly owner: FakeHookPageFactory,
  ) {}

  describe(): HookRuntimeDescription {
    const operations = Object.entries(this.context.manifest.operations)
      .filter(([, route]) => route?.page === this.context.definition.id)
      .map(([operation]) => operation as HookOperation)
    return {
      protocolVersion: this.protocolVersion,
      platform: this.context.manifest.platform,
      pageId: this.context.definition.id,
      capabilities: operations,
      operations,
    }
  }

  async invoke(operation: string, input: unknown): Promise<HookResult<unknown>> {
    if (this.disposed) return fail(hookError('RUNTIME_NOT_READY', 'Fake runtime 已销毁'))
    const key = `${this.context.definition.id}:${operation}`
    const delayMs = this.state.operationDelays.get(key) || 0
    if (delayMs > 0) await delay(delayMs)
    if (this.state.failNextOperations.delete(key)) throw new Error(`Fake runtime failure: ${operation}`)
    if (this.state.challengeOperations.has(key)) return fail(hookError('CHALLENGE_REQUIRED', '需要用户完成官方验证', { pageId: this.context.definition.id }, true))
    if (!this.state.authenticated && operation !== 'auth.state') return fail(hookError('LOGIN_REQUIRED', '请先登录'))
    switch (operation as HookOperation) {
      case 'auth.state': return ok({ authenticated: this.state.authenticated, shopId: this.context.shopId })
      case 'sessions.list': return ok([{ id: 'conversation-1', title: 'Fake 会话', unreadCount: this.state.messages.filter((message) => message.origin === 'customer').length }])
      case 'messages.listen': return ok({ listening: true, watermark: this.state.messages.at(-1)?.timestamp || 0 })
      case 'messages.history': return ok(this.state.messages.filter((message) => message.conversationId === String((input as { conversationId?: string })?.conversationId || 'conversation-1')))
      case 'messages.send.text': return this.sendText(input)
      case 'messages.send.file': return this.sendFile(input)
      case 'products.list': return ok(this.state.products)
      case 'products.detail': return this.productDetail(input)
      case 'orders.list': return ok([...this.state.orders.values()])
      case 'orders.listen': {
        this.state.pageEvents.set('orders', [])
        this.state.ordersListening = true
        return ok({ listening: true, watermark: Math.max(0, ...[...this.state.orders.values()].map((order) => order.updatedAt || order.createdAt || 0)) })
      }
      case 'handoff.targets.list': return ok(this.state.handoffTargets)
      case 'handoff.transfer': return this.transfer(input)
      default: return fail(hookError('NOT_SUPPORTED', `FakeHook 不支持 ${operation}`))
    }
  }

  async drainEvents(): Promise<HookEvent[]> {
    this.owner.drainCount += 1
    this.owner.activeDrains += 1
    this.owner.maxActiveDrains = Math.max(this.owner.maxActiveDrains, this.owner.activeDrains)
    try {
      if (this.owner.drainDelayMs > 0) await delay(this.owner.drainDelayMs)
      else await Promise.resolve()
      if (this.disposed) return []
      const events = this.state.pageEvents.get(this.context.definition.id) || []
      this.state.pageEvents.set(this.context.definition.id, [])
      return events
    } finally {
      this.owner.activeDrains -= 1
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.state.outbound.clear()
    if (this.state.failStop) {
      this.state.failStop = false
      throw new Error('Fake stop failure')
    }
  }

  private sendText(input: unknown): HookResult<HookMessage> {
    const value = input as { conversationId?: string; text?: string; simulateFailure?: boolean }
    if (!value?.conversationId || !value.text) return fail(hookError('INVALID_INPUT', 'conversationId 和 text 必填'))
    if (value.simulateFailure) {
      const tracked = this.state.outbound.register({
        conversationId: value.conversationId,
        messageType: 'text',
        fingerprint: outboundFingerprint('text', value.text),
      })
      this.state.outbound.remove(tracked.operationId)
      return fail(hookError('PLATFORM_ERROR', 'Fake outbound failure', undefined, true))
    }
    return ok(this.owner.sendAutomation(this.state, {
      conversationId: value.conversationId,
      content: value.text,
      type: 'text',
    }))
  }

  private sendFile(input: unknown): HookResult<HookMessage> {
    const value = input as { conversationId?: string; url?: string; name?: string; simulateFailure?: boolean }
    if (!value?.conversationId || !value.url) return fail(hookError('INVALID_INPUT', 'conversationId 和 url 必填'))
    const content = value.name || value.url
    if (value.simulateFailure) {
      const tracked = this.state.outbound.register({
        conversationId: value.conversationId,
        messageType: 'file',
        fingerprint: outboundFingerprint('file', content),
      })
      this.state.outbound.remove(tracked.operationId)
      return fail(hookError('PLATFORM_ERROR', 'Fake outbound failure', undefined, true))
    }
    return ok(this.owner.sendAutomation(this.state, {
      conversationId: value.conversationId,
      content,
      type: 'file',
      attachments: [{ url: value.url, name: value.name }],
    }))
  }

  private productDetail(input: unknown): HookResult<HookProduct> {
    const id = String((input as { id?: string })?.id || '')
    const product = this.state.products.find((item) => item.id === id)
    return product ? ok(product) : fail(hookError('INVALID_INPUT', `商品不存在: ${id}`))
  }

  private transfer(input: unknown): HookResult<HookHandoffTransferResult> {
    const value = input as HookHandoffTransferInput
    if (!value?.conversationId) return fail(hookError('INVALID_INPUT', 'conversationId 必填'))
    const target = value.targetId
      ? this.state.handoffTargets.find((item) => item.id === value.targetId)
      : value.targetName
        ? this.state.handoffTargets.find((item) => item.name === value.targetName)
        : this.state.handoffTargets[0]
    const result: HookHandoffTransferResult = { transferred: true, ...(target ? { target } : {}) }
    this.state.handoffs.push(result)
    return ok(result)
  }
}

function outboundFingerprint(type: HookMessageType, content: string): string {
  return `${type}:${content.trim()}`
}

function pageForOperation(operation: HookOperation): string {
  if (operation.startsWith('products.')) return 'products'
  if (operation.startsWith('orders.')) return 'orders'
  return 'primary'
}

function orderChangedFields(previous: HookOrder, next: HookOrder): string[] {
  const fields: Array<keyof HookOrder> = [
    'externalId', 'shopId', 'conversationId', 'buyer', 'status', 'items', 'total', 'receiver', 'createdAt',
  ]
  return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
