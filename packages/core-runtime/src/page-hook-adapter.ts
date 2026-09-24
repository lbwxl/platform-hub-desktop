import { fail, hookError, ok, type HookEvent, type HookOperation, type HookResult } from '@platform-hub/core-sdk'
import type { HookTransport } from '@platform-hub/core-transport'
import type { PageHookManifest, PlatformAccountRecord, PlatformDefinition, PlatformRuntimeAdapter, PlatformRuntimeFactory, PlatformRuntimeHostContext, PlatformRuntimeStatus, PlatformViewBounds } from './contracts.js'

export interface PageRuntimeStatusLike {
  connected: boolean
  authenticated: boolean
  url: string
  title?: string
  message: string
  webContentsId?: number
}

export interface PageRuntimePort {
  open(show?: boolean): Promise<void>
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  attachPrimaryView(): void
  detachPrimaryView(): void
  setPrimaryBounds(bounds: PlatformViewBounds): void
  getStatus(): PageRuntimeStatusLike
  refreshStatus(): Promise<PageRuntimeStatusLike>
  getWebContentsId(): number | undefined
  bindHostWindow(window: unknown): void
  showRuntimePageFor(method: string): Promise<void>
  waitForLogin(timeoutMs?: number, method?: string): Promise<void>
  close(): void
}

export interface PageRuntimeFactoryOptions {
  manifest: PageHookManifest
  createRuntime(
    account: PlatformAccountRecord,
    context: PlatformRuntimeHostContext,
    emit: (event: PageRuntimeEvent) => void,
  ): PageRuntimePort
  operationMethods?: Record<string, string>
}

export interface PageRuntimeEvent {
  id: string
  accountId: string
  platform: string
  type: string
  timestamp: number
  payload: unknown
}

export function createPageRuntimeFactory(options: PageRuntimeFactoryOptions): PlatformRuntimeFactory {
  const manifest = options.manifest
  const definition: PlatformDefinition = {
    id: manifest.id,
    label: manifest.label,
    url: manifest.url,
    executionModel: 'page',
    capabilities: [...manifest.capabilities],
    version: manifest.version,
  }
  return {
    definition,
    create(account, context) {
      let adapter: PageHookRuntimeAdapter | undefined
      const runtime = options.createRuntime(account, context, (event) => adapter?.acceptPlatformEvent(event))
      adapter = new PageHookRuntimeAdapter(account, runtime, context, options.operationMethods)
      return adapter
    },
  }
}

export class PageHookRuntimeAdapter implements PlatformRuntimeAdapter {
  readonly transport: PageRuntimeHookTransport

  constructor(
    private readonly account: PlatformAccountRecord,
    private readonly runtime: PageRuntimePort,
    private readonly context: PlatformRuntimeHostContext,
    operationMethods?: Record<string, string>,
  ) {
    this.transport = new PageRuntimeHookTransport(runtime, account, operationMethods)
  }

  get id(): string { return this.account.id }

  async start(): Promise<void> { await this.transport.start() }

  async stop(): Promise<void> {
    await this.transport.stop()
    this.runtime.close()
  }

  async getStatus(): Promise<PlatformRuntimeStatus> {
    const status = await this.runtime.refreshStatus()
    return { ...status, webContentsId: this.runtime.getWebContentsId() }
  }

  async attachPrimaryView(): Promise<void> {
    const window = this.context.getHostWindow()
    if (!window) throw new Error('主工作台窗口尚未就绪')
    this.runtime.bindHostWindow(window)
    await this.runtime.open(false)
    this.runtime.attachPrimaryView()
    const bounds = this.context.getPrimaryViewBounds()
    if (bounds) this.runtime.setPrimaryBounds(bounds)
  }

  detachPrimaryView(): void { this.runtime.detachPrimaryView() }

  updatePrimaryViewBounds(bounds: PlatformViewBounds): void { this.runtime.setPrimaryBounds(bounds) }

  getPrimaryWebContentsId(): number | undefined { return this.runtime.getWebContentsId() }

  bindHostWindow(window: unknown): void { this.runtime.bindHostWindow(window) }

  async showOperationPage(operation: string): Promise<void> {
    await this.runtime.showRuntimePageFor(methodFor(operation))
  }

  async waitForLogin(operation: string): Promise<void> {
    await this.runtime.waitForLogin(undefined, methodFor(operation))
  }

  async dispose(): Promise<void> {
    this.detachPrimaryView()
    await this.transport.stop()
    this.runtime.close()
  }

  acceptPlatformEvent(event: PageRuntimeEvent): void { this.transport.acceptPlatformEvent(event) }
}

class PageRuntimeHookTransport implements HookTransport {
  private readonly listeners = new Set<(event: HookEvent) => void>()
  private started = false
  private stopped = false
  private startPromise?: Promise<void>

  constructor(
    private readonly runtime: PageRuntimePort,
    private readonly account: PlatformAccountRecord,
    private readonly operationMethods: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Page Runtime Transport 已停止')
    if (!this.startPromise) {
      this.startPromise = this.runtime.open(false).then(() => { this.started = true }, (error) => {
        this.startPromise = undefined
        throw error
      })
    }
    await this.startPromise
  }

  async invoke<T = unknown>(operation: HookOperation | string, input: unknown): Promise<HookResult<T>> {
    if (this.stopped) return fail(hookError('RUNTIME_NOT_READY', 'Page Runtime Transport 已停止'))
    const { method, args } = operationCall(operation, input, this.operationMethods)
    try {
      const value = await this.runtime.invoke(method, ...args)
      const record = asRecord(value)
      const errorCode = stringValue(record.errorCode ?? record.code)
      if (errorCode || record.success === false) {
        return fail(hookError(normalizeErrorCode(errorCode), stringValue(record.error ?? record.message) || `${this.account.platform} 操作失败`, undefined, isRetryable(errorCode)))
      }
      if (record.success === true && Object.prototype.hasOwnProperty.call(record, 'message')) return ok(record.message as T)
      return ok(value as T)
    } catch (error) {
      return fail(hookError('PLATFORM_ERROR', error instanceof Error ? error.message : String(error), undefined, true))
    }
  }

  subscribe(listener: (event: HookEvent) => void): () => void {
    if (this.stopped) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.started = false
    this.listeners.clear()
  }

  acceptPlatformEvent(source: PageRuntimeEvent): void {
    if (this.stopped) return
    const payload = asRecord(source.payload)
    const type = source.type === 'message'
      ? 'message.created'
      : source.type === 'connection'
        ? 'auth.changed'
        : source.type === 'order'
          ? (stringValue(payload.eventType) || 'order.updated')
          : 'runtime.error'
    const normalizedPayload = type === 'message.created'
      ? { message: normalizeMessage(asRecord(payload.message ?? source.payload)) }
      : type === 'auth.changed'
        ? { auth: { authenticated: payload.authenticated === true, shopId: optionalString(payload.shopId), userId: optionalString(payload.userId) } }
        : type === 'order.created' || type === 'order.updated'
          ? { order: normalizeOrder(asRecord(payload.order ?? source.payload)) }
          : { message: stringValue(payload.message) || 'Page Hook runtime event' }
    const event = { id: source.id, type, payload: normalizedPayload, timestamp: source.timestamp } as HookEvent
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* isolate transport consumers */ }
    }
  }
}

const OPERATION_METHODS: Record<string, string> = {
  'auth.state': 'getAuthState',
  'sessions.list': 'listSessions',
  'messages.listen': 'listenMessages',
  'messages.history': 'listMessages',
  'messages.send.text': 'sendMessage',
  'messages.send.file': 'sendFile',
  'products.list': 'collectProducts',
  'products.detail': 'getProductDetail',
  'orders.list': 'getOrders',
  'orders.sync': 'syncOrders',
  'orders.listen': 'listenOrders',
  'handoff.targets.list': 'listHandoffTargets',
  'handoff.transfer': 'transferSession',
  'conversation.attention.set': 'setConversationAttention',
}

function operationCall(operation: string, input: unknown, overrides: Record<string, string>): { method: string; args: unknown[] } {
  const row = asRecord(input)
  const method = overrides[operation] || OPERATION_METHODS[operation] || operation
  switch (operation) {
    case 'messages.history': return { method, args: [row.conversationId ?? row.sessionId] }
    case 'messages.send.text': return { method, args: [row.conversationId ?? row.sessionId, row.text ?? row.content] }
    case 'messages.send.file': return { method, args: [row.conversationId ?? row.sessionId, row.data ?? row.dataUrl ?? row.url, row.name ?? row.fileName, row.mimeType ?? row.mime] }
    case 'products.detail': return { method, args: [row.id ?? row.externalId] }
    case 'orders.list': return { method, args: [row.userId ?? row.conversationId, row.orderId] }
    case 'orders.sync': return { method, args: [row.conversationId, row.userId] }
    case 'orders.listen': return { method, args: [row.conversationId, row.orderId] }
    case 'handoff.transfer': return { method, args: [row.conversationId, row.targetId ?? row.targetName] }
    case 'conversation.attention.set': return { method, args: [row.conversationId, row.state] }
    default: return { method, args: [] }
  }
}

function methodFor(operation: string): string { return OPERATION_METHODS[operation] || operation }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '' }
function optionalString(value: unknown): string | undefined { return stringValue(value) || undefined }
function normalizeErrorCode(code: string): 'LOGIN_REQUIRED' | 'CHALLENGE_REQUIRED' | 'RUNTIME_NOT_READY' | 'RATE_LIMITED' | 'NOT_SUPPORTED' | 'INVALID_INPUT' | 'PLATFORM_ERROR' | 'TIMEOUT' {
  return ['LOGIN_REQUIRED', 'CHALLENGE_REQUIRED', 'RUNTIME_NOT_READY', 'RATE_LIMITED', 'NOT_SUPPORTED', 'INVALID_INPUT', 'TIMEOUT'].includes(code)
    ? code as 'LOGIN_REQUIRED' | 'CHALLENGE_REQUIRED' | 'RUNTIME_NOT_READY' | 'RATE_LIMITED' | 'NOT_SUPPORTED' | 'INVALID_INPUT' | 'TIMEOUT'
    : 'PLATFORM_ERROR'
}
function isRetryable(code: string): boolean { return ['LOGIN_REQUIRED', 'CHALLENGE_REQUIRED', 'RUNTIME_NOT_READY', 'RATE_LIMITED', 'TIMEOUT'].includes(code) }

function normalizeMessage(value: Record<string, unknown>): Record<string, unknown> {
  const id = stringValue(value.id ?? value.messageId) || `message-${Date.now()}`
  return {
    id,
    conversationId: stringValue(value.conversationId ?? value.sessionId),
    senderId: optionalString(value.senderId),
    senderName: optionalString(value.senderName),
    content: stringValue(value.content ?? value.text),
    type: value.type || 'unknown',
    direction: value.direction || (value.isMine === true ? 'outbound' : 'inbound'),
    origin: value.origin || 'unknown',
    timestamp: Number(value.timestamp) || Date.now(),
    raw: value.raw,
  }
}

function normalizeOrder(value: Record<string, unknown>): Record<string, unknown> {
  const first = asRecord(Array.isArray(value.items) ? value.items[0] : undefined)
  return {
    id: stringValue(value.id ?? value.orderId),
    externalId: stringValue(value.externalId ?? value.orderId ?? value.id),
    shopId: optionalString(value.shopId),
    conversationId: optionalString(value.conversationId ?? value.sessionId),
    buyer: value.buyer,
    status: value.status || 'unknown',
    items: Array.isArray(value.items) ? value.items : [{ title: stringValue(value.productName), quantity: Number(value.quantity) || 1, productId: optionalString(value.productId) }],
    total: value.total || (Number.isFinite(Number(value.totalAmount)) ? { amount: Number(value.totalAmount), currency: 'CNY' } : undefined),
    receiver: value.receiver,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    raw: value.raw,
    ...(first.title ? {} : {}),
  }
}
