import type { HookPackageManifest, PlatformCapability } from './types.js'

export const kuaishouCapabilities: PlatformCapability[] = [
  'messages.listen', 'messages.history', 'messages.send', 'messages.file', 'sessions.list',
  'products.collect', 'products.detail', 'orders.read', 'orders.listen', 'session.transfer',
]

const hookVersion = '1.2.5'

/**
 * 快手小店 Hook 只通过页面 window runtime 工作。
 * 不读取 document、不操作元素、不拦截网络；认证由用户在官方页面完成。
 */
export const kuaishouHookScript = String.raw`(() => {
  const QUEUE_KEY = '__platformHub'
  const HOOK_VERSION = ${JSON.stringify(hookVersion)}
  const existing = window[QUEUE_KEY]
  if (existing && existing.__version === HOOK_VERSION) return
  try { existing?.dispose?.() } catch (_) {}

  const queue = []
  const methodCache = new Map()
  const subscriptions = []
  const primedSessions = new Set()
  const seenIds = new Set()
  const seenFingerprints = new Set()
  const seenOrderKeys = new Set()
  const waterlines = new Map()
  const watchedOrderUsers = new Map()
  const orderSnapshots = new Map()
  const pendingSentTexts = new Map()
  let pollTimer = null
  let orderPollTimer = null
  let orderPollBusy = false
  let messagesBound = false
  let listeningStartedAt = 0
  let disposed = false
  const ORDER_WATCH_MAX = 50
  const ORDER_WATCH_TTL_MS = 30 * 60 * 1000
  const ORDER_ACTIVE_WINDOW_MS = 2 * 60 * 1000
  const ORDER_ACTIVE_INTERVAL_MS = 5 * 1000
  const ORDER_IDLE_INTERVAL_MS = 30 * 1000
  const ORDER_POLL_TICK_MS = 1000
  const ORDER_POLL_BATCH_SIZE = 1
  const SENT_TEXT_TTL_MS = 30 * 1000
  const SENT_TEXT_MAX = 100
  let pendingSentSequence = 0

  const aliases = {
    getAuthState: ['getAuthState', 'getLoginState', 'getUserInfo', 'getCurrentUser', 'getShopInfo'],
    collectProducts: ['collectProducts', 'listProducts', 'getProducts', 'getProductList', 'listGoods', 'getGoodsList'],
    getProductDetail: ['getProductDetail', 'productDetail', 'getGoodsDetail', 'queryProduct', 'queryGoods'],
    listSessions: ['listSessions', 'getSessions', 'getSessionList', 'getConversationList', 'listConversations'],
    listMessages: ['listMessages', 'getMessages', 'getMessageList', 'getHistoryMessages'],
    sendMessage: ['sendTextMsg', 'sendTextMessage', 'sendText', 'sendMessage', 'sendMsg'],
    uploadFile: ['uploadFile', 'uploadImage', 'uploadMedia'],
    sendFile: ['sendImageMsg', 'sendFile', 'sendImage', 'sendMedia'],
    getOrders: ['getOrders', 'queryOrders', 'getOrderList', 'listOrders'],
    transferSession: ['transferSession', 'transferConversation', 'assignConversation', 'batchTransferSessions'],
    subscribeMessages: ['subscribeMessages', 'onMessage', 'subscribeMessage', 'watchMessages'],
  }

  function safeValue(owner, key) {
    try { return owner?.[key] } catch (_) { return undefined }
  }

  function safeKeys(value) {
    try { return Object.getOwnPropertyNames(value).slice(0, 160) } catch (_) { return [] }
  }

  function collectionValues(value) {
    if (!value) return []
    if (Array.isArray(value)) return value.slice(0, 500)
    try { if (typeof value.values === 'function') return Array.from(value.values()).slice(0, 500) } catch (_) {}
    try { return Object.values(value).slice(0, 500) } catch (_) { return [] }
  }

  function pickArray(value) {
    if (Array.isArray(value)) return value
    for (const key of ['list', 'items', 'records', 'rows', 'data', 'result', 'products', 'goodsList', 'dataSource', 'itemInfo', 'itemList', 'orderInfoList']) {
      const nested = safeValue(value, key)
      if (Array.isArray(nested)) return nested
      if (nested && typeof nested === 'object') {
        for (const child of ['list', 'items', 'records', 'rows', 'products', 'goodsList', 'dataSource', 'itemInfo', 'itemList', 'orderInfoList']) {
          if (Array.isArray(safeValue(nested, child))) return safeValue(nested, child)
        }
      }
    }
    return []
  }

  function snapshot(value) {
    if (value == null) return value
    try { return typeof value.toJSON === 'function' ? value.toJSON() : JSON.parse(JSON.stringify(value)) } catch (_) { return value }
  }

  function parseJson(value) {
    if (!value || typeof value === 'object') return value || null
    try { return JSON.parse(value) } catch (_) { return null }
  }

  function idValue(value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') {
      try {
        const converted = value.toString?.()
        if (converted && converted !== '[object Object]') return String(converted)
      } catch (_) {}
    }
    const text = String(value).trim()
    return text === 'undefined' || text === 'null' ? '' : text
  }

  function jsonIntegerString(value, key) {
    if (typeof value === 'string') {
      const match = value.match(new RegExp('"' + key + '"\\s*:\\s*"?([0-9]+)"?'))
      if (match) return match[1]
    }
    return idValue(parseJson(value)?.[key])
  }

  function unixMilliseconds(value) {
    const number = Number(value || 0)
    if (!Number.isFinite(number) || number <= 0) return Date.now()
    return number < 100000000000 ? number * 1000 : number
  }

  function responseData(value) {
    const first = value?.data ?? value
    return first?.data ?? first
  }

  function scopes() {
    const result = [{ value: window, path: 'window' }]
    try {
      const count = Math.min(Number(window.frames?.length || 0), 12)
      for (let index = 0; index < count; index += 1) {
        try { result.push({ value: window.frames[index], path: 'window.frames[' + index + ']' }) } catch (_) {}
      }
    } catch (_) {}
    return result
  }

  function rootObjects() {
    const roots = []
    const seen = new Set()
    const knownNames = [
      '__chat_sdk', '__CHAT_SDK__', '__KS_IM__', '__KUAISHOU_SDK__', '__INITIAL_STATE__',
      '__STORE__', 'store', 'app', 'kuaishou', 'kuaishouSDK', 'kwai', 'ksShop', 'containerSdk',
    ]
    const add = (value, path) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return
      seen.add(value); roots.push({ value, path, depth: 0 })
    }
    for (const scope of scopes()) {
      for (const name of knownNames) add(safeValue(scope.value, name), scope.path + '.' + name)
      let names = []
      try { names = Object.getOwnPropertyNames(scope.value) } catch (_) {}
      for (const name of names) {
        if (!/(chat|sdk|store|service|message|session|goods|product|order|shop|kwai|kuaishou)/i.test(name)) continue
        add(safeValue(scope.value, name), scope.path + '.' + name)
        if (roots.length >= 160) break
      }
    }
    return roots
  }

  function runtimeObjects() {
    const pending = rootObjects()
    const output = []
    const seen = new Set()
    while (pending.length && output.length < 1200) {
      const item = pending.shift()
      const value = item?.value
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
      seen.add(value)
      const keys = safeKeys(value)
      output.push({ value, path: item.path, depth: item.depth, keys })
      if (item.depth >= 3) continue
      for (const key of keys) {
        if (!/(chat|sdk|store|service|message|session|conversation|goods|product|order|shop|provider|current|client|api)/i.test(key)) continue
        const child = safeValue(value, key)
        if (child && (typeof child === 'object' || typeof child === 'function')) {
          pending.push({ value: child, path: item.path + '.' + key, depth: item.depth + 1 })
        }
      }
    }
    return output
  }

  function locateRuntime() {
    return runtimeObjects().map((item) => {
      const methods = item.keys.filter((key) => typeof safeValue(item.value, key) === 'function')
      const methodText = methods.join('|')
      const score = (item.path.match(/chat|sdk|store|message|session|product|order/gi) || []).length * 4
        + aliases.sendMessage.filter((name) => methods.includes(name)).length * 20
        + aliases.listMessages.filter((name) => methods.includes(name)).length * 16
        + (/currentSessionMessageListStore/.test(item.keys.join('|')) ? 30 : 0)
        + (/send|message|session|goods|product|order/i.test(methodText) ? 8 : 0)
      return { path: item.path, methods, score }
    }).filter((item) => item.methods.length || item.score >= 20).sort((a, b) => b.score - a.score)
  }

  function findMethod(capability) {
    const cached = methodCache.get(capability)
    if (cached && typeof cached.fn === 'function') return cached
    for (const item of runtimeObjects()) {
      for (const name of aliases[capability] || [capability]) {
        const fn = safeValue(item.value, name)
        if (typeof fn === 'function') {
          const found = { owner: item.value, fn, name, path: item.path + '.' + name }
          methodCache.set(capability, found)
          return found
        }
      }
    }
    return null
  }

  async function invokeMethod(capability, args) {
    let method = findMethod(capability)
    if (!method) return { unavailable: true }
    try { return { value: await method.fn.apply(method.owner, args), path: method.path } } catch (error) {
      methodCache.delete(capability)
      method = findMethod(capability)
      if (!method) throw error
      return { value: await method.fn.apply(method.owner, args), path: method.path }
    }
  }

  function getChatSdk() {
    for (const scope of scopes()) {
      for (const name of ['__chat_sdk', '__CHAT_SDK__', '__KS_IM__', '__KUAISHOU_SDK__']) {
        const sdk = safeValue(scope.value, name)
        if (sdk && typeof sdk === 'object') return sdk
      }
    }
    for (const item of runtimeObjects()) {
      const value = item.value
      if (safeValue(value, 'currentSessionMessageListStore') || (safeValue(value, 'appInfo') && safeValue(value, 'chatSdk'))) return value.chatSdk || value
    }
    return null
  }

  function identity() {
    const sdk = getChatSdk()
    const login = snapshot(safeValue(safeValue(sdk, 'appInfo'), 'extraLoginInfo')) || {}
    const user = snapshot(safeValue(sdk, 'currentUser')) || snapshot(safeValue(sdk, 'userInfo')) || {}
    return {
      shopId: idValue(login.shopId || login.shop_id || user.shopId || user.shop_id),
      userId: idValue(login.userId || login.user_id || login.sellerId || user.userId || user.uid || user.id),
      name: String(login.shopName || login.userName || user.nickname || user.name || ''),
    }
  }

  async function auth() {
    const host = String(window.location?.hostname || '')
    const path = String(window.location?.pathname || '')
    if (host === 'login.kwaixiaodian.com' || /not-login|\/login(?:\/|$)/i.test(path)) {
      return { authenticated: false, errorCode: 'LOGIN_REQUIRED' }
    }
    const current = identity()
    // The chat SDK shell is present on the public/login route too. Its mere
    // existence must not be treated as a successful login; wait for an
    // identity (or an explicit auth method) before allowing business calls.
    if (current.shopId || current.userId) return { authenticated: true, ...current }
    const method = findMethod('getAuthState')
    if (method) {
      try {
        const value = snapshot(await method.fn.call(method.owner)) || {}
        const authenticated = value.authenticated === true || value.isLogin === true || value.loggedIn === true || Boolean(value.shopId || value.userId || value.id)
        return { ...value, authenticated, errorCode: authenticated ? undefined : 'LOGIN_REQUIRED' }
      } catch (_) {}
    }
    const hasRuntime = runtimeObjects().length > 0
    return { authenticated: false, errorCode: hasRuntime ? 'LOGIN_REQUIRED' : 'RUNTIME_NOT_READY' }
  }

  async function requireLogin(capability, ...args) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    try {
      const result = await invokeMethod(capability, args)
      if (result.unavailable) return { success: false, errorCode: 'CAPABILITY_UNAVAILABLE', error: '快手页面尚未暴露 ' + capability + ' 能力' }
      return result.value
    } catch (error) {
      return { success: false, errorCode: 'RUNTIME_ERROR', error: String(error?.message || error) }
    }
  }

  function messageCollections(store) {
    const output = []
    const seen = new Set()
    const add = (value) => {
      for (const row of collectionValues(value)) {
        if (!row || typeof row !== 'object' || seen.has(row)) continue
        seen.add(row); output.push(row)
      }
    }
    for (const key of ['messages', 'messageList', 'msgList', 'list', 'currentMessages', 'sortedMessages', 'visibleMessages']) add(safeValue(store, key))
    for (const key of ['currentSessionMessageListStore', 'messageStore', 'messagesStore', 'store']) {
      const nested = safeValue(store, key)
      if (nested && nested !== store) {
        for (const child of ['messages', 'messageList', 'msgList', 'list', 'currentMessages', 'sortedMessages', 'visibleMessages']) add(safeValue(nested, child))
      }
    }
    return output.slice(0, 2000)
  }

  function messageStores() {
    const output = []
    const seen = new Set()
    const add = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      if (!messageCollections(value).length && !safeValue(value, 'providerMap') && !safeValue(value, 'currentSessionMessageListStore')) return
      seen.add(value); output.push(value)
    }
    const sdk = getChatSdk()
    add(safeValue(sdk, 'currentSessionMessageListStore'))
    add(sdk)
    for (const item of runtimeObjects()) {
      if (output.length >= 40) break
      add(item.value)
    }
    return output
  }

  function sessionMap() {
    const sdk = getChatSdk()
    return sdk?.sessionModel?.sessionAllModel?.allSessionMap || sdk?.sessionModel?.allSessionsMap || sdk?.sessionModel?.sessionMap || null
  }

  function sessionRecord(sessionId) {
    const source = sessionMap()
    try { if (typeof source?.get === 'function') return source.get(String(sessionId)) || source.get(Number(sessionId)) } catch (_) {}
    return safeValue(source, String(sessionId)) || null
  }

  function currentSessionId() {
    const sdk = getChatSdk()
    const store = sdk?.currentSessionMessageListStore
    let active
    try { active = sdk?.store?.get?.('chatTargetSession') } catch (_) {}
    return idValue(store?.session?.targetId || store?.session?.rawSession?.targetId || store?.session?.cachedSession?.targetId || active?.targetId)
  }

  async function selectSession(sessionId) {
    const sdk = getChatSdk()
    if (!sdk) return null
    if (currentSessionId() === String(sessionId) && sdk.currentSessionMessageListStore) return sdk.currentSessionMessageListStore
    const session = sessionRecord(sessionId)
    if (!session || typeof sdk.chatWithTarget !== 'function') return null
    sdk.chatWithTarget({ targetSession: session })
    const started = Date.now()
    while (Date.now() - started < 8000) {
      const store = sdk.currentSessionMessageListStore
      if (store && currentSessionId() === String(sessionId)) return store
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  }

  function rawMessageId(value, kMsg, rawMsg) {
    return idValue(rawMsg?.id || rawMsg?.messageId || kMsg?.id || kMsg?.msgId || value?.messageId || value?.id)
  }

  function peerId(value, kMsg, rawMsg) {
    const direct = idValue(rawMsg?.sessionTargetId || rawMsg?.targetId || kMsg?.sessionTargetId || value?.sessionTargetId || value?.conversationId || value?.sessionId)
    if (direct) return direct
    const parts = idValue(kMsg?.id).split('_').filter(Boolean)
    return parts.length >= 2 ? parts[1] : idValue(value?.provider?.userId || rawMsg?.fromUserId || kMsg?.fromUserId)
  }

  function prunePendingSentTexts(now = Date.now()) {
    for (const [token, pending] of pendingSentTexts) {
      if (now - Number(pending.createdAt || 0) >= SENT_TEXT_TTL_MS) pendingSentTexts.delete(token)
    }
    const overflow = pendingSentTexts.size - SENT_TEXT_MAX
    if (overflow <= 0) return
    const oldest = [...pendingSentTexts.entries()]
      .sort((left, right) => Number(left[1].createdAt || 0) - Number(right[1].createdAt || 0))
      .slice(0, overflow)
    for (const [token] of oldest) pendingSentTexts.delete(token)
  }

  function rememberSentText(sessionId, content) {
    const pending = {
      token: 'sent-text-' + (++pendingSentSequence),
      sessionId: idValue(sessionId),
      content: String(content || ''),
      createdAt: Date.now(),
      messageId: '',
    }
    pendingSentTexts.set(pending.token, pending)
    prunePendingSentTexts(pending.createdAt)
    return pending
  }

  function forgetSentText(pending) {
    if (pending?.token) pendingSentTexts.delete(pending.token)
  }

  function pendingTextForMessage(messageId, sessionId, timestamp) {
    const now = Date.now()
    prunePendingSentTexts(now)
    let match = null
    let distance = Number.POSITIVE_INFINITY
    for (const pending of pendingSentTexts.values()) {
      if (pending.sessionId !== String(sessionId)) continue
      if (messageId && pending.messageId === messageId) { match = pending; break }
      const currentDistance = Math.abs(Number(timestamp || now) - Number(pending.createdAt || now))
      if (currentDistance <= SENT_TEXT_TTL_MS && currentDistance < distance) {
        match = pending
        distance = currentDistance
      }
    }
    if (!match) return ''
    if (messageId && !match.messageId) match.messageId = messageId
    return match.content
  }

  function messageText(value, kMsg, rawMsg, meta) {
    const encodedContent = parseJson(kMsg?.eContent) || kMsg?.eContent || parseJson(rawMsg?.content) || rawMsg?.content || parseJson(value?.content) || value?.content || {}
    const fields = parseJson(encodedContent?.fields) || encodedContent?.fields || {}
    const candidates = [
      kMsg?.text,
      rawMsg?.text,
      rawMsg?.title,
      value?.text,
      value?.title,
      typeof kMsg?.content === 'string' ? kMsg.content : '',
      encodedContent?.text,
      typeof encodedContent?.content === 'string' ? encodedContent.content : '',
      encodedContent?.message,
      fields?.text,
      typeof fields?.content === 'string' ? fields.content : '',
      fields?.message,
    ]
    const direct = candidates.find((candidate) => typeof candidate === 'string' && candidate.length)
    if (direct) return direct
    return meta.isMine ? pendingTextForMessage(meta.id, meta.sessionId, meta.timestamp) : ''
  }

  function productFromMessage(value, kMsg) {
    const content = parseJson(kMsg?.eContent) || kMsg?.eContent || parseJson(value?.content) || {}
    let fields = parseJson(content?.fields) || content?.fields || {}
    if (fields?.content) fields = { ...fields, ...fields.content }
    const type = Number(value?.eMessageType ?? value?.messageType ?? value?.msgType)
    const itemDetailUrl = String(content?.itemDetailUrl || fields?.itemDetailUrl || '')
    const itemDetailId = itemDetailUrl.match(/[?&](?:itemId|goodsId|productId)=([^&#]+)/i)?.[1] || ''
    const itemId = idValue(content?.itemId || fields?.itemId || fields?.goodsId || fields?.productId || itemDetailId)
    const looksLikeProduct = type === 2000 || Boolean(itemId && (content?.itemTitle || fields?.itemTitle || fields?.title || content?.itemImg || fields?.itemPicUrl))
    if (!looksLikeProduct || !itemId) return null
    const shopId = identity().shopId
    const priceText = String(content?.itemPrice ?? fields?.itemPrice ?? fields?.description ?? '0').replace(/[¥￥,]/g, '')
    return {
      id: 'kuaishou-shop;' + shopId + ';' + itemId,
      goodsId: itemId,
      name: String(content?.itemTitle || fields?.itemTitle || fields?.title || kMsg?.text || '商品'),
      price: Number(priceText) || 0,
      images: [content?.itemImg || fields?.itemPicUrl || fields?.image].filter(Boolean).map(String),
      goodsUrl: itemDetailUrl || 'https://app.kwaixiaodian.com/merchant/shop/detail?id=' + itemId,
      shopId,
      platform: 'kuaishou-shop',
      raw: { eMessageType: type },
    }
  }

  function orderFromMessage(value, kMsg) {
    const content = parseJson(kMsg?.eContent) || kMsg?.eContent || parseJson(value?.content) || {}
    const fields = parseJson(content?.fields) || content?.fields || content
    const orderId = idValue(fields?.orderId || fields?.order_id || fields?.oid || jsonIntegerString(content?.fields, 'orderId'))
    const typeText = String(content?.type || content?.cardType || fields?.type || '')
    if (!orderId || (!/order/i.test(typeText) && !fields?.orderStatus && !fields?.order_status && !fields?.oid)) return null
    const shopId = identity().shopId
    const rawAmount = fields?.payAmount ?? fields?.totalAmount ?? fields?.paymentInfo?.price
    const amount = Number(String(rawAmount ?? '').replace(/[¥￥,]/g, ''))
    return {
      id: 'kuaishou-shop;' + shopId + ';' + orderId,
      orderId,
      skuOrderId: idValue(fields?.skuOrderId || fields?.sku_order_id) || undefined,
      status: String(fields?.orderStatusDesc || fields?.statusDesc || fields?.orderStatus || fields?.order_status || ''),
      totalAmount: Number.isFinite(amount) ? amount : undefined,
      quantity: Number(fields?.quantity || fields?.num || fields?.itemCount || 0) || undefined,
      productId: idValue(fields?.itemId || fields?.goodsId || fields?.productId) || undefined,
      productName: String(fields?.itemTitle || fields?.goodsName || fields?.productName || ''),
      productImage: fields?.itemPicUrl || fields?.image || undefined,
      orderUrl: fields?.jumpUrl || fields?.url || undefined,
      shopId,
      platform: 'kuaishou-shop',
      raw: { cardType: typeText },
    }
  }

  function normalizeMessage(raw) {
    const value = safeValue(raw, 'message') || safeValue(raw, 'data') || safeValue(raw, 'payload') || raw
    if (!value || typeof value !== 'object') return null
    const kMsg = safeValue(value, 'kMsg') || safeValue(value, 'rawMessage') || value
    const rawMsg = safeValue(kMsg, 'rawMsg') || (safeValue(value, 'sessionTargetId') ? value : {})
    const id = rawMessageId(value, kMsg, rawMsg)
    const sessionId = peerId(value, kMsg, rawMsg)
    if (!id || !sessionId) return null
    const senderId = idValue(rawMsg.fromUserId || kMsg.fromUserId || value.fromUserId || value.senderId || value.provider?.userId)
    const seller = identity()
    const typeNumber = Number(value.eMessageType ?? value.messageType ?? value.msgType)
    const order = orderFromMessage(value, kMsg)
    const product = order ? null : productFromMessage(value, kMsg)
    const isSystem = typeNumber === 10 || typeNumber === 1000000
    const isMine = !isSystem && (value.isMine === true || rawMsg.isMine === true || (senderId && senderId !== sessionId && (senderId === seller.userId || senderId === seller.shopId)))
    const timestamp = unixMilliseconds(rawMsg.timestampMs || rawMsg.timestamp || kMsg.timestampMs || kMsg.createTime || value.timestamp || value.createTime)
    const text = messageText(value, kMsg, rawMsg, { id, sessionId, isMine, timestamp })
    return {
      id,
      sessionId,
      senderId,
      senderName: String(isSystem ? '系统' : value.provider?.nickname || value.provider?.name || value.senderName || (isMine ? seller.name : '') || sessionId),
      content: typeof text === 'string' ? text : String(text || ''),
      type: order ? 'order' : product ? 'product' : isSystem ? 'system' : typeNumber === 1 ? 'image' : 'text',
      isMine,
      timestamp,
      avatar: value.provider?.avatar || value.avatar || undefined,
      order: order || undefined,
      product: product || undefined,
    }
  }

  function allMessages(sessionId) {
    const result = []
    const ids = new Set()
    for (const store of messageStores()) {
      for (const raw of messageCollections(store)) {
        const message = normalizeMessage(raw)
        if (!message || ids.has(message.id) || (sessionId && message.sessionId !== String(sessionId))) continue
        ids.add(message.id); result.push(message)
      }
    }
    return result.sort((a, b) => a.timestamp - b.timestamp)
  }

  function normalizeSession(item) {
    const id = idValue(item?.sessionTargetId || item?.conversationId || item?.sessionId || item?.targetId || item?.buyerId || item?.userId || item?.id)
    if (!id) return null
    const last = item?.lastMessage || item?.latestMessage || item?.lastMsg || {}
    const updatedAt = Number(last?.timestampMs || last?.timestamp || item?.activeTime || item?.updateTime || item?.updatedAt || 0)
    return {
      id,
      title: String(item?.nickname || item?.userName || item?.buyerName || item?.title || item?.name || id),
      unread: Number(item?.unreadCount || item?.unread || item?.badge || 0),
      lastMessage: String(last?.text || last?.content || item?.lastMessageText || (typeof last === 'string' ? last : '')),
      avatar: item?.avatar || item?.headUrl || item?.userAvatar || undefined,
      updatedAt: updatedAt ? unixMilliseconds(updatedAt) : undefined,
    }
  }

  function nativeSessions() {
    const result = new Map()
    for (const row of collectionValues(sessionMap())) {
      const normalized = normalizeSession(snapshot(row))
      if (normalized) result.set(normalized.id, normalized)
    }
    if (!result.size) {
      for (const item of runtimeObjects()) {
        for (const key of ['sessions', 'sessionList', 'conversationList', 'conversations', 'recentSessions']) {
          for (const row of collectionValues(safeValue(item.value, key))) {
            const normalized = normalizeSession(snapshot(row))
            if (normalized) result.set(normalized.id, normalized)
          }
        }
      }
    }
    for (const message of allMessages()) {
      const current = result.get(message.sessionId)
      if (!current || Number(current.updatedAt || 0) <= message.timestamp) {
        result.set(message.sessionId, { ...current, id: message.sessionId, title: current?.title || (!message.isMine ? message.senderName : '') || message.sessionId, unread: current?.unread || 0, lastMessage: message.content, avatar: current?.avatar || message.avatar, updatedAt: message.timestamp })
      }
    }
    return Array.from(result.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  }

  function normalizeProduct(item) {
    const goodsId = idValue(item?.itemId || item?.item_id || item?.goodsId || item?.goods_id || item?.productId || item?.product_id || item?.id)
    const shopId = idValue(item?.shopId || item?.shop_id || identity().shopId)
    // getGoodsListNew has returned both the chat-side item shape and the
    // catalog-side dataSource shape over time. Keep all parsing here so the
    // host only sees one ProductRecord contract.
    const title = item?.itemDesc?.title?.text || item?.itemDesc?.title || item?.itemProfile?.title
    const priceList = pickArray(item?.managerPrice?.price || item?.priceList || item?.prices)
    const priceSource = item?.itemPrice ?? item?.price ?? item?.salePrice ?? item?.minPrice ?? priceList[0] ?? item?.managerPrice?.price?.[0] ?? 0
    // The catalog managerPrice.price field is already in yuan (the legacy
    // Hook mapped it with parseFloat), while chat-side min/max prices may be
    // returned in cents. Do not scale managerPrice implicitly.
    const hasCentPrice = item?.minPrice != null || item?.maxPrice != null
    const divisor = hasCentPrice ? 100 : (Number(priceSource) > 100000 && !String(priceSource).includes('.') ? 100 : 1)
    const images = pickArray(item?.images || item?.imageUrls || item?.imageList || item?.pics || item?.itemDesc?.mainImage).map((image) => String(image?.url || image)).filter(Boolean)
    const primary = item?.itemImg || item?.image || item?.coverUrl || item?.picUrl || item?.itemDesc?.mainImage?.[0]
    if (primary && !images.includes(String(primary))) images.unshift(String(primary))
    return {
      id: 'kuaishou-shop;' + shopId + ';' + goodsId,
      goodsId,
      name: String(item?.itemTitle || item?.title || item?.goodsName || item?.productName || item?.name || title || ''),
      price: Number(priceSource) / divisor || 0,
      originalPrice: Number(item?.originalPrice || item?.marketPrice || 0) / divisor || undefined,
      stockQuantity: Number(item?.stock || item?.stockQuantity || item?.inventory || 0) || undefined,
      status: String(item?.statusDesc || item?.status || item?.state || ''),
      images,
      goodsUrl: item?.itemUrl?.link || item?.itemUrl || item?.itemDetailUrl?.link || item?.itemDetailUrl || item?.detailUrl || item?.goodsUrl || (goodsId
        ? (item?.itemDesc ? 'https://app.kwaixiaodian.com/web/kwaishop-goods-detail-page-app?id=' + goodsId : 'https://s.kwaixiaodian.com/zone/goods/detail?id=' + goodsId)
        : undefined),
      editUrl: item?.editUrl || (goodsId ? 'https://s.kwaixiaodian.com/zone/goods/config/release/detail?itemId=' + goodsId : undefined),
      shopId,
      platform: 'kuaishou-shop',
      createTime: item?.createTime || item?.createdAt || undefined,
      description: item?.description || item?.desc || undefined,
      skuList: pickArray(item?.skuList || item?.skus).map((sku) => ({
        skuId: idValue(sku?.skuId || sku?.id),
        skuName: String(sku?.skuName || sku?.spec || sku?.name || ''),
        skuPrice: Number(sku?.skuPrice ?? sku?.price ?? 0) / divisor,
      })),
      raw: { sellerId: idValue(item?.sellerId), triggerType: item?.triggerType, maxPrice: item?.maxPrice },
    }
  }

  function stateProducts() {
    const result = new Map()
    for (const item of runtimeObjects()) {
      for (const key of ['products', 'productList', 'goods', 'goodsList', 'items', 'itemList', 'dataSource', 'itemInfo']) {
        for (const row of collectionValues(safeValue(item.value, key))) {
          const value = snapshot(row)
          if (!value || typeof value !== 'object') continue
          const product = normalizeProduct(value)
          if (product.goodsId && product.name) result.set(product.goodsId, product)
        }
      }
    }
    return Array.from(result.values())
  }

  function normalizeOrder(item) {
    const alreadyNormalized = item?.platform === 'kuaishou-shop' && item?.orderId
    const base = item?.orderBaseInfo || item?.baseInfo || item
    const goods = item?.itemAndPriceInfo || item?.goodsInfo || item?.item || {}
    const orderId = idValue(base?.oid || base?.orderId || base?.order_id || item?.oid || item?.orderId)
    const shopId = idValue(base?.shopId || item?.shopId || identity().shopId)
    if (alreadyNormalized) {
      return {
        id: item.id || 'kuaishou-shop;' + shopId + ';' + orderId,
        orderId,
        skuOrderId: item.skuOrderId || undefined,
        status: String(item.status || ''),
        totalAmount: item.totalAmount == null ? undefined : Number(item.totalAmount),
        quantity: item.quantity == null ? undefined : Number(item.quantity),
        productId: item.productId || undefined,
        productName: String(item.productName || ''),
        productImage: item.productImage || undefined,
        orderUrl: item.orderUrl || undefined,
        shopId,
        sessionId: item.sessionId ? idValue(item.sessionId) : undefined,
        userId: item.userId ? idValue(item.userId) : undefined,
        messageId: item.messageId ? idValue(item.messageId) : undefined,
        updatedAt: Number(item.updatedAt || 0) || undefined,
        platform: 'kuaishou-shop',
        raw: {
          cardType: item?.raw?.cardType,
          orderStatus: item?.raw?.orderStatus,
          payTime: item?.raw?.payTime,
        },
      }
    }
    const rawAmount = goods?.paymentInfo?.priceText ?? goods?.paymentInfo?.price ?? goods?.actualPayment ?? item?.payAmount ?? item?.totalAmount
    const amountNumber = Number(String(rawAmount ?? '').replace(/[¥￥,]/g, ''))
    const amount = typeof rawAmount === 'number' && Number.isInteger(rawAmount) ? amountNumber / 100 : amountNumber
    return {
      id: 'kuaishou-shop;' + shopId + ';' + orderId,
      orderId,
      skuOrderId: idValue(goods?.skuId || item?.skuOrderId) || undefined,
      status: String(base?.orderStatusDesc || base?.orderStatusTag?.text || base?.statusDesc || item?.statusDesc || item?.status || base?.status || ''),
      totalAmount: Number.isFinite(amount) ? amount : undefined,
      quantity: Number(goods?.quantity || goods?.itemNum || item?.quantity || item?.itemCount || 0) || undefined,
      productId: idValue(goods?.itemId || goods?.goodsId || item?.itemId) || undefined,
      productName: String(goods?.itemTitle || goods?.goodsName || item?.itemTitle || ''),
      productImage: goods?.itemPicUrl || goods?.image || item?.itemPicUrl || undefined,
      orderUrl: item?.orderUrl || item?.jumpUrl || undefined,
      shopId,
      sessionId: item?.sessionId ? idValue(item.sessionId) : undefined,
      userId: item?.userId ? idValue(item.userId) : undefined,
      messageId: item?.messageId ? idValue(item.messageId) : undefined,
      updatedAt: Number(item?.updatedAt || item?.updateTime || item?.timestamp || 0) || undefined,
      platform: 'kuaishou-shop',
      raw: {
        cardType: item?.raw?.cardType,
        orderStatus: base?.orderStatus || base?.status || item?.raw?.orderStatus || item?.status,
        payTime: base?.payTime || item?.raw?.payTime || item?.payTime,
      },
    }
  }

  async function listSessions() {
    const local = nativeSessions()
    if (local.length) return local
    const value = await requireLogin('listSessions')
    if (value?.errorCode) return value
    return pickArray(value).map((item) => normalizeSession(snapshot(item))).filter(Boolean)
  }

  async function listMessages(sessionId) {
    await selectSession(sessionId)
    const local = allMessages(sessionId)
    if (local.length) return local
    const value = await requireLogin('listMessages', sessionId)
    if (value?.errorCode) return value
    return pickArray(value).map(normalizeMessage).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp)
  }

  async function collectProducts() {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    const sdk = getChatSdk()
    if (typeof sdk?.commonRequest?.getGoodsListNew === 'function') {
      try {
        const buyerId = currentSessionId() || nativeSessions()[0]?.id || state.shopId
        const rows = []
        let offset = 0
        let total = 1
        while (offset < total && rows.length < 500) {
          const value = await sdk.commonRequest.getGoodsListNew({ buyerId, limit: 20, offset, viewTab: 1, searchKeyword: '' })
          const data = responseData(value) || {}
          const page = pickArray(data?.itemInfo || data)
          rows.push(...page)
          total = Number(data?.total || rows.length)
          if (!page.length) break
          offset += page.length
        }
        return rows.map((item) => normalizeProduct(snapshot(item))).filter((item) => item.goodsId)
      } catch (error) {
        return { success: false, errorCode: 'PRODUCTS_READ_FAILED', error: String(error?.error_msg || error?.message || error) }
      }
    }
    const local = stateProducts()
    if (local.length) return local
    const value = await requireLogin('collectProducts')
    if (value?.errorCode) return value
    return pickArray(value).map((item) => normalizeProduct(snapshot(item))).filter((item) => item.goodsId)
  }

  async function getProductDetail(goodsId) {
    const products = await collectProducts()
    if (Array.isArray(products)) {
      const product = products.find((item) => item.goodsId === String(goodsId))
      if (product) return product
    } else if (products?.errorCode) return products
    const value = await requireLogin('getProductDetail', goodsId)
    if (value?.errorCode) return value
    return normalizeProduct(snapshot(value?.data || value))
  }

  async function getOrders(userId) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    const sdk = getChatSdk()
    const buyerId = idValue(userId || currentSessionId() || nativeSessions()[0]?.id)
    if (typeof sdk?.https?.post === 'function' && buyerId) {
      try {
        const value = await sdk.https.post('/gateway/business/cs/order/list', { buyerId, itemTitle: '', limit: 20, offset: 0, orderStatus: 0 })
        const data = responseData(value) || {}
        return pickArray(data?.orderInfoList || data).map((item) => normalizeOrder(snapshot(item))).filter((item) => item.orderId)
      } catch (error) {
        return { success: false, errorCode: 'ORDERS_READ_FAILED', error: String(error?.error_msg || error?.message || error) }
      }
    }
    const value = await requireLogin('getOrders', userId)
    if (value?.errorCode) return value
    return pickArray(value).map((item) => normalizeOrder(snapshot(item))).filter((item) => item.orderId)
  }

  async function syncOrders(sessionId, userId) {
    const syncedAt = Date.now()
    const state = await auth()
    const requestedSession = idValue(sessionId || userId || currentSessionId())
    const requestedUser = idValue(userId || requestedSession)
    if (!state.authenticated) {
      return {
        orders: [],
        authoritative: false,
        source: 'none',
        syncedAt,
        sessionId: requestedSession || undefined,
        userId: requestedUser || undefined,
        errorCode: state.errorCode || 'LOGIN_REQUIRED',
        error: '请在快手小店页面完成登录后继续',
      }
    }

    const ordersById = new Map()
    const sources = new Set()
    const addOrder = (value) => {
      const normalized = normalizeOrder(value)
      if (!normalized?.orderId) return
      const previous = ordersById.get(normalized.orderId) || {}
      const merged = { ...previous }
      for (const [key, next] of Object.entries(normalized)) if (next !== undefined && next !== '') merged[key] = next
      ordersById.set(normalized.orderId, merged)
    }

    const platformResult = await getOrders(requestedUser || undefined)
    const platformAvailable = Array.isArray(platformResult)
    if (platformAvailable) {
      sources.add('platform-runtime')
      for (const order of platformResult) addOrder(order)
    }

    let historyAvailable = false
    const messages = allMessages(requestedSession || undefined)
    for (const message of messages) {
      if (!message.order) continue
      historyAvailable = true
      addOrder({
        ...message.order,
        sessionId: message.sessionId,
        userId: message.sessionId,
        messageId: message.id,
        updatedAt: message.timestamp,
      })
    }
    if (historyAvailable) sources.add('session-history')

    const source = sources.size > 1 ? 'combined' : sources.values().next().value || 'none'
    const result = {
      orders: Array.from(ordersById.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
      authoritative: platformAvailable || historyAvailable,
      source,
      syncedAt,
      sessionId: requestedSession || undefined,
      userId: requestedUser || undefined,
    }
    if (!platformAvailable && platformResult?.errorCode) {
      result.errorCode = platformResult.errorCode
      result.error = platformResult.error
    }
    if (requestedUser && result.authoritative) watchOrderSnapshot(requestedSession || requestedUser, requestedUser, result.orders)
    return result
  }

  function orderStateKey(order) {
    return [order?.orderId || '', order?.status || '', order?.totalAmount ?? '', order?.quantity ?? ''].join('|')
  }

  function orderStateMap(orders) {
    const result = new Map()
    for (const order of orders || []) if (order?.orderId) result.set(order.orderId, { key: orderStateKey(order), order })
    return result
  }

  function watchOrderSnapshot(sessionId, userId, orders) {
    const targetUser = idValue(userId || sessionId)
    if (!targetUser) return
    const now = Date.now()
    const existing = watchedOrderUsers.get(targetUser)
    watchedOrderUsers.set(targetUser, {
      sessionId: idValue(sessionId || targetUser),
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
    if (overflow <= 0) return
    const oldest = [...watchedOrderUsers.entries()]
      .sort((left, right) => Number(left[1].lastActiveAt || 0) - Number(right[1].lastActiveAt || 0))
      .slice(0, overflow)
    for (const [userId] of oldest) removeOrderWatch(userId)
    if (!watchedOrderUsers.size && orderPollTimer) {
      clearInterval(orderPollTimer)
      orderPollTimer = null
    }
  }

  function touchOrderWatch(sessionId, userId) {
    const targetUser = idValue(userId || sessionId)
    const watch = watchedOrderUsers.get(targetUser)
    if (!watch) return false
    const now = Date.now()
    watch.sessionId = idValue(sessionId || watch.sessionId || targetUser)
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
              const timestamp = Date.now()
              push('order', {
                order: { ...current.order, sessionId: watch.sessionId, userId, updatedAt: current.order.updatedAt || timestamp },
                sessionId: watch.sessionId,
                userId,
                source: 'platform-runtime',
                timestamp,
              })
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

  function messageExtra(session) {
    const sdk = getChatSdk()
    const loginUser = safeValue(safeValue(safeValue(sdk, 'store'), 'state'), 'loginUserInfo') || {}
    return {
      realFromRole: Number(safeValue(loginUser, 'role') || 1),
      sourcePage: 0,
      device: 4,
      senderUserId: safeValue(loginUser, 'loginImId') || safeValue(loginUser, 'userId') || safeValue(safeValue(sdk, 'esImSdk'), 'uid'),
      assistantId: safeValue(session, 'assistantId') || 0,
    }
  }

  async function sendMessage(sessionId, content) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    const sdk = getChatSdk()
    const pending = rememberSentText(sessionId, content)
    if (typeof sdk?.messageSender?.sendTextMsg === 'function') {
      try {
        const session = sessionRecord(sessionId)
        const value = await sdk.messageSender.sendTextMsg({
          targetType: Number(session?.chatTargetType || 0),
          targetId: String(sessionId),
          text: String(content),
          extra: messageExtra(session),
          receiptRequired: false,
          notCountUnread: false,
          notAutoCreateSession: false,
          needForward: false,
        })
        pending.messageId = idValue(value?.id || value?.messageId || value?.rawMsg?.id)
        return { success: true, messageId: pending.messageId, runtimePath: 'window.__chat_sdk.messageSender.sendTextMsg' }
      } catch (error) {
        forgetSentText(pending)
        return { success: false, errorCode: 'SEND_FAILED', error: String(error?.message || error) }
      }
    }
    const method = findMethod('sendMessage')
    if (!method) {
      forgetSentText(pending)
      return { success: false, errorCode: 'CAPABILITY_UNAVAILABLE', error: '快手页面尚未暴露文本发送方法' }
    }
    try {
      const value = await method.fn.apply(method.owner, [sessionId, content])
      if (value?.success === false || value?.ok === false) { forgetSentText(pending); return value }
      pending.messageId = idValue(value?.id || value?.messageId || value?.rawMsg?.id)
      return { success: true, messageId: pending.messageId, value: snapshot(value), runtimePath: method.path }
    } catch (error) {
      forgetSentText(pending)
      methodCache.delete('sendMessage')
      return { success: false, errorCode: 'SEND_FAILED', error: String(error?.message || error) }
    }
  }

  async function sendFile(sessionId, dataUrl, fileName) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    try {
      const match = String(dataUrl || '').match(/^data:([^;,]+)?;base64,(.*)$/)
      const mime = match?.[1] || 'application/octet-stream'
      const base64 = match?.[2] || String(dataUrl || '')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const file = new File([bytes], fileName || 'upload.bin', { type: mime })
      const sdk = getChatSdk()
      if (typeof sdk?.messageSender?.sendImageMsg === 'function') {
        if (!mime.startsWith('image/')) return { success: false, errorCode: 'UNSUPPORTED_FILE_TYPE', error: '快手当前 window runtime 仅支持直接发送图片' }
        const bitmap = await createImageBitmap(file)
        try {
          const session = sessionRecord(sessionId)
          const value = await sdk.messageSender.sendImageMsg({
            targetType: Number(session?.chatTargetType || 0),
            targetId: String(sessionId),
            image: file,
            width: bitmap.width,
            height: bitmap.height,
            extra: messageExtra(session),
            receiptRequired: false,
            notCountUnread: false,
            notAutoCreateSession: false,
            needForward: false,
          })
          return { success: true, messageId: idValue(value?.id), runtimePath: 'window.__chat_sdk.messageSender.sendImageMsg' }
        } finally { bitmap.close?.() }
      }
      const sendMethod = findMethod('sendFile')
      if (!sendMethod) return { success: false, errorCode: 'CAPABILITY_UNAVAILABLE', error: '快手页面尚未暴露文件发送方法' }
      const uploadMethod = findMethod('uploadFile')
      let payload = file
      if (uploadMethod && uploadMethod.fn !== sendMethod.fn) {
        const uploaded = await uploadMethod.fn.apply(uploadMethod.owner, [file])
        payload = uploaded?.url || uploaded?.uri || uploaded?.data?.url || uploaded?.data || uploaded
      }
      const value = await sendMethod.fn.apply(sendMethod.owner, [sessionId, payload])
      if (value?.success === false || value?.ok === false) return value
      return { success: true, value: snapshot(value), runtimePath: sendMethod.path }
    } catch (error) {
      return { success: false, errorCode: 'FILE_SEND_FAILED', error: String(error?.message || error) }
    }
  }

  async function transferSession(sessionId, target) {
    const state = await auth()
    if (!state.authenticated) return { success: false, errorCode: state.errorCode || 'LOGIN_REQUIRED', error: '请在快手小店页面完成登录后继续' }
    const request = getChatSdk()?.commonRequest
    if (typeof request?.getOnlineCsList === 'function' && typeof request?.batchTransferSessions === 'function') {
      try {
        const staffData = responseData(await request.getOnlineCsList({})) || {}
        const staff = pickArray(staffData?.stat || staffData)
        const selected = staff.find((item) => [item?.staffId, item?.userId, item?.allocationUserId, item?.id].some((id) => idValue(id) === String(target)))
          || staff.find((item) => [item?.staffName, item?.userName, item?.nickname, item?.name].some((name) => String(name || '').includes(String(target))))
        if (!selected) return { success: false, errorCode: 'TARGET_NOT_FOUND', error: '未找到目标客服', available: staff.map((item) => ({ id: idValue(item?.staffId || item?.userId || item?.id), name: String(item?.staffName || item?.userName || item?.nickname || item?.name || '') })) }
        const value = await request.batchTransferSessions({ allocationUserId: idValue(selected.staffId || selected.userId || selected.id), buyerIds: [String(sessionId)], message: '智能转人工', sellerId: state.userId || '' })
        return { success: true, value: snapshot(responseData(value)) }
      } catch (error) {
        return { success: false, errorCode: 'TRANSFER_FAILED', error: String(error?.error_msg || error?.message || error) }
      }
    }
    const value = await requireLogin('transferSession', sessionId, target)
    if (value?.errorCode || value?.success === false || value?.ok === false) return value
    return { success: true, value: snapshot(value) }
  }

  function push(type, payload) {
    if (queue.length >= 200) queue.shift()
    queue.push({ type, payload, timestamp: Date.now() })
  }

  function remember(message) {
    const fingerprint = [message.sessionId, message.senderId, message.content, message.timestamp].join('|')
    if (seenIds.has(message.id) || seenFingerprints.has(fingerprint)) return false
    seenIds.add(message.id); seenFingerprints.add(fingerprint)
    return true
  }

  function updateWaterline(message) {
    const current = Number(waterlines.get(message.sessionId) || 0)
    if (message.timestamp > current) waterlines.set(message.sessionId, message.timestamp)
    primedSessions.add(message.sessionId)
  }

  function primeMessage(message) {
    remember(message)
    const key = orderKey(message)
    if (key) seenOrderKeys.add(key)
    updateWaterline(message)
  }

  function orderKey(message) {
    return message.order ? [message.order.orderId, message.order.status || '', message.id].join('|') : ''
  }

  function publishOrder(message) {
    const key = orderKey(message)
    if (!key || seenOrderKeys.has(key)) return false
    seenOrderKeys.add(key)
    const userId = idValue(message.sessionId)
    const watched = orderSnapshots.get(userId)
    if (watched) watched.set(message.order.orderId, { key: orderStateKey(message.order), order: message.order })
    push('order', {
      order: {
        ...message.order,
        sessionId: message.sessionId,
        userId: message.sessionId,
        messageId: message.id,
        updatedAt: message.timestamp,
      },
      sessionId: message.sessionId,
      userId,
      messageId: message.id,
      source: 'message',
      timestamp: message.timestamp,
    })
    return true
  }

  function publishMessage(message, trustedNewMessage = false) {
    const waterline = Number(waterlines.get(message.sessionId) || listeningStartedAt || 0)
    const knownMessage = seenIds.has(message.id)
    if (!trustedNewMessage && message.timestamp <= waterline && !knownMessage) {
      primeMessage(message)
      return
    }
    publishOrder(message)
    if (!touchOrderWatch(message.sessionId, message.sessionId)) {
      void syncOrders(message.sessionId, message.sessionId).catch((error) => push('error', { error: String(error?.message || error), source: 'orders.listen' }))
    }
    if (remember(message)) push('message', message)
    updateWaterline(message)
  }

  function groupedMessages() {
    const grouped = new Map()
    for (const message of allMessages()) {
      const rows = grouped.get(message.sessionId) || []
      rows.push(message); grouped.set(message.sessionId, rows)
    }
    return grouped
  }

  function primeCurrentHistory() {
    for (const messages of groupedMessages().values()) messages.forEach(primeMessage)
  }

  function pollMessages() {
    const grouped = groupedMessages()
    for (const [sessionId, messages] of grouped.entries()) {
      if (!primedSessions.has(sessionId)) {
        for (const message of messages) {
          if (message.timestamp > listeningStartedAt) publishMessage(message)
          else primeMessage(message)
        }
        continue
      }
      for (const message of messages) publishMessage(message)
    }
    if (seenIds.size > 5000 || seenOrderKeys.size > 5000) {
      seenIds.clear(); seenFingerprints.clear(); seenOrderKeys.clear(); primeCurrentHistory()
    }
  }

  function eventMessages(value) {
    const output = []
    const pending = [value]
    const visited = new Set()
    while (pending.length && visited.size < 200) {
      const current = pending.shift()
      if (!current || typeof current !== 'object' || visited.has(current)) continue
      visited.add(current)
      const message = normalizeMessage(current)
      if (message) output.push(message)
      if (Array.isArray(current)) pending.push(...current)
      for (const key of ['message', 'data', 'payload', 'messages', 'items', 'list']) {
        const nested = safeValue(current, key)
        if (Array.isArray(nested)) pending.push(...nested)
        else if (nested && typeof nested === 'object') pending.push(nested)
      }
    }
    return output
  }

  function subscribeEmitter(owner, eventName, handler) {
    if (typeof owner?.on !== 'function') return false
    try {
      const subscription = owner.on(eventName, handler)
      subscriptions.push(() => {
        if (typeof subscription === 'function') subscription()
        else if (subscription && subscription !== owner && typeof subscription.unsubscribe === 'function') subscription.unsubscribe()
        else if (typeof owner.off === 'function') owner.off(eventName, handler)
        else if (typeof owner.removeListener === 'function') owner.removeListener(eventName, handler)
      })
      return true
    } catch (error) {
      push('error', { error: String(error?.message || error), eventName })
      return false
    }
  }

  function bindNativeMessages() {
    if (disposed || subscriptions.length) return
    const handleEvents = (trustedNewMessage, values) => {
      for (const message of eventMessages(values)) publishMessage(message, trustedNewMessage)
    }
    const sdk = getChatSdk()
    subscribeEmitter(sdk, 'system.session.newMessageFromBuyer', (...values) => handleEvents(true, values))
    subscribeEmitter(sdk?.esImSdk, 'messagesUpdate', (...values) => handleEvents(false, values))

    if (!subscriptions.length) {
      const method = findMethod('subscribeMessages')
      try {
        if (method) {
          const subscription = method.fn.call(method.owner, (...values) => handleEvents(false, values))
          subscriptions.push(() => {
            if (typeof subscription === 'function') subscription()
            else if (typeof subscription?.unsubscribe === 'function') subscription.unsubscribe()
          })
        }
      } catch (error) { push('error', { error: String(error?.message || error) }) }
    }
    if (subscriptions.length && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function bindMessages() {
    if (disposed) return
    if (!messagesBound) {
      messagesBound = true
      listeningStartedAt = Date.now()
      primeCurrentHistory()
      const activeSession = currentSessionId()
      if (activeSession) void syncOrders(activeSession, activeSession).catch(() => undefined)
    }
    bindNativeMessages()
    if (!subscriptions.length && !pollTimer) {
      pollTimer = setInterval(() => {
        pollMessages()
        bindNativeMessages()
      }, 500)
    }
  }

  window[QUEUE_KEY] = {
    __version: HOOK_VERSION,
    capabilities: ${JSON.stringify(kuaishouCapabilities)},
    getAuthState: auth,
    collectProducts,
    getProductDetail,
    listSessions,
    listMessages,
    sendMessage,
    sendFile,
    getOrders,
    syncOrders,
    transferSession,
    diagnose: () => locateRuntime().slice(0, 40),
    drainEvents: () => { bindMessages(); return queue.splice(0, queue.length) },
    dispose: () => {
      disposed = true
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (orderPollTimer) clearInterval(orderPollTimer)
      orderPollTimer = null
      for (const item of subscriptions.splice(0)) {
        try { if (typeof item === 'function') item(); else item?.unsubscribe?.() } catch (_) {}
      }
      queue.length = 0
      methodCache.clear()
      waterlines.clear()
      primedSessions.clear()
      seenIds.clear()
      seenFingerprints.clear()
      seenOrderKeys.clear()
      watchedOrderUsers.clear()
      orderSnapshots.clear()
      pendingSentTexts.clear()
    },
  }
  bindMessages()
  push('ready', { capabilities: window[QUEUE_KEY].capabilities })
})()`

export const kuaishouHook: HookPackageManifest = {
  id: 'kuaishou-shop',
  label: '快手小店',
  version: hookVersion,
  url: 'https://im.kwaixiaodian.com/workbench',
  match: ['*.kwaixiaodian.com/*', '*.kuaishou.com/*'],
  capabilities: kuaishouCapabilities,
  script: kuaishouHookScript,
  source: 'builtin',
}
