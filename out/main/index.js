import { WebContentsView, BrowserWindow, app, session, dialog, shell, ipcMain } from "electron";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { HOOK_PROTOCOL_VERSION } from "@platform-hub/hook-sdk";
import "node:module";
import { kuaishouHook as kuaishouHook$1 } from "@platform-hub/kuaishou-hook";
import { GoofishMessagingClient } from "@idle-fish/goofish-messaging";
import { GoofishTransport } from "@platform-hub/goofish-transport";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const EVENT_POLL_INTERVAL_MS = 800;
const AUTH_POLL_INTERVAL_MS = 15e3;
const UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS = 2e3;
const RUNTIME_PAGE_IDLE_MS = 2 * 6e4;
class CdpSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.window = options.hostWindow;
  }
  options;
  window;
  primaryView = null;
  primaryAttached = false;
  contents = null;
  runtimeWindows = /* @__PURE__ */ new Map();
  runtimeWindowIdleTimers = /* @__PURE__ */ new Map();
  connected = false;
  authenticated = false;
  destroyed = false;
  opening = null;
  primaryNavigation = null;
  pollTimer = null;
  pollInFlight = false;
  pollGeneration = 0;
  lastAuthPollAt = 0;
  async open(_show = true) {
    if (this.destroyed) throw new Error("CDP 会话已销毁");
    if (this.primaryView?.webContents.isDestroyed()) {
      this.detachPrimaryView();
      this.primaryView = null;
      this.contents = null;
      this.connected = false;
      this.stopRuntimePolling();
    }
    if (this.primaryView && !this.primaryView.webContents.isDestroyed()) {
      if (this.opening) await this.opening;
      return;
    }
    if (this.window.isDestroyed()) throw new Error("主工作台窗口已销毁");
    this.primaryView = new WebContentsView({
      webPreferences: {
        partition: this.options.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    });
    this.primaryAttached = false;
    this.primaryView.setVisible(false);
    this.contents = this.primaryView.webContents;
    this.contents.setWindowOpenHandler(({ url }) => {
      if (this.isLoginUrl(url)) {
        void this.contents?.loadURL(url).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
      }
      return { action: "deny" };
    });
    this.contents.on("did-finish-load", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("did-navigate", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("render-process-gone", (_event, details) => this.emitError(`页面进程退出: ${details.reason}`));
    const opening = this.contents.loadURL(this.options.url).then(() => this.installHook(this.contents, true));
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }
  async installHook(contents = this.contents, primary = true, pageId = primary ? "primary" : void 0) {
    if (!contents || contents.isDestroyed()) return;
    if (!this.options.hook.script) throw new Error("Hook 包没有可执行脚本");
    if (pageId) await this.evaluate(contents, `globalThis.__PLATFORM_HOOK_PAGE_ID__ = ${JSON.stringify(pageId)}`);
    await this.evaluate(contents, this.options.hook.script);
    if (primary) {
      this.connected = true;
      this.startRuntimePolling();
      this.emitStatus("Hook 已通过 CDP 注入，等待平台事件");
      const diagnosis = await this.invoke("diagnose").catch(() => []);
      console.info(`[platform-hub] ${this.options.platform} window runtime`, diagnosis);
    }
  }
  async waitForLogin(timeoutMs = 15 * 6e4, method) {
    const route = method ? this.routeForMethod(method) : void 0;
    const contents = route ? await this.openRuntimePage(route) : this.contents;
    if (!contents || contents.isDestroyed()) throw new Error("页面尚未连接，请先打开平台页面");
    const started = Date.now();
    while (!this.destroyed && Date.now() - started < timeoutMs) {
      const result = await this.evaluate(
        contents,
        `window.__platformHub && window.__platformHub.getAuthState()`
      ).catch(() => null);
      const authenticated = result?.authenticated === true || result?.isLogin === true || result?.loggedIn === true || Boolean(result?.shopId || result?.userId);
      if (!route) this.markAuthenticated(authenticated);
      if (authenticated) {
        if (!route) await this.ensurePrimaryRuntimePage();
        return;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    }
    throw new Error("等待平台登录超时，请完成登录后重试");
  }
  async invoke(method, ...args) {
    const route = this.routeForMethod(method);
    try {
      const contents = await this.contentsForMethod(method);
      return await this.evaluate(
        contents,
        `window.__platformHub && window.__platformHub[${JSON.stringify(method)}](...${JSON.stringify(args)})`
      );
    } finally {
      if (route && !route.persistent) this.scheduleRuntimeWindowClose(route.id);
    }
  }
  bindHostWindow(window) {
    if (this.window === window) return;
    this.detachPrimaryView();
    this.window = window;
  }
  hasPrimaryView() {
    return Boolean(this.primaryView && !this.primaryView.webContents.isDestroyed());
  }
  isPrimaryViewAttached() {
    return this.primaryAttached && this.hasPrimaryView();
  }
  attachPrimaryView() {
    if (this.destroyed) throw new Error("CDP 会话已销毁");
    const view = this.primaryView;
    if (!view || view.webContents.isDestroyed()) throw new Error("主页面尚未创建，请先打开平台页面");
    if (this.window.isDestroyed()) throw new Error("主工作台窗口已销毁");
    if (this.primaryAttached) return;
    this.window.contentView.addChildView(view);
    this.primaryAttached = true;
    view.setVisible(true);
  }
  detachPrimaryView() {
    const view = this.primaryView;
    if (!view) {
      this.primaryAttached = false;
      return;
    }
    if (this.primaryAttached && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    this.primaryAttached = false;
    if (!view.webContents.isDestroyed()) view.setVisible(false);
  }
  setPrimaryBounds(bounds) {
    if (this.primaryAttached && this.primaryView && !this.primaryView.webContents.isDestroyed()) this.primaryView.setBounds(bounds);
  }
  async showRuntimePageFor(method) {
    const route = this.routeForMethod(method);
    if (!route) {
      await this.ensurePrimaryRuntimePage();
      return;
    }
    await this.openRuntimePage(route);
    const target = this.runtimeWindows.get(route.id);
    if (target && !target.isDestroyed()) {
      this.clearRuntimeWindowTimer(route.id);
      target.show();
      target.focus();
    }
  }
  getWebContentsId() {
    return this.contents && !this.contents.isDestroyed() ? this.contents.id : void 0;
  }
  getStatus() {
    return {
      accountId: this.options.accountId,
      platform: this.options.platform,
      connected: this.connected,
      authenticated: this.authenticated,
      url: this.contents?.getURL() || this.options.url,
      title: this.contents?.getTitle(),
      message: this.connected ? this.authenticated ? "已登录并监听中" : "页面已连接，等待登录" : "页面未连接"
    };
  }
  async refreshStatus() {
    const state = await this.invoke("getAuthState").catch(() => null);
    const authenticated = state?.authenticated === true || state?.isLogin === true || state?.loggedIn === true || Boolean(state?.shopId || state?.userId);
    this.markAuthenticated(authenticated);
    if (authenticated) await this.ensurePrimaryRuntimePage();
    return this.getStatus();
  }
  markAuthenticated(value) {
    if (this.authenticated === value) return;
    this.authenticated = value;
    this.emitStatus(value ? "已检测到登录状态" : "需要登录平台账号");
  }
  close() {
    this.destroyed = true;
    this.stopRuntimePolling();
    this.closeRuntimeWindows();
    if (this.primaryView) {
      this.detachPrimaryView();
      if (!this.primaryView.webContents.isDestroyed()) this.primaryView.webContents.close();
    }
    this.primaryAttached = false;
    this.primaryView = null;
    this.contents = null;
    this.removeAllListeners();
  }
  startRuntimePolling() {
    this.stopRuntimePolling();
    this.lastAuthPollAt = 0;
    this.pollTimer = setInterval(() => {
      void this.pollRuntime();
    }, EVENT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    void this.pollRuntime();
  }
  stopRuntimePolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollGeneration += 1;
    this.pollInFlight = false;
  }
  async pollRuntime() {
    const contents = this.contents;
    if (this.destroyed || this.pollInFlight || !contents || contents.isDestroyed()) return;
    const now = Date.now();
    const authPollInterval = this.authenticated ? AUTH_POLL_INTERVAL_MS : UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS;
    const includeAuth = now - this.lastAuthPollAt >= authPollInterval;
    if (includeAuth) this.lastAuthPollAt = now;
    const generation = this.pollGeneration;
    this.pollInFlight = true;
    try {
      const targets = [{ contents, includeAuth }];
      for (const [id, target] of this.runtimeWindows) {
        const route = this.options.hook.runtimePages?.find((page) => page.id === id);
        if (!route?.persistent || target.isDestroyed()) continue;
        targets.push({ contents: target.webContents, includeAuth: false });
      }
      const results = await Promise.all(targets.map(async (target) => {
        if (target.contents.isDestroyed()) return null;
        try {
          return await this.evaluate(target.contents, this.runtimePollExpression(target.includeAuth));
        } catch {
          return null;
        }
      }));
      if (generation !== this.pollGeneration || contents !== this.contents || contents.isDestroyed()) return;
      const primary = results[0];
      if (primary?.auth) this.applyAuthState(primary.auth);
      for (const result of results) for (const item of result?.events || []) this.emitRuntimeEvent(item);
    } catch {
    } finally {
      if (generation === this.pollGeneration) this.pollInFlight = false;
    }
  }
  runtimePollExpression(includeAuth) {
    return `(async () => {
      const api = window.__platformHub
      if (!api) return { auth: null, events: [] }
      const safely = async (method, fallback) => {
        try { return typeof api[method] === 'function' ? await api[method]() : fallback } catch { return fallback }
      }
      return {
        auth: ${includeAuth ? "await safely('getAuthState', null)" : "null"},
        events: await safely('drainEvents', []),
      }
    })()`;
  }
  applyAuthState(record) {
    const authenticated = record.authenticated === true || record.isLogin === true || record.loggedIn === true || Boolean(record.shopId || record.userId);
    if (authenticated === this.authenticated) return;
    this.markAuthenticated(authenticated);
    if (authenticated) void this.ensurePrimaryRuntimePage().catch((error) => this.emitError(`进入消息接待页失败: ${String(error)}`));
  }
  emitRuntimeEvent(item) {
    this.options.emit({
      id: `${this.options.accountId}:${item.type}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: item.type === "message" ? "message" : item.type === "order" ? "order" : item.type === "error" ? "error" : "log",
      timestamp: item.timestamp || Date.now(),
      payload: item.payload
    });
  }
  routeForMethod(method) {
    return this.options.hook.runtimePages?.find((page) => page.methods.includes(method));
  }
  async ensurePrimaryRuntimePage() {
    if (this.window.isDestroyed() || !this.contents || this.contents.isDestroyed()) {
      throw new Error("页面尚未连接，请先打开平台页面");
    }
    if (this.sameRuntimePage(this.contents.getURL(), this.options.hook.url)) return;
    if (this.primaryNavigation) return this.primaryNavigation;
    const navigation = (async () => {
      this.emitStatus("登录成功，正在进入消息接待页");
      await this.contents.loadURL(this.options.hook.url);
      if (!this.contents || this.contents.isDestroyed()) throw new Error("消息接待页加载后连接已失效");
      await this.installHook(this.contents, true);
      this.emitStatus("已进入消息接待页并开始监听");
    })();
    this.primaryNavigation = navigation;
    try {
      await navigation;
    } finally {
      if (this.primaryNavigation === navigation) this.primaryNavigation = null;
    }
  }
  sameRuntimePage(current, expected) {
    try {
      const left = new URL(current);
      const right = new URL(expected);
      return left.origin === right.origin && left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
    } catch {
      return current === expected;
    }
  }
  reinstallHook(contents, primary, pageId) {
    void this.installHook(contents, primary, pageId).catch((error) => this.emitError(`Hook 注入失败: ${String(error)}`));
  }
  reinstallPrimaryHook(contents) {
    if (!contents || contents.isDestroyed()) return;
    const loginUrl = this.loginUrlFor(contents.getURL());
    if (loginUrl && !this.window.isDestroyed()) {
      this.emitStatus("正在打开平台官方登录页");
      void this.contents?.loadURL(loginUrl).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
      return;
    }
    this.reinstallHook(contents, true);
  }
  loginUrlFor(currentUrl) {
    const loginUrl = this.options.hook.loginUrl;
    if (!loginUrl) return void 0;
    const patterns = this.options.hook.loginMatch || [];
    return patterns.some((pattern) => this.matchesUrl(currentUrl, pattern)) ? loginUrl : void 0;
  }
  isLoginUrl(url) {
    const loginUrl = this.options.hook.loginUrl;
    if (!loginUrl) return false;
    try {
      return new URL(url).origin === new URL(loginUrl).origin;
    } catch {
      return false;
    }
  }
  matchesUrl(url, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(url);
  }
  async contentsForMethod(method) {
    const route = this.routeForMethod(method);
    if (!route) {
      if (!this.contents || this.contents.isDestroyed()) throw new Error("页面尚未连接，请先打开平台页面");
      return this.contents;
    }
    return this.openRuntimePage(route);
  }
  async openRuntimePage(route) {
    let target = this.runtimeWindows.get(route.id);
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
          backgroundThrottling: false
        }
      });
      this.runtimeWindows.set(route.id, target);
      const contents = target.webContents;
      contents.on("did-finish-load", () => this.reinstallHook(contents, false, route.id));
      contents.on("render-process-gone", (_event, details) => this.emitError(`${route.id} 页面进程退出: ${details.reason}`));
      target.on("closed", () => {
        this.clearRuntimeWindowTimer(route.id);
        this.runtimeWindows.delete(route.id);
      });
      await this.loadRuntimeUrl(target, route.url);
    } else if (route.refreshBeforeInvoke) {
      await this.loadRuntimeUrl(target, route.url);
    }
    await this.installHook(target.webContents, false, route.id);
    return target.webContents;
  }
  async loadRuntimeUrl(target, url) {
    try {
      await target.loadURL(url);
    } catch (error) {
      if (target.isDestroyed()) throw error;
      const currentUrl = target.webContents.getURL();
      const redirected = currentUrl && currentUrl !== "about:blank" && currentUrl !== url;
      if (!redirected || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
  scheduleRuntimeWindowClose(id) {
    this.clearRuntimeWindowTimer(id);
    const timer = setTimeout(() => {
      this.runtimeWindowIdleTimers.delete(id);
      const target = this.runtimeWindows.get(id);
      if (target && !target.isDestroyed()) target.close();
    }, RUNTIME_PAGE_IDLE_MS);
    timer.unref?.();
    this.runtimeWindowIdleTimers.set(id, timer);
  }
  clearRuntimeWindowTimer(id) {
    const timer = this.runtimeWindowIdleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.runtimeWindowIdleTimers.delete(id);
  }
  closeRuntimeWindows() {
    for (const timer of this.runtimeWindowIdleTimers.values()) clearTimeout(timer);
    this.runtimeWindowIdleTimers.clear();
    for (const target of this.runtimeWindows.values()) if (!target.isDestroyed()) target.close();
    this.runtimeWindows.clear();
  }
  async evaluate(contents, expression) {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const response = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP Runtime.evaluate 执行失败");
    }
    return response.result?.value;
  }
  emitStatus(message) {
    const status = this.getStatus();
    this.options.emit({
      id: `${this.options.accountId}:status:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: "connection",
      timestamp: Date.now(),
      payload: { ...status, message }
    });
  }
  emitError(message) {
    this.options.emit({
      id: `${this.options.accountId}:error:${Date.now()}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: "error",
      timestamp: Date.now(),
      payload: { message }
    });
  }
}
function partitionFor(platform, accountId) {
  return `persist:platform-hub-${platform}-${accountId.replace(/[^a-z0-9_-]/gi, "_")}`;
}
const DOUYIN_PLATFORM_ID = "douyin";
const DOUYIN_PRIMARY_PAGE_ID = "primary";
const DOUYIN_PRODUCTS_PAGE_ID = "products";
const DOUYIN_ORDERS_PAGE_ID = "orders";
const DOUYIN_PRIMARY_OPERATIONS = [
  "auth.state",
  "sessions.list",
  "messages.listen",
  "messages.history",
  "messages.send.text",
  "messages.send.file",
  "conversation.attention.set",
  "handoff.targets.list",
  "handoff.transfer"
];
const DOUYIN_PRODUCTS_OPERATIONS = [
  "products.list",
  "products.detail"
];
const DOUYIN_ORDERS_OPERATIONS = [
  "orders.list",
  "orders.listen"
];
const douyinHookManifest = {
  version: "1.1.0",
  capabilities: [...DOUYIN_PRIMARY_OPERATIONS, ...DOUYIN_PRODUCTS_OPERATIONS, ...DOUYIN_ORDERS_OPERATIONS],
  pages: [
    {
      id: DOUYIN_PRIMARY_PAGE_ID,
      kind: "primary",
      url: "https://im.jinritemai.com/pc_seller_v2/main/workspace"
    },
    {
      id: DOUYIN_PRODUCTS_PAGE_ID,
      kind: "worker",
      url: "https://fxg.jinritemai.com/ffa/g/list?tab=all",
      idleTtlMs: 3e4
    },
    {
      id: DOUYIN_ORDERS_PAGE_ID,
      kind: "persistent",
      // The merchant home is the resident page that receives the official
      // order notification runtime. The order API is available in this same
      // authenticated fxg partition.
      url: "https://fxg.jinritemai.com/ffa/arrival-pages/home"
    }
  ]
};
const douyinHookRuntimeScript = String.raw`(() => {
  const KEY = '__PLATFORM_HOOK__'
  const VERSION = ${HOOK_PROTOCOL_VERSION}
  const PLATFORM = ${JSON.stringify(DOUYIN_PLATFORM_ID)}
  const PAGE = window.__PLATFORM_HOOK_PAGE_ID__ || (/fxg\.jinritemai\.com/i.test(String(location?.hostname || '')) ? 'products' : 'primary')
  const primaryOperations = ${JSON.stringify(DOUYIN_PRIMARY_OPERATIONS)}
  const productOperations = ${JSON.stringify(DOUYIN_PRODUCTS_OPERATIONS)}
  const orderOperations = ['orders.list', 'orders.listen']
  const operations = PAGE === 'products' ? productOperations : PAGE === 'orders' ? orderOperations : primaryOperations
  const existing = window[KEY]
  if (existing && !existing.__disposed && existing.protocolVersion === VERSION && existing.describe?.().pageId === PAGE) return
  try { existing?.dispose?.() } catch (_) {}

  const queue = []
  const seenMessages = new Set()
  const seenFingerprints = new Set()
  const orderSnapshots = new Map()
  const messageOrderSnapshots = new Map()
  const conversationAttention = new Map()
  let disposed = false
  let messageCleanup = null
  let conversationAttentionObserver = null
  let conversationAttentionStyle = null
  let conversationAttentionRenderTimer = null
  let orderReconciliationTimer = null
  let orderReconciliationBusy = false
  let orderNotificationCleanup = null
  let orderNotificationSources = []
  let orderNotificationBindingMode = ''
  let orderDomainRefreshTimer = null
  let orderDomainRefreshBusy = false
  let orderDomainRefreshDirty = false
  let orderDomainRefreshController = null
  const orderRefreshes = new Map()
  const retryTimers = new Map()
  let orderReconciliationController = null
  const listenerState = () => {
    try { return window.sessionStorage?.getItem('__PLATFORM_HOOK_ORDER_LISTENING__') === '1' || window.__PLATFORM_HOOK_ORDER_LISTENING__ === true } catch (_) { return window.__PLATFORM_HOOK_ORDER_LISTENING__ === true }
  }
  const listenerStartedAt = () => {
    try { return Number(window.sessionStorage?.getItem('__PLATFORM_HOOK_ORDER_LISTENER_STARTED_AT__')) || Number(window.__PLATFORM_HOOK_ORDER_LISTENER_STARTED_AT__) || 0 } catch (_) { return Number(window.__PLATFORM_HOOK_ORDER_LISTENER_STARTED_AT__) || 0 }
  }
  const setListenerState = (startedAt) => {
    window.__PLATFORM_HOOK_ORDER_LISTENING__ = true
    window.__PLATFORM_HOOK_ORDER_LISTENER_STARTED_AT__ = startedAt
    try {
      window.sessionStorage?.setItem('__PLATFORM_HOOK_ORDER_LISTENING__', '1')
      window.sessionStorage?.setItem('__PLATFORM_HOOK_ORDER_LISTENER_STARTED_AT__', String(startedAt))
    } catch (_) {}
  }
  let orderListening = listenerState()
  let orderListenerStartedAt = listenerStartedAt()
  const processingFingerprints = new Set()
  const processedFingerprints = new Set()
  const outboundCorrelations = []
  const automatedOutboundIds = new Set()
  const OUTBOUND_CORRELATION_TTL_MS = 30_000
  const ORDER_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000
  const ORDER_RECONCILIATION_LIMIT = 20
  const ORDER_QUERY_RETRY_DELAYS_MS = [0, 300, 1000, 2500]
  const ORDER_DOMAIN_WAKEUP_DEBOUNCE_MS = 500

  const store = () => window.ss?._frontStore || window.ss?.instance || null
  const pageContext = () => window.__mona_pigeon_event?.globalStore?.data?.initContextData || null
  const im = () => pageContext()?.im || null
  const pagePost = () => pageContext()?.post
  const pcUIState = () => {
    const context = pageContext()
    try { return context?.zContainer?.get?.(context?.PCUIModelSymbol)?.getData?.() || null } catch (_) { return null }
  }
  const values = (value) => {
    if (!value) return []
    if (Array.isArray(value)) return [...value]
    try { if (typeof value.values === 'function') return [...value.values()] } catch (_) {}
    try { return Object.values(value) } catch (_) { return [] }
  }
  const json = (value) => {
    if (value && typeof value === 'object') return value
    if (typeof value !== 'string') return {}
    try { return JSON.parse(value) || {} } catch (_) { return {} }
  }
  const text = (value) => value == null ? '' : String(value)
  const identifier = (value) => {
    const result = text(value).trim()
    return result && !['-1', '0', 'null', 'undefined'].includes(result.toLowerCase()) ? result : ''
  }
  const number = (value) => {
    const result = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''))
    return Number.isFinite(result) ? result : undefined
  }
  const time = (value) => {
    const result = number(value)
    if (result !== undefined) return result > 0 && result < 100000000000 ? result * 1000 : result
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const wait = (delayMs) => delayMs > 0 && typeof setTimeout === 'function'
    ? new Promise((resolve) => {
      const timer = setTimeout(() => { retryTimers.delete(timer); resolve() }, delayMs)
      retryTimers.set(timer, resolve)
    })
    : Promise.resolve()
  const snapshot = (value) => {
    if (!value) return value
    try { return typeof value.toJSON === 'function' ? value.toJSON() : JSON.parse(JSON.stringify(value)) } catch (_) { return value }
  }
  const array = (value) => {
    if (Array.isArray(value)) return value
    const item = value && typeof value === 'object' ? value : {}
    for (const candidate of [item.data, item.list, item.items, item.records, item.data?.list, item.data?.items, item.data?.records]) if (Array.isArray(candidate)) return candidate
    return []
  }
  const attributionMetadata = (item, ext) => {
    const safe = {}
    for (const [prefix, source] of [['item', item], ['ext', ext]]) {
      for (const [key, value] of Object.entries(source || {})) {
        if (!/(source|sender|role|staff|agent|operator|manual|client|device|from|mine|creator)/i.test(key)) continue
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safe[prefix + '.' + key] = value
      }
    }
    safe.manualSendCheck = Boolean(text(ext?.['p:check_Send'] || ext?.['p:check_send'] || ext?.p_check_send))
    return safe
  }
  const emit = (event) => {
    if (disposed) return
    queue.push({ ...event, timestamp: event.timestamp || Date.now() })
    if (queue.length > 500) queue.splice(0, queue.length - 500)
  }
  const trackOutbound = (conversationId, type, content) => {
    const entry = { conversationId, type, fingerprint: type === 'text' ? text(content).trim() : '', createdAt: Date.now(), serverId: '' }
    outboundCorrelations.push(entry)
    if (outboundCorrelations.length > 500) outboundCorrelations.splice(0, outboundCorrelations.length - 500)
    return entry
  }
  const removeOutbound = (entry) => {
    const index = outboundCorrelations.indexOf(entry)
    if (index >= 0) outboundCorrelations.splice(index, 1)
  }
  const rememberAutomatedOutbound = (id) => {
    if (!id) return
    automatedOutboundIds.delete(id)
    automatedOutboundIds.add(id)
    while (automatedOutboundIds.size > 5_000) automatedOutboundIds.delete(automatedOutboundIds.values().next().value)
  }
  const correlateOutbound = (item) => {
    if (item.direction !== 'outbound') return item
    const now = Date.now()
    while (outboundCorrelations.length && now - outboundCorrelations[0].createdAt > OUTBOUND_CORRELATION_TTL_MS) outboundCorrelations.shift()
    if (automatedOutboundIds.has(item.id)) return { ...item, origin: 'automation' }
    const index = outboundCorrelations.findIndex((entry) => entry.conversationId === item.conversationId
      && entry.type === item.type
      && (entry.serverId === item.id || ((!entry.fingerprint || entry.fingerprint === text(item.content).trim())
        && item.timestamp >= entry.createdAt - 5_000 && item.timestamp <= entry.createdAt + OUTBOUND_CORRELATION_TTL_MS)))
    if (index < 0) return item
    outboundCorrelations.splice(index, 1)
    if (item.id && !item.id.startsWith('pending-')) rememberAutomatedOutbound(item.id)
    return { ...item, origin: 'automation' }
  }
  const error = (code, message, retryable = false) => ({ ok: false, error: { code, message, retryable } })
  const loginError = () => error('LOGIN_REQUIRED', '请在抖店官方页面完成登录后继续')
  const runtimeError = () => error('RUNTIME_NOT_READY', '抖店页面尚未暴露所需运行时能力', true)
  const auth = async () => {
    if (/captcha|verify|challenge|risk/i.test(String(location?.pathname || '') + String(location?.search || ''))) {
      return error('CHALLENGE_REQUIRED', '抖店要求完成官方安全验证', true)
    }
    const primaryRedirectedHome = PAGE === 'primary'
      && /(^|\.)fxg\.jinritemai\.com$/i.test(String(location?.hostname || ''))
      && /^\/ffa\/mshop\/homepage(?:\/|$)/i.test(String(location?.pathname || ''))
    if (primaryRedirectedHome) {
      try { window.location?.replace?.('https://im.jinritemai.com/pc_seller_v2/main/workspace') } catch (_) {}
      return error('RUNTIME_NOT_READY', '抖店已登录，正在返回飞鸽客服工作台', true)
    }
    const current = store()
    const shopId = identifier(current?.shopInfo?.id || window.__mona_store__?.shopId || window.__shop_id)
    const userId = identifier(current?.selfInfo?.id)
    if (shopId || userId) return {
      ok: true,
      data: {
        authenticated: true,
        ...(shopId ? { shopId } : {}),
        ...(userId ? { userId } : {}),
        checkedAt: Date.now(),
      },
    }
    const getters = window.__STORE__GETTERS__
    try {
      const loggedIn = typeof getters?.isLogin === 'function' ? getters.isLogin() : getters?.isLogin
      const user = typeof getters?.user === 'function' ? getters.user() : getters?.user
      const getterShopId = identifier(user?.shop_id || user?.shopId)
      const getterUserId = identifier(user?.id || user?.user_id)
      if (loggedIn === true || getterShopId || getterUserId) return {
        ok: true,
        data: { authenticated: true, shopId: getterShopId || undefined, userId: getterUserId || undefined, checkedAt: Date.now() },
      }
    } catch (_) {}
    // Product workers do not reliably expose the primary page store.  Their
    // authenticated state is established by the same-origin official product
    // request below, never by the GOODS_SWR_CACHE_V1 page cache.
    if (PAGE === 'products' && /fxg\.jinritemai\.com/i.test(String(location?.hostname || '')) && /^\/ffa\/g\/list(?:\/|$)/i.test(String(location?.pathname || ''))) {
      return { ok: true, data: { authenticated: true, checkedAt: Date.now() } }
    }
    if (/^\/login(?:\/|$)/i.test(String(location?.pathname || ''))) return { ok: true, data: { authenticated: false, checkedAt: Date.now() } }
    return error('RUNTIME_NOT_READY', '抖店账号状态 Runtime 尚未准备好', true)
  }
  const requireAuth = async () => {
    const result = await auth()
    return result.ok && result.data.authenticated ? null : result
  }
  const handoffTargets = async () => {
    const transfer = store()?.uiState?.chatRooms?.transferConv
    if (!transfer) return null
    if (!values(transfer.canTransferServiceList).length && typeof transfer.fetchTransferServiceList === 'function') await transfer.fetchTransferServiceList()
    if (!values(transfer.canTransferGroupList).length && typeof transfer.fetchTransferGroupList === 'function') await transfer.fetchTransferGroupList()
    const targets = []
    const seen = new Set()
    for (const item of [...values(transfer.canTransferServiceList), ...values(transfer.canTransferGroupList)]) {
      const id = identifier(item?.id || item?.staffId || item?.userId)
      const name = text(item?.name || item?.title || item?.staffName).trim()
      if (!id && !name) continue
      const key = id + ':' + name
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ ...(id ? { id } : {}), name: name || id })
    }
    return { transfer, targets }
  }
  const conversations = () => {
    const info = store()?.conversationsInfo
    if (!info) return []
    const result = []
    const seen = new Set()
    for (const source of [info.unClosedConversations, info.closedConversations, info.normalCurrentConversations, info.platformMessageConversations]) {
      for (const raw of values(source)) {
        const value = snapshot(raw) || {}
        const id = text(value.id || value.conversationId)
        if (!id || seen.has(id)) continue
        seen.add(id); result.push({ raw, value })
      }
    }
    return result
  }
  const talker = (conversation) => {
    const buyerId = text(conversation?.buyerId || conversation?.currentTalkId)
    try { return snapshot(store()?.talkerMap?.getTalkerInfo?.(buyerId)) || {} } catch (_) { return {} }
  }
  const sessionRows = () => conversations().map(({ raw, value }) => {
    const person = talker(raw)
    const last = snapshot(raw?.lastMessage || raw?.lastAnyMessage || value.lastMessage || value.lastAnyMessage) || {}
    return {
      id: text(value.id),
      title: text(person.name || person.screenName || person.nickName || person.nickname || value.rawExt?.fusion_uname || value.buyerName) || '用户',
      unreadCount: number(value.unreadCount || value.unread) || 0,
      ...(text(last.content || last.text || last.message) ? { lastMessage: text(last.content || last.text || last.message) } : {}),
      ...(time(last.createTime || last.timestamp || value.versionTime) ? { updatedAt: time(last.createTime || last.timestamp || value.versionTime) } : {}),
      ...(text(person.avatar || person.avatarUrl) ? { avatarUrl: text(person.avatar || person.avatarUrl) } : {}),
    }
  }).filter((item) => item.id)
  const conversationFor = (conversationId) => conversations().find(({ value }) => text(value.id) === text(conversationId))
  const ATTENTION_STYLE_ID = 'platform-hook-douyin-conversation-attention-style'
  const ATTENTION_ROW_SELECTOR = '[data-kora="conversation"], [data-qa-id="qa-chat-item"]'
  const ATTENTION_CLASS = 'platform-hook-douyin-conversation-attention'
  const ATTENTION_PENDING_CLASS = ATTENTION_CLASS + '--pending'
  const ATTENTION_OPENED_CLASS = ATTENTION_CLASS + '--opened'
  const attentionDocument = () => {
    try { return window.document || null } catch (_) { return null }
  }
  const activeAttentionId = (value) => {
    if (!['string', 'number', 'bigint'].includes(typeof value)) return ''
    const id = identifier(value)
    if (conversationAttention.has(id)) return id
    // ConversationCard stores the buyer segment as its React key; the Hook contract uses the full conversation id.
    for (const conversationId of conversationAttention.keys()) {
      if (text(conversationId).split(':')[0] === id) return conversationId
    }
    return ''
  }
  const attentionIdFromReact = (row) => {
    const roots = []
    try {
      for (const key of Object.getOwnPropertyNames(row || {})) {
        if (!/^__(?:react(?:Props|Fiber|Container|EventHandlers)|reactInternalInstance)\$/.test(key)) continue
        try { roots.push(row[key]) } catch (_) {}
      }
    } catch (_) {}
    const visited = new Set()
    const visit = (value, depth, allowGenericId = false) => {
      const direct = activeAttentionId(value)
      if (direct || !value || !['object', 'function'].includes(typeof value) || depth > 5 || visited.has(value)) return direct
      visited.add(value)
      const candidateKeys = allowGenericId
        ? ['id', 'conversationId', 'conversation_id', 'sessionId', 'session_id', 'chatId', 'chat_id']
        : ['conversationId', 'conversation_id', 'sessionId', 'session_id', 'chatId', 'chat_id']
      for (const key of candidateKeys) {
        let candidate
        try { candidate = value[key] } catch (_) { continue }
        const id = activeAttentionId(candidate)
        if (id) return id
      }
      for (const key of ['conversation', 'session', 'chat', 'target', 'item']) {
        let nested
        try { nested = value[key] } catch (_) { continue }
        const id = visit(nested, depth + 1, true)
        if (id) return id
      }
      let keys = []
      try { keys = Object.getOwnPropertyNames(value).slice(0, 80) } catch (_) { return '' }
      for (const key of keys) {
        if (!/(conversation|session|chat|props|memoized|pending|data|item)/i.test(key)) continue
        let nested
        try { nested = value[key] } catch (_) { continue }
        const id = visit(nested, depth + 1, false)
        if (id) return id
      }
      return ''
    }
    const visitReactParents = (root) => {
      let current = root
      const visitedParents = new Set()
      for (let depth = 0; current && depth < 12 && !visitedParents.has(current); depth += 1) {
        visitedParents.add(current)
        const id = activeAttentionId(current.key)
        if (id) return id
        try { current = current.return } catch (_) { break }
      }
      return ''
    }
    for (const root of roots) {
      const id = visit(root, 0, false)
      if (id) return id
      const parentId = visitReactParents(root)
      if (parentId) return parentId
    }
    return ''
  }
  const attentionIdForRow = (row) => {
    if (!row) return ''
    for (const name of ['data-conversation-id', 'data-conversationid', 'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid', 'data-id']) {
      try { const id = activeAttentionId(row.getAttribute?.(name)); if (id) return id } catch (_) {}
    }
    try {
      for (const [name, value] of Object.entries(row.dataset || {})) {
        if (!/(conversation|session|chat|id)/i.test(name)) continue
        const id = activeAttentionId(value)
        if (id) return id
      }
    } catch (_) {}
    try {
      for (const attribute of Array.from(row.attributes || [])) {
        if (!/(conversation|session|chat|data-id)/i.test(attribute?.name || '')) continue
        const id = activeAttentionId(attribute?.value)
        if (id) return id
      }
    } catch (_) {}
    return attentionIdFromReact(row)
  }
  const attentionRows = () => {
    const doc = attentionDocument()
    try { return Array.from(doc?.querySelectorAll?.(ATTENTION_ROW_SELECTOR) || []) } catch (_) { return [] }
  }
  const attentionClassPresent = (row, name) => {
    try { return Boolean(row?.classList?.contains?.(name)) } catch (_) { return false }
  }
  const setAttentionClass = (row, name, enabled) => {
    if (attentionClassPresent(row, name) === enabled) return
    try { row?.classList?.[enabled ? 'add' : 'remove']?.(name) } catch (_) {}
  }
  const clearAttentionRow = (row) => {
    setAttentionClass(row, ATTENTION_CLASS, false)
    setAttentionClass(row, ATTENTION_PENDING_CLASS, false)
    setAttentionClass(row, ATTENTION_OPENED_CLASS, false)
    try {
      if (row?.getAttribute?.('data-platform-hook-conversation-attention') !== null) {
        row.removeAttribute?.('data-platform-hook-conversation-attention')
      }
    } catch (_) {}
  }
  const applyConversationAttention = () => {
    for (const row of attentionRows()) {
      const conversationId = attentionIdForRow(row)
      const state = conversationId ? conversationAttention.get(conversationId) : undefined
      if (!state) {
        clearAttentionRow(row)
        continue
      }
      setAttentionClass(row, ATTENTION_CLASS, true)
      setAttentionClass(row, ATTENTION_PENDING_CLASS, state === 'pending')
      setAttentionClass(row, ATTENTION_OPENED_CLASS, state === 'opened')
      try {
        if (row.getAttribute?.('data-platform-hook-conversation-attention') !== state) {
          row.setAttribute?.('data-platform-hook-conversation-attention', state)
        }
      } catch (_) {}
    }
  }
  const ensureAttentionStyle = () => {
    const doc = attentionDocument()
    if (!doc?.createElement) return
    const current = doc.getElementById?.(ATTENTION_STYLE_ID)
    if (current) { conversationAttentionStyle = current; return }
    const root = doc.head || doc.documentElement || doc.body
    if (!root?.appendChild) return
    const style = doc.createElement('style')
    style.id = ATTENTION_STYLE_ID
    style.textContent = [
      '@keyframes platformHookDouyinConversationAttentionPulse{0%,100%{box-shadow:inset 3px 0 0 #ff4d4f;background-color:rgba(255,77,79,.12)}50%{box-shadow:inset 5px 0 0 #ff7875;background-color:rgba(255,77,79,.28)}}',
      '.' + ATTENTION_CLASS + '{box-shadow:inset 3px 0 0 #ff4d4f!important;background-color:rgba(255,77,79,.12)!important}',
      '.' + ATTENTION_PENDING_CLASS + '{animation:platformHookDouyinConversationAttentionPulse 1.1s ease-in-out infinite!important}',
      '.' + ATTENTION_OPENED_CLASS + '{animation:none!important}',
    ].join('')
    root.appendChild(style)
    conversationAttentionStyle = style
  }
  const renderConversationAttention = () => {
    if (conversationAttention.size) ensureAttentionStyle()
    applyConversationAttention()
  }
  const scheduleConversationAttentionRender = () => {
    if (disposed || !conversationAttention.size || conversationAttentionRenderTimer) return
    if (typeof setTimeout !== 'function') { renderConversationAttention(); return }
    conversationAttentionRenderTimer = setTimeout(() => {
      conversationAttentionRenderTimer = null
      if (!disposed && conversationAttention.size) renderConversationAttention()
    }, 80)
  }
  const removeAttentionStyle = () => {
    const doc = attentionDocument()
    const style = conversationAttentionStyle || doc?.getElementById?.(ATTENTION_STYLE_ID)
    try { style?.parentNode?.removeChild?.(style) } catch (_) {}
    conversationAttentionStyle = null
  }
  const stopConversationAttentionProjection = () => {
    try { conversationAttentionObserver?.disconnect?.() } catch (_) {}
    conversationAttentionObserver = null
    if (conversationAttentionRenderTimer) {
      try { clearTimeout?.(conversationAttentionRenderTimer) } catch (_) {}
      conversationAttentionRenderTimer = null
    }
    removeAttentionStyle()
  }
  const ensureConversationAttentionProjection = () => {
    renderConversationAttention()
    if (conversationAttentionObserver) return
    const doc = attentionDocument()
    const root = doc?.documentElement || doc?.body
    const Observer = window.MutationObserver
    if (!root || typeof Observer !== 'function') return
    try {
      conversationAttentionObserver = new Observer(() => { scheduleConversationAttentionRender() })
      conversationAttentionObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-conversation-id', 'data-conversationid', 'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid', 'data-id'],
      })
    } catch (_) { conversationAttentionObserver = null }
  }
  const setConversationAttention = (input) => {
    const conversationId = identifier(input?.conversationId)
    const state = text(input?.state)
    if (!conversationId) return error('INVALID_INPUT', 'conversationId 必填')
    if (!['pending', 'opened', 'resolved'].includes(state)) return error('INVALID_INPUT', 'state 必须是 pending、opened 或 resolved')
    if (state === 'resolved') {
      conversationAttention.delete(conversationId)
      applyConversationAttention()
      if (!conversationAttention.size) stopConversationAttentionProjection()
      return { ok: true, data: { conversationId, state, active: false } }
    }
    conversationAttention.set(conversationId, state)
    ensureConversationAttentionProjection()
    return { ok: true, data: { conversationId, state, active: true } }
  }
  const buyerFor = (conversationId) => {
    const conversation = conversationFor(conversationId)
    const person = conversation ? talker(conversation.raw) : {}
    return text(conversation?.value?.buyerId || conversation?.value?.currentTalkId || conversation?.value?.userId || person.id || person.userId)
  }
  const transferViaOfficialApi = async (conversationId, targetId) => {
    const current = store()
    const shopId = identifier(current?.shopInfo?.id)
    const buyerId = identifier(buyerFor(conversationId) || text(conversationId).split(':')[0])
    if (!shopId || !buyerId) return error('RUNTIME_NOT_READY', '抖店转接缺少真实店铺或买家身份', true)
    const post = pagePost()
    if (typeof post !== 'function') return runtimeError()
    const response = await post('https://pigeon.jinritemai.com/chat/api/backstage/conversation/transfer_conversation?PIGEON_BIZ_TYPE=2', {
      securityBizConversationId: buyerId + ':' + shopId + '::2:1:pigeon',
      toCid: targetId,
      extParams: '{}',
    })
    const payload = response?.data && typeof response.data === 'object' ? response.data : response || {}
    const code = payload?.code ?? payload?.status_code ?? payload?.statusCode
    const failedCode = code !== undefined && ![0, '0', 200, '200'].includes(code)
    if (response?.success === false || payload?.success === false || failedCode) {
      return error('PLATFORM_ERROR', text(payload?.message || payload?.msg || response?.message || '转人工失败'), false)
    }
    return { ok: true }
  }
  const product = (raw) => {
    const item = raw && typeof raw === 'object' ? raw : {}
    const externalId = text(item.goodsId ?? item.goods_id ?? item.productId ?? item.product_id ?? item.id)
    if (!externalId) return undefined
    const shopId = text(item.shopId ?? item.shop_id ?? item.sellerId ?? store()?.shopInfo?.id)
    const cents = item.discount_price !== undefined ? item.discount_price : item.discountPrice
    const rawPrice = cents !== undefined ? number(cents) / 100 : number(item.price)
    const imageValues = Array.isArray(item.images || item.pics || item.image_list) ? (item.images || item.pics || item.image_list) : (item.img ? [item.img] : [])
    const skus = array(item.skus || item.skuList).map((sku) => {
      const skuAmount = number(sku.skuPrice ?? sku.price)
      return {
        id: text(sku.skuId || sku.sku_id || sku.id) || externalId + ':default',
        externalId: text(sku.skuId || sku.sku_id || sku.id) || undefined,
        name: text(sku.skuName || sku.spec_desc || sku.name) || '默认',
        ...(skuAmount !== undefined ? { price: { amount: sku.skuPrice === undefined && sku.price !== undefined ? skuAmount / 100 : skuAmount, currency: 'CNY' } } : {}),
        ...(number(sku.stockQuantity ?? sku.stock_num ?? sku.stock) !== undefined ? { stockQuantity: number(sku.stockQuantity ?? sku.stock_num ?? sku.stock) } : {}),
      }
    })
    const status = text(item.status ?? item.product_status).toLowerCase()
    const statusText = text(item.tab || item.status_text || item.status_desc || item.put_status_text).toLowerCase()
    const statusSource = status + ' ' + statusText
    // /product/tproduct/list is requested with is_online=1. Prefer an
    // explicit status marker from this response; the current API returns
    // status=0 for saleable rows, so tab/is_online are also accepted markers.
    const normalizedStatus = /off[_ -]?sale|off.?line|下架|停售|已下架|审核驳回/.test(statusSource)
      ? (/草稿|draft/.test(statusSource) ? 'draft' : 'off_sale')
      : /on[_ -]?sale|selling|online|在售|售卖中|上架/.test(statusSource)
        ? 'on_sale'
        : ['1', '2'].includes(status) || item.is_online === 1 || item.is_online === true
          ? 'on_sale'
          : /草稿|draft/.test(statusSource) ? 'draft' : 'unknown'
    return {
      id: 'douyin:' + (shopId || 'unknown') + ':' + externalId,
      externalId,
      title: text(item.name || item.title || item.product_name) || '未命名商品',
      ...(text(item.description || item.desc) ? { description: text(item.description || item.desc) } : {}),
      status: normalizedStatus,
      ...(rawPrice !== undefined ? { price: { amount: rawPrice, currency: 'CNY' } } : {}),
      ...(number(item.stockQuantity ?? item.stock_num ?? item.stock) !== undefined ? { stockQuantity: number(item.stockQuantity ?? item.stock_num ?? item.stock) } : {}),
      images: imageValues.map((image) => typeof image === 'string' ? image : text(image?.url)).filter(Boolean),
      skus,
      ...(text(item.goodsUrl || item.product_url || item.detail_url) ? { url: text(item.goodsUrl || item.product_url || item.detail_url) } : {}),
      ...(time(item.updatedAt || item.update_time || item.modify_time) ? { updatedAt: time(item.updatedAt || item.update_time || item.modify_time) } : {}),
      raw: {
        platformStatus: item.status ?? item.product_status,
        platformTab: item.tab,
        platformIsShow: item.is_show,
        platformPutStatus: item.put_status,
        authoritativeScope: 'is_online=1',
      },
    }
  }
  const PRODUCT_LIST_PATH = '/product/tproduct/list'
  const PRODUCT_PAGE_SIZE = 100
  const PRODUCT_QUERY = {
    check_status: '',
    group_id: '',
    sku_type: '',
    tab: 'all',
    business_type: '4',
    is_online: '1',
    not_for_sale_search_type: '1',
    from_mng: '1',
    supply_status: '',
    need_auto_rectify_info: 'true',
    need_pay_no_stock_skus: 'false',
    appid: '1',
  }
  const PRODUCT_HEADERS = {
    accept: 'application/json, text/plain, */*',
    'x-tt-from-appid': 'ffa-goods',
    'x-tt-from-end': 'PC',
    'x-tt-from-page': 'https://fxg.jinritemai.com/ffa/g/list',
    'x-tt-from-version': '1.0.1.8537',
  }
  const productRows = (value) => {
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') return Object.values(value)
    return []
  }
  const authoritativeOnSale = (raw) => {
    const item = raw && typeof raw === 'object' ? raw : {}
    const status = text(item.status ?? item.product_status).toLowerCase()
    const statusText = text(item.tab || item.status_text || item.status_desc || item.put_status_text).toLowerCase()
    if (/off[_ -]?sale|off.?line|下架|停售|已下架|审核驳回|草稿|draft/.test(status + ' ' + statusText)) return false
    if (/on[_ -]?sale|selling|online|在售|售卖中|上架/.test(status + ' ' + statusText)) return true
    return ['1', '2'].includes(status) || item.is_online === 1 || item.is_online === true
  }
  const productFailureCode = (response, payload) => {
    const raw = text(payload?.code || payload?.status_code || payload?.statusCode || payload?.error_code)
    const message = text(payload?.msg || payload?.message || payload?.status_msg || payload?.error)
    // The official gateway appends verifyFp and fp query parameters to
    // every authenticated product request.  Those values contain the word
    // "verify" but are not a challenge response.  Inspect only the response
    // pathname (and payload markers), never the full URL/query string, so a
    // healthy request cannot be misclassified as CHALLENGE_REQUIRED.
    let responsePath = ''
    try { responsePath = new URL(response?.url || '', location?.href || '').pathname } catch (_) {}
    const combined = raw + ' ' + message + ' ' + responsePath
    return /captcha|challenge|verify|risk|验证码|滑块|安全验证/i.test(combined) ? 'CHALLENGE_REQUIRED' : ''
  }
  const fetchAuthoritativeProductPage = async (page, signal) => {
    const query = new URLSearchParams({ ...PRODUCT_QUERY, page: String(page), pageSize: String(PRODUCT_PAGE_SIZE) })
    const response = await fetch(PRODUCT_LIST_PATH + '?' + query.toString(), {
      credentials: 'include',
      headers: PRODUCT_HEADERS,
      signal,
    })
    let payload
    try { payload = await response.json() } catch (_) { throw new Error('商品官方接口返回了无效 JSON (page=' + page + ')') }
    const challenge = productFailureCode(response, payload)
    if (challenge) { const failure = new Error(text(payload?.msg || '抖店要求完成官方商品验证')); failure.code = challenge; throw failure }
    if (!response.ok) throw new Error('商品官方接口请求失败 (HTTP ' + response.status + ', page=' + page + ')')
    const code = payload?.code
    if (code !== undefined && ![0, '0'].includes(code)) {
      const failure = new Error(text(payload?.msg || payload?.message || ('商品官方接口返回 code=' + code)))
      failure.code = /login|unauth|登录/i.test(failure.message) ? 'LOGIN_REQUIRED' : 'PLATFORM_ERROR'
      throw failure
    }
    const rows = productRows(payload?.data)
    const reportedTotal = number(payload?.total ?? payload?.data?.total)
    const reportedSize = number(payload?.size ?? payload?.data?.size) || rows.length || PRODUCT_PAGE_SIZE
    return { rows, total: reportedTotal, size: reportedSize, page: number(payload?.page) ?? page }
  }
  const authoritativeProducts = async () => {
    if (typeof fetch !== 'function') return error('RUNTIME_NOT_READY', '商品官方请求能力不可用', true)
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const byId = new Map()
    let page = 0
    let expectedTotal
    let effectivePageSize
    try {
      while (page < 1000) {
        const result = await fetchAuthoritativeProductPage(page, controller?.signal)
        if (expectedTotal === undefined && result.total !== undefined) expectedTotal = Math.max(0, result.total)
        // A backend may cap pageSize without updating the echoed size. Infer
        // that cap from a short non-final page so total-based pagination does
        // not stop early or skip pages.
        if (!effectivePageSize && result.rows.length > 0 && result.rows.length < result.size && expectedTotal !== undefined && expectedTotal > result.rows.length) effectivePageSize = result.rows.length
        effectivePageSize ||= result.size
        for (const raw of result.rows) {
          if (!authoritativeOnSale(raw)) continue
          const item = product(raw)
          if (item) byId.set(item.externalId, item)
        }
        const fetched = (page + 1) * effectivePageSize
        const reachedTotal = expectedTotal !== undefined && (fetched >= expectedTotal || byId.size >= expectedTotal)
        if (result.rows.length === 0 && expectedTotal !== undefined && fetched < expectedTotal) throw new Error('商品官方接口分页提前结束 (page=' + page + ')')
        // When total is provided it is authoritative. Some deployments cap
        // pageSize silently while still echoing the requested size, so a
        // short non-empty page must not be mistaken for the final page.
        const reachedEnd = result.rows.length === 0 || (expectedTotal === undefined && result.rows.length < result.size)
        if (reachedTotal || reachedEnd) break
        page += 1
      }
      if (page >= 1000) throw new Error('商品官方接口分页超过安全上限')
      // The endpoint is scoped with is_online=1; every returned row is an
      // authoritative current in-sale row. Never fall back to localStorage.
      return { ok: true, data: [...byId.values()] }
    } catch (caught) {
      controller?.abort?.()
      const code = caught?.code || ''
      if (code === 'CHALLENGE_REQUIRED') return error('CHALLENGE_REQUIRED', String(caught?.message || '抖店要求完成官方商品验证'), true)
      if (code === 'LOGIN_REQUIRED') return loginError()
      return error('PLATFORM_ERROR', String(caught?.message || caught), true)
    }
  }
  const message = (raw, context = {}) => {
    const item = raw?.message || raw?.data || raw?.payload || raw
    if (!item || typeof item !== 'object') return undefined
    const ext = item.ext && typeof item.ext === 'object' ? item.ext : json(item.ext)
    const conversationId = text(item.conversationId || item.originConversationId || item.securityConversationId || item.sessionId || context.conversationId)
    const id = text(item.serverId || item.messageId || item.clientId || item.id)
    if (!conversationId || !id) return undefined
    const senderId = text(item.sender || item.senderId || item.originSender || item.securitySender || item.from)
    const senderRole = text(ext.sender_role || ext['s:sender_biz_role'] || item.senderRole)
    const platformMessageType = text(ext.type || item.messageType || item.type)
    const clientMessageId = text(ext['s:client_message_id'] || item.clientMessageId)
    const content = text(item.content || item.text || item.message)
    const system = senderRole === '3' || senderRole === '4'
      || /system|notice|notification|allocated_service|user_enter_from_transfer|系统|通知|接入|转移/i.test([item.messageType, item.type, ext.type, ext.message_type].map(text).join(' '))
      || Boolean(ext.from_event_center)
      || /(?:CsAssign|transfer_staff|close_non_process)/i.test(clientMessageId)
      || (senderRole !== '1' && isOfficialServiceNotice(content))
    const direction = !system && (item.isMine === true || senderId === context.selfId || senderRole === '2') ? 'outbound' : 'inbound'
    const platformType = platformMessageType.toLowerCase()
    const cardScene = text(json(ext.card_header).cardSourceScene)
    const type = /order|订单/i.test(platformType + cardScene) ? 'order' : system ? 'system' : /image|图片/.test(platformType) ? 'image' : /file|文件/.test(platformType) ? 'file' : /goods|product|商品/i.test(platformType + cardScene) ? 'product' : !platformType || /text|文字/.test(platformType) ? 'text' : 'unknown'
    const source = [ext.send_source, ext.sender_source, ext.operation_source, ext.source, item.sendSource, item.senderSource, item.operationSource, item.source].map(text).filter(Boolean).join(' ')
    const manualSendCheck = Boolean(text(ext['p:check_Send'] || ext['p:check_send'] || ext.p_check_send))
    const buyer = senderRole === '1' || /buyer|customer|买家|消费者/i.test(text(ext['s:sender_biz_role'] || item.senderRole))
    const origin = system ? 'system' : direction === 'inbound' ? buyer ? 'customer' : 'unknown' : manualSendCheck || /(?:^|[._ -])(manual|human|staff)(?:$|[._ -])|人工|客服手动/i.test(source) ? 'human' : 'unknown'
    const status = text(item.deliveryStatus || item.sendStatus || item.status).toLowerCase()
    const attachmentUrl = text(item.url || item.uri || item.imageUrl || item.fileUrl || ext.url || ext.image_url || ext.file_url)
    const attachmentName = text(item.fileName || item.name || ext.file_name)
    const attachmentMime = text(item.mimeType || item.mime || ext.mime_type)
    return {
      id, conversationId,
      ...(senderId ? { senderId } : {}),
      ...(text(ext.uname || item.senderName || context.conversationTitle) ? { senderName: system ? '系统' : text(ext.uname || item.senderName || context.conversationTitle) } : {}),
      content, type, direction, origin,
      deliveryStatus: /fail|error|失败/.test(status) ? 'failed' : /pending|sending|发送中/.test(status) ? 'pending' : 'sent',
      timestamp: time(item.createTime || item.createdAt || item.timestamp || item.timestampMs) || Date.now(),
      ...(attachmentUrl || attachmentName || attachmentMime ? { attachments: [{ ...(attachmentUrl ? { url: attachmentUrl } : {}), ...(attachmentName ? { name: attachmentName } : {}), ...(attachmentMime ? { mimeType: attachmentMime } : {}) }] } : {}),
      raw: {
        senderRole,
        source: source || undefined,
        platformType: platformType || undefined,
        provisional: !item.serverId && !item.messageId && Boolean(item.clientId),
        attributionMetadata: attributionMetadata(item, ext),
        ...(type === 'order' ? {
          orderId: text(ext.order_id || ext.shop_order_id || json(ext.point_info).shop_order_id || item.orderId),
          productId: text(ext.goods_id || json(ext.point_info).product_id),
          productName: text(json(ext.static_data).product_name || json(ext.static_data).b_good?.product_name),
          status: text(json(ext.static_data).order_status || json(ext.static_data).tag_content),
          totalAmount: (() => { const match = text(json(ext.static_data).sell_num_desc).match(/[¥￥]\s*([\d,.]+)/); return match ? Number(match[1].replace(/,/g, '')) : undefined })(),
          quantity: (() => { const match = text(json(ext.static_data).sell_num_desc).match(/共\s*(\d+)\s*件/); return match ? Number(match[1]) : undefined })(),
        } : {}),
      },
    }
  }
  const isOfficialServiceNotice = (content) => /(?:人工)?客服.{0,30}(?:为您服务|已?接入|已加入(?:会话)?|进入会话)|(?:为您转接|转接给.{0,20}客服|客服.{0,20}(?:接入|已加入(?:会话)?))/i.test(text(content))
  const messages = (conversationId) => {
    const info = store()?.conversationsInfo
    if (!info) return []
    const result = []
    const sessions = sessionRows().filter((item) => !conversationId || item.id === text(conversationId))
    for (const session of sessions) {
      let source
      try { source = typeof info.messagesByConversationId?.get === 'function' ? info.messagesByConversationId.get(session.id) : info.messagesByConversationId?.[session.id] } catch (_) {}
      const rows = source?.sortedMessages || source?.visibleMessages || source?.value || source
      for (const raw of values(rows)) {
        const parsed = message(raw, { conversationId: session.id, selfId: text(store()?.selfInfo?.id), conversationTitle: session.title })
        const normalized = parsed ? correlateOutbound(parsed) : undefined
        if (normalized && !result.some((item) => item.id === normalized.id)) result.push(normalized)
      }
    }
    return result.sort((a, b) => a.timestamp - b.timestamp)
  }
  const order = (raw, context = {}) => {
    const item = raw && typeof raw === 'object' ? raw : {}
    const externalId = text(item.orderId || item.order_id || item.shopOrderId || item.shop_order_id || item.skuOrderId || item.sku_order_id || item.id)
    if (!externalId) return undefined
    const shopId = text(item.shopId || item.shop_id || store()?.shopInfo?.id || window.__shop_id)
    const itemRows = array(item.items || item.orderItems || item.skuOrders)
    const quantity = number(item.quantity ?? item.count ?? item.product_count ?? item.item_num) || 1
    const fallback = { productId: text(item.productId || item.product_id || item.goodsId || item.goods_id) || undefined, skuId: text(item.skuId || item.sku_id) || undefined, skuName: text(item.skuName || item.sku_name || item.spec_desc || item.goods_spec_desc || item.sku) || undefined, title: text(item.productName || item.product_name || item.goodsName || item.goods_name) || '未知商品', quantity }
    const items = (itemRows.length ? itemRows : [fallback]).map((rawItem) => {
      const row = rawItem && typeof rawItem === 'object' ? rawItem : {}
      const amount = number(row.price ?? row.itemPrice ?? row.pay_amount)
      return {
        ...(text(row.productId || row.product_id || row.goodsId || row.goods_id) ? { productId: text(row.productId || row.product_id || row.goodsId || row.goods_id), externalProductId: text(row.productId || row.product_id || row.goodsId || row.goods_id) } : {}),
        ...(text(row.skuId || row.sku_id) ? { skuId: text(row.skuId || row.sku_id) } : {}),
        ...(text(row.skuName || row.sku_name || row.spec_desc || row.goods_spec_desc || row.sku) ? { skuName: text(row.skuName || row.sku_name || row.spec_desc || row.goods_spec_desc || row.sku) } : {}),
        title: text(row.title || row.productName || row.product_name || row.goodsName || row.goods_name) || '未知商品',
        quantity: number(row.quantity ?? row.count ?? row.item_num) || quantity,
        ...(amount !== undefined ? { price: { amount, currency: 'CNY' } } : {}),
      }
    })
    const amount = number(item.totalAmount ?? item.total_amount ?? item.orderAmount ?? item.order_amount_yuan ?? item.price)
    const cents = number(item.pay_amount ?? item.order_amount ?? item.total_fee)
    const total = amount !== undefined ? amount : cents !== undefined ? cents / 100 : undefined
    const platformStatus = text(item.platformStatus || item.status_desc || item.order_status_desc || item.status || item.orderStatus || item.order_status)
    const platformAftersaleStatus = text(item.platformAftersaleStatus || item.aftersaleStatus || item.aftersale_sum_status_desc).trim()
    const effectiveAftersaleStatus = /^[-—]?$/.test(platformAftersaleStatus) ? '' : platformAftersaleStatus
    const status = (effectiveAftersaleStatus || platformStatus).toLowerCase()
    let normalizedStatus = /退款成功|退款完成|已退款|售后完成|售后成功|refunded/.test(status) ? 'refunded' : /退款|退货|售后|refund/.test(status) ? 'refunding' : /取消|关闭|cancel|closed/.test(status) ? 'cancelled' : /完成|交易成功|已收货|complete|success/.test(status) ? 'completed' : /已发货|运输中|物流|shipped|shipping/.test(status) ? 'shipped' : /待发货|备货|处理中|processing/.test(status) ? 'processing' : /已付款|已支付|支付成功|paid/.test(status) ? 'paid' : /待付款|待支付|未付款|新订单|created|pending/.test(status) ? 'created' : 'unknown'
    if (normalizedStatus === 'unknown') normalizedStatus = ({ '1': 'created', '2': 'processing', '3': 'shipped', '4': 'cancelled' })[text(item.order_status || item.orderStatus || item.status)] || normalizedStatus
    const fallbackStatus = normalizedStatus === 'unknown' && number(item.pay_time) ? 'paid' : normalizedStatus
    return {
      id: 'douyin:' + (shopId || 'unknown') + ':' + externalId, externalId,
      ...(shopId ? { shopId } : {}),
      ...(text(item.conversationId || item.sessionId || context.conversationId) ? { conversationId: text(item.conversationId || item.sessionId || context.conversationId) } : {}),
      ...((text(item.buyerId || item.userId) || text(item.buyerName || item.buyer_name)) ? { buyer: { ...(text(item.buyerId || item.userId) ? { id: text(item.buyerId || item.userId) } : {}), ...(text(item.buyerName || item.buyer_name) ? { name: text(item.buyerName || item.buyer_name) } : {}) } } : {}),
      status: fallbackStatus, items,
      ...(total !== undefined ? { total: { amount: total, currency: 'CNY' } } : {}),
      ...((text(item.receiverName || item.receiver_name) || text(item.receiverAddress || item.receiver_address) || text(item.phoneMasked || item.receiver_phone_mask)) ? { receiver: { ...(text(item.receiverName || item.receiver_name) ? { name: text(item.receiverName || item.receiver_name) } : {}), ...(text(item.phoneMasked || item.receiver_phone_mask) ? { phoneMasked: text(item.phoneMasked || item.receiver_phone_mask) } : {}), ...(text(item.receiverAddress || item.receiver_address) ? { address: text(item.receiverAddress || item.receiver_address) } : {}) } } : {}),
      ...(time(item.createdAt || item.create_time || item.order_create_time) ? { createdAt: time(item.createdAt || item.create_time || item.order_create_time) } : {}),
      ...(time(item.updatedAt || item.update_time || item.timestamp) ? { updatedAt: time(item.updatedAt || item.update_time || item.timestamp) } : {}),
      raw: { platformStatus, ...(effectiveAftersaleStatus ? { platformAftersaleStatus: effectiveAftersaleStatus } : {}) },
    }
  }
  const orderMessages = (conversationId) => messages(conversationId).map((item) => item.type === 'order' ? orderFromMessage(item, conversationId) : undefined).filter(Boolean)
  const orderFromMessage = (item, conversationId) => {
    const raw = item.raw || {}
    const id = text(raw.orderId || raw.shopOrderId)
    return id ? order({ ...raw, orderId: id }, { conversationId }) : undefined
  }
  const officialOrders = (response, conversationId, buyerId) => {
    const direct = array(response)
    const rows = direct.length ? direct : array(response?.data)
    return rows.map((raw) => {
      const item = raw && typeof raw === 'object' ? raw : {}
      const skuRows = array(item.sku_order_list || item.skuOrders || item.items)
      const items = skuRows.map((rawSku) => {
        const sku = rawSku && typeof rawSku === 'object' ? rawSku : {}
        const specs = array(sku.sku_specs).map((spec) => text(spec?.value || spec?.name)).filter(Boolean)
        const cents = number(sku.actual_pay_amount ?? sku.pay_amount ?? sku.price)
        return {
          productId: text(sku.product_id || sku.goods_id) || undefined,
          skuId: text(sku.sku_id) || undefined,
          skuName: text(sku.sku_name || sku.spec_desc || sku.goods_spec_desc) || specs.join(', ') || undefined,
          title: text(sku.product_name || sku.goods_name) || '未知商品',
          quantity: number(sku.quantity ?? sku.count ?? sku.item_num ?? sku.combo_num ?? sku.buy_num) || 1,
          ...(cents !== undefined ? { price: cents / 100 } : {}),
        }
      })
      const directCents = number(item.actual_pay_amount ?? item.total_pay_amount ?? item.pay_amount ?? item.order_amount ?? item.total_fee)
      const itemCents = skuRows.reduce((total, rawSku) => total + (number(rawSku?.actual_pay_amount ?? rawSku?.total_pay_amount ?? rawSku?.pay_amount ?? rawSku?.price) || 0), 0)
      const totalAmount = directCents !== undefined ? directCents / 100 : itemCents ? itemCents / 100 : undefined
      const aftersaleRows = skuRows.flatMap((rawSku) => array(rawSku?.after_sale_orders || rawSku?.afterSaleOrders))
      const platformAftersaleStatus = [
        item.aftersale_sum_status_desc,
        ...aftersaleRows.flatMap((afterSale) => [afterSale?.after_sale_status_desc, afterSale?.title, afterSale?.sub_title?.text]),
      ].map(text).filter(Boolean).join(' ')
      const address = item.post_address && typeof item.post_address === 'object'
        ? [item.post_address.province?.name, item.post_address.city?.name, item.post_address.town?.name, item.post_address.street?.name, item.post_address.detail].map(text).filter(Boolean).join('')
        : text(item.receiver_address)
      return order({
        ...item,
        orderId: item.order_id || item.shop_order_id || item.orderId,
        platformStatus: item.order_status_desc || item.status_desc || item.order_status || item.status,
        platformAftersaleStatus,
        ...(items.length ? { items } : {}),
        ...(totalAmount !== undefined ? { totalAmount } : {}),
        buyerId: item.security_user_id || item.user_id || item.buyer_id || buyerId,
        buyerName: item.user_nick_name || item.buyer_name,
        receiverName: item.post_receiver || item.receiver_name,
        receiverAddress: address,
        phoneMasked: item.mobile || item.receiver_phone_mask,
        createdAt: item.order_time_sec || item.create_time_sec || item.create_time || item.order_create_time,
        updatedAt: item.update_time_sec || item.update_time || item.pay_time_sec,
      }, { conversationId, buyerId })
    }).filter(Boolean)
  }
  const orderIdsFor = (conversationId, explicitOrderId, messageOrders) => {
    const ids = new Set()
    const add = (value) => { const id = identifier(value); if (id) ids.add(id) }
    add(explicitOrderId)
    for (const item of messageOrders) add(item.externalId)
    const conversation = conversationFor(conversationId)
    for (const source of [conversation?.value, conversation?.value?.rawExt, conversation?.raw]) {
      add(source?.orderId || source?.order_id || source?.shopOrderId || source?.shop_order_id)
    }
    const currentConversationId = text(snapshot(store()?.conversationsInfo?.currentConversation)?.id)
    if (!conversationId || !currentConversationId || currentConversationId === conversationId) {
      const workstation = store()?.uiState?.workstation
      const ui = pcUIState()
      add(workstation?.currentOrder)
      add(ui?.rightTabOrder?.locationOrderId || ui?.rightTabOrder?.orderId || ui?.rightTabOrder?.order_id)
      for (const value of values(store()?.historyConversationData?.conversationOrderIdList)) add(value)
    }
    return [...ids].slice(0, 20)
  }
  const requestOfficialOrders = async (conversationId, orderId) => {
    const post = pagePost()
    const conversation = conversationFor(conversationId)
    const buyerId = identifier(buyerFor(conversationId))
    if (!buyerId || typeof post !== 'function') return []
    const current = store()
    const encrypted = current?.useEncryptUid
    const identityKeys = encrypted === false ? ['user_id'] : encrypted === true ? ['security_user_id'] : ['security_user_id', 'user_id']
    const common = {
      page_no: 0,
      page_size: 5,
      is_init_tab: 1,
      tab_type: orderId ? 0 : 1,
      biz_type: 2,
      search_words: orderId || '',
      workstation_opt_version: current?.uiState?.workstation?.isUIVersionV3 ? 'v2' : 'v1',
      service_entity_id: identifier(conversation?.value?.serviceEntityId || conversation?.value?.rawExt?.service_entity_id || current?.shopInfo?.id) || undefined,
      from_conversation_short_id: identifier(conversation?.value?.shortId) || undefined,
      version: '1.0',
      workstation_opt_gray: true,
    }
    for (const identityKey of identityKeys) {
      try {
        const response = await post('/backstage/cmpoent/order/query', { ...common, [identityKey]: buyerId })
        const rows = officialOrders(response, conversationId, buyerId)
        if (rows.length) return rows
      } catch (_) {}
    }
    return []
  }
  const requestCommerceOrders = async (explicitOrderId, signal) => {
    if (PAGE !== 'orders' || signal?.aborted || disposed) return []
    const request = window['fetch']
    if (typeof request !== 'function') return []
    const query = [
      ['page', '0'],
      ['pageSize', explicitOrderId ? '20' : '100'],
      ['order_by', 'create_time'],
      ['order', 'desc'],
      ['tab', 'all'],
      ...(explicitOrderId ? [['search_words', explicitOrderId]] : []),
    ].map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&')
    try {
      const response = await request.call(window, '/api/order/searchlist?' + query, { credentials: 'include', ...(signal ? { signal } : {}) })
      if (!response?.ok) return []
      const payload = await response.json()
      const rows = array(payload?.data)
      const normalizedRows = rows.map((item) => {
        const value = item && typeof item === 'object' ? item : {}
        const productRows = array(value.product_item).map((productItem) => {
          const row = productItem && typeof productItem === 'object' ? productItem : {}
          return {
            ...row,
            product_id: row.product_id || row.goods_id,
            product_name: row.product_name || row.goods_name,
            sku_id: row.sku_id || row.sku_id_str,
            sku_name: row.sku_name || (Array.isArray(row.sku_spec) ? row.sku_spec.map((spec) => text(spec?.value || spec?.name || spec)).filter(Boolean).join(', ') : ''),
            quantity: row.combo_num || row.quantity || row.buy_num,
            actual_pay_amount: row.pay_amount ?? row.total_amount ?? row.combo_amount,
            after_sale_orders: row.after_sale_info ? [row.after_sale_info] : [],
          }
        })
        const firstProduct = productRows[0] || {}
        const receiver = value.receiver_info && typeof value.receiver_info === 'object' ? value.receiver_info : {}
        const aftersale = productRows.flatMap((row) => array(row.after_sale_orders)).map((row) => text(row?.after_sale_text || row?.aftersale_status_class_string || row?.after_sale_status_remark)).filter(Boolean).join(' ')
        const statusText = text(value.order_status_info?.order_status_text || value.status_desc || value.order_status_desc || value.order_status)
        return {
          ...value,
          order_id: value.shop_order_id || value.order_id,
          sku_order_list: productRows,
          // Keep the platform's status text authoritative. pay_time is only a
          // fallback when the platform omits a usable status.
          order_status_desc: statusText,
          aftersale_sum_status_desc: aftersale,
          user_id: value.user_id,
          post_receiver: receiver.post_receiver,
          mobile: receiver.post_tel || receiver.post_tel_mask,
          post_address: receiver.post_addr,
          createdAt: value.create_time,
          update_time: value.update_time || value.pay_time || value.create_time,
          ...(firstProduct.product_id ? { product_id: firstProduct.product_id } : {}),
        }
      })
      const rowsForOrder = explicitOrderId ? normalizedRows.filter((item) => identifier(item.order_id) === identifier(explicitOrderId)) : normalizedRows
      return officialOrders({ data: rowsForOrder }, '', '').map((item) => ({ ...item, raw: { ...item.raw, source: 'fxg.order.searchlist' } }))
    } catch (_) {
      return []
    }
  }
  const mergeOrders = (rows) => {
    const result = new Map()
    for (const item of rows) {
      const previous = result.get(item.externalId)
      if (!previous) { result.set(item.externalId, item); continue }
      const preferred = previous.status === 'unknown' && item.status !== 'unknown' ? item : previous
      const fallback = preferred === item ? previous : item
      const items = []
      const seenItems = new Set()
      for (const orderItem of [...(preferred.items || []), ...(fallback.items || [])]) {
        const key = JSON.stringify([orderItem.productId, orderItem.externalProductId, orderItem.skuId, orderItem.skuName, orderItem.title, orderItem.quantity, orderItem.price])
        if (!seenItems.has(key)) { seenItems.add(key); items.push(orderItem) }
      }
      const createdAt = Math.min(...[preferred.createdAt, fallback.createdAt].filter((value) => Number.isFinite(value)))
      const updatedAt = Math.max(...[preferred.updatedAt, fallback.updatedAt].filter((value) => Number.isFinite(value)))
      result.set(item.externalId, {
        ...fallback,
        ...preferred,
        items,
        ...(preferred.conversationId || fallback.conversationId ? { conversationId: preferred.conversationId || fallback.conversationId } : {}),
        ...(preferred.buyer || fallback.buyer ? { buyer: preferred.buyer || fallback.buyer } : {}),
        ...(preferred.total || fallback.total ? { total: preferred.total || fallback.total } : {}),
        ...(preferred.receiver || fallback.receiver ? { receiver: preferred.receiver || fallback.receiver } : {}),
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
      })
    }
    return [...result.values()]
  }
  const orders = async (conversationId, explicitOrderId) => {
    if (PAGE === 'orders') return mergeOrders(await requestCommerceOrders(explicitOrderId))
    const current = store()
    const service = current?.orderInvitation || current?.orderInfo
    const collected = []
    for (const name of ['getOrders', 'fetchOrders', 'fetchOrderList', 'queryOrders']) {
      try {
        if (typeof service?.[name] === 'function') {
          const value = await service[name](buyerFor(conversationId))
          const rows = array(value).map((item) => order(item, { conversationId })).filter(Boolean)
          collected.push(...rows)
        }
      } catch (_) {}
    }
    const messageOrders = orderMessages(conversationId)
    const orderIds = orderIdsFor(conversationId, explicitOrderId, messageOrders)
    if (orderIds.length) {
      for (const orderId of orderIds) collected.push(...await requestOfficialOrders(conversationId, orderId))
    } else {
      collected.push(...await requestOfficialOrders(conversationId, ''))
    }
    collected.push(...messageOrders)
    return mergeOrders(collected)
  }
  // Buyer and conversation context may be opportunistically filled by the
  // commerce list API. They do not represent an order-domain state change.
  const orderKey = (item) => JSON.stringify([item.externalId, item.status, item.items, item.total, item.receiver])
  const changedOrderFields = (previous, next) => ['status', 'items', 'total', 'receiver'].filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]))
  const isOlderOrder = (previous, next) => Boolean(previous?.updatedAt && next?.updatedAt && next.updatedAt < previous.updatedAt)
  const orderSnapshot = (orderId) => {
    const current = orderSnapshots.get('*') || new Map()
    return current.get(orderId)
  }
  const saveOrderSnapshot = (item) => {
    const current = orderSnapshots.get('*') || new Map()
    const previous = current.get(item.externalId)
    if (isOlderOrder(previous, item)) return false
    current.set(item.externalId, item)
    orderSnapshots.set('*', current)
    return true
  }
  const decodeNotificationPayload = (value) => {
    if (typeof value === 'string') return json(value)
    if ((typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(value))) {
      try { return json(new TextDecoder().decode(value)) } catch (_) { return {} }
    }
    if (value?.message?.payload !== undefined) {
      const decoded = decodeNotificationPayload(value.message.payload)
      if (decoded && typeof decoded === 'object') return decoded.data && typeof decoded.data === 'object' ? { ...decoded, ...decoded.data } : decoded
    }
    if (value?.payload !== undefined && (typeof value.payload === 'string' || value.payload instanceof Uint8Array)) {
      const decoded = decodeNotificationPayload(value.payload)
      if (decoded && typeof decoded === 'object') return decoded.data && typeof decoded.data === 'object' ? { ...decoded, ...decoded.data } : decoded
    }
    return value
  }
  const notificationObject = (value) => {
    value = decodeNotificationPayload(value)
    const visited = new Set()
    const queue = [value]
    while (queue.length && visited.size < 100) {
      const item = queue.shift()
      if (!item || typeof item !== 'object' || visited.has(item)) continue
      visited.add(item)
      if (item.msgItem || item.msg_item || item.messageItem) {
        const nested = item.msgItem || item.msg_item || item.messageItem
        const value = decodeNotificationPayload(nested)
        if (!value || typeof value !== 'object') return value
        const metadata = {}
        for (const key of ['type', 'msg_type', 'notice_type', 'event_id', 'eventId', 'msg_id', 'msgId', 'biz_type', 'bizType', 'timestamp', 'create_time']) {
          if (item[key] !== undefined && item[key] !== null) metadata[key] = item[key]
        }
        return { ...value, ...metadata }
      }
      for (const key of ['data', 'payload', 'message', 'item', 'items', 'list', 'messages', 'notice', 'notification']) {
        const nested = item[key]
        if (Array.isArray(nested)) queue.push(...nested)
        else if (nested && typeof nested === 'object') queue.push(nested)
      }
    }
    return value && typeof value === 'object' ? value : {}
  }
  const notificationOrderId = (value) => {
    const item = notificationObject(value)
    const rawExt = item.ext_info || item.extInfo || item.ext || item.extra
    const ext = json(rawExt)
    const candidates = [
      ext.order_id, ext.shop_order_id, ext.orderId, ext.shopOrderId, ext.order_id_str, ext.shop_order_id_str,
      ext.point_info && json(ext.point_info).shop_order_id,
      item.order_id, item.shop_order_id, item.orderId, item.shopOrderId,
    ]
    const urls = [rawExt, ext.url, ext.detail_url, ext.order_url, ext.order_detail_url, ext.orderDetailUrl, ext.order_detail_url_h5, item.url].map(text).filter(Boolean)
    const pending = [ext]
    const visited = new Set()
    while (pending.length && visited.size < 100) {
      const current = pending.shift()
      if (!current || typeof current !== 'object' || visited.has(current)) continue
      visited.add(current)
      for (const [key, nested] of Object.entries(current)) {
        if (/(?:order.*id|id.*order)/i.test(key)) candidates.push(nested)
        if (/url|link/i.test(key) && typeof nested === 'string') urls.push(nested)
        if (nested && ['object', 'function'].includes(typeof nested)) pending.push(nested)
      }
    }
    for (const url of urls) {
      try {
        const parsed = new URL(url, location.origin)
        candidates.push(parsed.searchParams.get('order_id'), parsed.searchParams.get('orderId'), parsed.searchParams.get('shop_order_id'))
      } catch (_) {}
      const matches = url.match(/\b\d{8,24}\b/g)
      if (matches) candidates.push(...matches)
    }
    const orderId = candidates.map(identifier).find(Boolean) || ''
    return orderId ? {
      orderId,
      type: text(item.type || item.msg_type || item.notice_type || ext.type || ext.msg_type),
      eventId: identifier(item.event_id || item.eventId || item.msg_id || item.id || ext.event_id || ext.eventId || ext.msg_id),
      bizType: text(item.biz_type || item.bizType || ext.biz_type || ext.bizType),
      timestamp: time(item.timestamp || item.create_time || ext.timestamp || ext.create_time) || Date.now(),
      raw: { type: item.type || item.msg_type || item.notice_type, extInfo: ext },
    } : undefined
  }
  const queryOrderById = async (orderId, signal) => {
    const expected = identifier(orderId)
    if (!expected || disposed || signal?.aborted) return undefined
    for (const delayMs of ORDER_QUERY_RETRY_DELAYS_MS) {
      if (disposed || signal?.aborted) return undefined
      if (delayMs) await wait(delayMs)
      if (disposed || signal?.aborted) return undefined
      let rows = []
      try { rows = await requestCommerceOrders(expected, signal) } catch (_) { rows = [] }
      const match = rows.find((item) => identifier(item.externalId) === expected)
      if (match) return match
    }
    return undefined
  }
  const isCreationNotification = (notification) => /^(6001|create|created|new|order_created)$/i.test(notification.type) || /new.?order|order.?created|下单|新订单/i.test(notification.type)
  const refreshOrderByNotification = async (notification, signal) => {
    const next = await queryOrderById(notification.orderId, signal)
    if (!next) return false
    const enriched = { ...next, raw: { ...(next.raw || {}), notification: { source: notification.source || undefined, type: notification.type || undefined, bizType: notification.bizType || undefined, timestamp: notification.timestamp } } }
    const previous = orderSnapshot(enriched.externalId)
    if (previous && isOlderOrder(previous, enriched)) return true
    if (!previous) {
      if (isCreationNotification(notification) && (enriched.createdAt || 0) >= orderListenerStartedAt) emit({ type: 'order.created', payload: { order: enriched } })
      else emit({ type: 'order.updated', payload: { order: enriched, changedFields: ['status', 'items', 'total', 'receiver', 'buyer', 'conversationId'] } })
    } else if (orderKey(previous) !== orderKey(enriched)) {
      emit({ type: 'order.updated', payload: { order: enriched, previous, changedFields: changedOrderFields(previous, enriched) } })
    }
    saveOrderSnapshot(enriched)
    return true
  }
  const notificationFingerprint = (notification) => {
    const stablePayload = notification.eventId
      ? notification.eventId
      : JSON.stringify([notification.timestamp, notification.raw?.extInfo || notification.raw || {}])
    return [notification.orderId, notification.eventId || '', notification.type || '', notification.bizType || '', stablePayload || ''].join(':')
  }
  const rememberProcessedFingerprint = (fingerprint) => {
    processedFingerprints.add(fingerprint)
    if (processedFingerprints.size > 2000) processedFingerprints.delete(processedFingerprints.values().next().value)
  }
  const drainOrderRefresh = async (orderId, state) => {
    try {
      while (!disposed && state.pending.length) {
        const entry = state.pending.shift()
        if (!entry) continue
        let processed = false
        try { processed = await refreshOrderByNotification(entry.notification, state.controller?.signal) } catch (_) { processed = false }
        processingFingerprints.delete(entry.fingerprint)
        if (processed) rememberProcessedFingerprint(entry.fingerprint)
        if (state.pending.length > 1) {
          const latest = state.pending.at(-1)
          for (const discarded of state.pending.slice(0, -1)) processingFingerprints.delete(discarded.fingerprint)
          state.pending = latest ? [latest] : []
          state.dirty = false
        }
      }
    } finally {
      for (const entry of state.pending) processingFingerprints.delete(entry.fingerprint)
      state.pending.length = 0
      if (orderRefreshes.get(orderId) === state) orderRefreshes.delete(orderId)
    }
  }
  const enqueueOrderRefresh = (notification) => {
    if (!orderListening || disposed) return
    const fingerprint = notificationFingerprint(notification)
    if (processedFingerprints.has(fingerprint) || processingFingerprints.has(fingerprint)) return
    processingFingerprints.add(fingerprint)
    const pending = { notification, fingerprint }
    const current = orderRefreshes.get(notification.orderId)
    if (current) {
      current.dirty = true
      current.pending.push(pending)
      return
    }
    const state = {
      dirty: false,
      pending: [pending],
      controller: typeof AbortController === 'function' ? new AbortController() : undefined,
    }
    orderRefreshes.set(notification.orderId, state)
    void drainOrderRefresh(notification.orderId, state)
  }
  const refreshRecentOrdersForDomainWakeup = async (signal) => {
    const current = await requestCommerceOrders('', signal)
    for (const item of current.slice(0, ORDER_RECONCILIATION_LIMIT)) {
      if (orderRefreshes.has(item.externalId)) continue
      const previous = orderSnapshot(item.externalId)
      if (previous && isOlderOrder(previous, item)) continue
      if (!previous && (item.createdAt || 0) >= orderListenerStartedAt) emit({ type: 'order.created', payload: { order: item } })
      else if (previous && orderKey(previous) !== orderKey(item)) emit({ type: 'order.updated', payload: { order: item, previous, changedFields: changedOrderFields(previous, item) } })
      saveOrderSnapshot(item)
    }
  }
  const drainOrderDomainRefresh = async () => {
    if (!orderListening || disposed || orderDomainRefreshBusy) return
    orderDomainRefreshBusy = true
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    orderDomainRefreshController = controller
    try {
      await refreshRecentOrdersForDomainWakeup(controller?.signal)
    } finally {
      if (orderDomainRefreshController === controller) orderDomainRefreshController = null
      orderDomainRefreshBusy = false
      if (!disposed && orderDomainRefreshDirty) {
        orderDomainRefreshDirty = false
        void drainOrderDomainRefresh()
      }
    }
  }
  const scheduleOrderDomainRefresh = () => {
    if (!orderListening || disposed) return
    orderDomainRefreshDirty = true
    if (orderDomainRefreshBusy || orderDomainRefreshTimer) return
    const timer = setTimeout(() => {
      if (orderDomainRefreshTimer === timer) orderDomainRefreshTimer = null
      if (disposed || !orderDomainRefreshDirty) return
      orderDomainRefreshDirty = false
      void drainOrderDomainRefresh()
    }, ORDER_DOMAIN_WAKEUP_DEBOUNCE_MS)
    orderDomainRefreshTimer = timer
  }
  const explicitNotificationCandidates = () => {
    const candidates = [
      window.frontierInstance?.fws,
      window.__DOUYIN_NOTIFICATION_RUNTIME__, window.__DOUYIN_NOTIFICATION_STORE__, window.__FRONTIER_NOTIFICATION_RUNTIME__,
      window.__REACH_RUNTIME__, window.__NOTICE_RUNTIME__, window.__NOTIFICATION_RUNTIME__, window.__NOTIFICATION_STORE__,
      store()?.notificationRuntime, store()?.notificationStore, store()?.noticeStore, store()?.notice, store()?.notification,
      pageContext()?.notificationRuntime, pageContext()?.notificationStore, pageContext()?.noticeStore, pageContext()?.notice, pageContext()?.notification,
      window.__mona_light_event, window.__lightEvent, window.__wbUpdateEventEmitter,
      window.__WORKBENCH_EVENT_SDK__, window.__WORKBENCH_EVENT_SDK_IN_WINDOW__, window.__WORKBENCH_EVENT_INSTANCE_MAP_NEW__,
      window.__WORKBENCH_EVENT_INSTANCE_MAP__, window.__MONA_EVENT_MAP_GLOBAL_KEY__,
    ]
    return [...new Set(candidates.filter(Boolean))]
  }
  const discoveredNotificationCandidates = () => {
    const relevant = /notification|notify|notice|reach|alert|frontier|broadcast|event/i
    const candidates = [
      window.__monaGlobalStore, window.rootStore, window.SDKRuntime,
    ]
    const roots = []
    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!relevant.test(key)) continue
        try { roots.push(window[key]) } catch (_) {}
      }
    } catch (_) {}
    roots.push(window.ss?._frontStore, window.ss?.instance, window.__mona_pigeon_event, window.__monaGlobalStore, window.__mona_light_event, window.__lightEvent, window.__wbUpdateEventEmitter, pageContext())
    const seen = new Set()
    const visit = (value, path, depth) => {
      if (!value || !['object', 'function'].includes(typeof value) || seen.has(value) || depth > 3) return
      seen.add(value)
      const hasListener = ['subscribe', 'listen', 'addListener', 'on', 'addEventListener'].some((name) => typeof value[name] === 'function')
      if (hasListener && relevant.test(path)) candidates.push(value)
      let keys = []
      try { keys = Object.getOwnPropertyNames(value).slice(0, 120) } catch (_) { return }
      for (const key of keys) {
        if (!relevant.test(key) && !['data', 'globalStore', 'store', 'runtime', 'bus'].includes(key)) continue
        let nested
        try { nested = value[key] } catch (_) { continue }
        visit(nested, path + '.' + key, depth + 1)
      }
    }
    roots.forEach((root, index) => visit(root, 'root' + index, 0))
    const result = []
    const unique = new Set()
    for (const candidate of candidates) {
      if (!candidate || !['object', 'function'].includes(typeof candidate) || unique.has(candidate)) continue
      if (!['subscribe', 'listen', 'addListener', 'on', 'addEventListener'].some((name) => typeof candidate[name] === 'function')) continue
      unique.add(candidate); result.push(candidate)
    }
    return result
  }
  const bindNotificationSource = (source, subscriptions) => {
    if (!source || !['object', 'function'].includes(typeof source)) return false
    const publish = (value) => { const notification = notificationOrderId(value); if (notification) enqueueOrderRefresh({ ...notification, source: 'official-runtime' }) }
    for (const name of ['subscribe', 'listen']) {
      if (typeof source[name] !== 'function') continue
      try {
        const result = source[name](publish)
        subscriptions.push(() => { try { typeof result === 'function' ? result() : result?.unsubscribe?.() } catch (_) {} })
        return true
      } catch (_) {}
    }
    for (const name of ['addListener', 'on', 'addEventListener']) {
      if (typeof source[name] !== 'function') continue
      try {
        if (source[name].length <= 1) {
          const result = source[name](publish)
          subscriptions.push(() => { try { typeof result === 'function' ? result() : result?.unsubscribe?.() } catch (_) {} })
          return true
        }
        let bound = false
        for (const eventName of ['notification', 'notice', 'alert', 'reach', 'message', 'event']) {
          try {
            const result = source[name](eventName, publish)
            subscriptions.push(() => {
              try {
                if (name === 'addEventListener') source.removeEventListener?.(eventName, publish)
                else source.removeListener?.(eventName, publish) || source.off?.(eventName, publish)
                typeof result === 'function' ? result() : result?.unsubscribe?.()
              } catch (_) {}
            })
            bound = true
          } catch (_) {}
        }
        if (bound) return true
      } catch (_) {}
    }
    return false
  }
  const bindFrontierNotificationSource = (subscriptions) => {
    const source = window.frontierInstance?.fws
    if (!source || typeof source.addEventListener !== 'function') return false
    const publish = (value) => {
      const notification = notificationOrderId(value)
      if (notification) {
        enqueueOrderRefresh({ ...notification, source: 'frontierInstance.fws.message' })
        return
      }
      const message = value?.message
      if (number(message?.service) === 20132 && number(message?.method) === 0) scheduleOrderDomainRefresh()
    }
    try {
      source.addEventListener('message', publish)
      subscriptions.push(() => { try { source.removeEventListener?.('message', publish) } catch (_) {} })
      return true
    } catch (_) { return false }
  }
  const bindOrderNotifications = () => {
    if (PAGE !== 'orders' || !orderListening) return
    const explicit = explicitNotificationCandidates()
    const discovered = discoveredNotificationCandidates()
    const candidateSets = explicit.length ? [['explicit', explicit]] : [['fallback', discovered]]
    if (explicit.length) candidateSets.push(['fallback', discovered])
    for (const [mode, candidates] of candidateSets) {
      if (orderNotificationCleanup && mode === orderNotificationBindingMode && candidates.length === orderNotificationSources.length && candidates.every((candidate) => orderNotificationSources.includes(candidate))) return
    }
    let selectedMode = ''
    let selectedCandidates = []
    let selectedSubscriptions = []
    for (const [mode, candidates] of candidateSets) {
      const subscriptions = []
      const bound = mode === 'explicit' && bindFrontierNotificationSource(subscriptions)
        || candidates.some((candidate) => candidate !== window.frontierInstance?.fws && bindNotificationSource(candidate, subscriptions))
      if (bound) {
        selectedMode = mode
        selectedCandidates = candidates
        selectedSubscriptions = subscriptions
        break
      }
      subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
    }
    try { orderNotificationCleanup?.() } catch (_) {}
    orderNotificationBindingMode = selectedMode
    orderNotificationSources = selectedCandidates
    orderNotificationCleanup = () => { selectedSubscriptions.splice(0).forEach((unsubscribe) => unsubscribe()); orderNotificationSources = []; orderNotificationBindingMode = ''; orderNotificationCleanup = null }
  }
  const reconcileOrders = async () => {
    if (!orderListening || orderReconciliationBusy || disposed) return
    orderReconciliationBusy = true
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    orderReconciliationController = controller
    try {
      const current = await requestCommerceOrders('', controller?.signal)
      for (const item of current.slice(0, ORDER_RECONCILIATION_LIMIT)) {
        if (orderRefreshes.has(item.externalId)) continue
        const previous = orderSnapshot(item.externalId)
        if (previous && isOlderOrder(previous, item)) continue
        if (!previous && (item.createdAt || 0) >= orderListenerStartedAt) emit({ type: 'order.created', payload: { order: item } })
        else if (previous && orderKey(previous) !== orderKey(item)) emit({ type: 'order.updated', payload: { order: item, previous, changedFields: changedOrderFields(previous, item) } })
        saveOrderSnapshot(item)
      }
    } finally {
      if (orderReconciliationController === controller) orderReconciliationController = null
      orderReconciliationBusy = false
    }
  }
  const bindMessages = () => {
    if (messageCleanup || PAGE !== 'primary') return
    if (!store()?.conversationsInfo) return
    const initial = messages()
    const initialWatermark = Math.max(Date.now() - 30_000, ...initial.map((item) => item.timestamp || 0))
    for (const item of initial) {
      seenMessages.add(item.id)
      seenFingerprints.add([item.conversationId, item.senderId, item.content, item.timestamp].join('|'))
      if (item.type === 'order') {
        const orderValue = orderFromMessage(item, item.conversationId)
        if (orderValue) messageOrderSnapshots.set(orderValue.externalId, orderValue)
      }
    }
    const publish = (value) => {
      const rows = []
      const pending = [value]
      const visited = new Set()
      while (pending.length && visited.size < 200) {
        const item = pending.shift()
        if (!item || typeof item !== 'object' || visited.has(item)) continue
        visited.add(item)
        const parsed = message(item, { selfId: text(store()?.selfInfo?.id) })
        const normalized = parsed ? correlateOutbound(parsed) : undefined
        if (normalized) rows.push(normalized)
        for (const key of ['message', 'data', 'payload', 'messages', 'items', 'list']) { const nested = item[key]; if (Array.isArray(nested)) pending.push(...nested); else if (nested && typeof nested === 'object') pending.push(nested) }
      }
      for (const item of rows) {
        if (item.direction === 'outbound' && item.raw?.provisional) continue
        const fingerprint = [item.conversationId, item.senderId, item.content, item.timestamp].join('|')
        if (seenMessages.has(item.id) || seenFingerprints.has(fingerprint)) continue
        seenMessages.add(item.id); seenFingerprints.add(fingerprint)
        if (item.timestamp <= initialWatermark) {
          if (item.type === 'order') {
            const orderValue = orderFromMessage(item, item.conversationId)
            if (orderValue) messageOrderSnapshots.set(orderValue.externalId, orderValue)
          }
          continue
        }
        if (item.type === 'order') {
          const orderValue = orderFromMessage(item, item.conversationId)
          if (orderValue) {
            const previous = messageOrderSnapshots.get(orderValue.externalId)
            if (!previous) emit({ type: 'order.created', payload: { order: orderValue } })
            else if (orderKey(previous) !== orderKey(orderValue)) {
              const changedFields = ['status', 'items', 'total', 'receiver'].filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(orderValue[key]))
              emit({ type: 'order.updated', payload: { order: orderValue, previous, changedFields } })
            }
            messageOrderSnapshots.set(orderValue.externalId, orderValue)
          }
        }
        emit({ type: 'message.created', payload: { message: item } })
      }
      if (seenMessages.size > 5000 || seenFingerprints.size > 5000) {
        seenMessages.clear(); seenFingerprints.clear()
        for (const current of messages()) { seenMessages.add(current.id); seenFingerprints.add([current.conversationId, current.senderId, current.content, current.timestamp].join('|')) }
      }
      if (messageOrderSnapshots.size > 2000) messageOrderSnapshots.clear()
    }
    const subscriptions = []
    for (const stream of [im()?._message$, im()?._messageUpsert$, im()?._batchUpsert$]) {
      if (typeof stream?.subscribe !== 'function') continue
      try { const subscription = stream.subscribe(publish); subscriptions.push(subscription) } catch (error) { emit({ type: 'runtime.error', payload: { message: String(error) } }) }
    }
    const timer = subscriptions.length ? null : setInterval(() => messages().forEach(publish), 2000)
    messageCleanup = () => { if (timer) clearInterval(timer); subscriptions.forEach((item) => { try { typeof item === 'function' ? item() : item?.unsubscribe?.() } catch (_) {} }); messageCleanup = null }
  }
  const invoke = async (operation, input = {}) => {
    if (disposed) return error('RUNTIME_NOT_READY', 'Runtime 已销毁', true)
    if (!operations.includes(operation)) return error('NOT_SUPPORTED', '当前页面未声明该 Operation')
    if (operation !== 'auth.state') { const authResult = await requireAuth(); if (authResult) return authResult }
    try {
      switch (operation) {
        case 'auth.state': return auth()
        case 'sessions.list': return { ok: true, data: sessionRows() }
        case 'messages.listen': bindMessages(); return { ok: true, data: { listening: true, watermark: Math.max(0, ...messages().map((item) => item.timestamp)) } }
        case 'messages.history': { const id = text(input.conversationId); if (!id) return error('INVALID_INPUT', 'conversationId 必填'); return { ok: true, data: messages(id) } }
        case 'messages.send.text': {
          const conversationId = text(input.conversationId), content = text(input.text)
          if (!conversationId || !content) return error('INVALID_INPUT', 'conversationId 和 text 必填')
          if (!sessionRows().some((item) => item.id === conversationId)) return error('INVALID_INPUT', '未找到目标会话')
          const api = im(); if (typeof api?.sendText !== 'function') return runtimeError()
          const correlation = trackOutbound(conversationId, 'text', content)
          let value
          try { value = await api.sendText(conversationId, content, {}) } catch (caught) { removeOutbound(correlation); throw caught }
          if (value?.success === false) { removeOutbound(correlation); return error('PLATFORM_ERROR', text(value.statusMsg || '发送文本失败'), true) }
          const id = text(value?.serverId || value?.messageId || value?.id)
          correlation.serverId = id
          rememberAutomatedOutbound(id)
          const outgoing = { id: id || 'pending-' + Date.now(), conversationId, senderId: text(store()?.selfInfo?.id) || undefined, content, type: 'text', direction: 'outbound', origin: 'automation', deliveryStatus: id || value?.success === true ? 'sent' : 'pending', timestamp: Date.now() }
          return { ok: true, data: outgoing }
        }
        case 'messages.send.file': {
          const conversationId = text(input.conversationId), data = text(input.data || input.dataUrl || input.url), name = text(input.name || input.fileName) || 'upload.bin', mimeType = text(input.mimeType || 'application/octet-stream')
          if (!conversationId || !data) return error('INVALID_INPUT', 'conversationId 和 data 必填')
          if (!sessionRows().some((item) => item.id === conversationId)) return error('INVALID_INPUT', '未找到目标会话')
          if (!mimeType.startsWith('image/')) return error('NOT_SUPPORTED', '抖店官方 window runtime 当前只支持图片发送')
          const context = window.__mona_pigeon_event?.globalStore?.data?.initContextData
          const api = im(); if (typeof api?.sendImage !== 'function' || typeof context?.customRequestUpload !== 'function') return runtimeError()
          const match = data.match(/^data:([^;,]+)?;base64,(.*)$/); const binary = atob(match?.[2] || data); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          const blob = new Blob([bytes], { type: mimeType })
          const file = new File([blob], name, { type: mimeType })
          const bitmap = await createImageBitmap(blob)
          const uri = URL.createObjectURL(blob)
          const upload = () => new Promise((resolve, reject) => context.customRequestUpload({ file, onSuccess: (response) => { const url = response?.data?.[0]?.url || response?.url || response?.uri; url ? resolve({ uri: url }) : reject(new Error('上传未返回地址')) }, onError: reject }))
          try {
            const correlation = trackOutbound(conversationId, 'image', '')
            let value
            try { value = await api.sendImage(conversationId, { uri, width: bitmap.width, height: bitmap.height, format: mimeType.split('/')[1] || 'png', size: file.size }, upload, {}, () => {}) } catch (caught) { removeOutbound(correlation); throw caught }
            if (!value) { removeOutbound(correlation); return error('PLATFORM_ERROR', '发送图片失败', true) }
            const id = text(value?.serverId || value?.messageId || value?.id)
            correlation.serverId = id
            rememberAutomatedOutbound(id)
            return { ok: true, data: { id: id || 'pending-' + Date.now(), conversationId, content: name, type: 'image', direction: 'outbound', origin: 'automation', deliveryStatus: id || value?.success === true ? 'sent' : 'pending', timestamp: Date.now(), attachments: [{ name, mimeType }] } }
          } finally { bitmap.close?.(); URL.revokeObjectURL(uri) }
        }
        case 'conversation.attention.set': return setConversationAttention(input)
        case 'products.list': return authoritativeProducts()
        case 'products.detail': {
          const id = text(input.id || input.externalId)
          if (!id) return error('INVALID_INPUT', '商品 id 必填')
          const listed = await authoritativeProducts()
          if (!listed.ok) return listed
          const found = listed.data.find((item) => item.externalId === id || item.id === id)
          return found ? { ok: true, data: found } : error('INVALID_INPUT', '未找到当前在售商品: ' + id)
        }
        case 'orders.list': { const result = await orders(text(input.conversationId), text(input.orderId || input.externalId)); return { ok: true, data: result } }
        case 'orders.listen': {
          const conversationId = text(input.conversationId)
          const orderId = text(input.orderId || input.externalId)
          const current = await orders(conversationId, orderId)
          orderSnapshots.set('*', new Map(current.map((item) => [item.externalId, item])))
          orderListening = true
          orderListenerStartedAt = Date.now()
          setListenerState(orderListenerStartedAt)
          bindOrderNotifications()
          if (!orderReconciliationTimer) orderReconciliationTimer = setInterval(() => { void reconcileOrders() }, ORDER_RECONCILIATION_INTERVAL_MS)
          return { ok: true, data: { listening: true, watermark: Math.max(0, ...current.map((item) => item.updatedAt || item.createdAt || 0)) } }
        }
        case 'handoff.targets.list': {
          const available = await handoffTargets()
          return available ? { ok: true, data: available.targets } : runtimeError()
        }
        case 'handoff.transfer': {
          const conversationId = text(input.conversationId), target = text(input.targetId || input.targetName)
          if (!conversationId) return error('INVALID_INPUT', 'conversationId 必填')
          if (!target) return error('INVALID_INPUT', '抖店转人工需要 targetId 或 targetName')
          const available = await handoffTargets()
          if (!available) return runtimeError()
          const selected = available.targets.find((item) => item.id === target || item.name === target) || available.targets.find((item) => item.name.includes(target))
          if (!selected) return error('INVALID_INPUT', '未在官方可转列表中找到目标客服或客服组')
          const transfer = available.transfer
          const targetId = text(selected.id || target)
          for (const name of ['transferConversation', 'transferSession', 'assignConversation', 'transfer']) if (typeof transfer[name] === 'function') {
            const value = await transfer[name](conversationId, targetId, input.remark)
            if (value?.success === false || value?.ok === false) return error('PLATFORM_ERROR', text(value?.error || value?.message || '转人工失败'), true)
            return { ok: true, data: { transferred: true, target: { id: targetId, name: selected.name } } }
          }
          const official = await transferViaOfficialApi(conversationId, targetId)
          if (!official.ok) return official
          return { ok: true, data: { transferred: true, target: { id: targetId, name: selected.name } } }
        }
      }
      return error('NOT_SUPPORTED', '当前 Runtime 不支持该 Operation')
    } catch (caught) {
      const message = String(caught?.message || caught)
      if (/challenge|captcha|verify|risk|验证码|滑块|安全验证/i.test(message)) return error('CHALLENGE_REQUIRED', message, true)
      if (/login|unauth|未登录|请登录/i.test(message)) return loginError()
      if (/rate|frequency|too many|频繁|限流/i.test(message)) return error('RATE_LIMITED', message, true)
      return error('PLATFORM_ERROR', message, true)
    }
  }
  window[KEY] = {
    get __disposed() { return disposed },
    protocolVersion: VERSION,
    describe: () => ({ protocolVersion: VERSION, platform: PLATFORM, pageId: PAGE, capabilities: [...operations], operations: [...operations] }),
    invoke,
    drainEvents: async () => { bindMessages(); bindOrderNotifications(); return queue.splice(0, queue.length) },
    dispose: async () => {
      if (disposed) return
      disposed = true
      outboundCorrelations.splice(0)
      automatedOutboundIds.clear()
      conversationAttention.clear()
      applyConversationAttention()
      stopConversationAttentionProjection()
      try { messageCleanup?.() } catch (_) {}
      try { orderNotificationCleanup?.() } catch (_) {}
      if (orderReconciliationTimer) clearInterval(orderReconciliationTimer)
      orderReconciliationTimer = null
      orderReconciliationController?.abort?.()
      orderReconciliationController = null
      if (orderDomainRefreshTimer) clearTimeout(orderDomainRefreshTimer)
      orderDomainRefreshTimer = null
      orderDomainRefreshController?.abort?.()
      orderDomainRefreshController = null
      orderDomainRefreshBusy = false
      orderDomainRefreshDirty = false
      for (const [timer, resolve] of retryTimers) {
        clearTimeout(timer)
        try { resolve() } catch (_) {}
      }
      retryTimers.clear()
      for (const state of orderRefreshes.values()) state.controller?.abort?.()
      orderRefreshes.clear()
      processingFingerprints.clear()
      processedFingerprints.clear()
      orderReconciliationBusy = false
      orderListening = false
      queue.length = 0
      seenMessages.clear()
      seenFingerprints.clear()
      orderSnapshots.clear()
      messageOrderSnapshots.clear()
    },
  }
})()`;
const primaryPage = douyinHookManifest.pages.find((page) => page.kind === "primary");
const productsPage = douyinHookManifest.pages.find((page) => page.id === "products");
const ordersPage = douyinHookManifest.pages.find((page) => page.id === "orders");
const capabilities$1 = [
  "messages.listen",
  "messages.history",
  "messages.send",
  "messages.file",
  "sessions.list",
  "products.collect",
  "products.detail",
  "orders.read",
  "orders.listen",
  "session.transfer"
];
const douyinHook = {
  id: "douyin-shop",
  label: "抖店",
  version: douyinHookManifest.version,
  url: primaryPage?.url || "https://im.jinritemai.com/pc_seller_v2/main/workspace",
  executionModel: "page",
  loginUrl: "https://fxg.jinritemai.com/login/common",
  loginMatch: ["https://im.jinritemai.com/login*"],
  capabilities: capabilities$1,
  runtimePages: [
    ...productsPage?.url ? [{ id: productsPage.id, url: productsPage.url, methods: ["collectProducts", "getProductDetail"] }] : [],
    ...ordersPage?.url ? [{ id: ordersPage.id, url: ordersPage.url, methods: ["getOrders", "syncOrders", "listenOrders"], persistent: true }] : []
  ],
  script: createShellRuntimeScript(),
  source: "builtin"
};
douyinHook.script || "";
function createShellRuntimeScript() {
  return `(() => {
${douyinHookRuntimeScript}
  const runtime = window.__PLATFORM_HOOK__
  if (!runtime) return
  const unwrap = async (operation, input = {}) => {
    const result = await runtime.invoke(operation, input)
    if (result?.ok) return result.data
    return { errorCode: result?.error?.code || 'PLATFORM_ERROR', error: result?.error?.message || 'Douyin operation failed' }
  }
  const message = (value) => {
    const item = value && typeof value === 'object' ? value : {}
    return {
      id: item.id,
      sessionId: item.conversationId,
      senderId: item.senderId || '',
      senderName: item.senderName || '',
      content: item.content || '',
      type: item.type || 'unknown',
      isMine: item.direction === 'outbound',
      direction: item.direction,
      origin: item.origin,
      timestamp: item.timestamp || Date.now(),
      ...(item.attachments?.[0]?.url ? { avatar: item.attachments[0].url } : {}),
      raw: item.raw,
    }
  }
  const product = (value) => {
    const item = value && typeof value === 'object' ? value : {}
    return {
      id: item.id,
      goodsId: item.externalId,
      name: item.title || '未命名商品',
      price: item.price?.amount || 0,
      stockQuantity: item.stockQuantity,
      status: item.status,
      images: item.images || [],
      goodsUrl: item.url,
      updatedAt: item.updatedAt,
      platform: 'douyin-shop',
      raw: item.raw,
    }
  }
  const order = (value, sessionId) => {
    const item = value && typeof value === 'object' ? value : {}
    const first = item.items?.[0] || {}
    return {
      id: item.id,
      orderId: item.externalId,
      status: item.status,
      totalAmount: item.total?.amount,
      quantity: first.quantity,
      productId: first.productId || first.externalProductId,
      productName: first.title,
      shopId: item.shopId,
      sessionId: item.conversationId || sessionId,
      userId: item.buyer?.id,
      buyerName: item.buyer?.name,
      receiverName: item.receiver?.name,
      shippingAddress: item.receiver?.address,
      updatedAt: item.updatedAt || item.createdAt,
      platform: 'douyin-shop',
      raw: item.raw,
    }
  }
  const event = (value) => {
    const item = value && typeof value === 'object' ? value : {}
    if (item.type === 'message.created') return { ...item, type: 'message', payload: { message: message(item.payload?.message) } }
    if (item.type === 'order.created' || item.type === 'order.updated') {
      return { ...item, type: 'order', payload: { ...item.payload, eventType: item.type, order: order(item.payload?.order, item.payload?.order?.conversationId || '') } }
    }
    if (item.type === 'runtime.error') return { ...item, type: 'error' }
    return item
  }
  window.__platformHub = {
    getAuthState: () => unwrap('auth.state'),
    listenMessages: async () => unwrap('messages.listen'),
    listSessions: async () => {
      const rows = await unwrap('sessions.list')
      return Array.isArray(rows) ? rows.map((item) => ({ ...item, unread: item.unreadCount || 0, avatar: item.avatarUrl })) : rows
    },
    listMessages: async (conversationId) => {
      const rows = await unwrap('messages.history', { conversationId })
      return Array.isArray(rows) ? rows.map(message) : rows
    },
    sendMessage: async (conversationId, text) => {
      const result = await unwrap('messages.send.text', { conversationId, text })
      return result?.errorCode ? { success: false, error: result.error, errorCode: result.errorCode } : { success: true, message: message(result) }
    },
    sendFile: async (conversationId, data, name, mimeType = 'image/png') => {
      const result = await unwrap('messages.send.file', { conversationId, data, name, mimeType })
      return result?.errorCode ? { success: false, error: result.error, errorCode: result.errorCode } : { success: true, message: message(result) }
    },
    collectProducts: async () => {
      const rows = await unwrap('products.list')
      return Array.isArray(rows) ? rows.map(product) : rows
    },
    getProductDetail: async (id) => {
      const result = await unwrap('products.detail', { id })
      return result?.errorCode ? result : product(result)
    },
    getOrders: async (conversationId, orderId) => {
      const rows = await unwrap('orders.list', { conversationId, orderId })
      return Array.isArray(rows) ? rows.map((item) => order(item, conversationId)) : rows
    },
    syncOrders: async (conversationId, orderId) => {
      const rows = await unwrap('orders.list', { conversationId, orderId })
      return rows?.errorCode ? rows : { orders: Array.isArray(rows) ? rows.map((item) => order(item, conversationId)) : [], authoritative: true, source: 'platform-runtime', syncedAt: Date.now() }
    },
    listenOrders: async (conversationId, orderId) => unwrap('orders.listen', { conversationId, orderId }),
    listHandoffTargets: async () => {
      const rows = await unwrap('handoff.targets.list')
      return Array.isArray(rows) ? rows : []
    },
    transferSession: (conversationId, target) => unwrap('handoff.transfer', { conversationId, targetId: target }),
    setConversationAttention: (conversationId, state) => unwrap('conversation.attention.set', { conversationId, state }),
    drainEvents: async () => (await runtime.drainEvents()).map(event),
    dispose: () => runtime.dispose(),
  }
})()`;
}
const capabilities = ["messages.listen", "messages.history", "messages.send", "messages.file", "sessions.list", "products.collect", "products.detail"];
const goofishHook = {
  id: "goofish",
  label: "闲鱼",
  version: "1.0.0",
  url: "https://www.goofish.com/im",
  executionModel: "native",
  capabilities,
  source: "builtin"
};
const kuaishouHook = { ...kuaishouHook$1, executionModel: "page" };
const builtinHooks = {
  [douyinHook.id]: douyinHook,
  [kuaishouHook.id]: kuaishouHook,
  [goofishHook.id]: goofishHook
};
const builtinPlatforms = [douyinHook, kuaishouHook, goofishHook].map((hook) => ({
  id: hook.id,
  label: hook.label,
  url: hook.url,
  executionModel: hook.executionModel,
  capabilities: hook.capabilities,
  hookVersion: hook.version,
  source: "builtin"
}));
const MESSAGE_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const MAX_MESSAGE_CLAIMS = 1e5;
const AUTOMATION_OUTBOUND_TTL_MS = 3e4;
const MAX_AUTOMATION_OUTBOUNDS = 500;
class ShopRuntimeManager {
  runtimes = /* @__PURE__ */ new Map();
  /**
   * Message delivery is shared by all account runtimes for the same shop.
   * Douyin can replay a conversation's existing messages after handoff; the
   * per-page/per-account listener watermarks cannot dedupe those deliveries.
   */
  messageClaims = /* @__PURE__ */ new Map();
  automationOutbounds = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  replyApi;
  fileLoader;
  constructor(replyApi, options = {}) {
    this.replyApi = replyApi;
    this.fileLoader = options.fileLoader || loadReplyFile;
  }
  register(accountId, transport, context = {}) {
    if (this.runtimes.has(accountId)) return;
    const runtime = {
      accountId,
      platform: context.platform || "unknown",
      shopName: context.shopName || accountId,
      // Use the account id as a stable mock-routing fallback until auth.state
      // supplies the platform's real shop id.
      shopId: accountId,
      transport,
      online: false,
      runtimeState: "stopped",
      messageListening: false,
      attention: /* @__PURE__ */ new Map(),
      processing: /* @__PURE__ */ new Set()
    };
    runtime.unsubscribe = transport.subscribe((event) => this.handleEvent(runtime, event));
    this.runtimes.set(accountId, runtime);
  }
  unregister(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.unsubscribe?.();
    runtime.unsubscribe = void 0;
    this.runtimes.delete(accountId);
    this.automationOutbounds.delete(accountId);
  }
  has(accountId) {
    return this.runtimes.has(accountId);
  }
  snapshot(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return void 0;
    return this.toSnapshot(runtime);
  }
  snapshots() {
    return [...this.runtimes.values()].map((runtime) => this.toSnapshot(runtime));
  }
  async setOnline(accountId, online) {
    const runtime = this.require(accountId);
    runtime.online = online;
    if (!online) {
      this.emit(runtime, "runtime", { online: false, runtimeState: runtime.runtimeState, messageListening: runtime.messageListening });
      return this.toSnapshot(runtime);
    }
    await this.start(runtime);
    return this.toSnapshot(runtime);
  }
  async stop(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.online = false;
    runtime.messageListening = false;
    runtime.runtimeState = "stopped";
    await runtime.transport.stop();
    runtime.unsubscribe?.();
    runtime.unsubscribe = void 0;
    this.runtimes.delete(accountId);
    this.automationOutbounds.delete(accountId);
  }
  async setAttention(accountId, conversationId, state) {
    const runtime = this.require(accountId);
    const result = await runtime.transport.invoke("conversation.attention.set", { conversationId, state });
    if (!result.ok) {
      if (result.error.code === "NOT_SUPPORTED") {
        this.emit(runtime, "attention", { conversationId, requestedState: state, supported: false });
        return;
      }
      throw new Error(result.error.message);
    }
    runtime.attention.set(conversationId, state);
    this.emit(runtime, "attention", { conversationId, state });
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Feed a native/legacy event into the same account-scoped pipeline. */
  pushEvent(accountId, event) {
    const runtime = this.runtimes.get(accountId);
    if (runtime) this.handleEvent(runtime, event);
  }
  /**
   * The Electron compatibility shell can receive an official outbound echo
   * without the Page Hook origin metadata. Attribute only messages that were
   * sent through this account's Reply API path, using a short-lived record and
   * an exact platform message id whenever one is available.
   */
  annotateEvent(accountId, event) {
    if (event.type !== "message") return event;
    const payload = asRecord$1(event.payload);
    const message = asRecord$1(payload.message || event.payload);
    const raw = asRecord$1(message.raw);
    const attribution = asRecord$1(raw.attributionMetadata);
    if (message.direction !== "outbound" || message.origin === "human" || message.origin === "automation" || attribution.manualSendCheck === true) return event;
    const records = this.automationOutbounds.get(accountId);
    if (!records?.length) return event;
    const now = Date.now();
    while (records.length && now - records[0].createdAt > AUTOMATION_OUTBOUND_TTL_MS) records.shift();
    const id = scalarString(message.id ?? message.serverId ?? message.messageId);
    const conversationId = scalarString(message.conversationId ?? message.sessionId);
    const type = scalarString(message.type ?? message.messageType) || "text";
    const content = scalarString(message.content ?? message.text);
    const matched = records.find((record) => Boolean(record.id && id && record.id === id)) || records.find((record) => {
      const timestamp = Number(message.timestamp) || event.timestamp || now;
      return record.conversationId === conversationId && record.type === type && record.content === content && timestamp >= record.createdAt - 5e3 && timestamp <= record.createdAt + AUTOMATION_OUTBOUND_TTL_MS;
    });
    if (!matched) return event;
    const index = records.indexOf(matched);
    if (index >= 0) records.splice(index, 1);
    const annotatedMessage = { ...message, origin: "automation" };
    return {
      ...event,
      payload: Object.prototype.hasOwnProperty.call(payload, "message") ? { ...payload, message: annotatedMessage } : annotatedMessage
    };
  }
  async start(runtime) {
    if (runtime.runtimeState === "running") return;
    if (runtime.startPromise) return runtime.startPromise;
    runtime.runtimeState = "starting";
    runtime.startPromise = (async () => {
      try {
        await runtime.transport.start();
        const auth = await runtime.transport.invoke("auth.state", {});
        if (!auth.ok) throw new Error(auth.error.message);
        const authData = asRecord$1(auth.data);
        const shopId = scalarString(authData.shopId ?? authData.shop_id);
        const userId = scalarString(authData.userId ?? authData.user_id);
        const authFlag = [authData.authenticated, authData.isLogin, authData.loggedIn].find((value) => typeof value === "boolean");
        const authenticated = typeof authFlag === "boolean" ? authFlag : Boolean(shopId || userId);
        if (!authenticated) throw new Error("LOGIN_REQUIRED: 店铺尚未登录，暂不启动 Reply API 自动处理");
        if (shopId) runtime.shopId = shopId;
        const listening = await runtime.transport.invoke("messages.listen", {});
        if (!listening.ok) throw new Error(listening.error.message);
        runtime.messageListening = true;
        runtime.runtimeState = "running";
        this.emit(runtime, "runtime", { online: runtime.online, runtimeState: runtime.runtimeState, messageListening: true });
      } catch (error) {
        runtime.runtimeState = "error";
        this.emit(runtime, "runtime", { online: runtime.online, runtimeState: "error", message: errorMessage(error) });
        throw error;
      } finally {
        runtime.startPromise = void 0;
      }
    })();
    return runtime.startPromise;
  }
  handleEvent(runtime, event) {
    const timestamp = event.timestamp || Date.now();
    this.emit(runtime, "hook", { event });
    if (event.type !== "message.created") return;
    const message = event.payload?.message || event.payload;
    if (!message) return;
    const conversationId = String(message.conversationId || message.sessionId || "");
    if (!conversationId) return;
    const direction = message.direction;
    const origin = message.origin;
    if (direction === "outbound") {
      if (origin === "human") void this.setAttention(runtime.accountId, conversationId, "resolved").catch(() => void 0);
      return;
    }
    if (direction !== "inbound" || origin !== "customer" || message.type === "system" || message.type === "order") return;
    runtime.lastIncomingAt = timestamp;
    const key = String(message.id || `${conversationId}:${timestamp}`);
    if (!runtime.online || runtime.runtimeState !== "running" || !runtime.messageListening || runtime.processing.has(key)) return;
    if (!this.claimShopMessage(runtime, conversationId, message)) return;
    runtime.processing.add(key);
    void this.processCustomerMessage(runtime, conversationId, message).finally(() => runtime.processing.delete(key));
  }
  claimShopMessage(runtime, conversationId, message) {
    const messageId = scalarString(message.id);
    if (!messageId) return true;
    const now = Date.now();
    for (const [key, expiresAt] of this.messageClaims) {
      if (expiresAt > now) break;
      this.messageClaims.delete(key);
    }
    const claimKey = JSON.stringify([runtime.platform, runtime.shopId, conversationId, messageId]);
    if (this.messageClaims.has(claimKey)) {
      this.messageClaims.delete(claimKey);
      this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS);
      return false;
    }
    this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS);
    while (this.messageClaims.size > MAX_MESSAGE_CLAIMS) {
      const oldest = this.messageClaims.keys().next().value;
      if (oldest === void 0) break;
      this.messageClaims.delete(oldest);
    }
    return true;
  }
  async processCustomerMessage(runtime, conversationId, message) {
    try {
      const decision = await this.replyApi.reply({
        accountId: runtime.accountId,
        platform: runtime.platform,
        shopId: runtime.shopId,
        shopName: runtime.shopName,
        conversationId,
        content: String(message.content || ""),
        customerId: String(message.senderId || message.userId || ""),
        customerName: String(message.senderName || message.name || ""),
        message
      });
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) {
        this.emit(runtime, "reply", { decision, conversationId, deliverySkipped: "shop-offline" });
        return;
      }
      if (decision.type === "reply") {
        const effects = {};
        if (decision.warnings?.length) effects.warnings = decision.warnings;
        if (decision.turn) effects.turn = decision.turn;
        if (decision.lifecycleAction) {
          const action = decision.lifecycleAction;
          const mapCard = action.payload?.map_card;
          if (action.kind === "map-card" || action.actionCode === 2 || mapCard) {
            effects.unsupportedLifecycleAction = "map-card";
            if (action.messages.length) await this.sendTexts(runtime, conversationId, action.messages);
          } else if (action.kind === "greeting" || action.kind === "farewell") {
            await this.sendTexts(runtime, conversationId, action.messages);
          }
          effects.lifecycleAction = action;
        } else {
          const texts = decision.texts || (decision.text ? [decision.text] : []);
          await this.sendTexts(runtime, conversationId, texts);
          for (const fileUrl of decision.fileUrls || []) {
            try {
              if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) break;
              const file = await this.fileLoader(fileUrl);
              const correlation = this.trackAutomation(runtime.accountId, conversationId, "image", file.name);
              try {
                const result = await runtime.transport.invoke("messages.send.file", {
                  conversationId,
                  data: file.dataUrl,
                  dataUrl: file.dataUrl,
                  name: file.name,
                  mimeType: file.mimeType
                });
                if (!result.ok) throw new Error(result.error.message);
                this.completeAutomation(correlation, result.data);
              } catch (error) {
                this.removeAutomation(runtime.accountId, correlation);
                throw error;
              }
            } catch (error) {
              const failures = Array.isArray(effects.fileErrors) ? effects.fileErrors : [];
              failures.push(errorMessage(error));
              effects.fileErrors = failures;
            }
          }
          if (decision.transfer) {
            await this.sendTexts(runtime, conversationId, decision.transfer.messages);
            if (decision.transfer.sendGreetingBeforeHandoff && decision.transfer.messages.length === 0) {
              await this.sendTexts(runtime, conversationId, ["您好，为您转接人工客服"]);
            }
            effects.handoff = await this.transferToOfficialTarget(runtime, conversationId, decision.transfer);
          }
        }
        this.emit(runtime, "reply", { decision, conversationId, ...effects });
      } else if (decision.type === "human_required") {
        await this.setAttention(runtime.accountId, conversationId, "pending");
        this.emit(runtime, "reply", { decision, conversationId, ...decision.turn ? { turn: decision.turn } : {}, ...decision.warnings?.length ? { warnings: decision.warnings } : {} });
      } else {
        this.emit(runtime, "reply", { decision, conversationId, ...decision.turn ? { turn: decision.turn } : {}, ...decision.warnings?.length ? { warnings: decision.warnings } : {} });
      }
      runtime.lastReplyAt = Date.now();
      runtime.lastReplyType = decision.type;
    } catch (error) {
      this.emit(runtime, "runtime", {
        replyError: errorMessage(error),
        ...error instanceof ReplyApiError ? { replyErrorCode: error.code } : {},
        conversationId
      });
    }
  }
  async sendTexts(runtime, conversationId, texts) {
    for (const text of texts) {
      if (!text.trim()) continue;
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return;
      const correlation = this.trackAutomation(runtime.accountId, conversationId, "text", text);
      try {
        const result = await runtime.transport.invoke("messages.send.text", { conversationId, text });
        if (!result.ok) throw new Error(result.error.message);
        this.completeAutomation(correlation, result.data);
      } catch (error) {
        this.removeAutomation(runtime.accountId, correlation);
        throw error;
      }
    }
  }
  trackAutomation(accountId, conversationId, type, content) {
    const record = { conversationId, type, content, createdAt: Date.now() };
    const records = this.automationOutbounds.get(accountId) || [];
    records.push(record);
    while (records.length > MAX_AUTOMATION_OUTBOUNDS) records.shift();
    this.automationOutbounds.set(accountId, records);
    return record;
  }
  completeAutomation(record, value) {
    const wrapper = asRecord$1(value);
    const message = asRecord$1(wrapper.message || value);
    record.id = scalarString(message.id ?? message.serverId ?? message.messageId) || void 0;
    record.content = scalarString(message.content ?? message.text ?? message.name) || record.content;
  }
  removeAutomation(accountId, record) {
    const records = this.automationOutbounds.get(accountId);
    if (!records) return;
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    if (!records.length) this.automationOutbounds.delete(accountId);
  }
  async transferToOfficialTarget(runtime, conversationId, transfer) {
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: "shop-offline" };
    const requested = transferTargetReference(transfer.target);
    if (!requested) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "official-target-required" };
    }
    const listed = await runtime.transport.invoke("handoff.targets.list", {});
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: "shop-offline" };
    if (!listed.ok || !Array.isArray(listed.data)) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "official-target-list-unavailable" };
    }
    const target = listed.data.map(asRecord$1).find(
      (item) => requested.id && scalarString(item.id) === requested.id || requested.name && scalarString(item.name) === requested.name
    );
    const targetId = target && scalarString(target.id);
    const targetName = target && scalarString(target.name);
    if (!target || !targetId) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "requested-target-not-in-official-list" };
    }
    const transferred = await runtime.transport.invoke("handoff.transfer", {
      conversationId,
      targetId,
      targetName,
      reason: transfer.reason
    });
    if (!transferred.ok) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: transferred.error.message, target: { id: targetId, name: targetName } };
    }
    return { transferred: true, target: { id: targetId, name: targetName }, reason: transfer.reason };
  }
  emit(runtime, type, payload) {
    const event = { accountId: runtime.accountId, type, timestamp: Date.now(), payload };
    for (const listener of [...this.listeners]) listener(event);
  }
  toSnapshot(runtime) {
    return {
      accountId: runtime.accountId,
      online: runtime.online,
      runtimeState: runtime.runtimeState,
      messageListening: runtime.messageListening,
      lastIncomingAt: runtime.lastIncomingAt,
      lastReplyAt: runtime.lastReplyAt,
      lastReplyType: runtime.lastReplyType,
      attention: Object.fromEntries(runtime.attention)
    };
  }
  require(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) throw new Error(`店铺 Runtime 不存在: ${accountId}`);
    return runtime;
  }
}
class HttpShopReplyApi {
  endpoint;
  endpointError;
  fetcher;
  timeoutMs;
  waitBeforeRetry;
  constructor(options = {}) {
    const configuredEndpoint = options.endpoint || process.env.PLATFORM_HUB_REPLY_API_URL || DEFAULT_REPLY_API_URL;
    try {
      this.endpoint = normalizeReplyEndpoint(configuredEndpoint);
    } catch (error) {
      this.endpoint = configuredEndpoint;
      this.endpointError = errorMessage(error);
    }
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs) || positiveInteger(Number(process.env.PLATFORM_HUB_REPLY_API_TIMEOUT_MS)) || 15e3;
    this.waitBeforeRetry = options.waitBeforeRetry || wait;
  }
  async reply(input) {
    if (this.endpointError) throw new ReplyApiError("INVALID_ENDPOINT", `Reply API 地址无效: ${this.endpointError}`);
    const message = asRecord$1(input.message);
    const messageType = scalarString(message.type) || scalarString(message.message_type) || "unknown";
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
          from: { id: input.customerId, name: input.customerName }
        }],
        extra_context: {
          account_id: input.accountId,
          conversation_id: input.conversationId,
          message_id: scalarString(message.id)
        }
      }
    };
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250);
          continue;
        }
        throw new ReplyApiError(timeout ? "TIMEOUT" : "NETWORK_ERROR", timeout ? "Reply API 请求超时" : `Reply API 网络失败: ${errorMessage(error)}`);
      }
      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250);
          continue;
        }
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ReplyApiError(timeout ? "TIMEOUT" : "NETWORK_ERROR", `读取 Reply API 响应失败: ${errorMessage(error)}`);
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = safeErrorDetail(responseText);
        const retryable = response.status === 429 || [500, 502, 503].includes(response.status);
        const delayMs = retryable ? retryDelay(response.headers.get("retry-after"), attempt) : void 0;
        if (retryable && attempt < maxAttempts && delayMs !== void 0) {
          await this.waitBeforeRetry(delayMs);
          continue;
        }
        throw new ReplyApiError(`HTTP_${response.status}`, detail || `Reply API HTTP ${response.status}`);
      }
      return parseReplyApiBody(responseText);
    }
    throw new ReplyApiError("NETWORK_ERROR", "Reply API 请求失败");
  }
}
const DEFAULT_REPLY_API_URL = "http://192.168.5.3:18021/api/v1/chats/reply";
class ReplyApiError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReplyApiError";
  }
}
function parseReplyApiBody(bodyText) {
  if (!bodyText) throw new ReplyApiError("EMPTY_BODY", "Reply API 返回空 body");
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ReplyApiError("INVALID_JSON", "Reply API 返回非法 JSON");
  }
  const root = asRecord$1(parsed);
  const data = asRecord$1(root.data);
  const turn = Object.keys(asRecord$1(data.turn)).length ? asRecord$1(data.turn) : void 0;
  if (turn?.should_process === false) return { type: "ignore", reason: "turn-should-not-process", turn };
  const lifecycle = asRecord$1(data.lifecycle);
  const actionValue = asRecord$1(lifecycle.action);
  if (Object.keys(actionValue).length) {
    const messages = stringArray(actionValue.messages);
    const warnings2 = Array.isArray(actionValue.messages) && messages.length !== actionValue.messages.length ? ["lifecycle.action.messages 包含非字符串，已丢弃"] : void 0;
    return {
      type: "reply",
      texts: [],
      lifecycleAction: {
        kind: scalarString(actionValue.kind) || "unknown",
        actionId: scalarString(actionValue.action_id),
        messages,
        actionCode: finiteNumber(actionValue.action_code),
        payload: Object.keys(asRecord$1(actionValue.payload)).length ? asRecord$1(actionValue.payload) : void 0
      },
      ...turn ? { turn } : {},
      ...warnings2 ? { warnings: warnings2 } : {}
    };
  }
  if (!Object.prototype.hasOwnProperty.call(data, "ai_reply")) {
    return { type: "ignore", reason: "unrecognized-response", ...turn ? { turn } : {}, warnings: ["响应缺少 data.ai_reply 与 lifecycle.action"] };
  }
  const ai = data.ai_reply;
  if (ai === null) return { type: "ignore", reason: "no-ai-reply", ...turn ? { turn } : {} };
  if (!ai || typeof ai !== "object" || Array.isArray(ai)) return { type: "ignore", reason: "unrecognized-ai-reply", ...turn ? { turn } : {}, warnings: ["data.ai_reply 类型错误，已忽略"] };
  const aiReply = asRecord$1(ai);
  const rawParts = aiReply.reply_parts;
  const texts = stringArray(rawParts);
  const rawFiles = aiReply.file_urls;
  const fileUrls = stringArray(rawFiles).filter(isHttpUrl);
  const transferRaw = asRecord$1(aiReply.transfer);
  const transfer = transferRaw.is_transfer === true ? {
    reason: scalarString(transferRaw.transfer_reason),
    source: scalarString(transferRaw.transfer_source),
    target: transferRaw.transfer_person,
    messages: stringArray(transferRaw.transfer_messages),
    sendGreetingBeforeHandoff: transferRaw.send_greeting_before_handoff === true,
    confidence: finiteNumber(transferRaw.confidence)
  } : void 0;
  const warnings = [];
  if (rawParts != null && !Array.isArray(rawParts)) warnings.push("ai_reply.reply_parts 类型错误，已丢弃");
  else if (Array.isArray(rawParts) && texts.length !== rawParts.length) warnings.push("ai_reply.reply_parts 含非字符串，已丢弃");
  if (rawFiles != null && !Array.isArray(rawFiles)) warnings.push("ai_reply.file_urls 类型错误，已丢弃");
  else if (Array.isArray(rawFiles) && fileUrls.length !== rawFiles.length) warnings.push("ai_reply.file_urls 含无效 URL，已丢弃");
  if (transferRaw.transfer_messages != null && !Array.isArray(transferRaw.transfer_messages)) warnings.push("transfer.transfer_messages 类型错误，已丢弃");
  if (!texts.length && !fileUrls.length && !transfer) return { type: "ignore", reason: "empty-ai-reply", ...turn ? { turn } : {}, ...warnings.length ? { warnings } : {} };
  return {
    type: "reply",
    texts,
    fileUrls,
    ...transfer ? { transfer } : {},
    ...turn ? { turn } : {},
    ...warnings.length ? { warnings } : {}
  };
}
function transferTargetReference(value) {
  if (typeof value === "string" || typeof value === "number") {
    const target = String(value).trim();
    return target ? { id: target, name: target } : void 0;
  }
  const item = asRecord$1(value);
  const id = scalarString(item.id || item.target_id || item.staff_id);
  const name = scalarString(item.name || item.target_name || item.staff_name);
  return id || name ? { id, name } : void 0;
}
async function loadReplyFile(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || isPrivateHostname(parsed.hostname)) throw new Error("Reply API 附件必须使用公网 HTTPS URL");
  const response = await fetch(url, { signal: AbortSignal.timeout(15e3), redirect: "error" });
  if (!response.ok) throw new Error(`读取 Reply API 附件失败: HTTP ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
  if (!mimeType.startsWith("image/")) throw new Error(`当前 Douyin Hook 暂不支持此附件类型: ${mimeType}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 8 * 1024 * 1024) throw new Error("Reply API 附件超过 8 MB 限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Reply API 附件超过 8 MB 限制");
  const base64 = Buffer.from(bytes).toString("base64");
  const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "reply-attachment").slice(0, 180);
  return { dataUrl: `data:${mimeType};base64,${base64}`, name: leaf, mimeType };
}
function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}
function normalizeReplyEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 HTTP / HTTPS");
  if (url.pathname === "/" || !url.pathname) url.pathname = "/api/v1/chats/reply";
  return url.toString();
}
function safeErrorDetail(bodyText) {
  try {
    const value = asRecord$1(JSON.parse(bodyText));
    return scalarString(value.detail) || scalarString(value.message);
  } catch {
    return bodyText.trim().slice(0, 400) || void 0;
  }
}
function retryDelay(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      const delayMs = Math.max(0, seconds * 1e3);
      return delayMs <= 3e4 ? delayMs : void 0;
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const delayMs = Math.max(0, date - Date.now());
      return delayMs <= 3e4 ? delayMs : void 0;
    }
  }
  return Math.min(2e3, 250 * 2 ** (attempt - 1));
}
function wait(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function positiveInteger(value) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : void 0;
}
function asRecord$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function scalarString(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : void 0;
}
function finiteNumber(value) {
  const number = Number(value);
  return value !== void 0 && Number.isFinite(number) ? number : void 0;
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
class PlatformManager {
  sessions = /* @__PURE__ */ new Map();
  goofishTransports = /* @__PURE__ */ new Map();
  goofishViews = /* @__PURE__ */ new Map();
  goofishAttachedWindows = /* @__PURE__ */ new Map();
  goofishPrimaryLoads = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  forwardedRuntimeEventIds = /* @__PURE__ */ new Set();
  state = { accounts: [], hooks: [] };
  statePath;
  stateBackupPath;
  saveQueue = Promise.resolve();
  shopRuntimes = new ShopRuntimeManager(new HttpShopReplyApi());
  goofishClientListener = (event) => this.onGoofishClientEvent(event);
  goofishClient = new GoofishMessagingClient({
    electron: { BrowserWindow, session, app },
    userDataPath: app.getPath("userData"),
    partitionPrefix: "goofish-messaging",
    shouldKeepAccountAlive: (clientAccountId) => [...this.state.accounts].some((account) => account.goofishClientAccountId === clientAccountId && account.online)
  });
  hostWindow = null;
  activeAccountId = "";
  primaryViewportBounds = null;
  constructor() {
    this.statePath = join(app.getPath("userData"), "platform-hub.json");
    this.stateBackupPath = join(app.getPath("userData"), "platform-hub.json.bak");
    this.shopRuntimes.onEvent((event) => this.emitRuntimeEvent(event));
  }
  async init() {
    this.state = await this.readState(this.statePath) || await this.readState(this.stateBackupPath) || { accounts: [], hooks: [] };
    this.state.accounts = this.state.accounts.map((account) => ({
      ...account,
      online: account.online === true,
      runtimeState: account.runtimeState || "stopped",
      messageListening: account.messageListening === true
    }));
    this.goofishClient.on("event", this.goofishClientListener);
    for (const account of this.state.accounts.filter((item) => item.platform === "goofish")) {
      this.ensureGoofishClientAccount(account);
      this.ensureGoofishTransport(account.id);
    }
  }
  async attachMainWindow(window) {
    if (this.hostWindow && this.hostWindow !== window) this.detachPrimaryViewsExcept("");
    this.hostWindow = window;
    for (const account of this.state.accounts) {
      if (account.platform === "goofish") this.ensureGoofishTransport(account.id);
      else {
        const existing = this.sessions.get(account.id);
        if (existing) existing.bindHostWindow(window);
        else this.ensureSession(account.id);
      }
    }
    for (const account of this.state.accounts.filter((item) => item.online)) {
      await this.setAccountOnline(account.id, true).catch((error) => {
        account.runtimeState = "error";
        console.error(`[platform-hub] 恢复店铺 Runtime 失败: ${account.id}`, error);
      });
    }
    if (this.activeAccountId) {
      this.detachPrimaryViewsExcept(this.activeAccountId);
      await this.attachPrimaryView(this.activeAccountId);
    }
  }
  listPlatforms() {
    return [...builtinPlatforms, ...this.state.hooks.map(({ manifest }) => ({
      id: manifest.id,
      label: manifest.label,
      url: manifest.url,
      executionModel: manifest.executionModel,
      capabilities: manifest.capabilities,
      hookVersion: manifest.version,
      source: "imported"
    }))];
  }
  listAccounts() {
    return this.state.accounts.map((account) => {
      const cdp = this.sessions.get(account.id);
      const goofishView = this.goofishViews.get(account.id);
      const live = cdp?.getStatus();
      return {
        ...account,
        connected: live?.connected ?? account.connected,
        authenticated: live?.authenticated ?? account.authenticated,
        webContentsId: cdp?.getWebContentsId() || this.liveGoofishWebContentsId(goofishView),
        ...this.shopRuntimes.snapshot(account.id) || { online: account.online, runtimeState: account.runtimeState, messageListening: account.messageListening }
      };
    });
  }
  async addAccount(input) {
    const platform = this.listPlatforms().find((item) => item.id === input.platform);
    if (!platform) throw new Error(`未找到平台适配器: ${input.platform}`);
    const id = randomUUID();
    const account = {
      id,
      platform: platform.id,
      label: input.label.trim() || platform.label,
      url: input.url || platform.url,
      partition: partitionFor(platform.id, id),
      connected: false,
      authenticated: false,
      online: false,
      runtimeState: "stopped",
      messageListening: false,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (platform.id === "goofish") {
      const clientAccount = this.goofishClient.addAccount({ id: temporaryGoofishAccountId(), label: account.label, show: false });
      const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccount.id);
      account.goofishClientAccountId = clientAccount.id;
      account.partition = config.partition;
      account.url = config.url;
    }
    this.state.accounts.push(account);
    if (this.hostWindow) {
      if (account.platform === "goofish") this.ensureGoofishTransport(account.id);
      else this.ensureSession(account.id);
    }
    await this.save();
    return account;
  }
  async removeAccount(accountId) {
    await this.shopRuntimes.stop(accountId).catch(() => void 0);
    this.shopRuntimes.unregister(accountId);
    this.sessions.get(accountId)?.close();
    this.sessions.delete(accountId);
    const account = this.state.accounts.find((item) => item.id === accountId);
    this.closeGoofishView(accountId);
    this.goofishTransports.delete(accountId);
    this.goofishPrimaryLoads.delete(accountId);
    if (account?.platform === "goofish") {
      const clientAccountId = this.currentGoofishClientAccountId(account);
      try {
        this.goofishClient.removeAccount(clientAccountId);
      } catch {
      }
    }
    this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = "";
    await this.save();
  }
  async open(accountId) {
    const account = this.requireAccount(accountId);
    await this.attachPrimaryView(accountId);
    this.activeAccountId = accountId;
    const webContentsId = account.platform === "goofish" ? this.liveGoofishWebContentsId(this.goofishViews.get(accountId)) : this.sessions.get(accountId)?.getWebContentsId();
    account.connected = true;
    account.webContentsId = webContentsId;
    account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save();
    return { ...account, connected: true, webContentsId };
  }
  async connect(accountId, webContentsId) {
    const account = this.requireAccount(accountId);
    if (account.platform === "goofish") {
      if (this.liveGoofishWebContentsId(this.goofishViews.get(accountId)) !== webContentsId) throw new Error("闲鱼 WebContents 与账号不匹配");
      account.connected = true;
      account.webContentsId = webContentsId;
      account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.save();
      return this.status(accountId);
    }
    const cdp = this.sessions.get(accountId);
    if (!cdp || cdp.getWebContentsId() !== webContentsId) throw new Error("CDP 页面与账号不匹配");
    account.connected = true;
    account.webContentsId = webContentsId;
    account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save();
    return cdp.getStatus();
  }
  async disconnect(accountId) {
    await this.shopRuntimes.stop(accountId).catch(() => void 0);
    this.shopRuntimes.unregister(accountId);
    this.sessions.get(accountId)?.close();
    this.sessions.delete(accountId);
    const account = this.requireAccount(accountId);
    if (account.platform === "goofish") {
      try {
        this.goofishClient.closeProducts(this.currentGoofishClientAccountId(account));
      } catch {
      }
      this.closeGoofishView(accountId);
      this.goofishTransports.delete(accountId);
      this.goofishPrimaryLoads.delete(accountId);
    }
    account.connected = false;
    account.webContentsId = void 0;
    account.online = false;
    account.runtimeState = "stopped";
    account.messageListening = false;
    await this.save();
  }
  async setAccountOnline(accountId, online) {
    const account = this.requireAccount(accountId);
    if (account.platform === "goofish") {
      const transport = this.ensureGoofishTransport(accountId);
      if (online) {
        const view = this.ensureGoofishView(accountId);
        await this.waitForGoofishPrimary(view);
        account.connected = true;
        account.webContentsId = view.webContents.id;
      }
      if (this.activeAccountId === accountId) await this.attachPrimaryView(accountId);
      if (!this.shopRuntimes.has(accountId)) this.shopRuntimes.register(accountId, transport, { platform: account.platform, shopName: account.label });
    } else {
      let cdp = this.sessions.get(accountId);
      if (online && (!cdp || !cdp.getStatus().connected)) {
        cdp = this.ensureSession(accountId);
        await cdp.open(false);
        account.connected = true;
        account.webContentsId = cdp.getWebContentsId();
      }
      if (!cdp) throw new Error("请先打开平台页面");
      if (this.activeAccountId === accountId) await this.attachPrimaryView(accountId);
      if (!this.shopRuntimes.has(accountId)) this.shopRuntimes.register(accountId, new CdpShopTransport(cdp), { platform: account.platform, shopName: account.label });
    }
    account.online = online;
    try {
      const snapshot = await this.shopRuntimes.setOnline(accountId, online);
      account.runtimeState = snapshot.runtimeState;
      account.messageListening = snapshot.messageListening;
      await this.save();
      return this.listAccounts().find((item) => item.id === accountId) || account;
    } catch (error) {
      const snapshot = this.shopRuntimes.snapshot(accountId);
      account.runtimeState = snapshot?.runtimeState || "error";
      account.messageListening = snapshot?.messageListening || false;
      await this.save();
      throw error;
    }
  }
  runtimeStates() {
    return this.shopRuntimes.snapshots();
  }
  setPrimaryViewportBounds(bounds) {
    this.primaryViewportBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    };
    if (!this.activeAccountId) return;
    const account = this.state.accounts.find((item) => item.id === this.activeAccountId);
    if (account?.platform === "goofish") {
      const view = this.goofishViews.get(this.activeAccountId);
      if (view && this.goofishAttachedWindows.has(this.activeAccountId)) view.setBounds(this.primaryViewportBounds);
    } else this.sessions.get(this.activeAccountId)?.setPrimaryBounds(this.primaryViewportBounds);
  }
  async setConversationAttention(accountId, conversationId, state) {
    await this.shopRuntimes.setAttention(accountId, conversationId, state);
  }
  async status(accountId) {
    const account = this.requireAccount(accountId);
    if (account.platform === "goofish") {
      const view = this.ensureGoofishView(accountId);
      const auth = await this.goofishInvoke(accountId, "auth.state", {});
      account.connected = Boolean(this.liveGoofishWebContentsId(view));
      account.authenticated = auth.authenticated === true;
      account.webContentsId = this.liveGoofishWebContentsId(view);
      if (auth.userId) {
        account.label = account.label || String(auth.nickname || "闲鱼店铺");
      }
      return {
        accountId,
        platform: account.platform,
        connected: account.connected,
        authenticated: account.authenticated,
        url: view.webContents.getURL() || account.url,
        title: view.webContents.getTitle(),
        message: account.authenticated ? "闲鱼已登录，Runtime 已就绪" : "请在当前闲鱼官方页面完成登录"
      };
    }
    let cdp = this.sessions.get(accountId);
    if (!cdp) {
      await this.open(accountId);
      cdp = this.sessions.get(accountId);
    }
    if (!cdp) throw new Error("页面尚未连接");
    await cdp.open(false);
    return cdp.refreshStatus();
  }
  async collectProducts(accountId) {
    if (this.requireAccount(accountId).platform === "goofish") return (await this.goofishInvoke(accountId, "products.list", {})).map(toPlatformProduct);
    return this.withLogin(accountId, "collectProducts");
  }
  async productDetail(accountId, goodsId) {
    if (this.requireAccount(accountId).platform === "goofish") return toPlatformProduct(await this.goofishInvoke(accountId, "products.detail", { id: goodsId }));
    return this.withLogin(accountId, "getProductDetail", goodsId);
  }
  async sessionsFor(accountId) {
    if (this.requireAccount(accountId).platform === "goofish") return (await this.goofishInvoke(accountId, "sessions.list", {})).map(toPlatformSession);
    return this.withLogin(accountId, "listSessions");
  }
  async messagesFor(accountId, sessionId) {
    if (this.requireAccount(accountId).platform === "goofish") return (await this.goofishInvoke(accountId, "messages.history", { conversationId: sessionId })).map(toPlatformMessage);
    return this.withLogin(accountId, "listMessages", sessionId);
  }
  async ordersFor(accountId, userId) {
    if (this.requireAccount(accountId).platform === "goofish") throw new Error("闲鱼暂不支持订单能力");
    return this.withLogin(accountId, "getOrders", userId);
  }
  async syncOrdersFor(accountId, sessionId, userId) {
    if (this.requireAccount(accountId).platform === "goofish") throw new Error("闲鱼暂不支持订单能力");
    return this.withLogin(accountId, "syncOrders", sessionId, userId);
  }
  async listenOrdersFor(accountId, sessionId, orderId) {
    if (this.requireAccount(accountId).platform === "goofish") throw new Error("闲鱼暂不支持订单能力");
    return this.withLogin(accountId, "listenOrders", sessionId, orderId);
  }
  async listenMessagesFor(accountId) {
    if (this.requireAccount(accountId).platform === "goofish") return this.goofishInvoke(accountId, "messages.listen", {});
    return this.withLogin(accountId, "listenMessages");
  }
  async handoffTargetsFor(accountId) {
    if (this.requireAccount(accountId).platform === "goofish") throw new Error("闲鱼暂不支持官方转人工目标能力");
    return this.withLogin(accountId, "listHandoffTargets");
  }
  async sendMessage(accountId, sessionId, content) {
    if (this.requireAccount(accountId).platform === "goofish") {
      await this.goofishInvoke(accountId, "messages.send.text", { conversationId: sessionId, text: content });
      return { success: true };
    }
    return this.withLogin(accountId, "sendMessage", sessionId, content);
  }
  async sendFile(accountId, sessionId, dataUrl, fileName) {
    if (this.requireAccount(accountId).platform === "goofish") {
      await this.goofishInvoke(accountId, "messages.send.file", { conversationId: sessionId, dataUrl, name: fileName, mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] || "image/png" });
      return { success: true };
    }
    return this.withLogin(accountId, "sendFile", sessionId, dataUrl, fileName);
  }
  async transferSession(accountId, sessionId, target) {
    if (this.requireAccount(accountId).platform === "goofish") throw new Error("闲鱼暂不支持官方会话转接能力");
    return this.withLogin(accountId, "transferSession", sessionId, target);
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async dispose() {
    for (const account of this.state.accounts) {
      await this.shopRuntimes.stop(account.id).catch(() => void 0);
      this.shopRuntimes.unregister(account.id);
      this.sessions.get(account.id)?.close();
      this.sessions.delete(account.id);
      if (account.platform === "goofish") this.closeGoofishView(account.id);
    }
    this.goofishClient.removeListener("event", this.goofishClientListener);
    this.goofishClient.dispose();
    this.goofishTransports.clear();
    this.listeners.clear();
  }
  async importPackage() {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Hook package", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const manifestPath = result.filePaths[0];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest.script && manifest.entry) {
      const packageRoot = dirname(manifestPath);
      const entryPath = resolve(packageRoot, manifest.entry);
      if (relative(packageRoot, entryPath).startsWith("..")) throw new Error("Hook 包 entry 不能指向包目录之外");
      manifest.script = await readFile(entryPath, "utf8");
    }
    if (!manifest.id || !manifest.script || !manifest.url || !Array.isArray(manifest.capabilities)) throw new Error("Hook 包 manifest 缺少必要字段");
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: result.filePaths[0] }];
    await this.save();
    return { id: manifest.id, label: manifest.label, url: manifest.url, capabilities: manifest.capabilities, hookVersion: manifest.version, source: "imported" };
  }
  getHook(id) {
    return this.state.hooks.find((item) => item.manifest.id === id)?.manifest || builtinHooks[id];
  }
  requireAccount(id) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) throw new Error("平台账号不存在");
    return account;
  }
  ensureGoofishClientAccount(account) {
    const clientAccounts = this.goofishClient.listAccounts();
    const match = clientAccounts.find((item) => String(item.id) === account.goofishClientAccountId) || clientAccounts.find((item) => {
      try {
        return this.goofishClient.getEmbeddedWebviewConfig(String(item.id)).partition === account.partition;
      } catch {
        return false;
      }
    });
    const clientAccount = match || this.goofishClient.addAccount({
      id: account.goofishClientAccountId || temporaryGoofishAccountId(),
      label: account.label,
      show: false
    });
    const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccount.id);
    const changed = account.goofishClientAccountId !== clientAccount.id || account.partition !== config.partition || account.url !== config.url;
    account.goofishClientAccountId = clientAccount.id;
    account.partition = config.partition;
    account.url = config.url;
    if (changed) void this.save();
    return clientAccount.id;
  }
  currentGoofishClientAccountId(account) {
    return this.ensureGoofishClientAccount(account);
  }
  ensureGoofishTransport(accountId) {
    const existing = this.goofishTransports.get(accountId);
    if (existing) return existing;
    const account = this.requireAccount(accountId);
    if (account.platform !== "goofish") throw new Error("账号不是闲鱼平台");
    const clientAccountId = this.ensureGoofishClientAccount(account);
    const transport = new GoofishTransport({ accountId, clientAccountId, client: this.goofishClient });
    this.goofishTransports.set(accountId, transport);
    this.shopRuntimes.register(accountId, transport, { platform: account.platform, shopName: account.label });
    return transport;
  }
  ensureGoofishView(accountId) {
    const account = this.requireAccount(accountId);
    if (account.platform !== "goofish") throw new Error("账号不是闲鱼平台");
    const existing = this.goofishViews.get(accountId);
    if (existing && !existing.webContents.isDestroyed()) return existing;
    if (!this.hostWindow || this.hostWindow.isDestroyed()) throw new Error("主工作台窗口尚未就绪");
    if (existing) this.goofishViews.delete(accountId);
    const clientAccountId = this.ensureGoofishClientAccount(account);
    const config = this.goofishClient.getEmbeddedWebviewConfig(clientAccountId);
    const view = new WebContentsView({
      webPreferences: {
        partition: config.partition,
        preload: fileURLToPath(config.preload),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isOfficialGoofishLoginUrl(url)) {
        void view.webContents.loadURL(url).catch((error) => this.emitGoofishRuntimeError(accountId, error));
      }
      return { action: "deny" };
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      this.emitGoofishRuntimeError(accountId, new Error(`闲鱼页面进程退出: ${details.reason}`));
    });
    view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emitGoofishRuntimeError(accountId, new Error(`闲鱼页面加载失败: ${description} (${url})`));
    });
    view.webContents.once("destroyed", () => {
      if (this.goofishViews.get(accountId) === view) {
        this.goofishViews.delete(accountId);
        this.goofishPrimaryLoads.delete(accountId);
        this.goofishAttachedWindows.delete(accountId);
      }
      this.goofishClient.detachEmbeddedWebContents(clientAccountId, view.webContents);
    });
    this.goofishViews.set(accountId, view);
    const load = (async () => {
      await this.goofishClient.attachEmbeddedWebContents(clientAccountId, view.webContents);
      await view.webContents.loadURL(config.url);
    })();
    this.goofishPrimaryLoads.set(accountId, load);
    void load.catch((error) => this.emitGoofishRuntimeError(accountId, error));
    return view;
  }
  liveGoofishWebContentsId(view) {
    return view && !view.webContents.isDestroyed() ? view.webContents.id : void 0;
  }
  async waitForGoofishPrimary(view) {
    if (view.webContents.isDestroyed()) throw new Error("闲鱼官方页面已关闭");
    const accountId = [...this.goofishViews].find(([, candidate]) => candidate === view)?.[0];
    const load = accountId ? this.goofishPrimaryLoads.get(accountId) : void 0;
    if (load) await load;
    if (view.webContents.isDestroyed()) throw new Error("闲鱼官方页面已关闭");
  }
  async attachPrimaryView(accountId) {
    const account = this.requireAccount(accountId);
    const hostWindow = this.hostWindow;
    if (!hostWindow || hostWindow.isDestroyed()) throw new Error("主工作台窗口尚未就绪");
    if (account.platform === "goofish") {
      const view = this.ensureGoofishView(accountId);
      await this.waitForGoofishPrimary(view);
      this.detachPrimaryViewsExcept(accountId);
      const attachedWindow = this.goofishAttachedWindows.get(accountId);
      if (attachedWindow !== hostWindow) {
        if (attachedWindow && !attachedWindow.isDestroyed()) {
          try {
            attachedWindow.contentView.removeChildView(view);
          } catch {
          }
        }
        hostWindow.contentView.addChildView(view);
        this.goofishAttachedWindows.set(accountId, hostWindow);
      }
      view.setVisible(true);
      if (this.primaryViewportBounds) view.setBounds(this.primaryViewportBounds);
      return;
    }
    const cdp = this.ensureSession(accountId);
    await cdp.open(false);
    this.detachPrimaryViewsExcept(accountId);
    cdp.attachPrimaryView();
    if (this.primaryViewportBounds) cdp.setPrimaryBounds(this.primaryViewportBounds);
  }
  detachGoofishView(accountId) {
    const view = this.goofishViews.get(accountId);
    const attachedWindow = this.goofishAttachedWindows.get(accountId);
    if (view && attachedWindow && !attachedWindow.isDestroyed()) {
      try {
        attachedWindow.contentView.removeChildView(view);
      } catch {
      }
    }
    if (view && !view.webContents.isDestroyed()) view.setVisible(false);
    this.goofishAttachedWindows.delete(accountId);
  }
  closeGoofishView(accountId) {
    const view = this.goofishViews.get(accountId);
    this.detachGoofishView(accountId);
    this.goofishViews.delete(accountId);
    this.goofishPrimaryLoads.delete(accountId);
    if (!view || view.webContents.isDestroyed()) return;
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (account) this.goofishClient.detachEmbeddedWebContents(this.currentGoofishClientAccountId(account), view.webContents);
    view.webContents.close();
  }
  ensureSession(accountId) {
    const existing = this.sessions.get(accountId);
    if (existing) return existing;
    const account = this.requireAccount(accountId);
    if (!this.hostWindow || this.hostWindow.isDestroyed()) throw new Error("主工作台窗口尚未就绪");
    const platform = this.listPlatforms().find((item) => item.id === account.platform);
    if (!platform) throw new Error(`未找到平台适配器: ${account.platform}`);
    const cdp = new CdpSession({ accountId, platform: platform.id, url: account.url, partition: account.partition, hook: this.getHook(platform.id), hostWindow: this.hostWindow, emit: (event) => this.emit(event) });
    this.sessions.set(accountId, cdp);
    this.shopRuntimes.register(accountId, new CdpShopTransport(cdp), { platform: account.platform, shopName: account.label });
    return cdp;
  }
  detachPrimaryViewsExcept(accountId) {
    for (const [id, session2] of this.sessions) {
      if (id !== accountId && session2.isPrimaryViewAttached()) session2.detachPrimaryView();
    }
    for (const id of this.goofishViews.keys()) {
      if (id !== accountId) this.detachGoofishView(id);
    }
  }
  async goofishInvoke(accountId, operation, input) {
    const transport = this.ensureGoofishTransport(accountId);
    const view = this.ensureGoofishView(accountId);
    await this.waitForGoofishPrimary(view);
    await transport.start();
    const result = await transport.invoke(operation, input);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return result.data;
  }
  onGoofishClientEvent(event) {
    const payload = asRecord(event.payload);
    const previousId = scalar(payload.previousAccountId);
    const nextId = scalar(payload.accountId ?? event.accountId);
    const account = this.state.accounts.find((item) => item.platform === "goofish" && (previousId && item.goofishClientAccountId === previousId || item.goofishClientAccountId === event.accountId || this.hasGoofishPartition(item, event.accountId)));
    if (!account) return;
    if (event.eventType === "account-migrated" && nextId) {
      account.goofishClientAccountId = nextId;
      try {
        account.partition = this.goofishClient.getEmbeddedWebviewConfig(nextId).partition;
      } catch {
      }
      const migrated = asRecord(payload.account);
      account.authenticated = migrated.status === "authenticated";
      if (migrated.nickname) account.label = String(migrated.nickname);
      void this.save();
      return;
    }
    let changed = false;
    if (event.eventType === "official-login-page") {
      account.authenticated = false;
      changed = true;
    }
    if (event.eventType === "bridge-ready" || event.eventType === "account-updated") {
      const metadata = event.eventType === "account-updated" ? payload : asRecord(payload);
      account.authenticated = metadata.status === "authenticated" || event.eventType === "bridge-ready";
      if (metadata.nickname && !account.label) account.label = String(metadata.nickname);
      changed = true;
      if (account.online && account.authenticated && this.shopRuntimes.snapshot(account.id)?.runtimeState !== "running") {
        void this.setAccountOnline(account.id, true).catch((error) => {
          console.error(`[platform-hub] 闲鱼登录后启动监听失败: ${account.id}`, error);
        });
      }
    }
    if (event.eventType === "connection-error" || event.eventType === "connection-closed" || event.eventType === "load-error") {
      account.connected = false;
      changed = true;
    }
    if (changed) void this.save();
  }
  hasGoofishPartition(account, clientAccountId) {
    try {
      return this.goofishClient.getEmbeddedWebviewConfig(clientAccountId).partition === account.partition;
    } catch {
      return false;
    }
  }
  emitGoofishRuntimeError(accountId, error) {
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (!account) return;
    const message = error instanceof Error ? error.message : String(error);
    this.publish({ id: `${accountId}:goofish:${Date.now()}:error`, accountId, platform: account.platform, type: "error", timestamp: Date.now(), payload: { message } });
  }
  publish(event) {
    this.listeners.forEach((listener) => listener(event));
  }
  async invoke(accountId, method, ...args) {
    const cdp = this.sessions.get(accountId);
    if (!cdp) throw new Error("请先打开平台页面");
    return cdp.invoke(method, ...args);
  }
  async withLogin(accountId, method, ...args) {
    const cdp = this.sessions.get(accountId);
    if (!cdp) throw new Error("请先打开平台页面");
    let result = await cdp.invoke(method, ...args);
    let errorCode = this.runtimeErrorCode(result);
    if (errorCode === "CHALLENGE_REQUIRED") {
      await cdp.showRuntimePageFor(method);
      const detail = result && typeof result === "object" ? result.error : void 0;
      const challengeError = new Error(
        `抖店要求完成安全验证，已打开该店铺的官方页面。完成验证后请返回工作台重新同步。${detail ? `（${detail}）` : ""}`
      );
      challengeError.code = errorCode;
      throw challengeError;
    }
    if (errorCode === "LOGIN_REQUIRED" || errorCode === "RUNTIME_NOT_READY" && !cdp.getStatus().authenticated) {
      await cdp.showRuntimePageFor(method);
      await cdp.waitForLogin(void 0, method);
      result = await cdp.invoke(method, ...args);
      errorCode = this.runtimeErrorCode(result);
    }
    if (errorCode === "RUNTIME_NOT_READY") {
      await cdp.showRuntimePageFor(method);
      result = await cdp.invoke(method, ...args);
      errorCode = this.runtimeErrorCode(result);
    }
    if (errorCode === "LOGIN_REQUIRED" || errorCode === "RUNTIME_NOT_READY") {
      const detail = result && typeof result === "object" ? result.error : void 0;
      throw new Error(detail || (errorCode === "LOGIN_REQUIRED" ? "请在平台页面完成登录后重试" : "平台运行时尚未就绪，请等待页面加载后重试"));
    }
    return result;
  }
  runtimeErrorCode(value) {
    return value && typeof value === "object" ? value.errorCode : void 0;
  }
  emit(event) {
    if (event.type === "connection" && event.payload && typeof event.payload === "object") {
      const account = this.state.accounts.find((item) => item.id === event.accountId);
      const status = event.payload;
      if (account) {
        account.connected = status.connected === true;
        account.authenticated = status.authenticated === true;
        account.lastSeenAt = new Date(event.timestamp).toISOString();
        void this.save();
        if (account.online && account.authenticated && this.shopRuntimes.snapshot(account.id)?.runtimeState !== "running") {
          void this.setAccountOnline(account.id, true).catch((error) => {
            console.error(`[platform-hub] 登录后启动店铺监听失败: ${account.id}`, error);
          });
        }
      }
    }
    const runtime = this.shopRuntimes.has(event.accountId) ? this.shopRuntimes : void 0;
    const attributedEvent = runtime ? runtime.annotateEvent(event.accountId, event) : event;
    if (runtime && attributedEvent.type === "message") {
      const payload = attributedEvent.payload && typeof attributedEvent.payload === "object" ? attributedEvent.payload : {};
      if (this.forwardedRuntimeEventIds.size >= 2e3) this.forwardedRuntimeEventIds.clear();
      this.forwardedRuntimeEventIds.add(attributedEvent.id);
      runtime.pushEvent(event.accountId, {
        id: attributedEvent.id,
        type: "message.created",
        timestamp: attributedEvent.timestamp,
        payload: { message: payload.message || payload }
      });
    }
    this.publish(attributedEvent);
  }
  emitRuntimeEvent(event) {
    if (event.type === "hook" && event.payload.event && typeof event.payload.event === "object") {
      const sourceId = event.payload.event.id;
      if (typeof sourceId === "string" && this.forwardedRuntimeEventIds.delete(sourceId)) return;
    }
    const account = this.state.accounts.find((item) => item.id === event.accountId);
    if (!account) return;
    const hookEvent = event.type === "hook" && event.payload.event && typeof event.payload.event === "object" ? event.payload.event : void 0;
    const rawPayload = hookEvent && typeof hookEvent === "object" ? hookEvent.payload : event.payload;
    const sourceType = hookEvent && typeof hookEvent === "object" ? String(hookEvent.type || "") : event.type;
    const hookPayload = asRecord(rawPayload);
    let payload = sourceType === "message.created" && hookEvent ? { message: toPlatformMessage(hookPayload.message) } : rawPayload;
    if (sourceType === "auth.changed" && hookEvent && account.platform === "goofish") {
      const auth = asRecord(hookPayload.auth);
      account.connected = account.platform === "goofish" ? Boolean(this.liveGoofishWebContentsId(this.goofishViews.get(account.id))) : account.connected;
      account.authenticated = auth.authenticated === true;
      const view = this.goofishViews.get(account.id);
      payload = {
        accountId: account.id,
        platform: account.platform,
        connected: account.connected,
        authenticated: account.authenticated,
        url: view?.webContents.getURL() || account.url,
        title: view?.webContents.getTitle(),
        message: account.authenticated ? "闲鱼已登录，Runtime 已就绪" : "请在当前闲鱼官方页面完成登录"
      };
      void this.save();
    }
    const platformEventType = sourceType === "message.created" ? "message" : sourceType.startsWith("order.") ? "order" : sourceType === "auth.changed" || sourceType === "connection" ? "connection" : sourceType === "runtime.error" ? "error" : "log";
    this.publish({
      id: `${event.accountId}:runtime:${event.timestamp}:${Math.random().toString(16).slice(2)}`,
      accountId: event.accountId,
      platform: account.platform,
      type: platformEventType,
      timestamp: event.timestamp,
      payload
    });
  }
  async readState(path) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(value.accounts) || !Array.isArray(value.hooks)) return null;
      return { accounts: value.accounts, hooks: value.hooks };
    } catch {
      return null;
    }
  }
  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const operation = this.saveQueue.catch(() => void 0).then(async () => {
      const directory = app.getPath("userData");
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true });
      const current = await readFile(this.statePath, "utf8").catch(() => "");
      if (current) {
        try {
          const parsed = JSON.parse(current);
          if (Array.isArray(parsed.accounts) && Array.isArray(parsed.hooks)) {
            await writeFile(this.stateBackupPath, current, "utf8");
          }
        } catch {
        }
      }
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.statePath);
    });
    this.saveQueue = operation;
    return operation;
  }
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function scalar(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
function temporaryGoofishAccountId() {
  return `${Date.now()}${randomInt(1e5, 1e6)}`;
}
function isOfficialGoofishLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["goofish.com", "taobao.com", "alipay.com"].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
function toPlatformProduct(product) {
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
    platform: "goofish",
    raw: product.raw && typeof product.raw === "object" ? product.raw : void 0
  };
}
function toPlatformSession(session2) {
  return {
    id: session2.id,
    title: session2.title,
    unread: session2.unreadCount,
    lastMessage: session2.lastMessage,
    updatedAt: session2.updatedAt,
    avatar: session2.avatarUrl
  };
}
function toPlatformMessage(message) {
  return {
    id: message.id,
    sessionId: message.conversationId,
    senderId: message.senderId || "",
    senderName: message.senderName || "",
    content: message.content,
    type: message.type,
    isMine: message.direction === "outbound",
    direction: message.direction,
    origin: message.origin,
    timestamp: message.timestamp,
    raw: message.raw && typeof message.raw === "object" ? message.raw : void 0
  };
}
class CdpShopTransport {
  constructor(cdp) {
    this.cdp = cdp;
  }
  cdp;
  async start() {
    await this.cdp.open(false);
  }
  async invoke(operation, input) {
    const args = input && typeof input === "object" ? input : {};
    const method = operation === "auth.state" ? "getAuthState" : operation === "messages.listen" ? "listenMessages" : operation === "messages.send.text" ? "sendMessage" : operation === "messages.send.file" ? "sendFile" : operation === "handoff.targets.list" ? "listHandoffTargets" : operation === "handoff.transfer" ? "transferSession" : operation === "conversation.attention.set" ? "setConversationAttention" : operation;
    const parameters = operation === "messages.send.text" ? [args.conversationId, args.text] : operation === "messages.send.file" ? [args.conversationId, args.data || args.dataUrl || args.url, args.name || args.fileName, args.mimeType] : operation === "handoff.transfer" ? [args.conversationId, args.targetId || args.targetName] : operation === "conversation.attention.set" ? [args.conversationId, args.state] : [];
    try {
      const value = await this.cdp.invoke(method, ...parameters);
      if (value && typeof value === "object" && "errorCode" in value) {
        const error = value;
        return { ok: false, error: { code: error.errorCode || "PLATFORM_ERROR", message: error.error || "平台操作失败" } };
      }
      return { ok: true, data: value };
    } catch (error) {
      return { ok: false, error: { code: "PLATFORM_ERROR", message: error instanceof Error ? error.message : String(error) } };
    }
  }
  subscribe(_listener) {
    return () => void 0;
  }
  async stop() {
  }
}
if (process.env.PLATFORM_HUB_USER_DATA) {
  app.setPath("userData", process.env.PLATFORM_HUB_USER_DATA);
}
if (process.env.PLATFORM_HUB_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
}
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PLATFORM_HUB_CDP_PORT || "9333");
}
let mainWindow = null;
const manager = new PlatformManager();
function assertRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("未经授权的 IPC 调用");
}
function createWindow(load = true) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f4f7fb",
    webPreferences: { preload: join(__dirname, "../preload/index.mjs"), contextIsolation: true, sandbox: false }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (load) loadRenderer(mainWindow);
  return mainWindow;
}
function loadRenderer(window) {
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}
function registerIpc() {
  ipcMain.handle("platforms:list", (event) => {
    assertRenderer(event);
    return manager.listPlatforms();
  });
  ipcMain.handle("platforms:import", async (event) => {
    assertRenderer(event);
    return manager.importPackage();
  });
  ipcMain.handle("accounts:list", (event) => {
    assertRenderer(event);
    return manager.listAccounts();
  });
  ipcMain.handle("accounts:add", (event, input) => {
    assertRenderer(event);
    return manager.addAccount(input);
  });
  ipcMain.handle("accounts:remove", (event, id) => {
    assertRenderer(event);
    return manager.removeAccount(id);
  });
  ipcMain.handle("accounts:open", (event, id) => {
    assertRenderer(event);
    return manager.open(id);
  });
  ipcMain.handle("accounts:setOnline", (event, id, online) => {
    assertRenderer(event);
    return manager.setAccountOnline(id, online);
  });
  ipcMain.handle("runtime:states", (event) => {
    assertRenderer(event);
    return manager.runtimeStates();
  });
  ipcMain.handle("conversation:attention:set", (event, id, conversationId, state) => {
    assertRenderer(event);
    return manager.setConversationAttention(id, conversationId, state);
  });
  ipcMain.handle("viewport:bounds", (event, bounds) => {
    assertRenderer(event);
    return manager.setPrimaryViewportBounds(bounds);
  });
  ipcMain.handle("platform:connect", (event, id, webContentsId) => {
    assertRenderer(event);
    return manager.connect(id, webContentsId);
  });
  ipcMain.handle("platform:disconnect", (event, id) => {
    assertRenderer(event);
    return manager.disconnect(id);
  });
  ipcMain.handle("platform:status", (event, id) => {
    assertRenderer(event);
    return manager.status(id);
  });
  ipcMain.handle("products:collect", (event, id) => {
    assertRenderer(event);
    return manager.collectProducts(id);
  });
  ipcMain.handle("products:detail", (event, id, goodsId) => {
    assertRenderer(event);
    return manager.productDetail(id, goodsId);
  });
  ipcMain.handle("sessions:list", (event, id) => {
    assertRenderer(event);
    return manager.sessionsFor(id);
  });
  ipcMain.handle("messages:list", (event, id, sessionId) => {
    assertRenderer(event);
    return manager.messagesFor(id, sessionId);
  });
  ipcMain.handle("orders:list", (event, id, userId) => {
    assertRenderer(event);
    return manager.ordersFor(id, userId);
  });
  ipcMain.handle("orders:sync", (event, id, sessionId, userId) => {
    assertRenderer(event);
    return manager.syncOrdersFor(id, sessionId, userId);
  });
  ipcMain.handle("orders:listen", (event, id, sessionId, orderId) => {
    assertRenderer(event);
    return manager.listenOrdersFor(id, sessionId, orderId);
  });
  ipcMain.handle("messages:listen", (event, id) => {
    assertRenderer(event);
    return manager.listenMessagesFor(id);
  });
  ipcMain.handle("handoff:targets", (event, id) => {
    assertRenderer(event);
    return manager.handoffTargetsFor(id);
  });
  ipcMain.handle("message:send", (event, id, sessionId, content) => {
    assertRenderer(event);
    return manager.sendMessage(id, sessionId, content);
  });
  ipcMain.handle("message:file", (event, id, sessionId, dataUrl, fileName) => {
    assertRenderer(event);
    return manager.sendFile(id, sessionId, dataUrl, fileName);
  });
  ipcMain.handle("session:transfer", (event, id, sessionId, target) => {
    assertRenderer(event);
    return manager.transferSession(id, sessionId, target);
  });
}
app.whenReady().then(async () => {
  await manager.init();
  createWindow(false);
  if (mainWindow) await manager.attachMainWindow(mainWindow);
  if (!manager.listAccounts().length) {
    await manager.addAccount({ platform: "douyin-shop", label: "抖店主账号" });
  }
  registerIpc();
  manager.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("platform:event", event);
  });
  if (mainWindow) loadRenderer(mainWindow);
  const douyin = manager.listAccounts().find((account) => account.platform === "douyin-shop");
  if (douyin) void manager.open(douyin.id).catch((error) => console.error("[platform-hub] 打开抖店页面失败", error));
  app.on("activate", () => {
    if (!mainWindow) {
      const window = createWindow(false);
      void manager.attachMainWindow(window).then(() => loadRenderer(window));
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let shuttingDown = false;
let shutdownComplete = false;
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void manager.dispose().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
