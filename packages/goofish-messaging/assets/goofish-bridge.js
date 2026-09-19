(function installIdleFishBridge() {
  if (window.__idleFishBridgeInstalled) return;
  window.__idleFishBridgeInstalled = true;

  const SOURCE = 'idle-fish-bridge';
  let webpackRequire;
  let engine;
  let messageUnsubscribe;
  let statusUnsubscribe;
  let dataUnsubscribe;
  let listenerInstallPromise;
  let listenerRetryTimer;
  let bridgeReadyEmitted = false;
  let bridgeReadyRetryTimer;
  let listenersNeedRetry = true;
  let messageListenerInstalled = false;
  let statusListenerInstalled = false;
  let dataListenerInstalled = false;
  let messageOperation = Promise.resolve();
  const messageOperations = new Map();
  let sessionEventVersion = 0;
  const userInfoCache = new Map();
  // The page can expose its IM engine before its store and account identity
  // are hydrated. Keep all cold-start reads behind one budget so the first
  // product sync or session read does not mistake that state for a logout.
  const ENGINE_READY_TIMEOUT_MS = 12000;

  function emit(type, payload) {
    window.postMessage({ source: SOURCE, type: 'idle-fish:event', eventType: type, payload: serialize(payload) }, '*');
  }

  function respond(requestId, ok, result, error) {
    let message;
    if (error) {
      message = error.message || (typeof error === 'string' ? error : undefined);
      if (!message) {
        try { message = JSON.stringify(serialize(error)); } catch (_) { message = String(error); }
      }
    }
    window.postMessage({ source: SOURCE, type: 'idle-fish:response', requestId, ok, result: ok ? serialize(result) : undefined, error: message }, '*');
  }

  function serialize(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 5) return '[Object]';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return undefined;
    if (typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      if (value instanceof Map) {
        return Array.from(value.entries()).slice(0, 200).map(([key, item]) => [serialize(key, depth + 1, seen), serialize(item, depth + 1, seen)]);
      }
      if (value instanceof Set) return Array.from(value.values()).slice(0, 200).map((item) => serialize(item, depth + 1, seen));
      if (Array.isArray(value)) return value.slice(0, 200).map((item) => serialize(item, depth + 1, seen));
      const output = {};
      Object.keys(value).slice(0, 120).forEach((key) => {
        try {
          const serialized = serialize(value[key], depth + 1, seen);
          if (serialized !== undefined) output[key] = serialized;
        } catch (_) {}
      });
      return output;
    }
    return String(value);
  }

  function captureWebpack() {
    const chunk = window.webpackChunk_ice_lite_scaffold || (self && self.webpackChunk_ice_lite_scaffold);
    if (!chunk || typeof chunk.push !== 'function') return false;
    chunk.push([[`idle-fish-bridge-${Date.now()}`], {}, (require) => { webpackRequire = require; }]);
    return Boolean(webpackRequire);
  }

  function getEngineModule() {
    if (!webpackRequire) captureWebpack();
    if (!webpackRequire) throw new Error('闲鱼页面模块尚未就绪');
    const module = webpackRequire(7844);
    if (!module || !module.h || typeof module.h.getInstance !== 'function') throw new Error('闲鱼 IM 引擎接口不可用');
    return module;
  }

  async function getEngine() {
    const capturedManager = window[Symbol.for('idle-fish:engine-manager')]?.();
    if (capturedManager && (!engine || (!engine._engine && capturedManager._engine))) engine = capturedManager;
    if (!engine) engine = getEngineModule().h.getInstance();
    return engine;
  }

  function isEngineReady(current) {
    try {
      const store = readStore(current);
      return Boolean(store && idOf(current?.userId || store.userId) && current.isConnectAvailable?.());
    } catch (_) {
      return false;
    }
  }

  async function getReadyEngine(timeout = ENGINE_READY_TIMEOUT_MS) {
    const startedAt = Date.now();
    let current = await getEngine();
    while (!isEngineReady(current) && Date.now() - startedAt < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      current = await getEngine();
    }
    if (!isEngineReady(current)) throw new Error('闲鱼官方登录未生效或已过期，请在官方页面重新登录');
    return current;
  }

  async function getProfileReadyEngine(timeout = ENGINE_READY_TIMEOUT_MS) {
    const startedAt = Date.now();
    let current = await getEngine();
    while (!readStore(current) || !idOf(current.userId || readStore(current)?.userId)) {
      if (Date.now() - startedAt >= timeout) return current;
      await new Promise((resolve) => setTimeout(resolve, 150));
      current = await getEngine();
    }
    return current;
  }

  function unwrap(value) {
    if (value && typeof value === 'object' && 'data' in value) return value.data;
    return value;
  }

  async function getSessionService() { return (await getEngine()).getSessionService(); }
  async function getMessageService() { return (await getEngine()).getMessageService(); }

  function mapGet(map, key) {
    if (map instanceof Map) return map.get(key);
    return map && typeof map === 'object' ? map[key] : undefined;
  }

  function sessionKey(value) {
    return String(value || '').trim().replace(/@goofish$/i, '');
  }

  function isSameSession(left, right) {
    const leftKey = sessionKey(left);
    return Boolean(leftKey && leftKey === sessionKey(right));
  }

  function sessionMapGet(map, sessionId) {
    const direct = mapGet(map, sessionId);
    if (direct) return direct;
    const target = sessionKey(sessionId);
    if (!target) return undefined;
    if (map instanceof Map) {
      for (const [key, value] of map) {
        if (isSameSession(key, sessionId)) return value;
      }
      return undefined;
    }
    for (const [key, value] of Object.entries(map || {})) {
      if (isSameSession(key, sessionId)) return value;
    }
    return undefined;
  }

  function readStore(current) {
    try {
      return current && typeof current.getStore === 'function' ? current.getStore() : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function withTimeout(operation, timeout, fallback) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeout); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function sessionsFromStore(store) {
    if (!store || !Array.isArray(store.convIdList)) return [];
    return store.convIdList.map((sessionId) => {
      const session = sessionMapGet(store.convMap, sessionId);
      if (!session) return null;
      return { ...session, sessionId: session.sessionId || sessionId };
    }).filter((session) => session && session.visible !== false);
  }

  function idOf(value) {
    if (value == null) return '';
    if (typeof value === 'object') value = value.userId ?? value.uid ?? value.id;
    return String(value || '').split('@')[0];
  }

  function avatarOf(value, depth = 0) {
    if (depth > 2 || value == null) return '';
    if (typeof value === 'string') return value.trim().replace(/^http:/, 'https:');
    if (typeof value !== 'object') return '';
    const candidates = [
      value.avatar,
      value.avatarUrl,
      value.userAvatar,
      value.userAvatarUrl,
      value.headImg,
      value.headImgUrl,
      value.headPic,
      value.headPicUrl,
      value.headUrl,
      value.headImage,
      value.headImageUrl,
      value.headPortrait,
      value.portrait,
      value.profilePhoto,
      value.profileImage,
      value.userInfo,
      value.user,
      value.profile,
      value.account,
      value.basicInfo,
      value.userProfile,
      value.userLogo,
      value.logo,
      value.icon,
      value.url,
      value.src,
    ];
    for (const candidate of candidates) {
      const avatar = avatarOf(candidate, depth + 1);
      if (avatar) return avatar;
    }
    return '';
  }

  async function enrichSessions(sessions, current) {
    const service = await current.getUserService?.();
    if (!service || typeof service.getUserInfo !== 'function') return sessions;
    const ownId = idOf(current.userId);
    const enriched = new Array(sessions.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < sessions.length) {
        const index = cursor++;
        const session = sessions[index];
        const candidates = [session.userInfo, session.ownerInfo, session.peerUserInfo];
        const peer = candidates.find((candidate) => {
          const userId = idOf(candidate);
          return userId && userId !== ownId;
        }) || candidates.find(Boolean);
        if (!peer?.userId) { enriched[index] = session; continue; }
        const cacheKey = `${peer.type ?? 0}:${peer.userId}`;
        if (userInfoCache.has(cacheKey)) {
          enriched[index] = { ...session, peerUserInfo: { ...peer, ...userInfoCache.get(cacheKey) } };
          continue;
        }
        try {
          const result = await service.getUserInfo(peer.userId, peer.type ?? 0, session.sessionType, session.sessionId);
          const userInfo = result?.data;
          if (userInfo) userInfoCache.set(cacheKey, userInfo);
          enriched[index] = userInfo ? { ...session, peerUserInfo: { ...peer, ...userInfo } } : session;
        } catch (_) {
          enriched[index] = session;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, sessions.length) }, worker));
    return enriched;
  }

  function messagesFromStore(store, sessionId, preferFish = false) {
    if (!store) return [];
    if (sessionId && store.activeCid && !isSameSession(store.activeCid, sessionId)) return [];
    const fishIds = Array.isArray(store.fishMsgIdList) ? store.fishMsgIdList : [];
    const fishMessages = fishIds.map((messageId) => mapGet(store.fishMsgMap, messageId)).filter(Boolean);
    if (preferFish && fishMessages.length) {
      const matching = fishMessages.filter((message) => {
        const messageSessionId = message?.sessionId || message?.sessionInfo?.sessionId || message?.message?.sessionId || message?.message?.sessionInfo?.sessionId;
        return !messageSessionId || !sessionId || isSameSession(messageSessionId, sessionId);
      });
      return matching.length ? matching : fishMessages;
    }
    const messageIds = Array.isArray(store.msgIdList) ? store.msgIdList : [];
    return messageIds.map((messageId) => mapGet(store.msgMap, messageId)).filter((message) => {
      if (!message) return false;
      const messageSessionId = message.sessionId || message.sessionInfo?.sessionId || message.message?.sessionId || message.message?.sessionInfo?.sessionId;
      return !sessionId || !messageSessionId || isSameSession(messageSessionId, sessionId);
    });
  }

  function isLiteSession(session) {
    return Boolean(session?.extension && Object.prototype.hasOwnProperty.call(session.extension, '$impaas_reserved$_lite_conv'));
  }

  async function waitForStore(read, timeout = 3000) {
    const startedAt = Date.now();
    let result = read();
    while (!result.length && Date.now() - startedAt < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      result = read();
    }
    return result;
  }

  async function getSessions() {
    const current = await getReadyEngine();
    const existing = sessionsFromStore(readStore(current));
    if (existing.length) return enrichSessions(existing, current);
    const service = await getSessionService();
    await service.listSessionPagination(Number.MAX_SAFE_INTEGER, 100);
    return enrichSessions(await waitForStore(() => sessionsFromStore(readStore(current))), current);
  }

  async function getMessagesInternal(args) {
    const current = await getReadyEngine();
    const sessionService = await getSessionService();
    const initialStore = readStore(current);
    if (typeof sessionService.enterSession === 'function' && !isSameSession(initialStore?.activeCid, args.sessionId)) {
      await withTimeout(() => sessionService.enterSession(args.sessionId), 3500, undefined);
    }
    emit('session-opened', { sessionId: sessionKey(args.sessionId) });
    const session = sessionMapGet(readStore(current)?.convMap, args.sessionId);
    const lite = isLiteSession(session);
    if (lite) {
      const service = await getMessageService();
      await service.listFishMessage(args.sessionId, args.version, args.fetchs || 50);
    } else {
      const store = readStore(current);
      const existing = messagesFromStore(store, args.sessionId);
      if (!existing.length) {
        const service = await getMessageService();
        if (typeof service.listPreviousMessage === 'function' && store?.msgPrevCursor) await service.listPreviousMessage(String(store.msgPrevCursor), args.fetchs || 50);
      }
    }
    return waitForStore(() => messagesFromStore(readStore(current), args.sessionId, lite));
  }

  async function loadMoreMessages(args) {
    const current = await getReadyEngine();
    const sessionService = await getSessionService();
    const initialStore = readStore(current);
    if (typeof sessionService.enterSession === 'function' && !isSameSession(initialStore?.activeCid, args.sessionId)) {
      await withTimeout(() => sessionService.enterSession(args.sessionId), 3500, undefined);
    }
    const session = sessionMapGet(readStore(current)?.convMap, args.sessionId);
    const lite = isLiteSession(session);
    const store = readStore(current);
    const service = await getMessageService();
    const fetchs = Math.max(1, Number(args.fetchs) || 50);
    if (lite) {
      const cursor = args.version ?? store?.fishMsgPrevCursor;
      if (!cursor || store?.fishMsgPrevHasMore === false) return messagesFromStore(store, args.sessionId, true);
      await service.listFishMessage(args.sessionId, cursor, fetchs);
    } else {
      const cursor = args.cursor ?? store?.msgPrevCursor;
      if (!cursor || store?.msgPrevHasMore === false) return messagesFromStore(store, args.sessionId);
      await service.listPreviousMessage(String(cursor), fetchs);
    }
    return waitForStore(() => messagesFromStore(readStore(current), args.sessionId, lite));
  }

  function getMessages(args) {
    const key = sessionKey(args?.sessionId);
    const existing = key && messageOperations.get(key);
    if (existing) return existing;
    const operation = messageOperation.then(() => getMessagesInternal(args));
    messageOperation = operation.catch(() => {});
    if (key) {
      messageOperations.set(key, operation);
      operation.finally(() => {
        if (messageOperations.get(key) === operation) messageOperations.delete(key);
      }).catch(() => {});
    }
    return operation;
  }

  function decodeBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function imageDimensions(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    } catch (_) {
      return { width: 0, height: 0 };
    }
  }

  async function uploadImage(args) {
    const name = String(args.name || `pasted-${Date.now()}.png`).replace(/[\\/]/g, '_').slice(-120);
    const type = String(args.mime || args.type || 'image/png');
    const bytes = decodeBase64(args.data);
    if (!bytes.length) throw new Error('图片内容为空');
    const file = new File([bytes], name, { type });
    const form = new FormData();
    form.append('file', file);
    const endpoint = 'https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8';
    const response = await fetch(endpoint, { method: 'POST', body: form, credentials: 'include' });
    const result = await response.json().catch(() => null);
    const url = result?.object?.url;
    if (!response.ok || !url) throw new Error(result?.object?.reason || result?.message || `图片上传失败 (${response.status})`);
    const dimensions = await imageDimensions(file);
    return { url: String(url).replace(/^http:/, 'https:'), width: dimensions.width, height: dimensions.height, type: 0, name, size: bytes.length };
  }

  async function sendImageMessage(args) {
    if (!args?.sessionId) throw new Error('缺少 sessionId');
    const image = await uploadImage(args);
    const service = await getMessageService();
    const content = { contentType: 2, image: { pics: [{ width: image.width, height: image.height, type: image.type, url: image.url }] } };
    if (typeof service.sendMessage === 'function') {
      await service.sendMessage({ sessionId: args.sessionId, content });
      return { content, image };
    }
    throw new Error('当前闲鱼版本未暴露图片发送接口');
  }

  async function sendMessage(args) {
    if (!args?.sessionId) throw new Error('缺少 sessionId');
    const type = String(args.type || args.messageType || 'text').toLowerCase();
    const service = await getMessageService();
    const messageService = service.msgService;
    if (type === 'text') {
      const content = String(args.content ?? '').trim();
      if (!content) throw new Error('消息内容不能为空');
      if (typeof service.sendMessage === 'function') {
        return service.sendMessage({ sessionId: args.sessionId, content: { atUsers: [], contentType: 1, text: { text: content } } });
      }
      if (messageService && typeof messageService.sendTextMessage === 'function') {
        return messageService.sendMessage({
          uuid: `idle-fish-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          cid: `${args.sessionId}`.endsWith('@goofish') ? args.sessionId : `${args.sessionId}@goofish`,
          conversationType: Number(args.conversationType) || 1,
          content: { atUsers: [], contentType: 1, text: { text: content } },
          redPointPolicy: 1,
          extension: {},
          ctx: {},
          mtags: {},
          msgReadStatusSetting: 1,
        }, args.options || {});
      }
      throw new Error('当前闲鱼版本未暴露文本发送接口');
    }

    if (typeof service.sendMessage !== 'function' && (!messageService || typeof messageService.sendMessage !== 'function')) {
      throw new Error(`当前闲鱼版本未暴露 ${type} 消息发送接口`);
    }
    const content = args.contentModel || args.payload || args.content;
    if (!content || typeof content !== 'object') throw new Error(`${type} 消息需要 contentModel/payload 对象`);
    const contentType = { emoji: 5, image: 2, photo: 2, item: 26, product: 26, location: 7, geo: 7 }[type];
    const model = content.contentType ? content : { ...content, contentType: contentType || content.contentType };
    if (!model.contentType) throw new Error(`不支持的消息类型: ${type}`);
    if (typeof service.sendMessage === 'function') return service.sendMessage({ sessionId: args.sessionId, content: model });
    return messageService.sendMessage({
      uuid: `idle-fish-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cid: `${args.sessionId}`.endsWith('@goofish') ? args.sessionId : `${args.sessionId}@goofish`,
      conversationType: Number(args.conversationType) || 1,
      content: model,
      redPointPolicy: 1,
      extension: {},
      ctx: {},
      mtags: {},
      msgReadStatusSetting: 1,
    }, args.options || {});
  }

  async function snapshot() {
    // bridge-ready only confirms that the IM engine was found. Its store and
    // account identity commonly appear a little later on a cold WebView
    // startup, so wait for those before reporting the login state.
    const current = await getProfileReadyEngine();
    let connectionStatus = 'unknown';
    try {
      const checkedEngine = await withTimeout(
        () => current.getEngineWithoutCheck?.(),
        1200,
        current,
      );
      connectionStatus = await withTimeout(
        () => checkedEngine?.getConnectionStatus?.(),
        800,
        'unknown',
      );
    } catch (_) {}
    const userId = idOf(current.userId || readStore(current)?.userId);
    let profile = {};
    try {
      const service = await withTimeout(() => current.getUserService?.(), 1200, undefined);
      const result = userId && service?.getUserInfo
        ? await withTimeout(() => service.getUserInfo(userId, 0, 1, ''), 1800, undefined)
        : undefined;
      profile = result?.data && typeof result.data === 'object' ? result.data : {};
    } catch (_) {}
    const fishNick = typeof profile.fishNick === 'string' ? profile.fishNick.trim() : '';
    const nick = typeof profile.nick === 'string' ? profile.nick.trim() : '';
    let pageNick = '';
    if (!fishNick && !nick) {
      try {
        const node = [...document.querySelectorAll('[class]')].find((item) =>
          typeof item.className === 'string' && item.className.split(/\s+/).some((name) => name.startsWith('nick--')),
        );
        pageNick = typeof node?.textContent === 'string' ? node.textContent.trim() : '';
      } catch (_) {}
    }
    return {
      connectionStatus,
      connected: Boolean(current.isConnectAvailable?.()),
      authenticated: Boolean(readStore(current) && userId),
      userId,
      fishNick,
      nickname: fishNick || nick || pageNick,
      avatar: avatarOf(profile),
      href: location.href,
    };
  }

  async function installListeners() {
    if (!listenersNeedRetry) return;
    if (listenerInstallPromise) return listenerInstallPromise;
    listenerInstallPromise = (async () => {
      const current = await getEngine();
      if (!readStore(current)) throw new Error('闲鱼 IM engine 尚未完成初始化');
      const failures = [];
      const registerMessageListener = current.registerMessageChangeLisnter || current.registerMessageChangeListener;
      if (!messageListenerInstalled) {
        if (typeof registerMessageListener !== 'function') {
          failures.push(new Error('闲鱼消息监听接口尚未就绪'));
        } else {
          try {
            messageUnsubscribe = await registerMessageListener.call(current, {
              onAdd: (message) => emit('message-added', message),
              onLocalRemove: (message) => emit('message-removed', message),
            });
            messageListenerInstalled = true;
          } catch (error) { failures.push(error); }
        }
      }
      if (!statusListenerInstalled) {
        const registerStatusListener = current.registerConnectStatusChangeLisnter || current.registerConnectStatusChangeListener;
        if (typeof registerStatusListener !== 'function') {
          failures.push(new Error('闲鱼连接状态监听接口尚未就绪'));
        } else {
          try {
            statusUnsubscribe = registerStatusListener.call(current, {
              onChange: (status) => emit('connection-changed', status),
              onClose: (status) => emit('connection-closed', status),
              onError: (status) => emit('connection-error', status),
            });
            statusListenerInstalled = true;
          } catch (error) { failures.push(error); }
        }
      }
      if (!dataListenerInstalled) {
        const registerDataListener = current.registerDataChangeLisnter || current.registerDataChangeListener;
        if (typeof registerDataListener !== 'function') {
          failures.push(new Error('闲鱼数据监听接口尚未就绪'));
        } else {
          try {
            dataUnsubscribe = await registerDataListener.call(current, (store) => {
              const activeSessionId = sessionKey(store?.activeCid);
              if (activeSessionId) emit('session-opened', { sessionId: activeSessionId });
              const version = ++sessionEventVersion;
              enrichSessions(sessionsFromStore(store), current).then((sessions) => {
                if (version === sessionEventVersion) emit('sessions-changed', sessions);
              }).catch(() => {});
            });
            dataListenerInstalled = true;
          } catch (error) { failures.push(error); }
        }
      }
      listenersNeedRetry = failures.length > 0;
      if (failures.length) throw failures[0];
    })().finally(() => {
      listenerInstallPromise = undefined;
    });
    return listenerInstallPromise;
  }

  function scheduleListenerInstall(delay = 250) {
    if (listenerRetryTimer || !listenersNeedRetry) return;
    listenerRetryTimer = setTimeout(() => {
      listenerRetryTimer = undefined;
      installListeners().catch(() => scheduleListenerInstall(1000));
    }, delay);
  }

  function announceBridgeReady() {
    if (bridgeReadyEmitted) return;
    getReadyEngine().then(() => {
      if (!bridgeReadyEmitted) {
        bridgeReadyEmitted = true;
        emit('bridge-ready', { version: 3 });
      }
    }).catch(() => {
      if (bridgeReadyRetryTimer) return;
      bridgeReadyRetryTimer = setTimeout(() => {
        bridgeReadyRetryTimer = undefined;
        announceBridgeReady();
      }, 500);
    });
  }

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.source !== 'idle-fish-host' || !data.requestId) return;
    try {
      let result;
      if (data.command === 'sessions:list') result = await getSessions();
      else if (data.command === 'messages:list') result = await getMessages(data.args || {});
      else if (data.command === 'messages:send') result = String(data.args?.type || 'text').toLowerCase() === 'image' ? await sendImageMessage(data.args || {}) : await sendMessage(data.args || {});
      else if (data.command === 'messages:load-more') result = await loadMoreMessages(data.args || {});
      else if (data.command === 'snapshot') result = await snapshot();
      else throw new Error(`未知桥接命令: ${data.command}`);
      respond(data.requestId, true, result);
      installListeners().catch(() => {});
    } catch (error) {
      respond(data.requestId, false, undefined, error);
    }
  });

  window.__idleFishBridge = Object.freeze({ version: 3, commands: ['sessions:list', 'messages:list', 'messages:send', 'messages:load-more', 'snapshot'] });
  // Bridge readiness means the IM store, seller identity, and connection are
  // all usable. Listener registration is retried independently because one
  // registration method can be temporarily unavailable while others work.
  announceBridgeReady();
  installListeners().catch(() => scheduleListenerInstall());
})();
