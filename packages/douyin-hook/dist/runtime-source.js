import { HOOK_PROTOCOL_VERSION } from '@platform-hub/hook-sdk';
import { DOUYIN_PRIMARY_OPERATIONS, DOUYIN_PRODUCTS_OPERATIONS, DOUYIN_PLATFORM_ID } from './manifest.js';
export const douyinHookRuntimeScript = String.raw `(() => {
  const KEY = '__PLATFORM_HOOK__'
  const VERSION = ${HOOK_PROTOCOL_VERSION}
  const PLATFORM = ${JSON.stringify(DOUYIN_PLATFORM_ID)}
  const PAGE = window.__PLATFORM_HOOK_PAGE_ID__ || (/fxg\.jinritemai\.com/i.test(String(location?.hostname || '')) ? 'products' : 'primary')
  const primaryOperations = ${JSON.stringify(DOUYIN_PRIMARY_OPERATIONS)}
  const productOperations = ${JSON.stringify(DOUYIN_PRODUCTS_OPERATIONS)}
  const operations = PAGE === 'products' ? productOperations : primaryOperations
  const existing = window[KEY]
  if (existing && !existing.__disposed && existing.protocolVersion === VERSION && existing.describe?.().pageId === PAGE) return
  try { existing?.dispose?.() } catch (_) {}

  const queue = []
  const seenMessages = new Set()
  const seenFingerprints = new Set()
  const orderSnapshots = new Map()
  const orderWatches = new Map()
  const messageOrderSnapshots = new Map()
  let disposed = false
  let messageCleanup = null
  let orderTimer = null
  let orderPollBusy = false
  const ORDER_WATCH_MAX = 50
  const ORDER_WATCH_TTL_MS = 30 * 60 * 1000
  const ORDER_ACTIVE_WINDOW_MS = 2 * 60 * 1000
  const ORDER_ACTIVE_INTERVAL_MS = 5 * 1000
  const ORDER_IDLE_INTERVAL_MS = 30 * 1000
  const ORDER_POLL_BATCH_SIZE = 1

  const store = () => window.ss?._frontStore || window.ss?.instance || null
  const im = () => window.__mona_pigeon_event?.globalStore?.data?.initContextData?.im || null
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
  const error = (code, message, retryable = false) => ({ ok: false, error: { code, message, retryable } })
  const loginError = () => error('LOGIN_REQUIRED', '请在抖店官方页面完成登录后继续')
  const runtimeError = () => error('RUNTIME_NOT_READY', '抖店页面尚未暴露所需运行时能力', true)
  const auth = async () => {
    if (/captcha|verify|challenge|risk/i.test(String(location?.pathname || '') + String(location?.search || ''))) {
      return error('CHALLENGE_REQUIRED', '抖店要求完成官方安全验证', true)
    }
    const current = store()
    const shopId = identifier(current?.shopInfo?.id || window.__mona_store__?.shopId)
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
    if (PAGE === 'products') {
      try {
        if (window.localStorage?.getItem('GOODS_SWR_CACHE_V1') != null) return { ok: true, data: { authenticated: true, checkedAt: Date.now() } }
      } catch (_) {}
    }
    if (/^\/login(?:\/|$)/i.test(String(location?.pathname || ''))) return { ok: true, data: { authenticated: false, checkedAt: Date.now() } }
    return error('RUNTIME_NOT_READY', '抖店账号状态 Runtime 尚未准备好', true)
  }
  const requireAuth = async () => {
    const result = await auth()
    return result.ok && result.data.authenticated ? null : result
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
  const buyerFor = (conversationId) => {
    const conversation = conversations().find(({ value }) => text(value.id) === text(conversationId))
    const person = conversation ? talker(conversation.raw) : {}
    return text(conversation?.value?.buyerId || conversation?.value?.currentTalkId || conversation?.value?.userId || person.id || person.userId)
  }
  const product = (raw) => {
    const item = raw && typeof raw === 'object' ? raw : {}
    const externalId = text(item.goodsId || item.goods_id || item.productId || item.product_id || item.id)
    if (!externalId) return undefined
    const shopId = text(item.shopId || item.shop_id || item.sellerId || store()?.shopInfo?.id)
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
    const status = text(item.status || item.product_status).toLowerCase()
    return {
      id: 'douyin:' + (shopId || 'unknown') + ':' + externalId,
      externalId,
      title: text(item.name || item.title || item.product_name) || '未命名商品',
      ...(text(item.description || item.desc) ? { description: text(item.description || item.desc) } : {}),
      status: /on[_ -]?sale|selling|在售|上架/.test(status) || ['1', '2'].includes(status) ? 'on_sale' : /off[_ -]?sale|下架|停售/.test(status) || ['3', '4'].includes(status) ? 'off_sale' : /draft|草稿/.test(status) ? 'draft' : 'unknown',
      ...(rawPrice !== undefined ? { price: { amount: rawPrice, currency: 'CNY' } } : {}),
      ...(number(item.stockQuantity ?? item.stock_num ?? item.stock) !== undefined ? { stockQuantity: number(item.stockQuantity ?? item.stock_num ?? item.stock) } : {}),
      images: imageValues.map((image) => typeof image === 'string' ? image : text(image?.url)).filter(Boolean),
      skus,
      ...(text(item.goodsUrl || item.product_url || item.detail_url) ? { url: text(item.goodsUrl || item.product_url || item.detail_url) } : {}),
      ...(time(item.updatedAt || item.update_time || item.modify_time) ? { updatedAt: time(item.updatedAt || item.update_time || item.modify_time) } : {}),
      raw: { platformStatus: item.status || item.product_status },
    }
  }
  const cachedProducts = () => {
    let cache
    try { cache = JSON.parse(window.localStorage?.getItem('GOODS_SWR_CACHE_V1') || '{}') } catch (_) { return [] }
    const result = []
    const seen = new Set()
    for (const [key, entry] of Object.entries(cache || {})) {
      if (!/(?:product|goods).*?(?:list|search)|(?:list|search).*?(?:product|goods)/i.test(String(key))) continue
      for (const raw of array(entry?.__value__?.data || entry?.value?.data || entry?.data)) {
        const item = product(raw)
        if (!item || seen.has(item.externalId)) continue
        seen.add(item.externalId); result.push(item)
      }
    }
    return result
  }
  const waitForProducts = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    let result = cachedProducts()
    while (!result.length && PAGE === 'products' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      result = cachedProducts()
    }
    return result
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
    const system = senderRole === '3' || senderRole === '4' || /system|notice|notification|系统|通知/i.test([item.messageType, item.type, ext.type].map(text).join(' '))
    const direction = !system && (item.isMine === true || senderId === context.selfId || senderRole === '2') ? 'outbound' : 'inbound'
    const platformType = text(ext.type || item.messageType || item.type).toLowerCase()
    const cardScene = text(json(ext.card_header).cardSourceScene)
    const type = /order|订单/i.test(platformType + cardScene) ? 'order' : system ? 'system' : /image|图片/.test(platformType) ? 'image' : /file|文件/.test(platformType) ? 'file' : /goods|product|商品/i.test(platformType + cardScene) ? 'product' : !platformType || /text|文字/.test(platformType) ? 'text' : 'unknown'
    const source = [ext.send_source, ext.sender_source, ext.operation_source, ext.source, item.sendSource, item.senderSource, item.operationSource, item.source].map(text).filter(Boolean).join(' ')
    const manualSendCheck = Boolean(text(ext['p:check_Send'] || ext['p:check_send'] || ext.p_check_send))
    const origin = system ? 'system' : direction === 'inbound' ? 'customer' : manualSendCheck || /manual|human|staff|agent|人工|客服手动/i.test(source) ? 'human' : 'unknown'
    const status = text(item.deliveryStatus || item.sendStatus || item.status).toLowerCase()
    const attachmentUrl = text(item.url || item.uri || item.imageUrl || item.fileUrl || ext.url || ext.image_url || ext.file_url)
    const attachmentName = text(item.fileName || item.name || ext.file_name)
    const attachmentMime = text(item.mimeType || item.mime || ext.mime_type)
    return {
      id, conversationId,
      ...(senderId ? { senderId } : {}),
      ...(text(ext.uname || item.senderName || context.conversationTitle) ? { senderName: system ? '系统' : text(ext.uname || item.senderName || context.conversationTitle) } : {}),
      content: text(item.content || item.text || item.message), type, direction, origin,
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
        const normalized = message(raw, { conversationId: session.id, selfId: text(store()?.selfInfo?.id), conversationTitle: session.title })
        if (normalized && !result.some((item) => item.id === normalized.id)) result.push(normalized)
      }
    }
    return result.sort((a, b) => a.timestamp - b.timestamp)
  }
  const order = (raw, context = {}) => {
    const item = raw && typeof raw === 'object' ? raw : {}
    const externalId = text(item.orderId || item.order_id || item.shopOrderId || item.shop_order_id || item.skuOrderId || item.sku_order_id || item.id)
    if (!externalId) return undefined
    const shopId = text(item.shopId || item.shop_id || store()?.shopInfo?.id)
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
    const status = text(item.status || item.orderStatus || item.order_status || item.status_desc || item.order_status_desc).toLowerCase()
    const normalizedStatus = /退款成功|退款完成|已退款|refunded/.test(status) ? 'refunded' : /退款|退货|售后|refund/.test(status) ? 'refunding' : /取消|关闭|cancel|closed/.test(status) ? 'cancelled' : /完成|交易成功|已收货|complete|success/.test(status) ? 'completed' : /已发货|运输中|物流|shipped|shipping/.test(status) ? 'shipped' : /待发货|备货|处理中|processing/.test(status) ? 'processing' : /已付款|已支付|支付成功|paid/.test(status) ? 'paid' : /待付款|未付款|新订单|created|pending/.test(status) ? 'created' : 'unknown'
    return {
      id: 'douyin:' + (shopId || 'unknown') + ':' + externalId, externalId,
      ...(shopId ? { shopId } : {}),
      ...(text(item.conversationId || item.sessionId || context.conversationId) ? { conversationId: text(item.conversationId || item.sessionId || context.conversationId) } : {}),
      ...((text(item.buyerId || item.userId) || text(item.buyerName || item.buyer_name)) ? { buyer: { ...(text(item.buyerId || item.userId) ? { id: text(item.buyerId || item.userId) } : {}), ...(text(item.buyerName || item.buyer_name) ? { name: text(item.buyerName || item.buyer_name) } : {}) } } : {}),
      status: normalizedStatus, items,
      ...(total !== undefined ? { total: { amount: total, currency: 'CNY' } } : {}),
      ...((text(item.receiverName || item.receiver_name) || text(item.receiverAddress || item.receiver_address) || text(item.phoneMasked || item.receiver_phone_mask)) ? { receiver: { ...(text(item.receiverName || item.receiver_name) ? { name: text(item.receiverName || item.receiver_name) } : {}), ...(text(item.phoneMasked || item.receiver_phone_mask) ? { phoneMasked: text(item.phoneMasked || item.receiver_phone_mask) } : {}), ...(text(item.receiverAddress || item.receiver_address) ? { address: text(item.receiverAddress || item.receiver_address) } : {}) } } : {}),
      ...(time(item.createdAt || item.create_time || item.order_create_time) ? { createdAt: time(item.createdAt || item.create_time || item.order_create_time) } : {}),
      ...(time(item.updatedAt || item.update_time || item.timestamp) ? { updatedAt: time(item.updatedAt || item.update_time || item.timestamp) } : {}),
      raw: { platformStatus: item.status || item.orderStatus || item.order_status || item.status_desc || item.order_status_desc },
    }
  }
  const orderMessages = (conversationId) => messages(conversationId).map((item) => item.type === 'order' ? orderFromMessage(item, conversationId) : undefined).filter(Boolean)
  const orderFromMessage = (item, conversationId) => {
    const raw = item.raw || {}
    const id = text(raw.orderId || raw.shopOrderId)
    return id ? order({ ...raw, orderId: id }, { conversationId }) : undefined
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
  const orders = async (conversationId) => {
    const current = store()
    const service = current?.orderInvitation || current?.orderInfo
    for (const name of ['getOrders', 'fetchOrders', 'fetchOrderList', 'queryOrders']) {
      try {
        if (typeof service?.[name] === 'function') {
          const value = await service[name](buyerFor(conversationId))
          const rows = array(value).map((item) => order(item, { conversationId })).filter(Boolean)
          if (rows.length) return mergeOrders(rows)
        }
      } catch (_) {}
    }
    return mergeOrders(orderMessages(conversationId))
  }
  const orderKey = (item) => JSON.stringify([item.externalId, item.status, item.items, item.total, item.receiver])
  const pruneOrderWatches = (now = Date.now()) => {
    for (const [key, watch] of orderWatches) if (now - watch.lastActiveAt >= ORDER_WATCH_TTL_MS) { orderWatches.delete(key); orderSnapshots.delete(key) }
    const overflow = orderWatches.size - ORDER_WATCH_MAX
    if (overflow > 0) {
      for (const [key] of [...orderWatches.entries()].sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt).slice(0, overflow)) { orderWatches.delete(key); orderSnapshots.delete(key) }
    }
  }
  const touchOrderWatch = (conversationId) => {
    const key = orderWatches.has(conversationId) ? conversationId : orderWatches.has('*') ? '*' : ''
    if (!key) return
    const watch = orderWatches.get(key)
    const now = Date.now()
    watch.lastActiveAt = now
    watch.nextPollAt = Math.min(watch.nextPollAt, now)
  }
  const watchOrders = async () => {
    if (disposed || orderPollBusy || !orderWatches.size) return
    const startedAt = Date.now()
    pruneOrderWatches(startedAt)
    const due = [...orderWatches.entries()].filter(([, watch]) => watch.nextPollAt <= startedAt).sort((left, right) => left[1].nextPollAt - right[1].nextPollAt).slice(0, ORDER_POLL_BATCH_SIZE)
    if (!due.length) return
    orderPollBusy = true
    try {
      for (const [conversationId, watch] of due) {
        const previous = orderSnapshots.get(conversationId) || new Map()
        const current = await orders(conversationId === '*' ? '' : conversationId)
        const next = new Map(current.map((item) => [item.externalId, item]))
        const now = Date.now()
        watch.nextPollAt = now + (now - watch.lastActiveAt <= ORDER_ACTIVE_WINDOW_MS ? ORDER_ACTIVE_INTERVAL_MS : ORDER_IDLE_INTERVAL_MS)
        if (!next.size && previous.size) continue
        for (const [id, item] of next) {
          const old = previous.get(id)
          if (!old) { emit({ type: 'order.created', payload: { order: item } }); continue }
          if (orderKey(old) !== orderKey(item)) {
            const changedFields = ['status', 'items', 'total', 'receiver'].filter((key) => JSON.stringify(old[key]) !== JSON.stringify(item[key]))
            emit({ type: 'order.updated', payload: { order: item, previous: old, changedFields } })
          }
        }
        orderSnapshots.set(conversationId, next)
      }
    } finally { orderPollBusy = false }
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
        const normalized = message(item, { selfId: text(store()?.selfInfo?.id) })
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
        touchOrderWatch(item.conversationId)
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
          const value = await api.sendText(conversationId, content, {})
          if (value?.success === false) return error('PLATFORM_ERROR', text(value.statusMsg || '发送文本失败'), true)
          const id = text(value?.serverId || value?.messageId || value?.id)
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
            const value = await api.sendImage(conversationId, { uri, width: bitmap.width, height: bitmap.height, format: mimeType.split('/')[1] || 'png', size: file.size }, upload, {}, () => {})
            if (!value) return error('PLATFORM_ERROR', '发送图片失败', true)
            const id = text(value?.serverId || value?.messageId || value?.id)
            return { ok: true, data: { id: id || 'pending-' + Date.now(), conversationId, content: name, type: 'image', direction: 'outbound', origin: 'automation', deliveryStatus: id || value?.success === true ? 'sent' : 'pending', timestamp: Date.now(), attachments: [{ name, mimeType }] } }
          } finally { bitmap.close?.(); URL.revokeObjectURL(uri) }
        }
        case 'products.list': return { ok: true, data: await waitForProducts() }
        case 'products.detail': { const id = text(input.id || input.externalId); if (!id) return error('INVALID_INPUT', '商品 id 必填'); const found = (await waitForProducts()).find((item) => item.externalId === id || item.id === id); return found ? { ok: true, data: found } : error('INVALID_INPUT', '未找到商品: ' + id) }
        case 'orders.list': { const result = await orders(text(input.conversationId)); return { ok: true, data: result } }
        case 'orders.listen': { const conversationId = text(input.conversationId); const key = conversationId || '*'; const current = await orders(conversationId); const now = Date.now(); orderSnapshots.set(key, new Map(current.map((item) => [item.externalId, item]))); orderWatches.set(key, { lastActiveAt: now, nextPollAt: now }); pruneOrderWatches(now); if (!orderTimer) orderTimer = setInterval(() => { void watchOrders() }, 1000); return { ok: true, data: { listening: true, watermark: Math.max(0, ...current.map((item) => item.updatedAt || item.createdAt || 0)) } } }
        case 'handoff.transfer': {
          const conversationId = text(input.conversationId), target = text(input.targetId || input.targetName)
          if (!conversationId) return error('INVALID_INPUT', 'conversationId 必填')
          if (!target) return error('INVALID_INPUT', '抖店转人工需要 targetId 或 targetName')
          const transfer = store()?.uiState?.chatRooms?.transferConv
          if (!transfer) return runtimeError()
          if (!transfer.canTransferServiceList?.length && typeof transfer.fetchTransferServiceList === 'function') await transfer.fetchTransferServiceList()
          if (!transfer.canTransferGroupList?.length && typeof transfer.fetchTransferGroupList === 'function') await transfer.fetchTransferGroupList()
          const people = [...(transfer.canTransferServiceList || []), ...(transfer.canTransferGroupList || [])]
          const selected = people.find((item) => text(item?.id || item?.staffId || item?.userId || item?.name || item?.title) === target) || people.find((item) => text(item?.name || item?.title || item?.staffName).includes(target))
          if (people.length && !selected) return error('INVALID_INPUT', '未找到目标客服或客服组')
          const targetId = text(selected?.id || selected?.staffId || selected?.userId || input.targetId || target)
          for (const name of ['transferConversation', 'transferSession', 'assignConversation', 'transfer']) if (typeof transfer[name] === 'function') {
            const value = await transfer[name](conversationId, targetId, input.remark)
            if (value?.success === false || value?.ok === false) return error('PLATFORM_ERROR', text(value?.error || value?.message || '转人工失败'), true)
            return { ok: true, data: { transferred: true, target: { id: targetId, name: text(selected?.name || selected?.title || selected?.staffName || input.targetName || target) } } }
          }
          return runtimeError()
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
    drainEvents: async () => { bindMessages(); return queue.splice(0, queue.length) },
    dispose: async () => { if (disposed) return; disposed = true; try { messageCleanup?.() } catch (_) {} if (orderTimer) clearInterval(orderTimer); orderTimer = null; orderPollBusy = false; queue.length = 0; seenMessages.clear(); seenFingerprints.clear(); orderSnapshots.clear(); orderWatches.clear(); messageOrderSnapshots.clear() },
  }
})()`;
//# sourceMappingURL=runtime-source.js.map