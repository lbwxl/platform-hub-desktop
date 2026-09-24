import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { HookEvent, HookOperation } from '@platform-hub/core-sdk'
import { PlatformRuntimeManager, type PlatformRegistry, type PlatformRuntimeAdapter, type PlatformRuntimeFactory, type PlatformAccountRecord } from '@platform-hub/core-runtime'
import type {
  ChatSession,
  HandoffTarget,
  HookPackageManifest,
  ImportedHookPackage,
  OrderListenResult,
  OrderRecord,
  OrderSyncResult,
  PlatformAccount,
  PlatformCapability,
  PlatformDefinition,
  PlatformEvent,
  PlatformMessage,
  PlatformStatus,
  ProductRecord,
} from '../../shared/platform'
import { HttpShopReplyApi, ShopRuntimeManager, type ShopRuntimeEvent } from '../runtime/ShopRuntimeManager'

interface StoredPlatformAccount extends PlatformAccount { adapterMetadata?: Record<string, unknown> }
type Persisted = { accounts: StoredPlatformAccount[]; hooks: ImportedHookPackage[] }

export class PlatformManager {
  private readonly runtimeManager: PlatformRuntimeManager
  private readonly listeners = new Set<(event: PlatformEvent) => void>()
  private readonly runtimeUnsubscribers = new Map<string, () => void>()
  private state: Persisted = { accounts: [], hooks: [] }
  private readonly statePath: string
  private readonly stateBackupPath: string
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly shopRuntimes = new ShopRuntimeManager(new HttpShopReplyApi())
  private hostWindow: BrowserWindow | null = null
  private activeAccountId = ''
  private primaryViewportBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor(
    private readonly registry: PlatformRegistry,
    private readonly importedFactory: (manifest: HookPackageManifest) => PlatformRuntimeFactory,
  ) {
    this.statePath = join(app.getPath('userData'), 'platform-hub.json')
    this.stateBackupPath = join(app.getPath('userData'), 'platform-hub.json.bak')
    this.runtimeManager = new PlatformRuntimeManager(registry, (account) => this.runtimeContext(account))
    this.shopRuntimes.onEvent((event) => this.emitRuntimeEvent(event))
  }

  async init(): Promise<void> {
    this.state = await this.readState(this.statePath) || await this.readState(this.stateBackupPath) || { accounts: [], hooks: [] }
    this.state.accounts = this.state.accounts.map((account) => ({ ...account, online: account.online === true, runtimeState: account.runtimeState || 'stopped', messageListening: account.messageListening === true }))
    for (const { manifest } of this.state.hooks) if (!this.registry.has(manifest.id)) this.registry.register(this.importedFactory(manifest))
    for (const account of this.state.accounts) await this.prepareAccount(account)
  }

  async attachMainWindow(window: BrowserWindow): Promise<void> {
    if (this.hostWindow && this.hostWindow !== window) for (const account of this.state.accounts) this.runtimeManager.detachPrimaryView(account.id)
    this.hostWindow = window
    for (const account of this.state.accounts) (await this.ensureRuntime(account)).bindHostWindow?.(window)
    for (const account of this.state.accounts.filter((item) => item.online)) await this.setAccountOnline(account.id, true).catch((error) => {
      account.runtimeState = 'error'
      console.error(`[platform-hub] 恢复店铺 Runtime 失败: ${account.id}`, error)
    })
    if (this.activeAccountId) await this.open(this.activeAccountId)
  }

  listPlatforms(): PlatformDefinition[] {
    return this.registry.list().map(({ definition }) => {
      const imported = this.state.hooks.some(({ manifest }) => manifest.id === definition.id)
      return { id: definition.id, label: definition.label, url: definition.url, executionModel: definition.executionModel, capabilities: [...definition.capabilities] as PlatformCapability[], hookVersion: definition.version, source: imported ? 'imported' as const : 'builtin' as const }
    })
  }

  listAccounts(): PlatformAccount[] {
    return this.state.accounts.map((account) => publicAccount(account, this.runtimeManager.get(account.id)?.getPrimaryWebContentsId?.(), this.shopRuntimes.snapshot(account.id)))
  }

  async addAccount(input: { platform: string; label: string; url?: string }): Promise<PlatformAccount> {
    const definition = this.registry.require(input.platform).definition
    const account: StoredPlatformAccount = {
      id: randomUUID(), platform: definition.id, label: input.label.trim() || definition.label,
      url: input.url || definition.url, partition: partitionFor(definition.id, randomUUID()), connected: false,
      authenticated: false, online: false, runtimeState: 'stopped', messageListening: false, createdAt: new Date().toISOString(),
    }
    account.partition = partitionFor(definition.id, account.id)
    await this.prepareAccount(account)
    this.state.accounts.push(account)
    if (this.hostWindow) await this.ensureRuntime(account)
    await this.save()
    return publicAccount(account)
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId)
    await this.shopRuntimes.stop(accountId).catch(() => undefined)
    this.shopRuntimes.unregister(accountId)
    this.runtimeUnsubscribers.get(accountId)?.()
    this.runtimeUnsubscribers.delete(accountId)
    await this.runtimeManager.dispose(accountId).catch(() => undefined)
    await this.registry.require(account.platform).removeAccount?.(account)
    this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId)
    if (this.activeAccountId === accountId) this.activeAccountId = ''
    await this.save()
  }

  async open(accountId: string): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    for (const other of this.state.accounts) if (other.id !== accountId) this.runtimeManager.detachPrimaryView(other.id)
    const runtime = await this.ensureRuntime(account)
    await runtime.attachPrimaryView()
    this.activeAccountId = accountId
    const status = await runtime.getStatus()
    applyStatus(account, status)
    account.lastSeenAt = new Date().toISOString()
    await this.save()
    return publicAccount(account, status.webContentsId)
  }

  async connect(accountId: string, webContentsId: number): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    const runtime = await this.ensureRuntime(account)
    if (runtime.getPrimaryWebContentsId?.() !== webContentsId) throw new Error('页面 WebContents 与账号不匹配')
    const status = await runtime.getStatus()
    applyStatus(account, status)
    await this.save()
    return toPlatformStatus(account, status)
  }

  async disconnect(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId)
    await this.shopRuntimes.stop(accountId).catch(() => undefined)
    this.shopRuntimes.unregister(accountId)
    this.runtimeUnsubscribers.get(accountId)?.()
    this.runtimeUnsubscribers.delete(accountId)
    await this.runtimeManager.dispose(accountId)
    Object.assign(account, { connected: false, authenticated: false, webContentsId: undefined, online: false, runtimeState: 'stopped', messageListening: false })
    if (this.activeAccountId === accountId) this.activeAccountId = ''
    await this.save()
  }

  async setAccountOnline(accountId: string, online: boolean): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    const runtime = await this.ensureRuntime(account)
    if (online) {
      await runtime.start()
      applyStatus(account, await runtime.getStatus())
      if (this.activeAccountId === accountId) await runtime.attachPrimaryView()
    }
    account.online = online
    const snapshot = await this.shopRuntimes.setOnline(accountId, online)
    account.runtimeState = snapshot.runtimeState
    account.messageListening = snapshot.messageListening
    await this.save()
    return this.listAccounts().find((item) => item.id === accountId) || publicAccount(account)
  }

  runtimeStates() { return this.shopRuntimes.snapshots() }

  setPrimaryViewportBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.primaryViewportBounds = { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) }
    if (this.activeAccountId) this.runtimeManager.get(this.activeAccountId)?.updatePrimaryViewBounds?.(this.primaryViewportBounds)
  }

  async setConversationAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void> { await this.shopRuntimes.setAttention(accountId, conversationId, state) }

  async status(accountId: string): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    const runtime = await this.runtimeManager.start(account)
    const status = await runtime.getStatus()
    applyStatus(account, status)
    await this.save()
    return toPlatformStatus(account, status)
  }

  async collectProducts(accountId: string): Promise<ProductRecord[]> {
    const account = this.requireAccount(accountId)
    const result = await this.invokeOperation<unknown>(account, 'products.list', {})
    return (Array.isArray(result) ? result : []).map((item) => toPlatformProduct(item, account.platform))
  }

  async productDetail(accountId: string, goodsId: string): Promise<ProductRecord> { const account = this.requireAccount(accountId); return toPlatformProduct(await this.invokeOperation(account, 'products.detail', { id: goodsId }), account.platform) }
  async sessionsFor(accountId: string): Promise<ChatSession[]> { const result = await this.invokeOperation<unknown>(this.requireAccount(accountId), 'sessions.list', {}); return (Array.isArray(result) ? result : []).map(toPlatformSession) }
  async messagesFor(accountId: string, sessionId: string): Promise<PlatformMessage[]> { const result = await this.invokeOperation<unknown>(this.requireAccount(accountId), 'messages.history', { conversationId: sessionId }); return (Array.isArray(result) ? result : []).map(toPlatformMessage) }
  async ordersFor(accountId: string, userId?: string): Promise<OrderRecord[]> { const account = this.requireAccount(accountId); const result = await this.invokeOperation<unknown>(account, 'orders.list', { userId }); return (Array.isArray(result) ? result : []).map((item) => toPlatformOrder(item, account.platform)) }
  async syncOrdersFor(accountId: string, sessionId?: string, userId?: string): Promise<OrderSyncResult> { return { orders: await this.ordersFor(accountId, userId), authoritative: true, source: 'platform-runtime', syncedAt: Date.now(), sessionId, userId } }
  async listenOrdersFor(accountId: string, sessionId?: string, orderId?: string): Promise<OrderListenResult> { return this.invokeOperation(this.requireAccount(accountId), 'orders.listen', { conversationId: sessionId, orderId }) }
  async listenMessagesFor(accountId: string): Promise<{ listening: boolean; watermark?: number }> { return this.invokeOperation(this.requireAccount(accountId), 'messages.listen', {}) }
  async handoffTargetsFor(accountId: string): Promise<HandoffTarget[]> { return this.invokeOperation(this.requireAccount(accountId), 'handoff.targets.list', {}) }
  async sendMessage(accountId: string, sessionId: string, content: string): Promise<{ success: boolean; error?: string }> { await this.invokeOperation(this.requireAccount(accountId), 'messages.send.text', { conversationId: sessionId, text: content }); return { success: true } }
  async sendFile(accountId: string, sessionId: string, dataUrl: string, fileName?: string): Promise<{ success: boolean; error?: string }> { await this.invokeOperation(this.requireAccount(accountId), 'messages.send.file', { conversationId: sessionId, dataUrl, name: fileName, mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png' }); return { success: true } }
  async transferSession(accountId: string, sessionId: string, target: string): Promise<unknown> { return this.invokeOperation(this.requireAccount(accountId), 'handoff.transfer', { conversationId: sessionId, targetName: target }) }

  onEvent(listener: (event: PlatformEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async dispose(): Promise<void> {
    for (const account of this.state.accounts) {
      await this.shopRuntimes.stop(account.id).catch(() => undefined)
      this.shopRuntimes.unregister(account.id)
      this.runtimeUnsubscribers.get(account.id)?.()
    }
    this.runtimeUnsubscribers.clear()
    await this.runtimeManager.disposeAll()
    await Promise.all(this.registry.list().map((factory) => factory.dispose?.().catch(() => undefined)))
    this.listeners.clear()
  }

  async importPackage(): Promise<PlatformDefinition | null> {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Hook package', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const manifestPath = result.filePaths[0]
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as HookPackageManifest
    if (!manifest.script && manifest.entry) {
      const packageRoot = dirname(manifestPath)
      const entryPath = resolve(packageRoot, manifest.entry)
      if (relative(packageRoot, entryPath).startsWith('..')) throw new Error('Hook 包 entry 不能指向包目录之外')
      manifest.script = await readFile(entryPath, 'utf8')
    }
    if (!manifest.id || !manifest.script || !manifest.url || !Array.isArray(manifest.capabilities)) throw new Error('Hook 包 manifest 缺少必要字段')
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: manifestPath }]
    if (!this.registry.has(manifest.id)) this.registry.register(this.importedFactory(manifest))
    await this.save()
    return this.listPlatforms().find((item) => item.id === manifest.id) || null
  }

  private async prepareAccount(account: StoredPlatformAccount): Promise<void> { const setup = await this.registry.require(account.platform).prepareAccount?.(account); if (setup) Object.assign(account, setup) }

  private async ensureRuntime(account: StoredPlatformAccount): Promise<PlatformRuntimeAdapter> {
    const adapter = await this.runtimeManager.ensure(account)
    if (!this.shopRuntimes.has(account.id)) {
      this.shopRuntimes.register(account.id, adapter.transport, { platform: account.platform, shopName: account.label })
      this.runtimeUnsubscribers.set(account.id, adapter.transport.subscribe((event) => this.onRuntimeEvent(account.id, event)))
    }
    return adapter
  }

  private async invokeOperation<T = unknown>(account: StoredPlatformAccount, operation: HookOperation | string, input: unknown): Promise<T> {
    const runtime = await this.ensureRuntime(account)
    await runtime.start()
    let result = await runtime.transport.invoke<T>(operation as HookOperation, input)
    if (!result.ok) {
      if (result.error.code === 'CHALLENGE_REQUIRED') { await runtime.showOperationPage?.(operation); throw codedError(result.error.code, result.error.message) }
      if (result.error.code === 'LOGIN_REQUIRED') { await runtime.showOperationPage?.(operation); await runtime.waitForLogin?.(operation); result = await runtime.transport.invoke<T>(operation as HookOperation, input) }
      else if (result.error.code === 'RUNTIME_NOT_READY') { await runtime.showOperationPage?.(operation); result = await runtime.transport.invoke<T>(operation as HookOperation, input) }
    }
    if (!result.ok) throw codedError(result.error.code, result.error.message)
    return result.data
  }

  private runtimeContext(account: PlatformAccountRecord) {
    const stored = this.requireAccount(account.id)
    return {
      getAccount: () => stored,
      getHostWindow: () => this.hostWindow,
      getPrimaryViewBounds: () => this.primaryViewportBounds,
      updateAccount: (patch: Partial<PlatformAccountRecord>) => { Object.assign(stored, patch); void this.save() },
    }
  }

  private onRuntimeEvent(accountId: string, event: HookEvent): void {
    const account = this.state.accounts.find((item) => item.id === accountId)
    if (!account) return
    const payload = asRecord(event.payload)
    let type: PlatformEvent['type'] = 'log'
    let publicPayload: unknown = event.payload
    if (event.type === 'message.created') { type = 'message'; publicPayload = { message: toPlatformMessage(payload.message) } }
    else if (event.type.startsWith('order.')) { type = 'order'; publicPayload = { ...payload, order: toPlatformOrder(payload.order, account.platform), eventType: event.type } }
    else if (event.type === 'auth.changed') {
      type = 'connection'
      const auth = asRecord(payload.auth)
      account.authenticated = auth.authenticated === true
      account.lastSeenAt = new Date(event.timestamp).toISOString()
      publicPayload = toPlatformStatus(account, { connected: account.connected, authenticated: account.authenticated, url: account.url, message: account.authenticated ? '平台已登录，Runtime 已就绪' : '请在当前平台页面完成登录' })
      void this.save()
      if (account.online && account.authenticated && this.shopRuntimes.snapshot(accountId)?.runtimeState !== 'running') void this.setAccountOnline(accountId, true).catch(() => undefined)
    } else if (event.type === 'runtime.error') type = 'error'
    this.publish({ id: event.id || `${accountId}:runtime:${event.timestamp}:${randomUUID()}`, accountId, platform: account.platform, type, timestamp: event.timestamp, payload: publicPayload })
  }

  private emitRuntimeEvent(event: ShopRuntimeEvent): void {
    const account = this.state.accounts.find((item) => item.id === event.accountId)
    if (!account) return
    const hookEvent = event.type === 'hook' && event.payload.event && typeof event.payload.event === 'object' ? event.payload.event as HookEvent : undefined
    const type = hookEvent?.type || event.type
    const payload = hookEvent?.payload ?? event.payload
    const eventType: PlatformEvent['type'] = type === 'message.created' ? 'message' : type.startsWith('order.') ? 'order' : type === 'auth.changed' ? 'connection' : type === 'runtime.error' ? 'error' : 'log'
    this.publish({ id: `${event.accountId}:runtime:${event.timestamp}:${randomUUID()}`, accountId: event.accountId, platform: account.platform, type: eventType, timestamp: event.timestamp, payload: type === 'message.created' ? { message: toPlatformMessage(asRecord(payload).message) } : payload })
  }

  private publish(event: PlatformEvent): void { this.listeners.forEach((listener) => listener(event)) }
  private requireAccount(id: string): StoredPlatformAccount { const account = this.state.accounts.find((item) => item.id === id); if (!account) throw new Error('平台账号不存在'); return account }
  private async readState(path: string): Promise<Persisted | null> { try { const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Persisted>; return Array.isArray(value.accounts) && Array.isArray(value.hooks) ? { accounts: value.accounts, hooks: value.hooks } : null } catch { return null } }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const operation = this.saveQueue.catch(() => undefined).then(async () => {
      const directory = app.getPath('userData'); const temporaryPath = `${this.statePath}.${process.pid}.tmp`; await mkdir(directory, { recursive: true }); const current = await readFile(this.statePath, 'utf8').catch(() => '')
      if (current) await writeFile(this.stateBackupPath, current, 'utf8').catch(() => undefined)
      await writeFile(temporaryPath, snapshot, 'utf8'); await rename(temporaryPath, this.statePath)
    })
    this.saveQueue = operation
    return operation
  }
}

function publicAccount(account: StoredPlatformAccount, liveWebContentsId?: number, snapshot?: ReturnType<ShopRuntimeManager['snapshot']>): PlatformAccount { return { id: account.id, platform: account.platform, label: account.label, url: account.url, partition: account.partition, webContentsId: liveWebContentsId || account.webContentsId, connected: account.connected, authenticated: account.authenticated, online: snapshot?.online ?? account.online, runtimeState: snapshot?.runtimeState ?? account.runtimeState, messageListening: snapshot?.messageListening ?? account.messageListening, lastSeenAt: account.lastSeenAt, createdAt: account.createdAt } }
function applyStatus(account: StoredPlatformAccount, status: { connected: boolean; authenticated: boolean; webContentsId?: number }): void { account.connected = status.connected; account.authenticated = status.authenticated; account.webContentsId = status.webContentsId }
function toPlatformStatus(account: StoredPlatformAccount, status: { connected: boolean; authenticated: boolean; url: string; title?: string; message: string }): PlatformStatus { return { accountId: account.id, platform: account.platform, connected: status.connected, authenticated: status.authenticated, url: status.url || account.url, title: status.title, message: status.message } }
function toPlatformProduct(value: unknown, platform: string): ProductRecord { const product = asRecord(value); const price = asRecord(product.price); const skus = Array.isArray(product.skus) ? product.skus : Array.isArray(product.skuList) ? product.skuList : []; return { id: stringValue(product.id ?? product.externalId ?? product.goodsId), goodsId: stringValue(product.externalId ?? product.goodsId ?? product.id), name: stringValue(product.title ?? product.name), price: Number(price.amount ?? product.price) || 0, originalPrice: Number(asRecord(product.originalPrice).amount ?? product.originalPrice) || undefined, stockQuantity: Number(product.stockQuantity) || undefined, status: stringValue(product.status), images: Array.isArray(product.images) ? product.images.map(String) : [], goodsUrl: stringValue(product.url ?? product.goodsUrl) || undefined, editUrl: stringValue(product.editUrl) || undefined, shopId: stringValue(product.shopId) || undefined, platform, updatedAt: Number(product.updatedAt) || undefined, description: stringValue(product.description) || undefined, skuList: skus.map((item) => { const sku = asRecord(item); return { skuId: stringValue(sku.externalId ?? sku.skuId ?? sku.id), skuName: stringValue(sku.name ?? sku.skuName), skuPrice: Number(asRecord(sku.price).amount ?? sku.price ?? sku.skuPrice) || 0 } }), raw: asRecord(product.raw) } }
function toPlatformSession(value: unknown): ChatSession { const session = asRecord(value); return { id: stringValue(session.id ?? session.conversationId), title: stringValue(session.title ?? session.name), unread: Number(session.unreadCount ?? session.unread) || 0, lastMessage: stringValue(session.lastMessage) || undefined, updatedAt: Number(session.updatedAt) || undefined, avatar: stringValue(session.avatarUrl ?? session.avatar) || undefined } }
function toPlatformMessage(value: unknown): PlatformMessage { const message = asRecord(value); const direction = message.direction === 'outbound' || message.isMine === true ? 'outbound' : 'inbound'; return { id: stringValue(message.id ?? message.messageId), sessionId: stringValue(message.conversationId ?? message.sessionId), senderId: stringValue(message.senderId), senderName: stringValue(message.senderName), content: stringValue(message.content ?? message.text), type: stringValue(message.type) || 'unknown', isMine: direction === 'outbound', direction, origin: normalizeOrigin(message.origin), timestamp: Number(message.timestamp) || Date.now(), avatar: stringValue(message.avatar) || undefined, raw: asRecord(message.raw) } }
function toPlatformOrder(value: unknown, platform: string): OrderRecord { const order = asRecord(value); const first = asRecord(Array.isArray(order.items) ? order.items[0] : undefined); const total = asRecord(order.total); const buyer = asRecord(order.buyer); const receiver = asRecord(order.receiver); return { id: stringValue(order.id ?? order.externalId ?? order.orderId), orderId: stringValue(order.externalId ?? order.orderId ?? order.id), status: stringValue(order.status) || 'unknown', totalAmount: Number(total.amount ?? order.totalAmount) || undefined, quantity: Number(first.quantity ?? order.quantity) || undefined, productId: stringValue(first.productId ?? first.externalProductId ?? order.productId) || undefined, productName: stringValue(first.title ?? order.productName) || undefined, shopId: stringValue(order.shopId) || undefined, sessionId: stringValue(order.conversationId ?? order.sessionId) || undefined, userId: stringValue(buyer.id ?? order.userId) || undefined, buyerName: stringValue(buyer.name ?? order.buyerName) || undefined, receiverName: stringValue(receiver.name ?? order.receiverName) || undefined, shippingAddress: stringValue(receiver.address ?? order.shippingAddress) || undefined, updatedAt: Number(order.updatedAt) || undefined, platform, raw: asRecord(order.raw) } }
function normalizeOrigin(value: unknown): PlatformMessage['origin'] { return value === 'customer' || value === 'human' || value === 'automation' || value === 'system' ? value : 'unknown' }
function codedError(code: string, message: string): Error & { code: string } { const error = new Error(message) as Error & { code: string }; error.code = code; return error }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '' }
function partitionFor(platform: string, accountId: string): string { return `persist:platform-hub-${platform}-${accountId.replace(/[^a-z0-9_-]/gi, '_')}` }
