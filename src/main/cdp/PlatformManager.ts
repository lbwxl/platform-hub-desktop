import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { CdpSession, partitionFor } from './CdpSession'
import type { ChatSession, HandoffTarget, HookPackageManifest, ImportedHookPackage, OrderListenResult, OrderSyncResult, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
import { builtinHooks, builtinPlatforms } from '../hooks'
import { HttpShopReplyApi, ShopRuntimeManager, type ShopHookEvent, type ShopRuntimeEvent, type ShopTransportLike } from '../runtime/ShopRuntimeManager'

type Persisted = { accounts: PlatformAccount[]; hooks: ImportedHookPackage[] }

export class PlatformManager {
  private readonly sessions = new Map<string, CdpSession>()
  private readonly listeners = new Set<(event: PlatformEvent) => void>()
  private readonly forwardedRuntimeEventIds = new Set<string>()
  private state: Persisted = { accounts: [], hooks: [] }
  private readonly statePath: string
  private readonly stateBackupPath: string
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly shopRuntimes = new ShopRuntimeManager(new HttpShopReplyApi())
  private hostWindow: BrowserWindow | null = null
  private activeAccountId = ''
  private primaryViewportBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor() {
    this.statePath = join(app.getPath('userData'), 'platform-hub.json')
    this.stateBackupPath = join(app.getPath('userData'), 'platform-hub.json.bak')
    this.shopRuntimes.onEvent((event) => this.emitRuntimeEvent(event))
  }

  async init(): Promise<void> {
    this.state = await this.readState(this.statePath)
      || await this.readState(this.stateBackupPath)
      || { accounts: [], hooks: [] }
    this.state.accounts = this.state.accounts.map((account) => ({
      ...account,
      online: account.online === true,
      runtimeState: account.runtimeState || 'stopped',
      messageListening: account.messageListening === true,
    }))
  }

  async attachMainWindow(window: BrowserWindow): Promise<void> {
    this.hostWindow = window
    for (const account of this.state.accounts) {
      const existing = this.sessions.get(account.id)
      if (existing) existing.bindHostWindow(window)
      else this.ensureSession(account.id)
    }
    for (const account of this.state.accounts.filter((item) => item.online)) {
      await this.setAccountOnline(account.id, true).catch((error) => {
        account.runtimeState = 'error'
        console.error(`[platform-hub] 恢复店铺 Runtime 失败: ${account.id}`, error)
      })
    }
    if (this.activeAccountId) {
      this.detachPrimaryViewsExcept(this.activeAccountId)
      const active = this.sessions.get(this.activeAccountId)
      if (active?.hasPrimaryView()) {
        active.attachPrimaryView()
        if (this.primaryViewportBounds) active.setPrimaryBounds(this.primaryViewportBounds)
      }
    }
  }

  listPlatforms(): PlatformDefinition[] {
    return [...builtinPlatforms, ...this.state.hooks.map(({ manifest }) => ({
      id: manifest.id,
      label: manifest.label,
      url: manifest.url,
      executionModel: manifest.executionModel,
      capabilities: manifest.capabilities,
      hookVersion: manifest.version,
      source: 'imported' as const,
    }))]
  }

  listAccounts(): PlatformAccount[] {
    return this.state.accounts.map((account) => {
      const cdp = this.sessions.get(account.id)
      const live = cdp?.getStatus()
      return {
        ...account,
        connected: live?.connected ?? account.connected,
        authenticated: live?.authenticated ?? account.authenticated,
        webContentsId: cdp?.getWebContentsId(),
        ...(this.shopRuntimes.snapshot(account.id) || { online: account.online, runtimeState: account.runtimeState, messageListening: account.messageListening }),
      }
    })
  }

  async addAccount(input: { platform: string; label: string; url?: string }): Promise<PlatformAccount> {
    const platform = this.listPlatforms().find((item) => item.id === input.platform)
    if (!platform) throw new Error(`未找到平台适配器: ${input.platform}`)
    const id = randomUUID()
    const account: PlatformAccount = {
      id, platform: platform.id, label: input.label.trim() || platform.label,
      url: input.url || platform.url, partition: partitionFor(platform.id, id), connected: false,
      authenticated: false, online: false, runtimeState: 'stopped', messageListening: false,
      createdAt: new Date().toISOString(),
    }
    this.state.accounts.push(account)
    if (this.hostWindow) this.ensureSession(account.id)
    await this.save()
    return account
  }

  async removeAccount(accountId: string): Promise<void> { await this.shopRuntimes.stop(accountId).catch(() => undefined); this.sessions.get(accountId)?.close(); this.sessions.delete(accountId); this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId); await this.save() }

  async open(accountId: string): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    const previousAccountId = this.activeAccountId
    if (previousAccountId && previousAccountId !== accountId) this.sessions.get(previousAccountId)?.detachPrimaryView()
    const cdp = this.ensureSession(accountId)
    this.activeAccountId = accountId
    this.detachPrimaryViewsExcept(accountId)
    await cdp.open(false)
    cdp.attachPrimaryView()
    if (this.primaryViewportBounds) cdp.setPrimaryBounds(this.primaryViewportBounds)
    account.connected = true
    account.webContentsId = cdp.getWebContentsId()
    account.lastSeenAt = new Date().toISOString()
    await this.save()
    return { ...account, connected: true, webContentsId: cdp.getWebContentsId() }
  }

  async connect(accountId: string, webContentsId: number): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    const cdp = this.sessions.get(accountId)
    if (!cdp || cdp.getWebContentsId() !== webContentsId) throw new Error('CDP 页面与账号不匹配')
    account.connected = true; account.webContentsId = webContentsId; account.lastSeenAt = new Date().toISOString(); await this.save()
    return cdp.getStatus()
  }

  async disconnect(accountId: string): Promise<void> { await this.shopRuntimes.stop(accountId).catch(() => undefined); this.sessions.get(accountId)?.close(); this.sessions.delete(accountId); const account = this.requireAccount(accountId); account.connected = false; account.webContentsId = undefined; account.online = false; account.runtimeState = 'stopped'; account.messageListening = false; await this.save() }
  async setAccountOnline(accountId: string, online: boolean): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    let cdp = this.sessions.get(accountId)
    if (online && (!cdp || !cdp.getStatus().connected)) {
      // Going online is a background lifecycle operation. It may create the
      // account's primary WebContentsView, but must never change the UI's
      // active account or reveal an inactive shop's page.
      cdp = this.ensureSession(accountId)
      await cdp.open(false)
      account.connected = true
      account.webContentsId = cdp.getWebContentsId()
    }
    if (!cdp) throw new Error('请先打开平台页面')
    if (this.activeAccountId === accountId) {
      cdp.attachPrimaryView()
      if (this.primaryViewportBounds) cdp.setPrimaryBounds(this.primaryViewportBounds)
    }
    if (!this.shopRuntimes.has(accountId)) this.shopRuntimes.register(accountId, new CdpShopTransport(cdp), { platform: account.platform, shopName: account.label })
    account.online = online
    try {
      const snapshot = await this.shopRuntimes.setOnline(accountId, online)
      account.runtimeState = snapshot.runtimeState
      account.messageListening = snapshot.messageListening
      await this.save()
      return this.listAccounts().find((item) => item.id === accountId) || account
    } catch (error) {
      const snapshot = this.shopRuntimes.snapshot(accountId)
      account.runtimeState = snapshot?.runtimeState || 'error'
      account.messageListening = snapshot?.messageListening || false
      await this.save()
      throw error
    }
  }

  runtimeStates() { return this.shopRuntimes.snapshots() }

  setPrimaryViewportBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.primaryViewportBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }
    if (this.activeAccountId) this.sessions.get(this.activeAccountId)?.setPrimaryBounds(this.primaryViewportBounds)
  }

  async setConversationAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void> {
    await this.shopRuntimes.setAttention(accountId, conversationId, state)
  }

  async status(accountId: string): Promise<PlatformStatus> {
    let cdp = this.sessions.get(accountId)
    if (!cdp) {
      await this.open(accountId)
      cdp = this.sessions.get(accountId)
    }
    if (!cdp) throw new Error('页面尚未连接')
    await cdp.open(false)
    return cdp.refreshStatus()
  }

  async collectProducts(accountId: string): Promise<ProductRecord[]> { return this.withLogin<ProductRecord[]>(accountId, 'collectProducts') }
  async productDetail(accountId: string, goodsId: string): Promise<ProductRecord> { return this.withLogin<ProductRecord>(accountId, 'getProductDetail', goodsId) }
  async sessionsFor(accountId: string): Promise<ChatSession[]> { return this.withLogin<ChatSession[]>(accountId, 'listSessions') }
  async messagesFor(accountId: string, sessionId: string): Promise<PlatformMessage[]> { return this.withLogin<PlatformMessage[]>(accountId, 'listMessages', sessionId) }
  async ordersFor(accountId: string, userId?: string): Promise<unknown[]> { return this.withLogin<unknown[]>(accountId, 'getOrders', userId) }
  async syncOrdersFor(accountId: string, sessionId?: string, userId?: string): Promise<OrderSyncResult> { return this.withLogin<OrderSyncResult>(accountId, 'syncOrders', sessionId, userId) }
  async listenOrdersFor(accountId: string, sessionId?: string, orderId?: string): Promise<OrderListenResult> { return this.withLogin<OrderListenResult>(accountId, 'listenOrders', sessionId, orderId) }
  async listenMessagesFor(accountId: string): Promise<{ listening: boolean; watermark?: number }> { return this.withLogin(accountId, 'listenMessages') }
  async handoffTargetsFor(accountId: string): Promise<HandoffTarget[]> { return this.withLogin<HandoffTarget[]>(accountId, 'listHandoffTargets') }
  async sendMessage(accountId: string, sessionId: string, content: string): Promise<{ success: boolean; error?: string }> { return this.withLogin(accountId, 'sendMessage', sessionId, content) }
  async sendFile(accountId: string, sessionId: string, dataUrl: string, fileName?: string): Promise<{ success: boolean; error?: string }> { return this.withLogin(accountId, 'sendFile', sessionId, dataUrl, fileName) }
  async transferSession(accountId: string, sessionId: string, target: string): Promise<unknown> { return this.withLogin(accountId, 'transferSession', sessionId, target) }

  onEvent(listener: (event: PlatformEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

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
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: result.filePaths[0] }]
    await this.save()
    return { id: manifest.id, label: manifest.label, url: manifest.url, capabilities: manifest.capabilities, hookVersion: manifest.version, source: 'imported' }
  }

  private getHook(id: string): HookPackageManifest { return this.state.hooks.find((item) => item.manifest.id === id)?.manifest || builtinHooks[id] }
  private requireAccount(id: string): PlatformAccount { const account = this.state.accounts.find((item) => item.id === id); if (!account) throw new Error('平台账号不存在'); return account }
  private ensureSession(accountId: string): CdpSession {
    const existing = this.sessions.get(accountId)
    if (existing) return existing
    const account = this.requireAccount(accountId)
    if (!this.hostWindow || this.hostWindow.isDestroyed()) throw new Error('主工作台窗口尚未就绪')
    const platform = this.listPlatforms().find((item) => item.id === account.platform)
    if (!platform) throw new Error(`未找到平台适配器: ${account.platform}`)
    const cdp = new CdpSession({ accountId, platform: platform.id, url: account.url, partition: account.partition, hook: this.getHook(platform.id), hostWindow: this.hostWindow, emit: (event) => this.emit(event) })
    this.sessions.set(accountId, cdp)
    this.shopRuntimes.register(accountId, new CdpShopTransport(cdp), { platform: account.platform, shopName: account.label })
    return cdp
  }
  private detachPrimaryViewsExcept(accountId: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== accountId && session.isPrimaryViewAttached()) session.detachPrimaryView()
    }
  }
  private async invoke<T>(accountId: string, method: string, ...args: unknown[]): Promise<T> { const cdp = this.sessions.get(accountId); if (!cdp) throw new Error('请先打开平台页面'); return cdp.invoke<T>(method, ...args) }
  private async withLogin<T>(accountId: string, method: string, ...args: unknown[]): Promise<T> {
    const cdp = this.sessions.get(accountId)
    if (!cdp) throw new Error('请先打开平台页面')
    type RuntimeResult = T & { ok?: boolean; errorCode?: string; error?: string }
    let result = await cdp.invoke<RuntimeResult>(method, ...args)
    let errorCode = this.runtimeErrorCode(result)
    if (errorCode === 'CHALLENGE_REQUIRED') {
      await cdp.showRuntimePageFor(method)
      const detail = result && typeof result === 'object' ? result.error : undefined
      const challengeError = new Error(
        `抖店要求完成安全验证，已打开该店铺的官方页面。完成验证后请返回工作台重新同步。${detail ? `（${detail}）` : ''}`,
      ) as Error & { code?: string }
      challengeError.code = errorCode
      throw challengeError
    }
    if (errorCode === 'LOGIN_REQUIRED' || (errorCode === 'RUNTIME_NOT_READY' && !cdp.getStatus().authenticated)) {
      await cdp.showRuntimePageFor(method)
      await cdp.waitForLogin(undefined, method)
      result = await cdp.invoke<RuntimeResult>(method, ...args)
      errorCode = this.runtimeErrorCode(result)
    }
    if (errorCode === 'RUNTIME_NOT_READY') {
      await cdp.showRuntimePageFor(method)
      result = await cdp.invoke<RuntimeResult>(method, ...args)
      errorCode = this.runtimeErrorCode(result)
    }
    if (errorCode === 'LOGIN_REQUIRED' || errorCode === 'RUNTIME_NOT_READY') {
      const detail = result && typeof result === 'object' ? result.error : undefined
      throw new Error(detail || (errorCode === 'LOGIN_REQUIRED' ? '请在平台页面完成登录后重试' : '平台运行时尚未就绪，请等待页面加载后重试'))
    }
    return result as T
  }
  private runtimeErrorCode(value: unknown): string | undefined {
    return value && typeof value === 'object' ? (value as { errorCode?: string }).errorCode : undefined
  }
  private emit(event: PlatformEvent): void {
    if (event.type === 'connection' && event.payload && typeof event.payload === 'object') {
      const account = this.state.accounts.find((item) => item.id === event.accountId)
      const status = event.payload as Partial<PlatformStatus>
      if (account) {
        account.connected = status.connected === true
        account.authenticated = status.authenticated === true
        account.lastSeenAt = new Date(event.timestamp).toISOString()
        void this.save()
        if (account.online && account.authenticated && this.shopRuntimes.snapshot(account.id)?.runtimeState !== 'running') {
          void this.setAccountOnline(account.id, true).catch((error) => {
            console.error(`[platform-hub] 登录后启动店铺监听失败: ${account.id}`, error)
          })
        }
      }
    }
    const runtime = this.shopRuntimes.has(event.accountId) ? this.shopRuntimes : undefined
    if (runtime && event.type === 'message') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
      if (this.forwardedRuntimeEventIds.size >= 2_000) this.forwardedRuntimeEventIds.clear()
      this.forwardedRuntimeEventIds.add(event.id)
      runtime.pushEvent(event.accountId, {
        id: event.id,
        type: 'message.created',
        timestamp: event.timestamp,
        payload: { message: payload.message || payload },
      })
    }
    this.listeners.forEach((listener) => listener(event))
  }

  private emitRuntimeEvent(event: ShopRuntimeEvent): void {
    // CdpSession's original PlatformEvent is already emitted by emit(). Its
    // corresponding ShopRuntimeManager hook event is needed for processing,
    // but must not be sent to the renderer a second time. Hook events from a
    // different transport do not carry one of these ids and remain visible.
    if (event.type === 'hook' && event.payload.event && typeof event.payload.event === 'object') {
      const sourceId = (event.payload.event as { id?: unknown }).id
      if (typeof sourceId === 'string' && this.forwardedRuntimeEventIds.delete(sourceId)) return
    }
    const account = this.state.accounts.find((item) => item.id === event.accountId)
    if (!account) return
    const payload = event.type === 'hook' && event.payload.event && typeof event.payload.event === 'object'
      ? event.payload.event
      : event.payload
    const sourceType = event.type === 'hook' && payload && typeof payload === 'object' ? String((payload as { type?: string }).type || '') : event.type
    this.listeners.forEach((listener) => listener({
      id: `${event.accountId}:runtime:${event.timestamp}:${Math.random().toString(16).slice(2)}`,
      accountId: event.accountId,
      platform: account.platform,
      type: sourceType.startsWith('order.') ? 'order' : 'log',
      timestamp: event.timestamp,
      payload,
    }))
  }
  private async readState(path: string): Promise<Persisted | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Persisted>
      if (!Array.isArray(value.accounts) || !Array.isArray(value.hooks)) return null
      return { accounts: value.accounts, hooks: value.hooks }
    } catch {
      return null
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const operation = this.saveQueue.catch(() => undefined).then(async () => {
      const directory = app.getPath('userData')
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`
      await mkdir(directory, { recursive: true })
      const current = await readFile(this.statePath, 'utf8').catch(() => '')
      if (current) {
        try {
          const parsed = JSON.parse(current) as Partial<Persisted>
          if (Array.isArray(parsed.accounts) && Array.isArray(parsed.hooks)) {
            await writeFile(this.stateBackupPath, current, 'utf8')
          }
        } catch {
          // Keep the last valid backup when the primary file is incomplete.
        }
      }
      await writeFile(temporaryPath, snapshot, 'utf8')
      await rename(temporaryPath, this.statePath)
    })
    this.saveQueue = operation
    return operation
  }
}

class CdpShopTransport implements ShopTransportLike {
  constructor(private readonly cdp: CdpSession) {}

  async start(): Promise<void> { await this.cdp.open(false) }

  async invoke<T = unknown>(operation: string, input: unknown): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string; retryable?: boolean } }> {
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const method = operation === 'auth.state' ? 'getAuthState'
      : operation === 'messages.listen' ? 'listenMessages'
        : operation === 'messages.send.text' ? 'sendMessage'
          : operation === 'messages.send.file' ? 'sendFile'
            : operation === 'handoff.targets.list' ? 'listHandoffTargets'
              : operation === 'handoff.transfer' ? 'transferSession'
                : operation === 'conversation.attention.set' ? 'setConversationAttention'
                  : operation
    const parameters = operation === 'messages.send.text'
      ? [args.conversationId, args.text]
      : operation === 'messages.send.file'
        ? [args.conversationId, args.data || args.dataUrl || args.url, args.name || args.fileName, args.mimeType]
        : operation === 'handoff.transfer'
          ? [args.conversationId, args.targetId || args.targetName]
          : operation === 'conversation.attention.set'
            ? [args.conversationId, args.state]
            : []
    try {
      const value = await this.cdp.invoke<T>(method, ...parameters)
      if (value && typeof value === 'object' && 'errorCode' in (value as object)) {
        const error = value as { errorCode?: string; error?: string }
        return { ok: false, error: { code: error.errorCode || 'PLATFORM_ERROR', message: error.error || '平台操作失败' } }
      }
      return { ok: true, data: value }
    } catch (error) {
      return { ok: false, error: { code: 'PLATFORM_ERROR', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  subscribe(_listener: (event: ShopHookEvent) => void): () => void { return () => undefined }

  async stop(): Promise<void> { /* The BrowserWindow remains available while an account is offline. */ }
}
