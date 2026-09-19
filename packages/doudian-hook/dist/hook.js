export const doudianCapabilities = [
    'messages.listen', 'messages.history', 'messages.send', 'messages.file', 'sessions.list',
    'products.collect', 'products.detail', 'orders.read', 'orders.listen', 'session.transfer',
];
const hookVersion = '3.5.0';
/**
 * 抖店 Hook 只和平台暴露在 window 上的运行时交互。
 * 不读取 document、不查找元素、不模拟点击；登录由平台页面完成后自动继续。
 */
export const doudianHookScript = String.raw `(() => {
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
export const doudianHook = {
    id: 'douyin-shop',
    label: '抖店',
    version: hookVersion,
    url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
    match: ['*.jinritemai.com/*'],
    capabilities: doudianCapabilities,
    script: doudianHookScript,
    runtimePages: [
        {
            id: 'products',
            url: 'https://fxg.jinritemai.com/ffa/g/list?tab=all',
            methods: ['collectProducts', 'getProductDetail'],
            refreshBeforeInvoke: true,
        },
    ],
    source: 'builtin',
};
//# sourceMappingURL=hook.js.map