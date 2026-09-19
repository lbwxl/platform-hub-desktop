import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { kuaishouHook } from "@platform-hub/kuaishou-hook";
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
  }
  options;
  window = null;
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
  async open(show = true) {
    if (this.destroyed) throw new Error("CDP 会话已销毁");
    if (this.window && !this.window.isDestroyed()) {
      if (show) this.window.show();
      if (this.opening) await this.opening;
      return;
    }
    this.window = new BrowserWindow({
      width: 1260,
      height: 820,
      show,
      title: `${this.options.platform} · ${this.options.accountId}`,
      webPreferences: {
        partition: this.options.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    this.contents = this.window.webContents;
    this.contents.setWindowOpenHandler(({ url }) => {
      if (this.isLoginUrl(url)) {
        void this.window?.loadURL(url).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
      }
      return { action: "deny" };
    });
    this.contents.on("did-finish-load", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("did-navigate", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("render-process-gone", (_event, details) => this.emitError(`页面进程退出: ${details.reason}`));
    this.window.on("closed", () => {
      this.stopRuntimePolling();
      this.closeRuntimeWindows();
      this.contents = null;
      this.window = null;
      this.connected = false;
      this.emitStatus("页面已关闭");
    });
    const opening = this.window.loadURL(this.options.url).then(() => this.installHook(this.contents, true));
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }
  async installHook(contents = this.contents, primary = true) {
    if (!contents || contents.isDestroyed()) return;
    if (!this.options.hook.script) throw new Error("Hook 包没有可执行脚本");
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
        if (!route) await this.ensurePrimaryRuntimePage(true);
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
      if (route) this.scheduleRuntimeWindowClose(route.id);
    }
  }
  showPrimaryPage() {
    if (this.window && !this.window.isDestroyed()) this.window.show();
  }
  async showRuntimePageFor(method) {
    const route = this.routeForMethod(method);
    if (!route) {
      await this.ensurePrimaryRuntimePage(true);
      return;
    }
    await this.openRuntimePage(route);
    const target = this.runtimeWindows.get(route.id);
    if (target && !target.isDestroyed()) target.show();
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
    if (authenticated) await this.ensurePrimaryRuntimePage(false);
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
    if (this.window && !this.window.isDestroyed()) this.window.close();
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
      const result = await this.evaluate(contents, this.runtimePollExpression(includeAuth));
      if (generation !== this.pollGeneration || contents !== this.contents || contents.isDestroyed()) return;
      if (result.auth) this.applyAuthState(result.auth);
      for (const item of result.events || []) this.emitRuntimeEvent(item);
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
    if (authenticated) void this.ensurePrimaryRuntimePage(true).catch((error) => this.emitError(`进入消息接待页失败: ${String(error)}`));
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
  async ensurePrimaryRuntimePage(show) {
    if (!this.window || this.window.isDestroyed() || !this.contents || this.contents.isDestroyed()) {
      throw new Error("页面尚未连接，请先打开平台页面");
    }
    if (show) this.window.show();
    if (this.sameRuntimePage(this.contents.getURL(), this.options.hook.url)) return;
    if (this.primaryNavigation) return this.primaryNavigation;
    const navigation = (async () => {
      this.emitStatus("登录成功，正在进入消息接待页");
      await this.window.loadURL(this.options.hook.url);
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
  reinstallHook(contents, primary) {
    void this.installHook(contents, primary).catch((error) => this.emitError(`Hook 注入失败: ${String(error)}`));
  }
  reinstallPrimaryHook(contents) {
    if (!contents || contents.isDestroyed()) return;
    const loginUrl = this.loginUrlFor(contents.getURL());
    if (loginUrl && this.window && !this.window.isDestroyed()) {
      this.emitStatus("正在打开平台官方登录页");
      void this.window.loadURL(loginUrl).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
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
          webSecurity: true
        }
      });
      this.runtimeWindows.set(route.id, target);
      const contents = target.webContents;
      contents.on("did-finish-load", () => this.reinstallHook(contents, false));
      contents.on("render-process-gone", (_event, details) => this.emitError(`${route.id} 页面进程退出: ${details.reason}`));
      target.on("closed", () => {
        this.clearRuntimeWindowTimer(route.id);
        this.runtimeWindows.delete(route.id);
      });
      await this.loadRuntimeUrl(target, route.url);
    } else if (route.refreshBeforeInvoke) {
      await this.loadRuntimeUrl(target, route.url);
    }
    await this.installHook(target.webContents, false);
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
      id: `${this.options.accountId}:status:${Date.now()}`,
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
const doudianCapabilities = [
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
const hookVersion = "3.5.0";
const doudianHookScript = String.raw`(() => {
  const QUEUE_KEY = '__platformHub'
  const existing = window[QUEUE_KEY]
  const HOOK_VERSION = ${JSON.stringify(hookVersion)}
  if (existing && existing.__version === HOOK_VERSION) return
  try { existing?.dispose?.() } catch (_) {}

  const queue = []
  let runtime = null
  let subscription = null
  const methodCache = new Map()
  const watchedOrderUsers = new Map()
  const orderSnapshots = new Map()
  let orderPollTimer = null
  let orderPollBusy = false
  let disposed = false
  const emittedOrderKeys = new Set()
  const ORDER_WATCH_MAX = 50
  const ORDER_WATCH_TTL_MS = 30 * 60 * 1000
  const ORDER_ACTIVE_WINDOW_MS = 2 * 60 * 1000
  const ORDER_ACTIVE_INTERVAL_MS = 5 * 1000
  const ORDER_IDLE_INTERVAL_MS = 30 * 1000
  const ORDER_POLL_TICK_MS = 1000
  const ORDER_POLL_BATCH_SIZE = 1
  const platformRuntimeOrderEvent = { source: 'platform-runtime' }

  const aliases = {
    getAuthState: ['getAuthState', 'getLoginState', 'getShopInfo', 'currentUser', 'getCurrentUser'],
    collectProducts: ['collectProducts', 'listProducts', 'getProducts', 'getProductList', 'listOnSaleProducts'],
    getProductDetail: ['getProductDetail', 'productDetail', 'getGoodsDetail', 'queryProduct'],
    listSessions: ['listSessions', 'getSessions', 'getConversationList', 'listConversations'],
    listMessages: ['listMessages', 'getMessages', 'getMessageList'],
    sendMessage: ['sendMessage', 'sendText', 'sendTextMessage'],
    sendFile: ['sendFile', 'sendImage', 'sendMedia'],
    transferSession: ['transferSession', 'transferConversation', 'assignConversation'],
    getOrders: ['getOrders', 'queryOrders', 'getOrderList'],
    subscribeMessages: ['subscribeMessages', 'onMessage', 'subscribeMessage', 'watchMessages'],
  }

  const candidates = [
    () => window.__DOUDIAN_SDK__,
    () => window.__doudian__,
    () => window.doudianSDK,
    () => window.doudian,
    () => window.pigeon,
  ]

  function getStore() {
    return window.ss?._frontStore || window.ss?.instance || null
  }

  function getNativeIm() {
    return window.__mona_pigeon_event?.globalStore?.data?.initContextData?.im || null
  }

  function collectionValues(value) {
    if (!value) return []
    if (Array.isArray(value)) return [...value]
    try { if (typeof value.values === 'function') return [...value.values()] } catch (_) {}
    try { return Object.values(value) } catch (_) { return [] }
  }

  function snapshot(value) {
    if (!value) return value
    try { return typeof value.toJSON === 'function' ? value.toJSON() : JSON.parse(JSON.stringify(value)) } catch (_) { return value }
  }

  function parseJson(value) {
    if (!value || typeof value === 'object') return value || null
    try { return JSON.parse(value) } catch (_) { return null }
  }

  function jsonIntegerString(value, key) {
    if (typeof value === 'string') {
      const match = value.match(new RegExp('"' + key + '"\\s*:\\s*"?([0-9]+)"?'))
      if (match) return match[1]
    }
    const parsed = parseJson(value)
    return parsed?.[key] == null ? '' : String(parsed[key])
  }

  function storeConversations() {
    const info = getStore()?.conversationsInfo
    if (!info) return []
    const result = []
    const seen = new Set()
    for (const source of [info.unClosedConversations, info.closedConversations, info.normalCurrentConversations, info.platformMessageConversations]) {
      for (const raw of collectionValues(source)) {
        const value = snapshot(raw)
        const id = String(value?.id || value?.conversationId || '')
        if (!id || seen.has(id)) continue
        seen.add(id); result.push({ raw, value })
      }
    }
    return result
  }

  function talkerFor(conversation) {
    const store = getStore()
    const buyerId = String(conversation?.buyerId || conversation?.currentTalkId || '')
    try { return snapshot(store?.talkerMap?.getTalkerInfo?.(buyerId)) || {} } catch (_) { return {} }
  }

  function nativeSessions() {
    return storeConversations().map(({ raw, value }) => {
      const talker = talkerFor(raw)
      const last = snapshot(raw?.lastMessage || raw?.lastAnyMessage || value?.lastMessage || value?.lastAnyMessage || value?.lastCache) || {}
      return {
        id: String(value.id),
        title: String(talker?.name || talker?.screenName || talker?.nickName || talker?.nickname || value?.rawExt?.fusion_uname || value?.buyerName || value?.buyerId || '未命名会话'),
        unread: Number(value?.unreadCount || 0),
        lastMessage: String(last?.content || last?.text || last?.message || ''),
        avatar: talker?.avatar || talker?.avatarUrl,
        updatedAt: Number(last?.createTime || last?.timestamp || value?.versionTime || 0) || undefined,
      }
    })
  }

  function nativeMessages(sessionId) {
    const info = getStore()?.conversationsInfo
    if (!info) return []
    const output = []
    for (const session of nativeSessions()) {
      if (sessionId && session.id !== String(sessionId)) continue
      let source
      try { source = typeof info.messagesByConversationId?.get === 'function' ? info.messagesByConversationId.get(session.id) : info.messagesByConversationId?.[session.id] } catch (_) {}
      const rows = source?.sortedMessages || source?.visibleMessages || source?.value || source?.map || source
      const candidates = collectionValues(rows)
      const conversation = storeConversations().find(({ value }) => String(value.id) === session.id)?.raw
      if (conversation?.lastMessage) candidates.push(conversation.lastMessage)
      const rowIds = new Set()
      for (const raw of candidates) {
        const value = snapshot(raw) || {}
        const id = String(value.serverId || value.messageId || value.clientId || value.id || '')
        if (!id || rowIds.has(id)) continue
        rowIds.add(id)
        const ext = snapshot(value.ext) || {}
        const senderRole = String(ext.sender_role || ext['s:sender_biz_role'] || '')
        const isSystem = senderRole === '3' || senderRole === '4'
        const order = orderFromMessage(value, ext)
        const product = order ? null : productFromMessage(value, ext)
        output.push({
          id,
          sessionId: session.id,
          senderId: String(value.sender || value.senderId || value.originSender || value.securitySender || value.from || ''),
          senderName: String(isSystem ? '系统' : ext.uname || value.senderName || session.title),
          content: String(value.content || value.text || value.message || ''),
          type: String(order ? 'order' : isSystem ? 'system' : product ? 'product' : ext.type || value.type || 'text'),
          isMine: !isSystem && Boolean(value.isMine || value.sender === getStore()?.selfInfo?.id || senderRole === '2'),
          timestamp: Number(value.createTime || value.createdAt || value.timestamp || Date.now()),
          avatar: ext.avatar_uri || value.avatar,
          order: order || undefined,
          product: product || undefined,
        })
      }
    }
    return output
  }

  function methodsOf(value) {
    const names = new Set()
    let current = value
    for (let depth = 0; current && depth < 3; depth += 1) {
      try { Object.getOwnPropertyNames(current).forEach((name) => { if (name !== 'constructor' && typeof value[name] === 'function') names.add(name) }) } catch (_) {}
      try { current = Object.getPrototypeOf(current) } catch (_) { current = null }
    }
    return [...names]
  }

  function locateRuntime() {
    const direct = candidates.map((get) => { try { return get() } catch (_) { return null } }).filter(Boolean)
    const roots = []
    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!/(dou|pigeon|chat|im|shop|goods|product|seller|sdk|store|runtime|app)/i.test(key)) continue
        try { const value = window[key]; if (value && (typeof value === 'object' || typeof value === 'function')) roots.push({ value, path: 'window.' + key, depth: 0 }) } catch (_) {}
      }
    } catch (_) {}
    const queue = [...direct.map((value) => ({ value, path: 'window.direct', depth: 0 })), ...roots]
    const seen = new Set()
    const found = []
    let visited = 0
    while (queue.length && visited < 1200) {
      const item = queue.shift(); const value = item.value
      if (!value || seen.has(value)) continue
      seen.add(value); visited += 1
      const methods = methodsOf(value)
      const score = Object.values(aliases).flat().filter((name) => methods.includes(name)).length
      if (score) found.push({ value, path: item.path, methods, score })
      if (item.depth >= 3) continue
      let keys = []
      try { keys = Object.keys(value).slice(0, 160) } catch (_) {}
      for (const key of keys) {
        if (!/(api|client|service|manager|sdk|store|chat|message|conversation|goods|product|order|runtime|default)/i.test(key)) continue
        try {
          const child = value[key]
          if (child && (typeof child === 'object' || typeof child === 'function')) queue.push({ value: child, path: item.path + '.' + key, depth: item.depth + 1 })
        } catch (_) {}
      }
    }
    found.sort((a, b) => b.score - a.score)
    return found
  }

  function resolveRuntime() {
    if (runtime) return runtime
    runtime = locateRuntime()[0]?.value || null
    return runtime
  }

  function findMethod(name) {
    if (methodCache.has(name)) return methodCache.get(name)
    const names = aliases[name] || [name]
    const targets = locateRuntime()
    for (const target of targets) {
      for (const alias of names) {
        try {
          if (typeof target.value[alias] === 'function') {
            const method = { fn: target.value[alias], owner: target.value, alias, path: target.path }
            methodCache.set(name, method)
            return method
          }
        } catch (_) {}
      }
    }
    return null
  }

  function call(name, ...args) {
    resolveRuntime()
    const method = findMethod(name)
    if (!method) {
      return Promise.resolve({ ok: false, errorCode: 'RUNTIME_NOT_READY', error: '抖店页面尚未暴露运行时方法' })
    }
    try {
      return Promise.resolve(method.fn.apply(method.owner, args)).then((value) => value)
    } catch (error) {
      return Promise.resolve({ ok: false, errorCode: 'RUNTIME_ERROR', error: String(error?.message || error) })
    }
  }

  function normalizeAuth(value) {
    if (!value) return { authenticated: false }
    if (value.errorCode === 'LOGIN_REQUIRED') return { authenticated: false }
    const authenticated = value.authenticated === true || value.isLogin === true || value.loggedIn === true || Boolean(value.shopId || value.userId)
    return { ...value, authenticated }
  }

  async function auth() {
    if (/^\/login(?:\/|$)/i.test(String(window.location?.pathname || ''))) {
      return { authenticated: false, errorCode: 'LOGIN_REQUIRED' }
    }
    const store = getStore()
    if (store?.shopInfo?.id || window.__mona_store__?.shopId) {
      return { authenticated: true, shopId: String(store?.shopInfo?.id || window.__mona_store__.shopId), userId: String(store?.selfInfo?.id || '') }
    }
    try {
      const getters = window.__STORE__GETTERS__
      const loggedIn = typeof getters?.isLogin === 'function' ? getters.isLogin() : getters?.isLogin
      const user = typeof getters?.user === 'function' ? getters.user() : getters?.user
      if (loggedIn || user?.id || user?.shop_id || user?.shopId) {
        return { authenticated: true, shopId: String(user?.shop_id || user?.shopId || ''), userId: String(user?.id || user?.user_id || '') }
      }
    } catch (_) {}
    const result = await call('getAuthState')
    if (result?.errorCode === 'RUNTIME_NOT_READY') return { authenticated: false, errorCode: result.errorCode }
    return normalizeAuth(result)
  }

  async function requireLogin(method, ...args) {
    const state = await auth()
    if (!state.authenticated) return { ok: false, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续', state }
    const value = await call(method, ...args)
    if (value?.errorCode === 'LOGIN_REQUIRED' || value?.code === 'LOGIN_REQUIRED') return { ok: false, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续' }
    return value
  }

  function push(type, payload) {
    queue.push({ type, payload, timestamp: Date.now() })
    if (queue.length > 200) queue.splice(0, queue.length - 200)
  }

  function pickArray(value) {
    if (Array.isArray(value)) return value
    const options = [value?.data, value?.list, value?.items, value?.records, value?.data?.list, value?.data?.items, value?.data?.records]
    return options.find(Array.isArray) || []
  }

  function normalizeProduct(item) {
    const goodsId = String(item?.goodsId || item?.goods_id || item?.productId || item?.product_id || item?.id || '')
    const shopId = String(item?.shopId || item?.shop_id || item?.sellerId || '')
    const rawPrice = item?.discount_price ?? item?.discountPrice ?? item?.price ?? 0
    const price = item?.discount_price != null ? Number(rawPrice) / 100 : Number(rawPrice)
    const images = item?.images || item?.pics || item?.image_list || (item?.img ? [item.img] : [])
    return {
      id: 'douyin-shop;' + shopId + ';' + goodsId,
      goodsId,
      name: String(item?.name || item?.title || item?.product_name || ''),
      price: Number.isFinite(price) ? price : 0,
      originalPrice: (item?.original_price != null ? Number(item.original_price) / 100 : Number(item?.originalPrice || 0)) || undefined,
      stockQuantity: Number(item?.stockQuantity ?? item?.stock_num ?? item?.stock) || undefined,
      status: String(item?.status ?? item?.product_status ?? ''),
      images: Array.isArray(images) ? images.map((image) => typeof image === 'string' ? image : image?.url).filter(Boolean) : [],
      goodsUrl: item?.goodsUrl || item?.product_url,
      editUrl: item?.editUrl || (goodsId ? 'https://fxg.jinritemai.com/ffa/g/create?product_id=' + goodsId : ''),
      shopId,
      platform: 'douyin-shop',
      createTime: item?.createTime || item?.create_time,
      description: item?.description || item?.desc,
      skuList: pickArray(item?.skus || item?.skuList).map((sku) => ({
        skuId: String(sku?.skuId || sku?.sku_id || sku?.id || ''),
        skuName: String(sku?.skuName || sku?.spec_desc || sku?.name || ''),
        skuPrice: Number(sku?.skuPrice ?? sku?.price ?? 0) / (sku?.skuPrice == null && sku?.price != null ? 100 : 1),
      })),
      raw: item,
    }
  }

  function productFromMessage(value, ext) {
    const staticData = parseJson(ext?.static_data) || {}
    const goods = pickArray(staticData?.sale_goods)[0] || staticData
    const sourceType = String(ext?.type || value?.messageType || '')
    const cardSource = String(parseJson(ext?.card_header)?.cardSourceScene || '')
    if (!/(goods|product)/i.test(cardSource) && !/(goods_card|product_card)/i.test(sourceType)) return null
    const pointInfo = parseJson(ext?.point_info) || {}
    const search = parseJson(ext?.generic_search_keywords) || {}
    const goodsId = String(ext?.goods_id || jsonIntegerString(ext?.static_data, 'product_id') || jsonIntegerString(ext?.point_info, 'product_id') || goods?.product_id || pointInfo?.product_id || '')
    if (!goodsId) return null
    const shopId = String(ext?.shop_id || goods?.shop_id || getStore()?.shopInfo?.id || '')
    const rawPrice = goods?.current_price?.price ?? goods?.goods_price ?? goods?.price ?? 0
    const originalPrice = Number(goods?.origin_price || 0) || undefined
    const skuId = String(goods?.sku_id || '')
    const skuName = String(goods?.sku || goods?.goods_spec_desc || '')
    return {
      id: 'douyin-shop;' + shopId + ';' + goodsId,
      goodsId,
      name: String(goods?.product_name || goods?.product_name_two_lines || goods?.product_name_one_line || goods?.goods_name || search?.content || value?.content || '商品'),
      price: Number(rawPrice) || 0,
      originalPrice,
      status: String(goods?.product_status || goods?.status || ''),
      images: goods?.img || goods?.goods_img ? [String(goods.img || goods.goods_img)] : [],
      goodsUrl: goods?.jump_url || goods?.detail_url || goods?.product_detail_url || undefined,
      shopId,
      platform: 'douyin-shop',
      description: goods?.product_desc || undefined,
      skuList: skuId || skuName ? [{ skuId, skuName, skuPrice: Number(rawPrice) || 0 }] : [],
      raw: { sourceType, cardSource },
    }
  }

  function orderFromMessage(value, ext) {
    const cardSource = String(parseJson(ext?.card_header)?.cardSourceScene || '')
    if (!/order/i.test(cardSource)) return null
    const staticData = parseJson(ext?.static_data) || {}
    const pointInfo = parseJson(ext?.point_info) || {}
    const orderId = String(ext?.order_id || ext?.shop_order_id || jsonIntegerString(ext?.point_info, 'shop_order_id') || pointInfo?.shop_order_id || '')
    if (!orderId) return null
    const summary = String(staticData?.sell_num_desc || staticData?.b_good?.sell_num_desc || '')
    const amountMatch = summary.match(/[¥￥]\s*([\d,.]+)/)
    const quantityMatch = summary.match(/共\s*(\d+)\s*件/)
    const totalAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : undefined
    const productId = String(ext?.goods_id || jsonIntegerString(ext?.point_info, 'product_id') || pointInfo?.product_id || '') || undefined
    const shopId = String(ext?.shop_id || getStore()?.shopInfo?.id || '')
    return {
      id: 'douyin-shop;' + shopId + ';' + orderId,
      orderId,
      skuOrderId: String(ext?.sku_order_id || jsonIntegerString(ext?.point_info, 'sku_order_id') || pointInfo?.sku_order_id || '') || undefined,
      skuId: String(ext?.sku_id || jsonIntegerString(ext?.point_info, 'sku_id') || pointInfo?.sku_id || staticData?.sku_id || '') || undefined,
      status: String(staticData?.order_status || staticData?.tag_content || ''),
      totalAmount: Number.isFinite(totalAmount) ? totalAmount : undefined,
      quantity: quantityMatch ? Number(quantityMatch[1]) : undefined,
      productId,
      skuName: String(staticData?.sku_name || staticData?.skuName || staticData?.spec_desc || staticData?.goods_spec_desc || staticData?.sku || '') || undefined,
      productName: String(staticData?.product_name || staticData?.b_good?.product_name || ''),
      productImage: staticData?.img || staticData?.b_good?.img || undefined,
      orderUrl: staticData?.jump_url || undefined,
      buyerName: String(staticData?.buyer_name || staticData?.buyerName || '') || undefined,
      receiverName: String(staticData?.receiver_name || staticData?.receiverName || '') || undefined,
      shippingAddress: String(staticData?.receiver_address || staticData?.receiverAddress || staticData?.shipping_address || '') || undefined,
      shopId,
      platform: 'douyin-shop',
      raw: { sourceType: String(ext?.type || value?.type || 'template_card'), cardSource },
    }
  }

  function normalizeOrder(item) {
    if (!item || typeof item !== 'object') return null
    const orderId = String(item?.orderId || item?.order_id || item?.shopOrderId || item?.shop_order_id || item?.skuOrderId || item?.sku_order_id || item?.id || '')
    if (!orderId) return null
    const shopId = String(item?.shopId || item?.shop_id || getStore()?.shopInfo?.id || '')
    const amountInYuan = item?.totalAmount ?? item?.total_amount ?? item?.orderAmount ?? item?.order_amount_yuan
    const amountInCents = item?.pay_amount ?? item?.order_amount ?? item?.total_fee
    const totalAmount = amountInYuan != null ? Number(amountInYuan) : amountInCents != null ? Number(amountInCents) / 100 : undefined
    const quantity = Number(item?.quantity ?? item?.count ?? item?.product_count ?? item?.item_num)
    return {
      id: 'douyin-shop;' + shopId + ';' + orderId,
      orderId,
      skuOrderId: String(item?.skuOrderId || item?.sku_order_id || '') || undefined,
      skuId: String(item?.skuId || item?.sku_id || '') || undefined,
      status: String(item?.status || item?.orderStatus || item?.order_status || item?.status_desc || item?.order_status_desc || ''),
      totalAmount: Number.isFinite(totalAmount) ? totalAmount : undefined,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
      productId: String(item?.productId || item?.product_id || item?.goodsId || item?.goods_id || '') || undefined,
      skuName: String(item?.skuName || item?.sku_name || item?.spec_desc || item?.goods_spec_desc || item?.sku || '') || undefined,
      productName: String(item?.productName || item?.product_name || item?.goodsName || item?.goods_name || ''),
      productImage: item?.productImage || item?.product_image || item?.goods_image || undefined,
      orderUrl: item?.orderUrl || item?.order_url || undefined,
      buyerName: String(item?.buyerName || item?.buyer_name || '') || undefined,
      receiverName: String(item?.receiverName || item?.receiver_name || '') || undefined,
      shippingAddress: String(item?.shippingAddress || item?.shipping_address || item?.receiverAddress || item?.receiver_address || '') || undefined,
      shopId,
      sessionId: item?.sessionId ? String(item.sessionId) : undefined,
      userId: item?.userId ? String(item.userId) : undefined,
      messageId: item?.messageId ? String(item.messageId) : undefined,
      updatedAt: Number(item?.updatedAt || item?.update_time || item?.timestamp || 0) || undefined,
      platform: 'douyin-shop',
      raw: item?.raw && typeof item.raw === 'object'
        ? { sourceType: item.raw.sourceType, cardSource: item.raw.cardSource }
        : undefined,
    }
  }

  function buyerIdForSession(sessionId) {
    const conversation = storeConversations().find(({ value }) => String(value.id) === String(sessionId))
    const value = conversation?.value || {}
    const talker = conversation ? talkerFor(conversation.raw) : {}
    return String(value?.buyerId || value?.currentTalkId || value?.userId || talker?.id || talker?.userId || String(sessionId || '').split(':')[0] || '')
  }

  function workstationOrderContext() {
    const workstation = getStore()?.uiState?.workstation
    const current = workstation?.currentOrder
    const orderId = String(current?.orderId || current?.order_id || current?.shopOrderId || current?.shop_order_id || current || '')
    return {
      orderId,
      messageId: String(workstation?.currentOrderMsgId || workstation?.current_order_msg_id || ''),
    }
  }

  function cachedProductRows() {
    let cache
    try { cache = JSON.parse(window.localStorage?.getItem('GOODS_SWR_CACHE_V1') || '{}') } catch (_) { return [] }
    const rows = []
    const seen = new Set()
    for (const [key, entry] of Object.entries(cache || {})) {
      const cacheKey = String(key)
      const isProductList = /(?:product|goods).*?(?:list|search)|(?:list|search).*?(?:product|goods)/i.test(cacheKey)
      if (!isProductList) continue
      const data = entry?.__value__?.data || entry?.value?.data || entry?.data
      for (const item of pickArray(data)) {
        const id = String(item?.product_id || item?.productId || item?.goods_id || item?.goodsId || item?.id || '')
        if (!id || seen.has(id)) continue
        seen.add(id); rows.push(item)
      }
    }
    return rows
  }

  function isProductRuntimePage() {
    const hostname = String(window.location?.hostname || '')
    const pathname = String(window.location?.pathname || '')
    return hostname === 'fxg.jinritemai.com' && /\/(?:ffa\/g\/list|product|goods)(?:\/|$)/i.test(pathname)
  }

  async function waitForCachedProductRows(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    let rows = cachedProductRows()
    while (!rows.length && isProductRuntimePage() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      rows = cachedProductRows()
    }
    return rows
  }

  function normalizeSession(item) {
    return {
      id: String(item?.sessionId || item?.conversationId || item?.id || item?.userId || item?.uid || ''),
      title: String(item?.title || item?.userName || item?.username || item?.name || '未命名会话'),
      unread: Number(item?.unread || item?.unreadCount || item?.unread_count || 0),
      lastMessage: String(item?.lastMessage?.content || item?.lastMessage || item?.last_message || ''),
      avatar: item?.avatar || item?.userAvatar,
      updatedAt: Number(item?.updatedAt || item?.updateTime || item?.timestamp || 0) || undefined,
    }
  }

  async function collectProducts() {
    const cached = await waitForCachedProductRows()
    if (cached.length) return cached.map(normalizeProduct).filter((item) => item.goodsId)
    if (isProductRuntimePage()) return []
    const value = await requireLogin('collectProducts')
    if (value?.errorCode) return value
    return pickArray(value).map(normalizeProduct).filter((item) => item.goodsId)
  }


  async function getProductDetail(goodsId) {
    const cached = (await waitForCachedProductRows()).find((item) => String(item?.product_id || item?.productId || item?.goods_id || item?.goodsId || item?.id || '') === String(goodsId))
    if (cached) return normalizeProduct(cached)
    return requireLogin('getProductDetail', goodsId)
  }

  async function listSessions() {
    if (getStore()?.conversationsInfo) return nativeSessions()
    const value = await requireLogin('listSessions')
    if (value?.errorCode) return value
    return pickArray(value).map(normalizeSession).filter((item) => item.id)
  }

  async function listMessages(sessionId) {
    if (getStore()?.conversationsInfo) return nativeMessages(sessionId).sort((a, b) => a.timestamp - b.timestamp)
    const value = await requireLogin('listMessages', sessionId)
    if (value?.errorCode) return value
    return pickArray(value)
  }

  async function getOrders(userId) {
    const state = await auth()
    if (!state.authenticated) return { ok: false, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续' }
    const store = getStore()
    const orderStore = store?.orderInvitation || store?.orderInfo
    for (const name of ['getOrders', 'fetchOrders', 'fetchOrderList', 'queryOrders']) {
      try {
        if (typeof orderStore?.[name] === 'function') {
          const value = await orderStore[name](userId)
          return (Array.isArray(value) ? value : pickArray(value)).map(normalizeOrder).filter(Boolean)
        }
      } catch (_) {}
    }
    const value = await requireLogin('getOrders', userId)
    return value?.errorCode ? value : (Array.isArray(value) ? value : pickArray(value)).map(normalizeOrder).filter(Boolean)
  }

  async function syncOrders(sessionId, userId) {
    const syncedAt = Date.now()
    const state = await auth()
    if (!state.authenticated) {
      return { orders: [], authoritative: false, source: 'none', syncedAt, sessionId, userId, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续' }
    }

    const sessions = nativeSessions()
    let requestedSession = String(sessionId || '')
    let requestedUser = String(userId || '')
    if (requestedSession && !sessions.some((item) => item.id === requestedSession)) {
      if (!requestedUser) requestedUser = requestedSession
      requestedSession = ''
    }
    const targetSessionIds = new Set()
    if (requestedSession) targetSessionIds.add(requestedSession)
    if (requestedUser) {
      for (const session of sessions) if (buyerIdForSession(session.id) === requestedUser) targetSessionIds.add(session.id)
    }
    const hasFilter = Boolean(requestedSession || requestedUser)
    const allMessages = nativeMessages()
    const matchingMessages = allMessages.filter((message) => !hasFilter || targetSessionIds.has(message.sessionId))
    const ordersById = new Map()
    const sources = new Set()
    const addOrder = (value) => {
      const normalized = normalizeOrder(value)
      if (!normalized) return
      const previous = ordersById.get(normalized.orderId) || {}
      const merged = { ...previous }
      for (const [key, next] of Object.entries(normalized)) if (next !== undefined && next !== '') merged[key] = next
      ordersById.set(normalized.orderId, merged)
    }

    const platformResult = await getOrders(requestedUser || (requestedSession ? buyerIdForSession(requestedSession) : undefined))
    const platformAvailable = Array.isArray(platformResult)
    if (platformAvailable) {
      sources.add('platform-runtime')
      for (const order of platformResult) addOrder(order)
    }

    let historyAvailable = false
    for (const message of matchingMessages) {
      if (!message.order) continue
      historyAvailable = true
      const buyerId = buyerIdForSession(message.sessionId)
      addOrder({ ...message.order, sessionId: message.sessionId, userId: buyerId || undefined, messageId: message.id, updatedAt: message.timestamp })
    }
    if (historyAvailable) sources.add('session-history')

    const workstation = workstationOrderContext()
    const workstationMessage = allMessages.find((message) => message.id === workstation.messageId || message.order?.orderId === workstation.orderId)
    if (workstation.orderId && (!hasFilter || (workstationMessage && targetSessionIds.has(workstationMessage.sessionId)))) {
      sources.add('workstation')
      if (workstationMessage?.order) {
        addOrder({
          ...workstationMessage.order,
          sessionId: workstationMessage.sessionId,
          userId: buyerIdForSession(workstationMessage.sessionId) || undefined,
          messageId: workstationMessage.id,
          updatedAt: workstationMessage.timestamp,
        })
      } else {
        addOrder({ orderId: workstation.orderId, messageId: workstation.messageId || undefined, platform: 'douyin-shop' })
      }
    }

    const source = sources.size > 1 ? 'combined' : sources.values().next().value || 'none'
    const result = {
      orders: [...ordersById.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
      authoritative: platformAvailable || historyAvailable,
      source,
      syncedAt,
      sessionId: requestedSession || undefined,
      userId: requestedUser || undefined,
    }
    const targetSession = requestedSession || (matchingMessages[0]?.sessionId || '')
    const targetUser = requestedUser || (targetSession ? buyerIdForSession(targetSession) : '')
    if (result.authoritative && targetSession) {
      for (const order of result.orders) {
        emitOrderState({ ...order, sessionId: order.sessionId || targetSession, userId: order.userId || targetUser }, targetSession, targetUser, source, order.messageId, order.updatedAt || syncedAt)
      }
    }
    if (targetUser && result.authoritative) watchOrderSnapshot(targetSession || targetUser, targetUser, result.orders)
    return result
  }

  function orderStateKey(order) {
    return [
      order?.orderId || '', order?.status || '', order?.totalAmount ?? '', order?.quantity ?? '',
      order?.productId || '', order?.skuId || '', order?.skuName || '', order?.shippingAddress || '',
    ].join('|')
  }

  function orderStateMap(orders) {
    const result = new Map()
    for (const order of orders || []) if (order?.orderId) result.set(order.orderId, { key: orderStateKey(order), order })
    return result
  }

  function emitOrderState(order, sessionId, userId, source, messageId, timestamp) {
    if (!order?.orderId) return false
    const key = [String(userId || sessionId || ''), orderStateKey(order)].join('|')
    if (emittedOrderKeys.has(key)) return false
    emittedOrderKeys.add(key)
    if (emittedOrderKeys.size > 5000) emittedOrderKeys.clear()
    const updatedAt = Number(order.updatedAt || timestamp || Date.now()) || Date.now()
    push('order', {
      order: { ...order, sessionId: order.sessionId || sessionId, userId: order.userId || userId || undefined, messageId: order.messageId || messageId || undefined, updatedAt },
      sessionId: String(sessionId || order.sessionId || ''),
      userId: String(userId || order.userId || '') || undefined,
      messageId: String(messageId || order.messageId || '') || undefined,
      source,
      timestamp: updatedAt,
    })
    return true
  }

  function watchOrderSnapshot(sessionId, userId, orders) {
    const targetUser = String(userId || sessionId || '')
    if (!targetUser) return
    const now = Date.now()
    watchedOrderUsers.set(targetUser, {
      sessionId: String(sessionId || targetUser),
      lastActiveAt: now,
      nextPollAt: now + ORDER_ACTIVE_INTERVAL_MS,
    })
    if (!orderSnapshots.has(targetUser)) orderSnapshots.set(targetUser, orderStateMap(orders))
    pruneOrderWatches(now)
    bindOrderPolling()
  }

  function removeOrderWatch(userId) {
    watchedOrderUsers.delete(userId)
    orderSnapshots.delete(userId)
  }

  function pruneOrderWatches(now = Date.now()) {
    for (const [userId, watch] of watchedOrderUsers) {
      if (now - Number(watch.lastActiveAt || 0) >= ORDER_WATCH_TTL_MS) removeOrderWatch(userId)
    }
    const overflow = watchedOrderUsers.size - ORDER_WATCH_MAX
    if (overflow > 0) {
      const oldest = [...watchedOrderUsers.entries()]
        .sort((left, right) => Number(left[1].lastActiveAt || 0) - Number(right[1].lastActiveAt || 0))
        .slice(0, overflow)
      for (const [userId] of oldest) removeOrderWatch(userId)
    }
    if (!watchedOrderUsers.size && orderPollTimer) {
      clearInterval(orderPollTimer)
      orderPollTimer = null
    }
  }

  function touchOrderWatch(sessionId, userId) {
    const targetUser = String(userId || sessionId || '')
    const watch = watchedOrderUsers.get(targetUser)
    if (!watch) return false
    const now = Date.now()
    watch.sessionId = String(sessionId || watch.sessionId || targetUser)
    watch.lastActiveAt = now
    watch.nextPollAt = Math.min(Number(watch.nextPollAt || now), now)
    return true
  }

  function nextOrderPollDelay(watch, now) {
    return now - Number(watch.lastActiveAt || 0) <= ORDER_ACTIVE_WINDOW_MS
      ? ORDER_ACTIVE_INTERVAL_MS
      : ORDER_IDLE_INTERVAL_MS
  }

  async function pollOrderChanges() {
    if (disposed || orderPollBusy || !watchedOrderUsers.size) return
    const startedAt = Date.now()
    pruneOrderWatches(startedAt)
    const due = [...watchedOrderUsers.entries()]
      .filter(([, watch]) => Number(watch.nextPollAt || 0) <= startedAt)
      .sort((left, right) => Number(left[1].nextPollAt || 0) - Number(right[1].nextPollAt || 0))
      .slice(0, ORDER_POLL_BATCH_SIZE)
    if (!due.length) return
    orderPollBusy = true
    try {
      for (const [userId, watch] of due) {
        try {
          const value = await getOrders(userId)
          const now = Date.now()
          watch.nextPollAt = now + nextOrderPollDelay(watch, now)
          if (!Array.isArray(value)) continue
          const previous = orderSnapshots.get(userId)
          const next = orderStateMap(value)
          if (!next.size && previous?.size) continue
          if (previous) {
            for (const [orderId, current] of next) {
              if (previous.get(orderId)?.key === current.key) continue
              emitOrderState({ ...current.order, sessionId: watch.sessionId, userId, updatedAt: current.order.updatedAt || Date.now() }, watch.sessionId, userId, platformRuntimeOrderEvent.source, current.order.messageId, current.order.updatedAt)
            }
          }
          orderSnapshots.set(userId, next)
        } catch (error) {
          watch.nextPollAt = Date.now() + ORDER_IDLE_INTERVAL_MS
          push('error', { error: String(error?.message || error), source: 'orders.listen' })
        }
      }
    } finally {
      orderPollBusy = false
    }
  }

  function bindOrderPolling() {
    if (disposed || orderPollTimer) return
    orderPollTimer = setInterval(() => { void pollOrderChanges() }, ORDER_POLL_TICK_MS)
  }

  async function transferSession(sessionId, target) {
    const store = getStore()
    const transfer = store?.uiState?.chatRooms?.transferConv
    if (!transfer) return requireLogin('transferSession', sessionId, target)
    try {
      if (!transfer.canTransferServiceList?.length && typeof transfer.fetchTransferServiceList === 'function') await transfer.fetchTransferServiceList()
      if (!transfer.canTransferGroupList?.length && typeof transfer.fetchTransferGroupList === 'function') await transfer.fetchTransferGroupList()
      const people = [...(transfer.canTransferServiceList || []), ...(transfer.canTransferGroupList || [])]
      const selected = people.find((item) => String(item?.id || item?.staffId || item?.userId || item?.name || item?.title || '') === String(target))
        || people.find((item) => String(item?.name || item?.title || item?.staffName || '').includes(String(target)))
      if (!selected) return { success: false, errorCode: 'TARGET_NOT_FOUND', error: '未找到目标客服或客服组', available: people.map((item) => ({ id: item?.id || item?.staffId || item?.userId, name: item?.name || item?.title || item?.staffName })) }
      for (const name of ['transferConversation', 'transferSession', 'assignConversation', 'transfer']) {
        if (typeof transfer[name] === 'function') return { success: true, value: await transfer[name](sessionId, selected.id || selected.staffId || selected.userId) }
      }
    } catch (error) {
      return { success: false, errorCode: 'TRANSFER_FAILED', error: String(error?.message || error) }
    }
    return requireLogin('transferSession', sessionId, target)
  }

  async function sendFile(sessionId, dataUrl, fileName) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续' }
    const im = getNativeIm()
    const ctx = window.__mona_pigeon_event?.globalStore?.data?.initContextData
    if (!im || typeof im.sendImage !== 'function' || typeof ctx?.customRequestUpload !== 'function') return send('sendFile', sessionId, dataUrl, fileName)
    try {
      const match = String(dataUrl || '').match(/^data:([^;,]+)?;base64,(.*)$/)
      const mime = match?.[1] || 'application/octet-stream'
      const base64 = match?.[2] || String(dataUrl || '')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const blob = new Blob([bytes], { type: mime })
      const file = new File([blob], fileName || 'upload.bin', { type: mime })
      if (!mime.startsWith('image/')) return { success: false, errorCode: 'UNSUPPORTED_FILE_TYPE', error: '抖店当前 window runtime 仅支持直接发送图片' }
      const bitmap = await createImageBitmap(blob)
      const image = {
        uri: URL.createObjectURL(blob),
        width: bitmap.width,
        height: bitmap.height,
        format: mime.split('/')[1] || 'png',
        size: file.size,
      }
      bitmap.close?.()
      const upload = () => new Promise((resolve, reject) => {
        ctx.customRequestUpload({
          file,
          onSuccess: (response) => {
            const uri = response?.data?.[0]?.url || response?.url || response?.uri
            if (uri) resolve({ uri })
            else reject(new Error('图片上传未返回地址'))
          },
          onError: reject,
        })
      })
      let sendError = null
      try {
        const value = await im.sendImage(sessionId, image, upload, {}, (error) => { sendError = error })
        if (!value) return { success: false, errorCode: 'FILE_SEND_FAILED', error: String(sendError?.message || sendError || '抖店图片发送失败') }
        return { success: true, value: snapshot(value) }
      } finally {
        URL.revokeObjectURL(image.uri)
      }
    } catch (error) {
      return { success: false, errorCode: 'FILE_UPLOAD_FAILED', error: String(error?.message || error) }
    }
  }

  async function send(method, ...args) {
    const value = await requireLogin(method, ...args)
    if (value?.errorCode || value?.success === false || value?.ok === false) return value
    return { success: true, value }
  }

  async function sendText(sessionId, content) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: 'LOGIN_REQUIRED', error: '请在抖店页面完成登录后继续' }
    const im = getNativeIm()
    if (!im || typeof im.sendText !== 'function') return send('sendMessage', sessionId, content)
    try {
      if (typeof im.checkCanSendMessage === 'function' && !im.checkCanSendMessage(sessionId)) {
        return { success: false, errorCode: 'SESSION_NOT_SENDABLE', error: '当前会话不可发送消息' }
      }
      const value = await im.sendText(sessionId, content, {})
      if (value?.success === false) return { success: false, errorCode: String(value?.statusCode || 'SEND_FAILED'), error: value?.statusMsg || '抖店发送消息失败' }
      return { success: true, value: snapshot(value) }
    } catch (error) {
      return { success: false, errorCode: 'SEND_FAILED', error: String(error?.message || error) }
    }
  }

  function normalizeNativeMessage(raw) {
    const value = raw?.message || raw?.data || raw?.payload || raw
    if (!value || typeof value !== 'object') return null
    const sessionId = String(value.conversationId || value.originConversationId || value.securityConversationId || '')
    const id = String(value.serverId || value.messageId || value.clientId || value.id || '')
    if (!sessionId || !id) return null
    const ext = snapshot(value.ext) || {}
    const session = nativeSessions().find((item) => item.id === sessionId)
    const senderId = String(value.sender || value.senderId || value.originSender || value.securitySender || value.from || '')
    const senderRole = String(ext.sender_role || ext['s:sender_biz_role'] || '')
    const isSystem = senderRole === '3' || senderRole === '4'
    const order = orderFromMessage(value, ext)
    const product = order ? null : productFromMessage(value, ext)
    return {
      id,
      sessionId,
      senderId,
      senderName: String(isSystem ? '系统' : ext.uname || value.senderName || session?.title || ''),
      content: String(value.content || value.text || value.message || ''),
      type: String(order ? 'order' : isSystem ? 'system' : product ? 'product' : ext.type || value.type || 'text'),
      isMine: !isSystem && Boolean(value.isMine || senderId === String(getStore()?.selfInfo?.id || '') || senderRole === '2'),
      timestamp: Number(value.createTime || value.createdAt || value.timestamp || Date.now()),
      avatar: ext.avatar_uri || value.avatar,
      order: order || undefined,
      product: product || undefined,
    }
  }

  function eventMessages(value) {
    const messages = []
    const seen = new Set()
    const pending = [value]
    while (pending.length && seen.size < 200) {
      const item = pending.shift()
      if (!item || (typeof item !== 'object' && typeof item !== 'function') || seen.has(item)) continue
      seen.add(item)
      const normalized = normalizeNativeMessage(item)
      if (normalized) messages.push(normalized)
      if (Array.isArray(item)) pending.push(...item)
      for (const key of ['message', 'data', 'payload', 'messages', 'items', 'list']) {
        try {
          const nested = item[key]
          if (Array.isArray(nested)) pending.push(...nested)
          else if (nested && typeof nested === 'object') pending.push(nested)
        } catch (_) {}
      }
    }
    return messages
  }

  function bindMessages() {
    if (subscription) return
    if (getStore()?.conversationsInfo) {
      const seenIds = new Set()
      const seenFingerprints = new Set()
      const seenOrderKeys = new Set()
      const latestBySession = new Map()
      // The platform replays already loaded history when a stream is subscribed.
      // Establish a per-conversation waterline before subscribing so only newer
      // messages reach the host event bus.
      const initialMessages = nativeMessages()
      for (const message of initialMessages) {
        const timestamp = Number(message.timestamp || 0)
        if (timestamp > Number(latestBySession.get(message.sessionId) || 0)) latestBySession.set(message.sessionId, timestamp)
      }
      const remember = (message) => {
        const fingerprint = [message.sessionId, message.senderId, message.content, message.timestamp].join('|')
        if (seenIds.has(message.id) || seenFingerprints.has(fingerprint)) return false
        seenIds.add(message.id); seenFingerprints.add(fingerprint)
        return true
      }
      const orderKey = (message) => message.order ? orderStateKey(message.order) : ''
      const seedOrder = (message) => {
        const key = orderKey(message)
        if (key) seenOrderKeys.add(key)
      }
      const publishOrder = (message) => {
        const key = orderKey(message)
        if (!key || seenOrderKeys.has(key)) return false
        seenOrderKeys.add(key)
        const userId = buyerIdForSession(message.sessionId)
        const watched = orderSnapshots.get(userId)
        if (watched) watched.set(message.order.orderId, { key: orderStateKey(message.order), order: message.order })
        return emitOrderState({
          ...message.order,
          sessionId: message.sessionId,
          userId: userId || undefined,
          messageId: message.id,
          updatedAt: message.timestamp,
        }, message.sessionId, userId, 'message', message.id, message.timestamp)
      }
      const publishMessage = (message) => {
        const timestamp = Number(message.timestamp || 0)
        const latest = Number(latestBySession.get(message.sessionId) || 0)
        const knownMessage = seenIds.has(message.id)
        if (timestamp && latest && timestamp <= latest && !knownMessage) return
        publishOrder(message)
        const userId = buyerIdForSession(message.sessionId)
        if (!touchOrderWatch(message.sessionId, userId)) {
          void syncOrders(message.sessionId, userId).catch((error) => push('error', { error: String(error?.message || error), source: 'orders.listen' }))
        }
        if (!remember(message)) return
        if (timestamp > latest) latestBySession.set(message.sessionId, timestamp)
        push('message', message)
      }
      const reseed = () => {
        seenIds.clear(); seenFingerprints.clear(); seenOrderKeys.clear()
        for (const message of nativeMessages()) { remember(message); seedOrder(message) }
      }
      initialMessages.forEach((message) => { remember(message); seedOrder(message) })
      const subscriptions = []
      const im = getNativeIm()
      for (const stream of [im?._message$, im?._messageUpsert$, im?._batchUpsert$]) {
        if (typeof stream?.subscribe !== 'function') continue
        try {
          subscriptions.push(stream.subscribe((value) => {
            for (const message of eventMessages(value)) publishMessage(message)
            if (seenIds.size > 5000 || seenOrderKeys.size > 5000) reseed()
          }))
        } catch (error) {
          push('error', { error: String(error?.message || error) })
        }
      }
      const timer = subscriptions.length ? null : setInterval(() => {
        for (const message of nativeMessages()) publishMessage(message)
        if (seenIds.size > 5000 || seenOrderKeys.size > 5000) reseed()
      }, 500)
      subscription = () => {
        if (timer) clearInterval(timer)
        for (const item of subscriptions) {
          try { if (typeof item === 'function') item(); else item?.unsubscribe?.() } catch (_) {}
        }
      }
      return
    }
    const method = findMethod('subscribeMessages')
    if (!method) return
    try {
      const seenOrderKeys = new Set()
      subscription = method.fn.call(method.owner, (value) => {
        for (const message of eventMessages(value)) {
          push('message', message)
          if (!message.order) continue
          const key = orderStateKey(message.order)
          if (seenOrderKeys.has(key)) continue
          seenOrderKeys.add(key)
          const userId = buyerIdForSession(message.sessionId)
          const watched = orderSnapshots.get(userId)
          if (watched) watched.set(message.order.orderId, { key, order: message.order })
          push('order', {
            order: { ...message.order, sessionId: message.sessionId, userId: userId || undefined, messageId: message.id, updatedAt: message.timestamp },
            sessionId: message.sessionId,
            userId: userId || undefined,
            messageId: message.id,
            source: 'message',
            timestamp: message.timestamp,
          })
        }
      })
    } catch (error) {
      push('error', { error: String(error?.message || error) })
    }
  }

  window[QUEUE_KEY] = {
    __version: HOOK_VERSION,
    capabilities: ${JSON.stringify(doudianCapabilities)},
    getAuthState: auth,
    collectProducts,
    getProductDetail,
    listSessions,
    listMessages,
    sendMessage: sendText,
    sendFile,
    transferSession,
    getOrders,
    syncOrders,
    diagnose: () => locateRuntime().slice(0, 30).map((item) => ({ path: item.path, methods: item.methods, score: item.score })),
    drainEvents: () => { bindMessages(); return queue.splice(0, queue.length) },
    dispose: () => {
      disposed = true
      try { if (typeof subscription === 'function') subscription(); else subscription?.unsubscribe?.() } catch (_) {}
      subscription = null
      if (orderPollTimer) clearInterval(orderPollTimer)
      orderPollTimer = null
      orderPollBusy = false
      watchedOrderUsers.clear()
      orderSnapshots.clear()
      emittedOrderKeys.clear()
      queue.length = 0
    },
  }
  bindMessages()
  push('ready', { capabilities: window[QUEUE_KEY].capabilities })
})()`;
const doudianHook = {
  id: "douyin-shop",
  label: "抖店",
  version: hookVersion,
  url: "https://im.jinritemai.com/pc_seller_v2/main/workspace",
  match: ["*.jinritemai.com/*"],
  capabilities: doudianCapabilities,
  script: doudianHookScript,
  runtimePages: [
    {
      id: "products",
      url: "https://fxg.jinritemai.com/ffa/g/list?tab=all",
      methods: ["collectProducts", "getProductDetail"],
      refreshBeforeInvoke: true
    }
  ],
  source: "builtin"
};
const capabilities = ["messages.listen", "messages.history", "messages.send", "messages.file", "sessions.list", "products.collect", "products.detail"];
const goofishHook = {
  id: "goofish",
  label: "闲鱼",
  version: "1.0.0",
  url: "https://www.goofish.com/",
  capabilities,
  source: "builtin",
  script: `(() => {
    const bridge = window.__GOOFISH_BRIDGE__ || window.__goofishBridge
    const api = window.__platformHub || {}
    if (!bridge) return
    window.__platformHub = { ...api, __version: '2',
      getAuthState: () => bridge.snapshot?.() || { authenticated: true },
      collectProducts: () => bridge.listOnSaleProducts?.() || [],
      listSessions: () => bridge.listSessions?.() || [],
      listMessages: (id) => bridge.listMessages?.(id) || [],
      sendMessage: (id, text) => bridge.sendMessage?.(id, text),
      sendFile: (id, data, name) => bridge.sendFile?.(id, data, name),
      drainEvents: () => bridge.drainEvents?.() || []
    }
  })()`
};
const builtinHooks = {
  [doudianHook.id]: doudianHook,
  [kuaishouHook.id]: kuaishouHook,
  [goofishHook.id]: goofishHook
};
const builtinPlatforms = [doudianHook, kuaishouHook, goofishHook].map((hook) => ({
  id: hook.id,
  label: hook.label,
  url: hook.url,
  capabilities: hook.capabilities,
  hookVersion: hook.version,
  source: "builtin"
}));
class PlatformManager {
  sessions = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  state = { accounts: [], hooks: [] };
  statePath;
  stateBackupPath;
  saveQueue = Promise.resolve();
  constructor() {
    this.statePath = join(app.getPath("userData"), "platform-hub.json");
    this.stateBackupPath = join(app.getPath("userData"), "platform-hub.json.bak");
  }
  async init() {
    this.state = await this.readState(this.statePath) || await this.readState(this.stateBackupPath) || { accounts: [], hooks: [] };
  }
  listPlatforms() {
    return [...builtinPlatforms, ...this.state.hooks.map(({ manifest }) => ({
      id: manifest.id,
      label: manifest.label,
      url: manifest.url,
      capabilities: manifest.capabilities,
      hookVersion: manifest.version,
      source: "imported"
    }))];
  }
  listAccounts() {
    return this.state.accounts.map((account) => {
      const cdp = this.sessions.get(account.id);
      const live = cdp?.getStatus();
      return {
        ...account,
        connected: live?.connected ?? account.connected,
        authenticated: live?.authenticated ?? account.authenticated,
        webContentsId: cdp?.getWebContentsId()
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
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.state.accounts.push(account);
    await this.save();
    return account;
  }
  async removeAccount(accountId) {
    this.sessions.get(accountId)?.close();
    this.sessions.delete(accountId);
    this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId);
    await this.save();
  }
  async open(accountId) {
    const account = this.requireAccount(accountId);
    const platform = this.listPlatforms().find((item) => item.id === account.platform);
    const hook = this.getHook(platform.id);
    let cdp = this.sessions.get(accountId);
    if (!cdp) {
      cdp = new CdpSession({ accountId, platform: platform.id, url: account.url, partition: account.partition, hook, emit: (event) => this.emit(event) });
      this.sessions.set(accountId, cdp);
    }
    await cdp.open(true);
    account.connected = true;
    account.webContentsId = cdp.getWebContentsId();
    account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save();
    return { ...account, connected: true, webContentsId: cdp.getWebContentsId() };
  }
  async connect(accountId, webContentsId) {
    const account = this.requireAccount(accountId);
    const cdp = this.sessions.get(accountId);
    if (!cdp || cdp.getWebContentsId() !== webContentsId) throw new Error("CDP 页面与账号不匹配");
    account.connected = true;
    account.webContentsId = webContentsId;
    account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save();
    return cdp.getStatus();
  }
  async disconnect(accountId) {
    this.sessions.get(accountId)?.close();
    this.sessions.delete(accountId);
    const account = this.requireAccount(accountId);
    account.connected = false;
    account.webContentsId = void 0;
    await this.save();
  }
  async status(accountId) {
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
    return this.withLogin(accountId, "collectProducts");
  }
  async productDetail(accountId, goodsId) {
    return this.withLogin(accountId, "getProductDetail", goodsId);
  }
  async sessionsFor(accountId) {
    return this.withLogin(accountId, "listSessions");
  }
  async messagesFor(accountId, sessionId) {
    return this.withLogin(accountId, "listMessages", sessionId);
  }
  async ordersFor(accountId, userId) {
    return this.withLogin(accountId, "getOrders", userId);
  }
  async syncOrdersFor(accountId, sessionId, userId) {
    return this.withLogin(accountId, "syncOrders", sessionId, userId);
  }
  async sendMessage(accountId, sessionId, content) {
    return this.withLogin(accountId, "sendMessage", sessionId, content);
  }
  async sendFile(accountId, sessionId, dataUrl, fileName) {
    return this.withLogin(accountId, "sendFile", sessionId, dataUrl, fileName);
  }
  async transferSession(accountId, sessionId, target) {
    return this.withLogin(accountId, "transferSession", sessionId, target);
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      }
    }
    this.listeners.forEach((listener) => listener(event));
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
if (process.env.PLATFORM_HUB_USER_DATA) {
  app.setPath("userData", process.env.PLATFORM_HUB_USER_DATA);
}
if (process.env.PLATFORM_HUB_ENABLE_GPU !== "1") {
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
function createWindow() {
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
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
  if (!manager.listAccounts().length) {
    await manager.addAccount({ platform: "douyin-shop", label: "抖店主账号" });
  }
  registerIpc();
  manager.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("platform:event", event);
  });
  createWindow();
  const doudian = manager.listAccounts().find((account) => account.platform === "douyin-shop");
  if (doudian) void manager.open(doudian.id).catch((error) => console.error("[platform-hub] 打开抖店页面失败", error));
  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
