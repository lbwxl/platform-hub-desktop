import { app, BrowserWindow, dialog, WebContentsView, session } from 'electron'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpSession, partitionFor } from './CdpSession'
import type { ChatSession, HandoffTarget, HookPackageManifest, ImportedHookPackage, OrderListenResult, OrderSyncResult, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
import { builtinHooks, builtinPlatforms } from '../hooks'
import { HttpShopReplyApi, ShopRuntimeManager, type ShopHookEvent, type ShopRuntimeEvent, type ShopTransportLike } from '../runtime/ShopRuntimeManager'
import { GoofishMessagingClient } from '@idle-fish/goofish-messaging'
import { GoofishTransport } from '@platform-hub/goofish-transport'
import type { HookMessage, HookProduct, HookSessionSummary } from '@platform-hub/hook-sdk'

type Persisted = { accounts: PlatformAccount[]; hooks: ImportedHookPackage[] }

export class PlatformManager {
  private readonly sessions = new Map<string, CdpSession>()
  private readonly goofishTransports = new Map<string, GoofishTransport>()
  private readonly goofishViews = new Map<string, WebContentsView>()
  private readonly goofishAttachedWindows = new Map<string, BrowserWindow>()
  private readonly goofishPrimaryLoads = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: PlatformEvent) => void>()
  private readonly forwardedRuntimeEventIds = new Set<string>()
  private state: Persisted = { accounts: [], hooks: [] }
  private readonly statePath: string
  private readonly stateBackupPath: string
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly shopRuntimes = new ShopRuntimeManager(new HttpShopReplyApi())
  private readonly goofishClientListener = (event: { accountId: string; eventType: string; payload?: unknown }) => this.onGoofishClientEvent(event)
  private readonly goofishClient = new GoofishMessagingClient({
    electron: { BrowserWindow, session, app },
    userDataPath: app.getPath('userData'),
    partitionPrefix: 'goofish-messaging',
    shouldKeepAccountAlive: (clientAccountId: string) => [...this.state.accounts].some((account) => account.goofishClientAccountId === clientAccountId && account.online),
  })
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
    this.goofishClient.on('event', this.goofishClientListener)
    for (const account of this.state.accounts.filter((item) => item.platform === 'goofish')) {
      this.ensureGoofishClientAccount(account)
      this.ensureGoofishTransport(account.id)
    }
  }

  async attachMainWindow(window: BrowserWindow): Promise<void> {
    if (this.hostWindow && this.hostWindow !== window) this.detachPrimaryViewsExcept('')
    this.hostWindow = window
    for (const account of this.state.accounts) {
      if (account.platform === 'goofish') this.ensureGoofishTransport(account.id)
      else {
        const existing = this.sessions.get(account.id)
        if (existing) existing.bindHostWindow(window)
        else this.ensureSession(account.id)
      }
    }
    for (const account of this.state.accounts.filter((item) => item.online)) {
      await this.setAccountOnline(account.id, true).catch((error) => {
        account.runtimeState = 'error'
        console.error(`[platform-hub] 恢复店铺 Runtime 失败: ${account.id}`, error)
      })
    }
    if (this.activeAccountId) {
      this.detachPrimaryViewsExcept(this.activeAccountId)
      await this.attachPrimaryView(this.activeAccountId)
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
      const goofishView = this.goofishViews.get(account.id)
      const live = cdp?.getStatus()
      return {
        ...account,
        connected: live?.connected ?? account.connected,
        authenticated: live?.authenticated ?? account.authenticated,
        webContentsId: cdp?.getWebContentsId() || this.liveGoofishWebContentsId(goofishView),
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
    if (platform.id === 'goofish') {
      const clientAccount = this.goofishClient.addAccount({ id: temporaryGoofishAccountId(), label: account.label, show: false })
      const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccount.id)
      account.goofishClientAccountId = clientAccount.id
      account.partition = config.partition
      account.url = config.url
    }
    this.state.accounts.push(account)
    if (this.hostWindow) {
      if (account.platform === 'goofish') this.ensureGoofishTransport(account.id)
      else this.ensureSession(account.id)
    }
    await this.save()
    return account
  }

  async removeAccount(accountId: string): Promise<void> {
    await this.shopRuntimes.stop(accountId).catch(() => undefined)
    this.shopRuntimes.unregister(accountId)
    this.sessions.get(accountId)?.close()
    this.sessions.delete(accountId)
    const account = this.state.accounts.find((item) => item.id === accountId)
    this.closeGoofishView(accountId)
    this.goofishTransports.delete(accountId)
    this.goofishPrimaryLoads.delete(accountId)
    if (account?.platform === 'goofish') {
      const clientAccountId = this.currentGoofishClientAccountId(account)
      try { this.goofishClient.removeAccount(clientAccountId) } catch { /* the legacy account may already have migrated */ }
    }
    this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId)
    if (this.activeAccountId === accountId) this.activeAccountId = ''
    await this.save()
  }

  async open(accountId: string): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    await this.attachPrimaryView(accountId)
    this.activeAccountId = accountId
    const webContentsId = account.platform === 'goofish'
      ? this.liveGoofishWebContentsId(this.goofishViews.get(accountId))
      : this.sessions.get(accountId)?.getWebContentsId()
    account.connected = true
    account.webContentsId = webContentsId
    account.lastSeenAt = new Date().toISOString()
    await this.save()
    return { ...account, connected: true, webContentsId }
  }

  async connect(accountId: string, webContentsId: number): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    if (account.platform === 'goofish') {
      if (this.liveGoofishWebContentsId(this.goofishViews.get(accountId)) !== webContentsId) throw new Error('闲鱼 WebContents 与账号不匹配')
      account.connected = true
      account.webContentsId = webContentsId
      account.lastSeenAt = new Date().toISOString()
      await this.save()
      return this.status(accountId)
    }
    const cdp = this.sessions.get(accountId)
    if (!cdp || cdp.getWebContentsId() !== webContentsId) throw new Error('CDP 页面与账号不匹配')
    account.connected = true; account.webContentsId = webContentsId; account.lastSeenAt = new Date().toISOString(); await this.save()
    return cdp.getStatus()
  }

  async disconnect(accountId: string): Promise<void> {
    await this.shopRuntimes.stop(accountId).catch(() => undefined)
    this.shopRuntimes.unregister(accountId)
    this.sessions.get(accountId)?.close()
    this.sessions.delete(accountId)
    const account = this.requireAccount(accountId)
    if (account.platform === 'goofish') {
      try { this.goofishClient.closeProducts(this.currentGoofishClientAccountId(account)) } catch { /* no product page is currently open */ }
      this.closeGoofishView(accountId)
      this.goofishTransports.delete(accountId)
      this.goofishPrimaryLoads.delete(accountId)
    }
    account.connected = false
    account.webContentsId = undefined
    account.online = false
    account.runtimeState = 'stopped'
    account.messageListening = false
    await this.save()
  }
  async setAccountOnline(accountId: string, online: boolean): Promise<PlatformAccount> {
    const account = this.requireAccount(accountId)
    if (account.platform === 'goofish') {
      const transport = this.ensureGoofishTransport(accountId)
      if (online) {
        // Create the same official WebContents used by the visible native
        // workspace, but leave it detached when another account is active.
        const view = this.ensureGoofishView(accountId)
        await this.waitForGoofishPrimary(view)
        account.connected = true
        account.webContentsId = view.webContents.id
      }
      if (this.activeAccountId === accountId) await this.attachPrimaryView(accountId)
      if (!this.shopRuntimes.has(accountId)) this.shopRuntimes.register(accountId, transport, { platform: account.platform, shopName: account.label })
    } else {
      let cdp = this.sessions.get(accountId)
      if (online && (!cdp || !cdp.getStatus().connected)) {
        // Going online may prepare an inactive primary page but never reveal it.
        cdp = this.ensureSession(accountId)
        await cdp.open(false)
        account.connected = true
        account.webContentsId = cdp.getWebContentsId()
      }
      if (!cdp) throw new Error('请先打开平台页面')
      if (this.activeAccountId === accountId) await this.attachPrimaryView(accountId)
      if (!this.shopRuntimes.has(accountId)) this.shopRuntimes.register(accountId, new CdpShopTransport(cdp), { platform: account.platform, shopName: account.label })
    }
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
    if (!this.activeAccountId) return
    const account = this.state.accounts.find((item) => item.id === this.activeAccountId)
    if (account?.platform === 'goofish') {
      const view = this.goofishViews.get(this.activeAccountId)
      if (view && this.goofishAttachedWindows.has(this.activeAccountId)) view.setBounds(this.primaryViewportBounds)
    } else this.sessions.get(this.activeAccountId)?.setPrimaryBounds(this.primaryViewportBounds)
  }

  async setConversationAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void> {
    await this.shopRuntimes.setAttention(accountId, conversationId, state)
  }

  async status(accountId: string): Promise<PlatformStatus> {
    const account = this.requireAccount(accountId)
    if (account.platform === 'goofish') {
      const view = this.ensureGoofishView(accountId)
      const auth = await this.goofishInvoke<Record<string, unknown>>(accountId, 'auth.state', {})
      account.connected = Boolean(this.liveGoofishWebContentsId(view))
      account.authenticated = auth.authenticated === true
      account.webContentsId = this.liveGoofishWebContentsId(view)
      if (auth.userId) {
        account.label = account.label || String(auth.nickname || '闲鱼店铺')
      }
      return {
        accountId,
        platform: account.platform,
        connected: account.connected,
        authenticated: account.authenticated,
        url: view.webContents.getURL() || account.url,
        title: view.webContents.getTitle(),
        message: account.authenticated ? '闲鱼已登录，Runtime 已就绪' : '请在当前闲鱼官方页面完成登录',
      }
    }
    let cdp = this.sessions.get(accountId)
    if (!cdp) {
      await this.open(accountId)
      cdp = this.sessions.get(accountId)
    }
    if (!cdp) throw new Error('页面尚未连接')
    await cdp.open(false)
    return cdp.refreshStatus()
  }

  async collectProducts(accountId: string): Promise<ProductRecord[]> {
    if (this.requireAccount(accountId).platform === 'goofish') return (await this.goofishInvoke<HookProduct[]>(accountId, 'products.list', {})).map(toPlatformProduct)
    return this.withLogin<ProductRecord[]>(accountId, 'collectProducts')
  }
  async productDetail(accountId: string, goodsId: string): Promise<ProductRecord> {
    if (this.requireAccount(accountId).platform === 'goofish') return toPlatformProduct(await this.goofishInvoke<HookProduct>(accountId, 'products.detail', { id: goodsId }))
    return this.withLogin<ProductRecord>(accountId, 'getProductDetail', goodsId)
  }
  async sessionsFor(accountId: string): Promise<ChatSession[]> {
    if (this.requireAccount(accountId).platform === 'goofish') return (await this.goofishInvoke<HookSessionSummary[]>(accountId, 'sessions.list', {})).map(toPlatformSession)
    return this.withLogin<ChatSession[]>(accountId, 'listSessions')
  }
  async messagesFor(accountId: string, sessionId: string): Promise<PlatformMessage[]> {
    if (this.requireAccount(accountId).platform === 'goofish') return (await this.goofishInvoke<HookMessage[]>(accountId, 'messages.history', { conversationId: sessionId })).map(toPlatformMessage)
    return this.withLogin<PlatformMessage[]>(accountId, 'listMessages', sessionId)
  }
  async ordersFor(accountId: string, userId?: string): Promise<unknown[]> { if (this.requireAccount(accountId).platform === 'goofish') throw new Error('闲鱼暂不支持订单能力'); return this.withLogin<unknown[]>(accountId, 'getOrders', userId) }
  async syncOrdersFor(accountId: string, sessionId?: string, userId?: string): Promise<OrderSyncResult> { if (this.requireAccount(accountId).platform === 'goofish') throw new Error('闲鱼暂不支持订单能力'); return this.withLogin<OrderSyncResult>(accountId, 'syncOrders', sessionId, userId) }
  async listenOrdersFor(accountId: string, sessionId?: string, orderId?: string): Promise<OrderListenResult> { if (this.requireAccount(accountId).platform === 'goofish') throw new Error('闲鱼暂不支持订单能力'); return this.withLogin<OrderListenResult>(accountId, 'listenOrders', sessionId, orderId) }
  async listenMessagesFor(accountId: string): Promise<{ listening: boolean; watermark?: number }> {
    if (this.requireAccount(accountId).platform === 'goofish') return this.goofishInvoke(accountId, 'messages.listen', {})
    return this.withLogin(accountId, 'listenMessages')
  }
  async handoffTargetsFor(accountId: string): Promise<HandoffTarget[]> {
    if (this.requireAccount(accountId).platform === 'goofish') throw new Error('闲鱼暂不支持官方转人工目标能力')
    return this.withLogin<HandoffTarget[]>(accountId, 'listHandoffTargets')
  }
  async sendMessage(accountId: string, sessionId: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (this.requireAccount(accountId).platform === 'goofish') {
      await this.goofishInvoke(accountId, 'messages.send.text', { conversationId: sessionId, text: content })
      return { success: true }
    }
    return this.withLogin(accountId, 'sendMessage', sessionId, content)
  }
  async sendFile(accountId: string, sessionId: string, dataUrl: string, fileName?: string): Promise<{ success: boolean; error?: string }> {
    if (this.requireAccount(accountId).platform === 'goofish') {
      await this.goofishInvoke(accountId, 'messages.send.file', { conversationId: sessionId, dataUrl, name: fileName, mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png' })
      return { success: true }
    }
    return this.withLogin(accountId, 'sendFile', sessionId, dataUrl, fileName)
  }
  async transferSession(accountId: string, sessionId: string, target: string): Promise<unknown> {
    if (this.requireAccount(accountId).platform === 'goofish') throw new Error('闲鱼暂不支持官方会话转接能力')
    return this.withLogin(accountId, 'transferSession', sessionId, target)
  }

  onEvent(listener: (event: PlatformEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async dispose(): Promise<void> {
    for (const account of this.state.accounts) {
      await this.shopRuntimes.stop(account.id).catch(() => undefined)
      this.shopRuntimes.unregister(account.id)
      this.sessions.get(account.id)?.close()
      this.sessions.delete(account.id)
      if (account.platform === 'goofish') this.closeGoofishView(account.id)
    }
    this.goofishClient.removeListener('event', this.goofishClientListener)
    this.goofishClient.dispose()
    this.goofishTransports.clear()
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
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: result.filePaths[0] }]
    await this.save()
    return { id: manifest.id, label: manifest.label, url: manifest.url, capabilities: manifest.capabilities, hookVersion: manifest.version, source: 'imported' }
  }

  private getHook(id: string): HookPackageManifest { return this.state.hooks.find((item) => item.manifest.id === id)?.manifest || builtinHooks[id] }
  private requireAccount(id: string): PlatformAccount { const account = this.state.accounts.find((item) => item.id === id); if (!account) throw new Error('平台账号不存在'); return account }
  private ensureGoofishClientAccount(account: PlatformAccount): string {
    const clientAccounts = this.goofishClient.listAccounts()
    const match = clientAccounts.find((item) => String(item.id) === account.goofishClientAccountId)
      || clientAccounts.find((item) => {
        try { return this.goofishClient.getEmbeddedWebviewConfig(String(item.id)).partition === account.partition } catch { return false }
      })
    const clientAccount = match || this.goofishClient.addAccount({
      id: account.goofishClientAccountId || temporaryGoofishAccountId(),
      label: account.label,
      show: false,
    })
    const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccount.id)
    const changed = account.goofishClientAccountId !== clientAccount.id || account.partition !== config.partition || account.url !== config.url
    account.goofishClientAccountId = clientAccount.id
    account.partition = config.partition
    account.url = config.url
    if (changed) void this.save()
    return clientAccount.id
  }

  private currentGoofishClientAccountId(account: PlatformAccount): string {
    return this.ensureGoofishClientAccount(account)
  }

  private ensureGoofishTransport(accountId: string): GoofishTransport {
    const existing = this.goofishTransports.get(accountId)
    if (existing) return existing
    const account = this.requireAccount(accountId)
    if (account.platform !== 'goofish') throw new Error('账号不是闲鱼平台')
    const clientAccountId = this.ensureGoofishClientAccount(account)
    const transport = new GoofishTransport({ accountId, clientAccountId, client: this.goofishClient })
    this.goofishTransports.set(accountId, transport)
    this.shopRuntimes.register(accountId, transport, { platform: account.platform, shopName: account.label })
    return transport
  }

  private ensureGoofishView(accountId: string): WebContentsView {
    const account = this.requireAccount(accountId)
    if (account.platform !== 'goofish') throw new Error('账号不是闲鱼平台')
    const existing = this.goofishViews.get(accountId)
    if (existing && !existing.webContents.isDestroyed()) return existing
    if (!this.hostWindow || this.hostWindow.isDestroyed()) throw new Error('主工作台窗口尚未就绪')
    if (existing) this.goofishViews.delete(accountId)

    const clientAccountId = this.ensureGoofishClientAccount(account)
    const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccountId)
    const view = new WebContentsView({
      webPreferences: {
        partition: config.partition,
        preload: fileURLToPath(config.preload),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isOfficialGoofishLoginUrl(url)) {
        void view.webContents.loadURL(url).catch((error) => this.emitGoofishRuntimeError(accountId, error))
      }
      return { action: 'deny' }
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      this.emitGoofishRuntimeError(accountId, new Error(`闲鱼页面进程退出: ${details.reason}`))
    })
    view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emitGoofishRuntimeError(accountId, new Error(`闲鱼页面加载失败: ${description} (${url})`))
    })
    view.webContents.once('destroyed', () => {
      if (this.goofishViews.get(accountId) === view) {
        this.goofishViews.delete(accountId)
        this.goofishPrimaryLoads.delete(accountId)
        this.goofishAttachedWindows.delete(accountId)
      }
      this.goofishClient.detachEmbeddedWebContents(clientAccountId, view.webContents)
    })
    this.goofishViews.set(accountId, view)

    const load = (async () => {
      await this.goofishClient.attachEmbeddedWebContents(clientAccountId, view.webContents)
      await view.webContents.loadURL(config.url)
    })()
    this.goofishPrimaryLoads.set(accountId, load)
    void load.catch((error) => this.emitGoofishRuntimeError(accountId, error))
    return view
  }

  private liveGoofishWebContentsId(view: WebContentsView | undefined): number | undefined {
    return view && !view.webContents.isDestroyed() ? view.webContents.id : undefined
  }

  private async waitForGoofishPrimary(view: WebContentsView): Promise<void> {
    if (view.webContents.isDestroyed()) throw new Error('闲鱼官方页面已关闭')
    const accountId = [...this.goofishViews].find(([, candidate]) => candidate === view)?.[0]
    const load = accountId ? this.goofishPrimaryLoads.get(accountId) : undefined
    if (load) await load
    if (view.webContents.isDestroyed()) throw new Error('闲鱼官方页面已关闭')
  }

  private async attachPrimaryView(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId)
    const hostWindow = this.hostWindow
    if (!hostWindow || hostWindow.isDestroyed()) throw new Error('主工作台窗口尚未就绪')
    if (account.platform === 'goofish') {
      const view = this.ensureGoofishView(accountId)
      await this.waitForGoofishPrimary(view)
      this.detachPrimaryViewsExcept(accountId)
      const attachedWindow = this.goofishAttachedWindows.get(accountId)
      if (attachedWindow !== hostWindow) {
        if (attachedWindow && !attachedWindow.isDestroyed()) {
          try { attachedWindow.contentView.removeChildView(view) } catch { /* already detached */ }
        }
        hostWindow.contentView.addChildView(view)
        this.goofishAttachedWindows.set(accountId, hostWindow)
      }
      view.setVisible(true)
      if (this.primaryViewportBounds) view.setBounds(this.primaryViewportBounds)
      return
    }
    const cdp = this.ensureSession(accountId)
    await cdp.open(false)
    this.detachPrimaryViewsExcept(accountId)
    cdp.attachPrimaryView()
    if (this.primaryViewportBounds) cdp.setPrimaryBounds(this.primaryViewportBounds)
  }

  private detachGoofishView(accountId: string): void {
    const view = this.goofishViews.get(accountId)
    const attachedWindow = this.goofishAttachedWindows.get(accountId)
    if (view && attachedWindow && !attachedWindow.isDestroyed()) {
      try { attachedWindow.contentView.removeChildView(view) } catch { /* already detached */ }
    }
    if (view && !view.webContents.isDestroyed()) view.setVisible(false)
    this.goofishAttachedWindows.delete(accountId)
  }

  private closeGoofishView(accountId: string): void {
    const view = this.goofishViews.get(accountId)
    this.detachGoofishView(accountId)
    this.goofishViews.delete(accountId)
    this.goofishPrimaryLoads.delete(accountId)
    if (!view || view.webContents.isDestroyed()) return
    const account = this.state.accounts.find((item) => item.id === accountId)
    if (account) this.goofishClient.detachEmbeddedWebContents(this.currentGoofishClientAccountId(account), view.webContents)
    view.webContents.close()
  }

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
    for (const id of this.goofishViews.keys()) {
      if (id !== accountId) this.detachGoofishView(id)
    }
  }

  private async goofishInvoke<T>(accountId: string, operation: string, input: unknown): Promise<T> {
    const transport = this.ensureGoofishTransport(accountId)
    const view = this.ensureGoofishView(accountId)
    await this.waitForGoofishPrimary(view)
    await transport.start()
    const result = await transport.invoke<T>(operation, input)
    if (!result.ok) {
      const error = new Error(result.error.message) as Error & { code?: string }
      error.code = result.error.code
      throw error
    }
    return result.data
  }

  private onGoofishClientEvent(event: { accountId: string; eventType: string; payload?: unknown }): void {
    const payload = asRecord(event.payload)
    const previousId = scalar(payload.previousAccountId)
    const nextId = scalar(payload.accountId ?? event.accountId)
    const account = this.state.accounts.find((item) => item.platform === 'goofish' && (
      (previousId && item.goofishClientAccountId === previousId)
      || item.goofishClientAccountId === event.accountId
      || this.hasGoofishPartition(item, event.accountId)
    ))
    if (!account) return
    if (event.eventType === 'account-migrated' && nextId) {
      account.goofishClientAccountId = nextId
      try { account.partition = this.goofishClient.getEmbeddedWebviewConfig(nextId).partition } catch { /* the source partition remains persisted */ }
      const migrated = asRecord(payload.account)
      account.authenticated = migrated.status === 'authenticated'
      if (migrated.nickname) account.label = String(migrated.nickname)
      void this.save()
      return
    }
    let changed = false
    if (event.eventType === 'official-login-page') {
      account.authenticated = false
      changed = true
    }
    if (event.eventType === 'bridge-ready' || event.eventType === 'account-updated') {
      const metadata = event.eventType === 'account-updated' ? payload : asRecord(payload)
      account.authenticated = metadata.status === 'authenticated' || event.eventType === 'bridge-ready'
      if (metadata.nickname && !account.label) account.label = String(metadata.nickname)
      changed = true
      if (account.online && account.authenticated && this.shopRuntimes.snapshot(account.id)?.runtimeState !== 'running') {
        void this.setAccountOnline(account.id, true).catch((error) => {
          console.error(`[platform-hub] 闲鱼登录后启动监听失败: ${account.id}`, error)
        })
      }
    }
    if (event.eventType === 'connection-error' || event.eventType === 'connection-closed' || event.eventType === 'load-error') {
      account.connected = false
      changed = true
    }
    if (changed) void this.save()
  }

  private hasGoofishPartition(account: PlatformAccount, clientAccountId: string): boolean {
    try { return this.goofishClient.getEmbeddedWebviewConfig(clientAccountId).partition === account.partition } catch { return false }
  }

  private emitGoofishRuntimeError(accountId: string, error: unknown): void {
    const account = this.state.accounts.find((item) => item.id === accountId)
    if (!account) return
    const message = error instanceof Error ? error.message : String(error)
    this.publish({ id: `${accountId}:goofish:${Date.now()}:error`, accountId, platform: account.platform, type: 'error', timestamp: Date.now(), payload: { message } })
  }

  private publish(event: PlatformEvent): void {
    this.listeners.forEach((listener) => listener(event))
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
    const attributedEvent = runtime ? runtime.annotateEvent(event.accountId, event) : event
    if (runtime && attributedEvent.type === 'message') {
      const payload = attributedEvent.payload && typeof attributedEvent.payload === 'object' ? attributedEvent.payload as Record<string, unknown> : {}
      if (this.forwardedRuntimeEventIds.size >= 2_000) this.forwardedRuntimeEventIds.clear()
      this.forwardedRuntimeEventIds.add(attributedEvent.id)
      runtime.pushEvent(event.accountId, {
        id: attributedEvent.id,
        type: 'message.created',
        timestamp: attributedEvent.timestamp,
        payload: { message: payload.message || payload },
      })
    }
    this.publish(attributedEvent)
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
    const hookEvent = event.type === 'hook' && event.payload.event && typeof event.payload.event === 'object'
      ? event.payload.event
      : undefined
    const rawPayload = hookEvent && typeof hookEvent === 'object'
      ? (hookEvent as { payload?: unknown }).payload
      : event.payload
    const sourceType = hookEvent && typeof hookEvent === 'object' ? String((hookEvent as { type?: string }).type || '') : event.type
    const hookPayload = asRecord(rawPayload)
    let payload = sourceType === 'message.created' && hookEvent
      ? { message: toPlatformMessage(hookPayload.message as HookMessage) }
      : rawPayload
    if (sourceType === 'auth.changed' && hookEvent && account.platform === 'goofish') {
      const auth = asRecord(hookPayload.auth)
      account.connected = account.platform === 'goofish'
        ? Boolean(this.liveGoofishWebContentsId(this.goofishViews.get(account.id)))
        : account.connected
      account.authenticated = auth.authenticated === true
      const view = this.goofishViews.get(account.id)
      payload = {
        accountId: account.id,
        platform: account.platform,
        connected: account.connected,
        authenticated: account.authenticated,
        url: view?.webContents.getURL() || account.url,
        title: view?.webContents.getTitle(),
        message: account.authenticated ? '闲鱼已登录，Runtime 已就绪' : '请在当前闲鱼官方页面完成登录',
      } satisfies PlatformStatus
      void this.save()
    }
    const platformEventType: PlatformEvent['type'] = sourceType === 'message.created'
      ? 'message'
      : sourceType.startsWith('order.')
        ? 'order'
        : sourceType === 'auth.changed' || sourceType === 'connection'
          ? 'connection'
          : sourceType === 'runtime.error'
            ? 'error'
            : 'log'
    this.publish({
      id: `${event.accountId}:runtime:${event.timestamp}:${Math.random().toString(16).slice(2)}`,
      accountId: event.accountId,
      platform: account.platform,
      type: platformEventType,
      timestamp: event.timestamp,
      payload,
    })
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

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function temporaryGoofishAccountId(): string {
  return `${Date.now()}${randomInt(100_000, 1_000_000)}`
}

function isOfficialGoofishLoginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && ['goofish.com', 'taobao.com', 'alipay.com'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function toPlatformProduct(product: HookProduct): ProductRecord {
  return {
    id: product.id,
    goodsId: product.externalId,
    name: product.title,
    price: product.price?.amount || 0,
    status: product.status,
    images: product.images || [],
    goodsUrl: product.url,
    description: product.description,
    updatedAt: product.updatedAt,
    skuList: product.skus?.map((sku) => ({ skuId: sku.externalId || sku.id, skuName: sku.name, skuPrice: sku.price?.amount || 0 })),
    platform: 'goofish',
    raw: product.raw && typeof product.raw === 'object' ? product.raw as Record<string, unknown> : undefined,
  }
}

function toPlatformSession(session: HookSessionSummary): ChatSession {
  return {
    id: session.id,
    title: session.title,
    unread: session.unreadCount,
    lastMessage: session.lastMessage,
    updatedAt: session.updatedAt,
    avatar: session.avatarUrl,
  }
}

function toPlatformMessage(message: HookMessage): PlatformMessage {
  return {
    id: message.id,
    sessionId: message.conversationId,
    senderId: message.senderId || '',
    senderName: message.senderName || '',
    content: message.content,
    type: message.type,
    isMine: message.direction === 'outbound',
    direction: message.direction,
    origin: message.origin,
    timestamp: message.timestamp,
    raw: message.raw && typeof message.raw === 'object' ? message.raw as Record<string, unknown> : undefined,
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
