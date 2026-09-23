import { HOOK_PROTOCOL_VERSION } from '@platform-hub/hook-sdk'
import { DOUYIN_PRIMARY_OPERATIONS, DOUYIN_PRODUCTS_OPERATIONS, DOUYIN_PLATFORM_ID } from './manifest.js'

export const douyinHookRuntimeScript = String.raw`(() => {
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
    const combined = raw + ' ' + message + ' ' + (response?.url || '')
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
})()`
