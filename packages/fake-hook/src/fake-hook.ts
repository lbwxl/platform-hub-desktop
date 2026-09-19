import { HookHost, HookSession, type HookPageAdapter, type HookPageContext, type HookPageFactory } from '@platform-hub/hook-host'
import {
  fail,
  hookError,
  ok,
  type HookEvent,
  type HookMessage,
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
  orderFingerprints: Map<string, string>
  pageEvents: Map<string, HookEvent[]>
  challengeOperations: Set<string>
  challengeWaiters: Set<() => void>
  failNextOperations: Set<string>
  ordersListening: boolean
}

const defaultProducts = (): HookProduct[] => [
  { id: 'product-1', name: 'Fake 商品', price: 19.9, status: 'on_sale', stockQuantity: 8, images: ['fake://product-1.png'], skus: [{ id: 'sku-1', name: '默认', price: 19.9, stockQuantity: 8 }] },
]

export class FakeHookPageFactory implements HookPageFactory {
  private readonly shops = new Map<string, FakeShopState>()
  readonly pages: FakeHookPageAdapter[] = []
  createCount = 0
  closeCount = 0
  installCount = 0

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

  emitIncomingMessage(shopId: string, message?: Partial<HookMessage>): HookMessage {
    const state = this.stateFor(shopId)
    const value: HookMessage = {
      id: message?.id || `message-${state.messages.length + 1}`,
      sessionId: message?.sessionId || 'session-1',
      senderId: message?.senderId || 'buyer-1',
      senderName: message?.senderName || 'Fake 买家',
      content: message?.content || '你好',
      type: message?.type || 'text',
      direction: 'inbound',
      isMine: false,
      timestamp: message?.timestamp || Date.now(),
    }
    state.messages.push(value)
    this.pushEvent(state, 'primary', { type: 'message.created', timestamp: value.timestamp, payload: { message: value } })
    return value
  }

  emitOrder(shopId: string, order: HookOrder): boolean {
    const state = this.stateFor(shopId)
    const fingerprint = JSON.stringify(order)
    if (state.orderFingerprints.get(order.id) === fingerprint) return false
    const previous = state.orders.get(order.id)
    state.orders.set(order.id, order)
    state.orderFingerprints.set(order.id, fingerprint)
    if (state.ordersListening) {
      this.pushEvent(state, 'orders', previous
        ? { type: 'order.updated', timestamp: Date.now(), payload: { order, previous } }
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

  stateFor(shopId: string): FakeShopState {
    let state = this.shops.get(shopId)
    if (!state) {
      state = {
        authenticated: true,
        messages: [],
        products: defaultProducts(),
        orders: new Map(),
        orderFingerprints: new Map(),
        pageEvents: new Map(),
        challengeOperations: new Set(),
        challengeWaiters: new Set(),
        failNextOperations: new Set(),
        ordersListening: false,
      }
      this.shops.set(shopId, state)
    }
    return state
  }

  private pushEvent(state: FakeShopState, pageId: string, event: HookEvent): void {
    const events = state.pageEvents.get(pageId) || []
    events.push(event)
    state.pageEvents.set(pageId, events)
  }
}

export class FakeHook {
  readonly factory: FakeHookPageFactory
  readonly host: HookHost
  readonly session: HookSession

  constructor(readonly shopId = 'fake-shop-1', options?: { sessionId?: string; maxWorkerConcurrency?: number }) {
    this.factory = new FakeHookPageFactory()
    this.host = new HookHost({ pageFactory: this.factory, maxWorkerConcurrency: options?.maxWorkerConcurrency ?? 2 })
    this.session = this.host.createSession(fakeManifestForSession(), {
      sessionId: options?.sessionId || `fake-session-${shopId}`,
      shopId,
      maxWorkers: 2,
      workerIdleTtlMs: 40,
    })
  }

  async start(): Promise<void> { await this.session.start() }
  async stop(): Promise<void> { await this.session.dispose(); this.host.stop() }
  login(): void { this.factory.setAuthenticated(this.shopId, true) }
  logout(): void { this.factory.setAuthenticated(this.shopId, false) }
  receiveMessage(message?: Partial<HookMessage>): HookMessage { return this.factory.emitIncomingMessage(this.shopId, message) }
  createOrder(order: HookOrder): boolean { return this.factory.emitOrder(this.shopId, order) }
  updateOrder(order: HookOrder): boolean { return this.factory.emitOrder(this.shopId, order) }
  requireChallenge(operation: HookOperation, pageId = operation.startsWith('products.') ? 'products' : 'orders'): void { this.factory.requireChallenge(this.shopId, pageId, operation) }
  completeChallenge(operation: HookOperation, pageId = operation.startsWith('products.') ? 'products' : 'orders'): void { this.factory.solveChallenge(this.shopId, pageId, operation) }
  failNext(operation: HookOperation, pageId = operation.startsWith('products.') ? 'products' : 'orders'): void { this.factory.failNext(this.shopId, pageId, operation) }
  workerPageCount(): number { return this.session.workerPages.size }
  workerPageIds(): string[] { return this.session.workerPages.ids }
}

function fakeManifestForSession() {
  return fakeHookManifest
}

class FakeHookPageAdapter implements HookPageAdapter {
  readonly id: string
  readonly partition: string
  readonly definition: HookPageContext['definition']
  visible = false
  private alive = true
  private runtime?: FakePageRuntime

  constructor(
    private readonly context: HookPageContext,
    private readonly state: FakeShopState,
    private readonly owner: FakeHookPageFactory,
  ) {
    this.id = context.definition.id
    this.partition = context.partition
    this.definition = context.definition
  }

  async installRuntime(): Promise<PageHookRuntime> {
    if (!this.alive) throw new Error('Fake page 已关闭')
    this.runtime = new FakePageRuntime(this.context, this.state)
    this.owner.installCount += 1
    return this.runtime
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

  constructor(private readonly context: HookPageContext, private readonly state: FakeShopState) {}

  describe(): HookRuntimeDescription {
    const operations = Object.entries(this.context.manifest.operations)
      .filter(([, route]) => route.page === this.context.definition.id)
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
    if (this.state.failNextOperations.delete(key)) throw new Error(`Fake runtime failure: ${operation}`)
    if (this.state.challengeOperations.has(key)) return fail(hookError('CHALLENGE_REQUIRED', '需要用户完成官方验证', { pageId: this.context.definition.id }, true))
    if (!this.state.authenticated && operation !== 'auth.state') return fail(hookError('LOGIN_REQUIRED', '请先登录'))
    switch (operation as HookOperation) {
      case 'auth.state': return ok({ authenticated: this.state.authenticated, shopId: this.context.shopId })
      case 'sessions.list': return ok([{ id: 'session-1', title: 'Fake 会话', unreadCount: this.state.messages.filter((message) => !message.isMine).length }])
      case 'messages.listen': return ok({ listening: true, watermark: this.state.messages.at(-1)?.timestamp || 0 })
      case 'messages.history': return ok(this.state.messages.filter((message) => message.sessionId === String((input as { sessionId?: string })?.sessionId || 'session-1')))
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
      default: return fail(hookError('NOT_SUPPORTED', `FakeHook 不支持 ${operation}`))
    }
  }

  drainEvents(): HookEvent[] {
    if (this.disposed) return []
    const events = this.state.pageEvents.get(this.context.definition.id) || []
    this.state.pageEvents.set(this.context.definition.id, [])
    return events
  }

  async dispose(): Promise<void> { this.disposed = true }

  private sendText(input: unknown): HookResult<HookMessage> {
    const value = input as { sessionId?: string; text?: string }
    if (!value?.sessionId || !value.text) return fail(hookError('INVALID_INPUT', 'sessionId 和 text 必填'))
    const message: HookMessage = {
      id: `message-${this.state.messages.length + 1}`,
      sessionId: value.sessionId,
      senderId: 'seller',
      content: value.text,
      type: 'text',
      direction: 'outbound',
      isMine: true,
      timestamp: Date.now(),
    }
    this.state.messages.push(message)
    return ok(message)
  }

  private sendFile(input: unknown): HookResult<HookMessage> {
    const value = input as { sessionId?: string; url?: string; name?: string }
    if (!value?.sessionId || !value.url) return fail(hookError('INVALID_INPUT', 'sessionId 和 url 必填'))
    const message: HookMessage = {
      id: `message-${this.state.messages.length + 1}`,
      sessionId: value.sessionId,
      senderId: 'seller',
      content: value.name || value.url,
      type: 'file',
      direction: 'outbound',
      isMine: true,
      timestamp: Date.now(),
      attachments: [{ url: value.url, name: value.name }],
    }
    this.state.messages.push(message)
    return ok(message)
  }

  private productDetail(input: unknown): HookResult<HookProduct> {
    const id = String((input as { id?: string })?.id || '')
    const product = this.state.products.find((item) => item.id === id)
    return product ? ok(product) : fail(hookError('INVALID_INPUT', `商品不存在: ${id}`))
  }
}
