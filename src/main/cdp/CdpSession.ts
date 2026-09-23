import { EventEmitter } from 'node:events'
import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import type { HookPackageManifest, PlatformEvent, PlatformStatus } from '../../shared/platform'

type RuntimePage = NonNullable<HookPackageManifest['runtimePages']>[number]

const EVENT_POLL_INTERVAL_MS = 800
const AUTH_POLL_INTERVAL_MS = 15_000
const UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS = 2_000
const RUNTIME_PAGE_IDLE_MS = 2 * 60_000

interface RuntimePollResult {
  auth: Record<string, unknown> | null
  events: Array<{ type: string; payload: unknown; timestamp?: number }>
}

export interface CdpSessionOptions {
  accountId: string
  platform: string
  url: string
  partition: string
  hook: HookPackageManifest
  emit: (event: PlatformEvent) => void
  hostWindow: BrowserWindow
}

export class CdpSession extends EventEmitter {
  private window: BrowserWindow
  private primaryView: WebContentsView | null = null
  private primaryAttached = false
  private contents: WebContents | null = null
  private readonly runtimeWindows = new Map<string, BrowserWindow>()
  private readonly runtimeWindowIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private connected = false
  private authenticated = false
  private destroyed = false
  private opening: Promise<void> | null = null
  private primaryNavigation: Promise<void> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollInFlight = false
  private pollGeneration = 0
  private lastAuthPollAt = 0

  constructor(private readonly options: CdpSessionOptions) {
    super()
    this.window = options.hostWindow
  }

  async open(_show = true): Promise<void> {
    if (this.destroyed) throw new Error('CDP 会话已销毁')
    if (this.primaryView?.webContents.isDestroyed()) {
      // A renderer crash can destroy WebContents while leaving the wrapper
      // object around. Do not reuse the stale View or its polling generation.
      this.detachPrimaryView()
      this.primaryView = null
      this.contents = null
      this.connected = false
      this.stopRuntimePolling()
    }
    if (this.primaryView && !this.primaryView.webContents.isDestroyed()) {
      if (this.opening) await this.opening
      return
    }
    if (this.window.isDestroyed()) throw new Error('主工作台窗口已销毁')
    this.primaryView = new WebContentsView({
      webPreferences: {
        partition: this.options.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    this.primaryAttached = false
    this.primaryView.setVisible(false)
    this.contents = this.primaryView.webContents
    this.contents.setWindowOpenHandler(({ url }) => {
      if (this.isLoginUrl(url)) {
        void this.contents?.loadURL(url).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`))
      }
      return { action: 'deny' }
    })
    this.contents.on('did-finish-load', () => this.reinstallPrimaryHook(this.contents))
    this.contents.on('did-navigate', () => this.reinstallPrimaryHook(this.contents))
    this.contents.on('render-process-gone', (_event, details) => this.emitError(`页面进程退出: ${details.reason}`))
    const opening = this.contents.loadURL(this.options.url).then(() => this.installHook(this.contents, true))
    this.opening = opening
    try { await opening } finally { if (this.opening === opening) this.opening = null }
  }

  async installHook(contents: WebContents | null = this.contents, primary = true, pageId = primary ? 'primary' : undefined): Promise<void> {
    if (!contents || contents.isDestroyed()) return
    if (!this.options.hook.script) throw new Error('Hook 包没有可执行脚本')
    if (pageId) await this.evaluate(contents, `globalThis.__PLATFORM_HOOK_PAGE_ID__ = ${JSON.stringify(pageId)}`)
    await this.evaluate(contents, this.options.hook.script)
    if (primary) {
      this.connected = true
      this.startRuntimePolling()
      this.emitStatus('Hook 已通过 CDP 注入，等待平台事件')
      const diagnosis = await this.invoke<unknown[]>('diagnose').catch(() => [])
      console.info(`[platform-hub] ${this.options.platform} window runtime`, diagnosis)
    }
  }

  async waitForLogin(timeoutMs = 15 * 60_000, method?: string): Promise<void> {
    const route = method ? this.routeForMethod(method) : undefined
    const contents = route ? await this.openRuntimePage(route) : this.contents
    if (!contents || contents.isDestroyed()) throw new Error('页面尚未连接，请先打开平台页面')
    const started = Date.now()
    while (!this.destroyed && Date.now() - started < timeoutMs) {
      const result = await this.evaluate<Record<string, unknown>>(
        contents,
        `window.__platformHub && window.__platformHub.getAuthState()`,
      ).catch(() => null)
      const authenticated = result?.authenticated === true || result?.isLogin === true || result?.loggedIn === true || Boolean(result?.shopId || result?.userId)
      if (!route) this.markAuthenticated(authenticated)
      if (authenticated) {
        if (!route) await this.ensurePrimaryRuntimePage()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('等待平台登录超时，请完成登录后重试')
  }

  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    const route = this.routeForMethod(method)
    try {
      const contents = await this.contentsForMethod(method)
      return await this.evaluate<T>(
        contents,
        `window.__platformHub && window.__platformHub[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
      )
    } finally {
      if (route && !route.persistent) this.scheduleRuntimeWindowClose(route.id)
    }
  }

  bindHostWindow(window: BrowserWindow): void {
    if (this.window === window) return
    this.detachPrimaryView()
    this.window = window
  }

  hasPrimaryView(): boolean {
    return Boolean(this.primaryView && !this.primaryView.webContents.isDestroyed())
  }

  isPrimaryViewAttached(): boolean {
    return this.primaryAttached && this.hasPrimaryView()
  }

  attachPrimaryView(): void {
    if (this.destroyed) throw new Error('CDP 会话已销毁')
    const view = this.primaryView
    if (!view || view.webContents.isDestroyed()) throw new Error('主页面尚未创建，请先打开平台页面')
    if (this.window.isDestroyed()) throw new Error('主工作台窗口已销毁')
    if (this.primaryAttached) return
    this.window.contentView.addChildView(view)
    this.primaryAttached = true
    view.setVisible(true)
  }

  detachPrimaryView(): void {
    const view = this.primaryView
    if (!view) {
      this.primaryAttached = false
      return
    }
    if (this.primaryAttached && !this.window.isDestroyed()) this.window.contentView.removeChildView(view)
    this.primaryAttached = false
    if (!view.webContents.isDestroyed()) view.setVisible(false)
  }

  setPrimaryBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    if (this.primaryAttached && this.primaryView && !this.primaryView.webContents.isDestroyed()) this.primaryView.setBounds(bounds)
  }

  async showRuntimePageFor(method: string): Promise<void> {
    const route = this.routeForMethod(method)
    if (!route) {
      await this.ensurePrimaryRuntimePage()
      return
    }
    await this.openRuntimePage(route)
    const target = this.runtimeWindows.get(route.id)
    if (target && !target.isDestroyed()) {
      this.clearRuntimeWindowTimer(route.id)
      target.show()
      target.focus()
    }
  }

  getWebContentsId(): number | undefined {
    return this.contents && !this.contents.isDestroyed() ? this.contents.id : undefined
  }

  getStatus(): PlatformStatus {
    return {
      accountId: this.options.accountId,
      platform: this.options.platform,
      connected: this.connected,
      authenticated: this.authenticated,
      url: this.contents?.getURL() || this.options.url,
      title: this.contents?.getTitle(),
      message: this.connected ? (this.authenticated ? '已登录并监听中' : '页面已连接，等待登录') : '页面未连接',
    }
  }

  async refreshStatus(): Promise<PlatformStatus> {
    const state = await this.invoke<Record<string, unknown>>('getAuthState').catch(() => null)
    const authenticated = state?.authenticated === true || state?.isLogin === true || state?.loggedIn === true || Boolean(state?.shopId || state?.userId)
    this.markAuthenticated(authenticated)
    if (authenticated) await this.ensurePrimaryRuntimePage()
    return this.getStatus()
  }

  markAuthenticated(value: boolean): void {
    if (this.authenticated === value) return
    this.authenticated = value
    this.emitStatus(value ? '已检测到登录状态' : '需要登录平台账号')
  }

  close(): void {
    this.destroyed = true
    this.stopRuntimePolling()
    this.closeRuntimeWindows()
    if (this.primaryView) {
      this.detachPrimaryView()
      if (!this.primaryView.webContents.isDestroyed()) this.primaryView.webContents.close()
    }
    this.primaryAttached = false
    this.primaryView = null
    this.contents = null
    this.removeAllListeners()
  }

  private startRuntimePolling(): void {
    this.stopRuntimePolling()
    this.lastAuthPollAt = 0
    this.pollTimer = setInterval(() => { void this.pollRuntime() }, EVENT_POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
    void this.pollRuntime()
  }

  private stopRuntimePolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollGeneration += 1
    this.pollInFlight = false
  }

  private async pollRuntime(): Promise<void> {
    const contents = this.contents
    if (this.destroyed || this.pollInFlight || !contents || contents.isDestroyed()) return
    const now = Date.now()
    const authPollInterval = this.authenticated ? AUTH_POLL_INTERVAL_MS : UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS
    const includeAuth = now - this.lastAuthPollAt >= authPollInterval
    if (includeAuth) this.lastAuthPollAt = now
    const generation = this.pollGeneration
    this.pollInFlight = true
    try {
      const targets: Array<{ contents: WebContents; includeAuth: boolean }> = [{ contents, includeAuth }]
      for (const [id, target] of this.runtimeWindows) {
        const route = this.options.hook.runtimePages?.find((page) => page.id === id)
        if (!route?.persistent || target.isDestroyed()) continue
        targets.push({ contents: target.webContents, includeAuth: false })
      }
      const results = await Promise.all(targets.map(async (target) => {
        if (target.contents.isDestroyed()) return null
        try { return await this.evaluate<RuntimePollResult>(target.contents, this.runtimePollExpression(target.includeAuth)) } catch { return null }
      }))
      if (generation !== this.pollGeneration || contents !== this.contents || contents.isDestroyed()) return
      const primary = results[0]
      if (primary?.auth) this.applyAuthState(primary.auth)
      for (const result of results) for (const item of result?.events || []) this.emitRuntimeEvent(item)
    } catch {
      // Navigation and renderer teardown are recovered by the next hook install.
    } finally {
      if (generation === this.pollGeneration) this.pollInFlight = false
    }
  }

  private runtimePollExpression(includeAuth: boolean): string {
    return `(async () => {
      const api = window.__platformHub
      if (!api) return { auth: null, events: [] }
      const safely = async (method, fallback) => {
        try { return typeof api[method] === 'function' ? await api[method]() : fallback } catch { return fallback }
      }
      return {
        auth: ${includeAuth ? "await safely('getAuthState', null)" : 'null'},
        events: await safely('drainEvents', []),
      }
    })()`
  }

  private applyAuthState(record: Record<string, unknown>): void {
    const authenticated = record.authenticated === true || record.isLogin === true || record.loggedIn === true || Boolean(record.shopId || record.userId)
    if (authenticated === this.authenticated) return
    this.markAuthenticated(authenticated)
    if (authenticated) void this.ensurePrimaryRuntimePage().catch((error) => this.emitError(`进入消息接待页失败: ${String(error)}`))
  }

  private emitRuntimeEvent(item: { type: string; payload: unknown; timestamp?: number }): void {
    this.options.emit({
      id: `${this.options.accountId}:${item.type}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: item.type === 'message' ? 'message' : item.type === 'order' ? 'order' : item.type === 'error' ? 'error' : 'log',
      timestamp: item.timestamp || Date.now(),
      payload: item.payload,
    })
  }

  private routeForMethod(method: string): RuntimePage | undefined {
    return this.options.hook.runtimePages?.find((page) => page.methods.includes(method))
  }

  private async ensurePrimaryRuntimePage(): Promise<void> {
    if (this.window.isDestroyed() || !this.contents || this.contents.isDestroyed()) {
      throw new Error('页面尚未连接，请先打开平台页面')
    }
    if (this.sameRuntimePage(this.contents.getURL(), this.options.hook.url)) return
    if (this.primaryNavigation) return this.primaryNavigation

    const navigation = (async () => {
      this.emitStatus('登录成功，正在进入消息接待页')
      await this.contents!.loadURL(this.options.hook.url)
      if (!this.contents || this.contents.isDestroyed()) throw new Error('消息接待页加载后连接已失效')
      await this.installHook(this.contents, true)
      this.emitStatus('已进入消息接待页并开始监听')
    })()
    this.primaryNavigation = navigation
    try { await navigation } finally { if (this.primaryNavigation === navigation) this.primaryNavigation = null }
  }

  private sameRuntimePage(current: string, expected: string): boolean {
    try {
      const left = new URL(current)
      const right = new URL(expected)
      return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
    } catch {
      return current === expected
    }
  }

  private reinstallHook(contents: WebContents | null, primary: boolean, pageId?: string): void {
    void this.installHook(contents, primary, pageId).catch((error) => this.emitError(`Hook 注入失败: ${String(error)}`))
  }

  private reinstallPrimaryHook(contents: WebContents | null): void {
    if (!contents || contents.isDestroyed()) return
    const loginUrl = this.loginUrlFor(contents.getURL())
    if (loginUrl && !this.window.isDestroyed()) {
      this.emitStatus('正在打开平台官方登录页')
      void this.contents?.loadURL(loginUrl).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`))
      return
    }
    this.reinstallHook(contents, true)
  }

  private loginUrlFor(currentUrl: string): string | undefined {
    const loginUrl = this.options.hook.loginUrl
    if (!loginUrl) return undefined
    const patterns = this.options.hook.loginMatch || []
    return patterns.some((pattern) => this.matchesUrl(currentUrl, pattern)) ? loginUrl : undefined
  }

  private isLoginUrl(url: string): boolean {
    const loginUrl = this.options.hook.loginUrl
    if (!loginUrl) return false
    try { return new URL(url).origin === new URL(loginUrl).origin } catch { return false }
  }

  private matchesUrl(url: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp('^' + escaped + '$').test(url)
  }

  private async contentsForMethod(method: string): Promise<WebContents> {
    const route = this.routeForMethod(method)
    if (!route) {
      if (!this.contents || this.contents.isDestroyed()) throw new Error('页面尚未连接，请先打开平台页面')
      return this.contents
    }
    return this.openRuntimePage(route)
  }

  private async openRuntimePage(route: RuntimePage): Promise<WebContents> {
    let target = this.runtimeWindows.get(route.id)
    if (!target || target.isDestroyed()) {
      target = new BrowserWindow({
        width: 1260,
        height: 820,
        show: false,
        title: `${this.options.platform} · ${route.id}`,
        webPreferences: {
          partition: this.options.partition,
          contextIsolation: false,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      })
      this.runtimeWindows.set(route.id, target)
      const contents = target.webContents
      contents.on('did-finish-load', () => this.reinstallHook(contents, false, route.id))
      contents.on('render-process-gone', (_event, details) => this.emitError(`${route.id} 页面进程退出: ${details.reason}`))
      target.on('closed', () => {
        this.clearRuntimeWindowTimer(route.id)
        this.runtimeWindows.delete(route.id)
      })
      await this.loadRuntimeUrl(target, route.url)
    } else if (route.refreshBeforeInvoke) {
      await this.loadRuntimeUrl(target, route.url)
    }
    await this.installHook(target.webContents, false, route.id)
    return target.webContents
  }

  private async loadRuntimeUrl(target: BrowserWindow, url: string): Promise<void> {
    try {
      await target.loadURL(url)
    } catch (error) {
      if (target.isDestroyed()) throw error
      const currentUrl = target.webContents.getURL()
      const redirected = currentUrl && currentUrl !== 'about:blank' && currentUrl !== url
      if (!redirected || !String(error).includes('ERR_ABORTED')) throw error
      // Electron rejects loadURL when the official platform immediately redirects to
      // its login page. The redirected page is still valid and must remain available
      // so PlatformManager can surface it and wait for the user to authenticate.
    }
  }

  private scheduleRuntimeWindowClose(id: string): void {
    this.clearRuntimeWindowTimer(id)
    const timer = setTimeout(() => {
      this.runtimeWindowIdleTimers.delete(id)
      const target = this.runtimeWindows.get(id)
      if (target && !target.isDestroyed()) target.close()
    }, RUNTIME_PAGE_IDLE_MS)
    timer.unref?.()
    this.runtimeWindowIdleTimers.set(id, timer)
  }

  private clearRuntimeWindowTimer(id: string): void {
    const timer = this.runtimeWindowIdleTimers.get(id)
    if (timer) clearTimeout(timer)
    this.runtimeWindowIdleTimers.delete(id)
  }

  private closeRuntimeWindows(): void {
    for (const timer of this.runtimeWindowIdleTimers.values()) clearTimeout(timer)
    this.runtimeWindowIdleTimers.clear()
    for (const target of this.runtimeWindows.values()) if (!target.isDestroyed()) target.close()
    this.runtimeWindows.clear()
  }

  private async evaluate<T>(contents: WebContents, expression: string): Promise<T> {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    const response = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }) as { result?: { value?: T; description?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'CDP Runtime.evaluate 执行失败')
    }
    return response.result?.value as T
  }

  private emitStatus(message: string): void {
    const status = this.getStatus()
    this.options.emit({
      id: `${this.options.accountId}:status:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: 'connection',
      timestamp: Date.now(),
      payload: { ...status, message },
    })
  }

  private emitError(message: string): void {
    this.options.emit({
      id: `${this.options.accountId}:error:${Date.now()}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: 'error',
      timestamp: Date.now(),
      payload: { message },
    })
  }
}

export function partitionFor(platform: string, accountId: string): string {
  return `persist:platform-hub-${platform}-${accountId.replace(/[^a-z0-9_-]/gi, '_')}`
}

export function clearPartition(partition: string): void {
  void session.fromPartition(partition).clearStorageData()
}
