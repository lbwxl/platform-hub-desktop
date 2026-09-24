import { douyinHookManifest, douyinHookRuntimeScript } from '@platform-hub/douyin-hook'
import type { PageHookManifest as HookPackageManifest } from '@platform-hub/core-runtime'

type PlatformCapability = string

const primaryPage = douyinHookManifest.pages.find((page) => page.kind === 'primary')
const productsPage = douyinHookManifest.pages.find((page) => page.id === 'products')
const ordersPage = douyinHookManifest.pages.find((page) => page.id === 'orders')

const capabilities: PlatformCapability[] = [
  'messages.listen',
  'messages.history',
  'messages.send',
  'messages.file',
  'sessions.list',
  'products.collect',
  'products.detail',
  'orders.read',
  'orders.listen',
  'session.transfer',
]

/**
 * The desktop shell still exposes the legacy package-manifest shape to its
 * CDP session. The runtime itself is the formal Douyin Hook; this small
 * compatibility layer only translates the shell's old method calls into the
 * Page Hook operation protocol.
 */
export const douyinHook: HookPackageManifest = {
  id: 'douyin-shop',
  label: '抖店',
  version: douyinHookManifest.version,
  url: primaryPage?.url || 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
  executionModel: 'page',
  loginUrl: 'https://fxg.jinritemai.com/login/common',
  loginMatch: ['https://im.jinritemai.com/login*'],
  capabilities,
  runtimePages: [
    ...(productsPage?.url ? [{ id: productsPage.id, url: productsPage.url, methods: ['collectProducts', 'getProductDetail'] }] : []),
    ...(ordersPage?.url ? [{ id: ordersPage.id, url: ordersPage.url, methods: ['getOrders', 'syncOrders', 'listenOrders'], persistent: true }] : []),
  ],
  script: createShellRuntimeScript(),
  source: 'builtin',
}

export const douyinCapabilities = capabilities
export const douyinHookScript = douyinHook.script || ''

function createShellRuntimeScript(): string {
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
})()`
}
