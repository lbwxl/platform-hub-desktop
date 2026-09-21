import { HOOK_PROTOCOL_VERSION } from '@platform-hub/hook-sdk';
import { DOUYIN_PRIMARY_OPERATIONS, DOUYIN_PRODUCTS_OPERATIONS, DOUYIN_PLATFORM_ID } from './manifest.js';
export const douyinHookRuntimeScript = String.raw `(() => {
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
  const orderWatches = new Map()
  const messageOrderSnapshots = new Map()
  let disposed = false
  let messageCleanup = null
  let orderTimer = null
  let orderPollBusy = false
  const ORDER_WATCH_MAX = 50
  const ORDER_WATCH_TTL_MS = 30 * 60 * 1000
  const ORDER_ACTIVE_WINDOW_MS = 2 * 60 * 1000
  // The commerce API is a snapshot endpoint. Keep the active window at the
  // same cadence as the host drain loop so short-lived created/refunding
  // states are not skipped when a human completes the next transition.
  const ORDER_ACTIVE_INTERVAL_MS = 1 * 1000
  const ORDER_IDLE_INTERVAL_MS = 30 * 1000
  const ORDER_POLL_BATCH_SIZE = 1

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
    const platformStatus = text(item.platformStatus || item.orderStatus || item.order_status || item.status_desc || item.order_status_desc || item.status)
    const platformAftersaleStatus = text(item.platformAftersaleStatus || item.aftersaleStatus || item.aftersale_sum_status_desc).trim()
    const effectiveAftersaleStatus = /^[-—]?$/.test(platformAftersaleStatus) ? '' : platformAftersaleStatus
    const status = (effectiveAftersaleStatus || platformStatus).toLowerCase()
    const normalizedStatus = /退款成功|退款完成|已退款|售后完成|售后成功|refunded/.test(status) ? 'refunded' : /退款|退货|售后|refund/.test(status) ? 'refunding' : /取消|关闭|cancel|closed/.test(status) ? 'cancelled' : /完成|交易成功|已收货|complete|success/.test(status) ? 'completed' : /已发货|运输中|物流|shipped|shipping/.test(status) ? 'shipped' : /待发货|备货|处理中|processing/.test(status) ? 'processing' : /已付款|已支付|支付成功|paid/.test(status) ? 'paid' : /待付款|待支付|未付款|新订单|created|pending/.test(status) ? 'created' : 'unknown'
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
  const requestCommerceOrders = async (explicitOrderId) => {
    if (PAGE !== 'orders') return []
    const request = window['fetch']
    if (typeof request !== 'function') return []
    const query = 'page=0&pageSize=100&order_by=create_time&order=desc&tab=all'
    try {
      const response = await request.call(window, '/api/order/searchlist?' + query.toString(), { credentials: 'include' })
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
        const paidStatus = value.pay_time ? '已付款' : statusText
        return {
          ...value,
          order_id: value.shop_order_id || value.order_id,
          sku_order_list: productRows,
          order_status_desc: paidStatus,
          aftersale_sum_status_desc: aftersale,
          user_id: value.user_id,
          post_receiver: receiver.post_receiver,
          mobile: receiver.post_tel || receiver.post_tel_mask,
          post_address: receiver.post_addr,
          createdAt: value.create_time,
          update_time: value.pay_time || value.update_time || value.create_time,
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
        const current = await orders(conversationId === '*' ? '' : conversationId, watch.orderId)
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
        case 'orders.list': { const result = await orders(text(input.conversationId), text(input.orderId || input.externalId)); return { ok: true, data: result } }
        case 'orders.listen': { const conversationId = text(input.conversationId); const orderId = text(input.orderId || input.externalId); const key = conversationId || '*'; const current = await orders(conversationId, orderId); const now = Date.now(); orderSnapshots.set(key, new Map(current.map((item) => [item.externalId, item]))); orderWatches.set(key, { lastActiveAt: now, nextPollAt: now, orderId }); pruneOrderWatches(now); if (!orderTimer) orderTimer = setInterval(() => { void watchOrders() }, 1000); return { ok: true, data: { listening: true, watermark: Math.max(0, ...current.map((item) => item.updatedAt || item.createdAt || 0)) } } }
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
    drainEvents: async () => { bindMessages(); return queue.splice(0, queue.length) },
    dispose: async () => { if (disposed) return; disposed = true; try { messageCleanup?.() } catch (_) {} if (orderTimer) clearInterval(orderTimer); orderTimer = null; orderPollBusy = false; queue.length = 0; seenMessages.clear(); seenFingerprints.clear(); orderSnapshots.clear(); orderWatches.clear(); messageOrderSnapshots.clear() },
  }
})()`;
//# sourceMappingURL=runtime-source.js.map