const { EventEmitter } = require('node:events');
const { ALLOWED_COMMANDS, GOOFISH_URL, OFFICIAL_LOGIN_HOSTS } = require('./constants.cjs');
const { hostMatches, installSinglePopupHandler, partitionFor, registerWindowShortcuts } = require('./utils.cjs');

let requestSequence = 0;

class GoofishAccount extends EventEmitter {
  constructor(options) {
    super();
    const {
      account,
      BrowserWindow,
      session,
      bridgeScript,
      pagePreloadPath,
      logger,
      commandTimeout = 15_000,
      partitionPrefix = 'goofish-messaging',
      goofishUrl = GOOFISH_URL,
      windowOptions = {},
      enableDevShortcuts = false,
      shouldKeepAlive,
    } = options || {};
    if (!account?.id) throw new TypeError('GoofishAccount 需要有效的 account');
    if (!BrowserWindow || !session) throw new TypeError('GoofishAccount 需要 Electron BrowserWindow 和 session');
    this.account = { ...account };
    this.BrowserWindow = BrowserWindow;
    this.electronSession = session;
    this.bridgeScript = bridgeScript;
    this.pagePreloadPath = pagePreloadPath;
    this.logger = logger;
    this.commandTimeout = commandTimeout;
    this.partitionPrefix = partitionPrefix;
    this.goofishUrl = goofishUrl;
    this.windowOptions = windowOptions;
    this.enableDevShortcuts = enableDevShortcuts;
    this.shouldKeepAlive = shouldKeepAlive;
    this.activeCommands = 0;
    this.window = null;
    this.popupController = null;
    this.embeddedWebContents = null;
    this.embeddedListeners = null;
    this.pending = new Map();
    // The injected bridge can answer an account snapshot before IM finishes
    // connecting. Keep that separate from bridgeReady, which means the
    // message listener is fully usable.
    this.bridgeInstalled = false;
    this.bridgeReady = false;
    this.pageState = 'closed';
  }

  get id() { return this.account.id; }

  get partition() { return partitionFor(this.account.partitionId || this.id, this.partitionPrefix); }

  isWebContentsDestroyed(webContents) {
    return typeof webContents?.isDestroyed === 'function' && webContents.isDestroyed();
  }

  describe() {
    return {
      ...this.account,
      partition: this.partition,
      windowOpen: Boolean(this.commandTarget),
    };
  }

  updateAccount(account) {
    if (!account?.id) throw new Error('账号标识不匹配');
    this.account = { ...account };
    return this.describe();
  }

  isGoofishUrl(rawUrl) {
    return hostMatches(rawUrl, ['goofish.com']);
  }

  isOfficialLoginUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!hostMatches(url.href, OFFICIAL_LOGIN_HOSTS)) return false;
      if (url.hostname !== 'goofish.com' && !url.hostname.endsWith('.goofish.com')) return true;
      return /(?:^|\/)(?:login|not-login|passport|auth)(?:\/|$)/i.test(url.pathname)
        || /(?:^|[?&])(?:login|needLogin|notLogin)=/i.test(url.search);
    } catch (_) {
      return false;
    }
  }

  emitPageEvent(eventType, payload) {
    const event = { accountId: this.id, eventType, payload };
    this.emit('event', event);
    return event;
  }

  get commandTarget() {
    if (this.embeddedWebContents) {
      if (!this.isWebContentsDestroyed(this.embeddedWebContents)) {
        return this.embeddedWebContents;
      }
      // Router unmount can destroy the guest before renderer IPC unbind runs.
      // Drop the stale reference lazily so commands can create a fallback
      // BrowserWindow and continue with the same persistent partition.
      this.detachWebContents(this.embeddedWebContents);
    }
    if (this.window && !this.window.isDestroyed()) return this.window.webContents;
    return null;
  }

  get hasEmbeddedWebContents() {
    if (!this.embeddedWebContents) return false;
    if (!this.isWebContentsDestroyed(this.embeddedWebContents)) return true;
    this.detachWebContents(this.embeddedWebContents);
    return false;
  }

  attachWebContents(webContents) {
    if (!webContents || this.isWebContentsDestroyed(webContents)) {
      throw new Error('闲鱼内嵌页面不可用');
    }
    if (this.embeddedWebContents === webContents) {
      return this.installBridgeForWebContents(webContents);
    }

    this.detachWebContents();
    this.embeddedWebContents = webContents;
    const didStartNavigation = (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.bridgeInstalled = false;
      this.bridgeReady = false;
      this.pageState = 'loading';
      this.rejectPending('闲鱼页面已重新加载，请稍后重试');
    };
    const didFinishLoad = () => this.installBridgeForWebContents(webContents);
    const didFailLoad = (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.pageState = 'error';
      this.rejectPending('闲鱼页面加载失败，请检查网络后重试');
      this.emitPageEvent('load-error', { code, description, url });
    };
    const destroyed = () => this.detachWebContents(webContents);
    webContents.on('did-start-navigation', didStartNavigation);
    webContents.on('did-finish-load', didFinishLoad);
    webContents.on('did-fail-load', didFailLoad);
    webContents.once('destroyed', destroyed);
    this.embeddedListeners = {
      webContents,
      didStartNavigation,
      didFinishLoad,
      didFailLoad,
      destroyed,
    };

    if (this.window && !this.window.isDestroyed()) {
      const previousWindow = this.window;
      this.window = null;
      previousWindow.__goofishForceClose = true;
      previousWindow.destroy();
    }
    return this.installBridgeForWebContents(webContents);
  }

  detachWebContents(webContents) {
    if (webContents && this.embeddedWebContents !== webContents) return false;
    const listeners = this.embeddedListeners;
    if (listeners && !this.isWebContentsDestroyed(listeners.webContents)) {
      listeners.webContents.removeListener('did-start-navigation', listeners.didStartNavigation);
      listeners.webContents.removeListener('did-finish-load', listeners.didFinishLoad);
      listeners.webContents.removeListener('did-fail-load', listeners.didFailLoad);
      listeners.webContents.removeListener('destroyed', listeners.destroyed);
    }
    const detached = Boolean(this.embeddedWebContents);
    this.embeddedListeners = null;
    this.embeddedWebContents = null;
    if (detached) {
      this.bridgeInstalled = false;
      this.bridgeReady = false;
      this.pageState = 'closed';
      this.rejectPending('闲鱼内嵌页面已关闭');
    }
    return detached;
  }

  createWindow() {
    const accountSession = this.electronSession.fromPartition(this.partition, { cache: true });
    const customWebPreferences = this.windowOptions.webPreferences || {};
    const window = new this.BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      title: `闲鱼登录 - ${this.account.label}`,
      show: false,
      autoHideMenuBar: true,
      ...this.windowOptions,
      skipTaskbar: true,
      webPreferences: {
        ...customWebPreferences,
        session: accountSession,
        partition: this.partition,
        preload: this.pagePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: true,
      },
    });

    window.setSkipTaskbar?.(true);
    window.on('show', () => window.setSkipTaskbar?.(true));

    window.on('close', (event) => {
      if (!window.__goofishForceClose) {
        if (this.shouldKeepAlive && !this.shouldKeepAlive()) {
          event.preventDefault();
          this.close();
          return;
        }
        event.preventDefault();
        window.hide();
      }
    });
    if (this.enableDevShortcuts) registerWindowShortcuts(window);
    this.popupController?.dispose();
    const popupController = installSinglePopupHandler(window, {
      isAllowed: (url) => hostMatches(url, OFFICIAL_LOGIN_HOSTS),
      browserWindowOptions: {
        width: 920,
        height: 720,
        skipTaskbar: true,
        autoHideMenuBar: true,
        parent: window,
        webPreferences: {
          session: accountSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: true,
        },
      },
    });
    this.popupController = popupController;
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.bridgeInstalled = false;
      this.bridgeReady = false;
      this.pageState = 'loading';
      this.rejectPending('闲鱼页面已重新加载，请稍后重试');
    });
    window.webContents.on('did-finish-load', () => this.installBridge());
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.pageState = 'error';
      this.rejectPending('闲鱼页面加载失败，请检查网络后重试');
      this.emitPageEvent('load-error', { code, description, url });
    });
    window.on('closed', () => {
      popupController.dispose();
      if (this.popupController === popupController) this.popupController = null;
      if (this.window !== window) return;
      this.window = null;
      if (!this.hasEmbeddedWebContents) {
        this.bridgeReady = false;
        this.pageState = 'closed';
        this.rejectPending('闲鱼账号窗口已关闭');
      }
    });
    this.window = window;
    this.pageState = 'loading';
    Promise.resolve(window.loadURL(this.goofishUrl)).catch((error) => {
      this.emitPageEvent('load-error', { description: error.message, url: this.goofishUrl });
    });
    return window;
  }

  async installBridgeForWebContents(webContents) {
    if (!webContents || this.isWebContentsDestroyed(webContents)) return;
    const currentUrl = webContents.getURL();
    if (!this.isGoofishUrl(currentUrl) || this.isOfficialLoginUrl(currentUrl)) {
      this.bridgeInstalled = false;
      this.pageState = 'login';
      this.emitPageEvent('official-login-page', { url: currentUrl });
      return;
    }
    this.pageState = 'goofish';
    try {
      await webContents.executeJavaScript(this.bridgeScript, true);
      this.bridgeInstalled = true;
      this.emitPageEvent('page-loaded', { url: currentUrl });
      this.logger.write('listen', { accountId: this.id, eventType: 'page-loaded', payload: { url: currentUrl } });
    } catch (error) {
      this.bridgeInstalled = false;
      this.emitPageEvent('bridge-error', { message: error.message });
      this.logger.write('errors', { accountId: this.id, eventType: 'bridge-error', error: error.message });
    }
  }

  async installBridge() {
    return this.installBridgeForWebContents(this.window?.webContents);
  }

  open(show = true) {
    if (this.hasEmbeddedWebContents) {
      if (show) this.embeddedWebContents.focus();
      return { opened: true, embedded: true, accountId: this.id };
    }
    let window = this.window;
    if (!window || window.isDestroyed()) window = this.createWindow();
    else if (this.pageState === 'error') {
      this.pageState = 'loading';
      window.webContents.reload();
    }
    window.setSkipTaskbar?.(true);
    if (show) {
      window.show();
      window.focus();
    } else {
      window.hide();
    }
    return { opened: true, accountId: this.id };
  }

  refresh() {
    const target = this.commandTarget || this.ensureWindow().webContents;
    target.reload();
    return { refreshed: true, accountId: this.id };
  }

  ensureWindow() {
    if (!this.window || this.window.isDestroyed()) return this.createWindow();
    return this.window;
  }

  ownsSender(sender) {
    return Boolean(sender && this.commandTarget && this.commandTarget.id === sender.id);
  }

  handlePageMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'idle-fish:response' && data.requestId) {
      const request = this.pending.get(data.requestId);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(data.requestId);
      const kind = request.command === 'messages:send' ? 'send' : request.command.startsWith('messages:') ? 'history' : 'listen';
      this.logger.write(kind, { accountId: this.id, command: request.command, args: request.args, ok: Boolean(data.ok), result: data.ok ? data.result : undefined, error: data.ok ? undefined : data.error });
      if (data.ok) request.resolve(data.result);
      else request.reject(new Error(data.error || '闲鱼页面请求失败'));
      return;
    }
    if (data.type === 'idle-fish:event') {
      if (data.eventType === 'bridge-ready') this.bridgeReady = true;
      if (data.eventType === 'bridge-ready') this.pageState = 'ready';
      this.logger.write('listen', { accountId: this.id, eventType: data.eventType, payload: data.payload });
      this.emitPageEvent(data.eventType, data.payload);
    }
  }

  command(command, args = {}) {
    if (!ALLOWED_COMMANDS.includes(command)) return Promise.reject(new Error('不允许的闲鱼页面命令'));
    this.activeCommands += 1;
    return (async () => {
      const target = this.commandTarget || this.ensureWindow().webContents;
      if (command === 'snapshot' && !this.bridgeReady) {
        // Snapshot doubles as the startup readiness probe. A login redirect
        // is detected by waitForBridgeReady, while a normal embedded page can
        // take several seconds before its bridge becomes available.
        const currentUrl = target.getURL();
        // A freshly mounted embedded WebView can need several seconds to
        // capture the page engine and emit `bridge-ready`. Use the command
        // timeout as the readiness budget instead of returning a false,
        // unauthenticated snapshot after a short fixed delay.
        const wait = this.isGoofishUrl(currentUrl) || !currentUrl ? this.commandTimeout : 0;
        if (wait) await this.waitForBridgeReady(wait, true).catch(() => {});
        if (!this.bridgeReady && !this.bridgeInstalled) {
          return {
            ready: false,
            loginRequired: this.pageState === 'login' || this.pageState === 'error',
            authenticated: false,
            userId: '',
            nickname: '',
            connectionStatus: 'unknown',
            href: currentUrl,
          };
        }
      }
      // After an application restart the persisted account is restored before
      // its BrowserWindow and page bridge. Wait for the bridge instead of
      // turning this normal startup race into a false "not logged in" state.
      if (command !== 'snapshot' || !this.bridgeInstalled) await this.waitForBridgeReady();
      const commandTarget = this.commandTarget;
      if (!commandTarget || this.isWebContentsDestroyed(commandTarget) || commandTarget !== target) {
        throw new Error('闲鱼官方页面已关闭');
      }
      if (commandTarget.isLoadingMainFrame()) {
        throw new Error('闲鱼页面正在加载，请稍后重试');
      }
      const requestId = `goofish-${Date.now()}-${++requestSequence}`;
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(requestId);
          this.logger.write('errors', { accountId: this.id, command, args, error: '闲鱼页面请求超时' });
          reject(new Error('闲鱼页面响应超时，请确认账号已登录'));
        }, this.commandTimeout);
        this.pending.set(requestId, { command, args, resolve, reject, timeout });
        commandTarget.send('goofish:command', { requestId, command, args });
      });
    })().finally(() => {
      this.activeCommands -= 1;
      this.releaseIdleWindow();
    });
  }

  waitForBridgeReady(timeout = this.commandTimeout, allowInstalled = false) {
    if (this.bridgeReady || (allowInstalled && this.bridgeInstalled)) return Promise.resolve();
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (this.bridgeReady || (allowInstalled && this.bridgeInstalled)) {
          resolve();
          return;
        }
        if (this.pageState === 'login') {
          reject(new Error('闲鱼账号尚未登录，请在官方页面完成登录'));
          return;
        }
        if (this.pageState === 'error') {
          reject(new Error('闲鱼页面加载失败，请检查网络后重试'));
          return;
        }
        if (!this.commandTarget) {
          reject(new Error('闲鱼官方页面已关闭'));
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          reject(new Error('闲鱼页面桥接正在初始化，请稍后重试'));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  rejectPending(message) {
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timeout);
      this.pending.delete(requestId);
      request.reject(new Error(message));
    }
  }

  releaseIdleWindow() {
    if (this.activeCommands === 0 && this.shouldKeepAlive && !this.shouldKeepAlive()
      && !this.hasEmbeddedWebContents && this.window && !this.window.isDestroyed()
      && !this.window.isVisible()) this.close();
  }

  close() {
    this.rejectPending('闲鱼消息客户端已关闭');
    this.detachWebContents();
    this.popupController?.dispose();
    this.popupController = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.__goofishForceClose = true;
      this.window.destroy();
    }
    this.window = null;
    this.bridgeInstalled = false;
    this.bridgeReady = false;
    this.pageState = 'closed';
  }
}

module.exports = { GoofishAccount };
