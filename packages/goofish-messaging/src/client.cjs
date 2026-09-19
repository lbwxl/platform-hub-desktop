const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JsonAccountRepository } = require('./account-repository.cjs');
const { GoofishAccount } = require('./goofish-account.cjs');
const { GoofishProductCatalog } = require('./product-catalog.cjs');
const { NdjsonLogger } = require('./ndjson-logger.cjs');
const { ASSET_DIR } = require('./constants.cjs');

const SHOP_ID_PATTERN = /^\d+$/;

class GoofishMessagingClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const electron = options.electron || require('electron');
    const BrowserWindow = options.BrowserWindow || electron.BrowserWindow;
    const session = options.session || electron.session;
    if (!BrowserWindow || !session) throw new TypeError('GoofishMessagingClient 需要 Electron 的 BrowserWindow 和 session');
    const userDataPath = options.userDataPath || electron.app?.getPath?.('userData');
    if (!userDataPath) throw new TypeError('GoofishMessagingClient 需要 userDataPath');
    this.options = {
      ...options,
      BrowserWindow,
      session,
      userDataPath,
      bridgePath: options.bridgePath || path.join(ASSET_DIR, 'goofish-bridge.js'),
      pagePreloadPath: options.pagePreloadPath || path.join(ASSET_DIR, 'goofish-preload.cjs'),
      partitionPrefix: options.partitionPrefix || 'goofish-messaging',
      logDirectory: options.logDirectory === undefined ? path.join(userDataPath, 'goofish-messaging-logs') : options.logDirectory,
      accountsFileName: options.accountsFileName || 'goofish-accounts.json',
    };
    this.repository = options.repository || new JsonAccountRepository({ filePath: path.join(userDataPath, this.options.accountsFileName) });
    this.logger = options.logger || new NdjsonLogger({ directory: this.options.logDirectory });
    this.bridgeScript = options.bridgeScript || fs.readFileSync(this.options.bridgePath, 'utf8');
    this.accounts = new Map();
    this.productCatalogs = new Map();
    this.snapshotRequests = new Map();
    for (const account of this.repository.list()) {
      if (account?.id) this.attachAccount(account);
    }
  }

  attachAccount(account) {
    const instance = new GoofishAccount({
      ...this.options, account, bridgeScript: this.bridgeScript, logger: this.logger,
      shouldKeepAlive: this.options.shouldKeepAccountAlive
        ? () => this.options.shouldKeepAccountAlive(instance.id)
        : undefined,
    });
    instance.on('event', (event) => {
      if (event.eventType === 'official-login-page') {
        try {
          const current = this.repository.get(event.accountId);
          if (current.status === 'authenticated') {
            const updated = this.repository.update(event.accountId, { status: 'unknown' });
            instance.updateAccount(updated);
          }
        } catch {
          // The login window can still recover the session if metadata is unavailable.
        }
        // 内嵌官方页会直接显示登录状态；只有没有挂载 WebView 的后台账号
        // 才使用独立窗口作为恢复兜底。
        if (!instance.hasEmbeddedWebContents) instance.open(true);
      }
      if (event.eventType === 'bridge-ready') {
        this.refreshAccountProfile(event.accountId).catch(() => {});
      }
      this.emit('event', event);
    });
    this.accounts.set(account.id, instance);
    const catalog = new GoofishProductCatalog({ ...this.options, account, logger: this.logger });
    catalog.on('event', (event) => this.emit('event', event));
    this.productCatalogs.set(account.id, catalog);
    return instance;
  }

  async restoreAccounts({ openWindows = true } = {}) {
    // Reconcile duplicate records by the real seller shop_id. A canonical
    // record without partitionId may point at a stale container left by an
    // older build, so prefer the newest authenticated temporary record and
    // carry its partition over to the canonical key.
    const records = this.repository.list();
    const groups = new Map();
    for (const account of records) {
      const sellerId = String(account.userId || '').trim();
      const groupId = SHOP_ID_PATTERN.test(sellerId) ? sellerId : account.id;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId).push(account);
    }

    for (const [sellerId, group] of groups) {
      const candidates = group
        .filter((account) => account.status === 'authenticated')
        .sort((left, right) => {
          return (Date.parse(right.authenticatedAt || right.createdAt || '') || 0)
            - (Date.parse(left.authenticatedAt || left.createdAt || '') || 0);
        });
      const canonical = candidates.find((account) => account.id === sellerId);
      const source = canonical?.partitionId
        ? canonical
        : candidates.find((account) => account.id !== sellerId) || canonical || candidates[0] || group[0];
      let activeId = source?.id || group[0]?.id;
      let consolidated = false;
      try {
        if (source && SHOP_ID_PATTERN.test(sellerId) && source.id !== sellerId) {
          await this.migrateAccount(source.id, sellerId);
          activeId = sellerId;
          consolidated = true;
        }
      } catch (_) {
        // Keep the source partition alive if metadata migration
        // races with another startup operation.
      }

      const canonicalId = SHOP_ID_PATTERN.test(sellerId) ? sellerId : group[0]?.id;
      if (consolidated) {
        for (const account of group) {
          if (account.id === canonicalId) continue;
          try {
            this.account(account.id).close();
            this.productCatalogs.get(account.id)?.close();
            this.accounts.delete(account.id);
            this.productCatalogs.delete(account.id);
            this.snapshotRequests.delete(account.id);
            this.repository.remove(account.id);
          } catch (_) {}
        }
      }

      if (openWindows && activeId && this.accounts.has(activeId)) {
        this.openAccount(activeId, false);
      }
    }
  }

  account(accountId) {
    const id = String(accountId || '').trim();
    let instance = this.accounts.get(id);
    // The persisted account file can outlive an in-memory client instance
    // (for example after a renderer reload). Reattach it before failing so
    // callers continue using the same persisted seller container.
    if (!instance) {
      try {
        const stored = this.repository.get(id);
        instance = this.attachAccount(stored);
      } catch (_) {
        instance = null;
      }
    }
    if (!instance) throw new Error('账号不存在');
    return instance;
  }

  listAccounts() {
    return [...this.accounts.values()].map((account) => account.describe());
  }

  addAccount(input = {}) {
    const label = typeof input === 'string' ? input : input.label;
    const requestedId = typeof input === 'object' && input ? input.id : undefined;
    const record = this.repository.add(label, requestedId);
    if (this.accounts.has(record.id)) {
      const existing = this.account(record.id);
      if (input.show !== false) existing.open(true);
      return { ...existing.describe(), windowOpen: input.show === false ? existing.describe().windowOpen : true };
    }
    const account = this.attachAccount(record);
    const result = account.describe();
    if (input.show !== false) account.open(true);
    return { ...result, windowOpen: input.show === false ? false : true };
  }

  openAccount(accountId, show = true) { return this.account(accountId).open(show); }

  getEmbeddedWebviewConfig(accountId) {
    const account = this.account(accountId);
    return {
      accountId: account.id,
      partition: account.partition,
      preload: pathToFileURL(this.options.pagePreloadPath).toString(),
      url: account.goofishUrl,
    };
  }

  attachEmbeddedWebContents(accountId, webContents) {
    return this.account(accountId).attachWebContents(webContents);
  }

  detachEmbeddedWebContents(accountId, webContents) {
    const account = this.accounts.get(String(accountId || '').trim());
    if (!webContents) {
      const previous = account?.embeddedWebContents;
      if (!previous || !account.isWebContentsDestroyed(previous)) return false;
      return account.detachWebContents(previous);
    }
    return Boolean(account?.detachWebContents(webContents));
  }

  removeAccount(accountId) {
    const id = String(accountId || '').trim();
    const account = this.account(id);
    this.snapshotRequests.delete(id);
    account.close();
    const catalog = this.productCatalogs.get(id);
    if (catalog) catalog.close();
    this.accounts.delete(id);
    this.productCatalogs.delete(id);
    this.repository.remove(id);
    return { removed: true, accountId: id };
  }

  async migrateAccount(accountId, nextAccountId, options = {}) {
    const sourceId = String(accountId || '').trim();
    const targetId = String(nextAccountId || '').trim();
    if (!sourceId || !SHOP_ID_PATTERN.test(targetId)) {
      throw new TypeError('闲鱼账号需要有效的 shop_id');
    }
    if (sourceId === targetId) return this.account(sourceId).describe();

    const source = this.account(sourceId);
    const existingTarget = this.accounts.get(targetId);
    if (existingTarget) {
      const sourceStatus = source.describe().status;
      // During startup, only reconcile metadata and keep the seller-key
      // container. During a live login migration, sourceStatus is the result
      // of a successful page snapshot, so its partition is the one known to
      // contain the valid Cookie/IndexedDB session and must win.
      if (options.preferExisting || sourceStatus !== 'authenticated') {
        source.close();
        this.productCatalogs.get(sourceId)?.close();
        this.accounts.delete(sourceId);
        this.productCatalogs.delete(sourceId);
        this.snapshotRequests.delete(sourceId);
        this.repository.remove(sourceId);
        const account = existingTarget.describe();
        this.emit('event', {
          accountId: targetId,
          eventType: 'account-migrated',
          payload: { previousAccountId: sourceId, accountId: targetId, account },
        });
        return account;
      }
      existingTarget.close();
      this.productCatalogs.get(targetId)?.close();
      this.accounts.delete(targetId);
      this.productCatalogs.delete(targetId);
      this.snapshotRequests.delete(targetId);
      this.repository.remove(targetId);
    }

    const moved = this.repository.move(sourceId, targetId);
    const sourceCatalog = this.productCatalogs.get(sourceId);
    this.accounts.delete(sourceId);
    this.productCatalogs.delete(sourceId);
    this.snapshotRequests.delete(sourceId);

    // Re-key the existing live container rather than closing/recreating it.
    // Its partitionId continues to point at the original persistent session,
    // preserving cookies and IndexedDB without another login.
    source.updateAccount(moved);
    this.accounts.set(targetId, source);
    if (sourceCatalog) {
      sourceCatalog.updateAccount(moved);
      this.productCatalogs.set(targetId, sourceCatalog);
    }
    const account = source.describe();
    this.emit('event', {
      accountId: targetId,
      eventType: 'account-migrated',
      payload: { previousAccountId: sourceId, accountId: targetId, account },
    });
    return account;
  }

  refreshAccount(accountId) { return this.account(accountId).refresh(); }

  async snapshot(accountId) {
    const id = String(accountId || '').trim();
    const existing = this.snapshotRequests.get(id);
    if (existing) return existing;
    const request = (async () => {
      const snapshot = await this.account(id).command('snapshot');
      const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const userId = String(source.userId || '').trim();
      const shouldMigrate = source.authenticated === true && SHOP_ID_PATTERN.test(userId) && userId !== id;
      let account = this.updateAccountProfile(id, snapshot, { emit: !shouldMigrate });

      // The first login starts with the backend Shop.id as a temporary
      // connector key. Once the page reports the real seller shop_id, re-key
      // the existing account while retaining its partition and session.
      if (shouldMigrate) {
        try {
          account = await this.migrateAccount(id, userId);
        } catch (error) {
          // A bridge-ready/profile event may have completed the same move in
          // parallel. Reuse the canonical account when that is the case.
          if (!this.accounts.has(userId)) throw error;
          account = this.account(userId).describe();
        }
        this.emit('event', { accountId: account.id, eventType: 'account-updated', payload: account });
      }
      return {
        ...source,
        accountId: account.id,
        userId: source.userId || account.userId || '',
        nickname: source.nickname || source.fishNick || account.nickname || account.label || '',
      };
    })();
    this.snapshotRequests.set(id, request);
    const cleanup = () => {
      if (this.snapshotRequests.get(id) === request) this.snapshotRequests.delete(id);
    };
    request.then(cleanup, cleanup);
    return request;
  }

  updateAccountProfile(accountId, snapshot, { emit = true } = {}) {
    const id = String(accountId || '').trim();
    const userId = String(snapshot?.userId || '').trim();
    const nickname = String(snapshot?.fishNick || snapshot?.nickname || snapshot?.nick || '').trim();
    const avatar = String(snapshot?.avatar || '').trim();
    const account = this.account(id);
    const current = this.repository.get(id);
    // A false snapshot during page/IM bootstrap is transient. Only a direct
    // official-login-page event clears the persisted authenticated state.
    const status = snapshot?.authenticated === true ? 'authenticated' : current.status;
    const authenticatedAt = snapshot?.authenticated === true && !current.authenticatedAt
      ? new Date().toISOString()
      : current.authenticatedAt;
    if (!userId && !nickname && !avatar && status === current.status && !authenticatedAt) return account.describe();
    const updated = this.repository.update(id, {
      ...(userId ? { userId } : {}),
      ...(nickname ? { nickname, label: nickname } : {}),
      ...(avatar ? { avatar } : {}),
      ...(authenticatedAt ? { authenticatedAt } : {}),
      status,
    });
    account.updateAccount(updated);
    this.productCatalog(id).updateAccount(updated);
    const description = account.describe();
    if (emit) this.emit('event', { accountId: id, eventType: 'account-updated', payload: description });
    return description;
  }

  async refreshAccountProfile(accountId) {
    try {
      return await this.snapshot(accountId);
    } catch (_) {
      return null;
    }
  }

  listSessions(accountId) { return this.account(accountId).command('sessions:list'); }

  openSession(accountId, sessionId) { return this.listMessages(accountId, sessionId); }

  listMessages(accountId, sessionId, options = {}) {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID'));
    return this.account(accountId).command('messages:list', { sessionId, ...options });
  }

  loadMoreMessages(accountId, sessionId, fetchs = 50) {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID'));
    return this.account(accountId).command('messages:load-more', { sessionId, fetchs });
  }

  sendMessage(accountId, sessionId, message) {
    if (!sessionId) return Promise.reject(new Error('缺少会话 ID'));
    const input = typeof message === 'string' ? { type: 'text', content: message } : { ...(message || {}) };
    if (String(input.type || 'text').toLowerCase() === 'text' && !String(input.content || '').trim()) return Promise.reject(new Error('消息内容不能为空'));
    return this.account(accountId).command('messages:send', { sessionId, ...input, content: typeof input.content === 'string' ? input.content.trim() : input.content });
  }

  sendText(accountId, sessionId, text, options = {}) { return this.sendMessage(accountId, sessionId, { ...options, type: 'text', content: text }); }

  sendImage(accountId, sessionId, image) { return this.sendMessage(accountId, sessionId, { ...(image || {}), type: 'image' }); }

  sendMapCard(accountId, sessionId, card = {}) {
    const title = String(card.title || card.map_card_title || '').trim();
    const subtitle = String(card.subtitle || card.map_card_subtitle || '').trim();
    if (!title && !subtitle) return Promise.reject(new Error('地图卡片标题和副标题不能同时为空'));
    const latitude = Number(card.latitude);
    const longitude = Number(card.longitude);
    const normalizedLatitude = Number.isFinite(latitude) ? latitude.toFixed(7) : '39.9042000';
    const normalizedLongitude = Number.isFinite(longitude) ? longitude.toFixed(7) : '116.4074000';
    const locationUrl = 'https://market.m.taobao.com/app/idleFish-F2e/fish-base/pages/map-for-im/index.html'
      + `?role=consumer&latitude=${normalizedLatitude}&longitude=${normalizedLongitude}`
      + `&mainTitle=${encodeURIComponent(title)}&subTitle=${encodeURIComponent(subtitle)}`;
    const contentModel = {
      contentType: 30,
      locationCard: {
        action: {
          actionType: 4,
          page: {
            actionStyle: 0,
            actionType: 0,
            iosActionStyle: 0,
            showGuideAlways: false,
            url: locationUrl,
          },
        },
        content: subtitle,
        height: 0,
        latitude: normalizedLatitude,
        longitude: normalizedLongitude,
        showSender: false,
        title,
        url: 'https://img.alicdn.com/imgextra/i4/O1CN01t5Yxwi1vA3LNVBAWU_!!6000000006131-2-tps-300-300.png',
        width: 0,
      },
    };
    return this.sendMessage(accountId, sessionId, { type: 'location', contentModel });
  }

  productCatalog(accountId) {
    const catalog = this.productCatalogs.get(String(accountId || '').trim());
    if (!catalog) throw new Error('账号不存在');
    return catalog;
  }

  async listOnSaleProducts(accountId, options = {}) {
    const snapshot = await this.refreshAccountProfile(accountId);
    const id = String(snapshot?.accountId || accountId || '').trim();
    const account = this.repository.get(id);
    return this.productCatalog(id).listOnSaleProducts({ ...options, userId: account.userId });
  }

  listProducts(accountId, options = {}) { return this.listOnSaleProducts(accountId, options); }

  openProducts(accountId, url) { return this.productCatalog(accountId).open(true, url); }

  closeProducts(accountId) { this.productCatalog(accountId).close(); return { closed: true, accountId }; }

  handlePageMessage(sender, data) {
    for (const account of this.accounts.values()) {
      if (account.ownsSender(sender)) {
        account.handlePageMessage(data);
        return true;
      }
    }
    return false;
  }

  closeAll() {
    for (const account of this.accounts.values()) account.close();
    for (const catalog of this.productCatalogs.values()) catalog.close();
  }

  releaseIdleAccounts() {
    for (const account of this.accounts.values()) account.releaseIdleWindow();
  }

  dispose() {
    this.snapshotRequests.clear();
    this.closeAll();
    this.removeAllListeners();
  }
}

module.exports = { GoofishMessagingClient };
