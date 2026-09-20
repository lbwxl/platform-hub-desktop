import assert from 'node:assert/strict'
import test from 'node:test'
import {
  douyinOrderChangedFields,
  mapDouyinError,
  normalizeDouyinAuth,
  normalizeDouyinMessage,
  normalizeDouyinOrder,
  normalizeDouyinOrderStatus,
  normalizeDouyinProduct,
  normalizeDouyinSession,
} from '../packages/douyin-hook/dist/index.js'

test('Douyin auth and session values normalize to public contracts', () => {
  assert.deepEqual(normalizeDouyinAuth({ shopInfo: { id: 'shop-1' }, selfInfo: { id: 'seller-1' } }, 100), {
    authenticated: true,
    shopId: 'shop-1',
    userId: 'seller-1',
    checkedAt: 100,
  })
  assert.deepEqual(normalizeDouyinAuth({ shopInfo: { id: -1 }, selfInfo: { id: 0 } }, 101), {
    authenticated: false,
    checkedAt: 101,
  })
  assert.deepEqual(normalizeDouyinSession({
    conversationId: 'conversation-1',
    buyerName: '买家',
    unread_count: 2,
    lastMessage: { content: '最近消息', timestamp: 1_700_000_000 },
    avatar: 'https://example.test/avatar.png',
  }), {
    id: 'conversation-1',
    title: '买家',
    unreadCount: 2,
    lastMessage: '最近消息',
    updatedAt: 1_700_000_000_000,
    avatarUrl: 'https://example.test/avatar.png',
  })
  assert.equal(normalizeDouyinSession({ conversationId: 'conversation-2', buyerId: 'opaque-buyer-id' }).title, '用户')
})

test('Douyin message attribution requires affirmative human evidence', () => {
  const buyer = normalizeDouyinMessage({ serverId: 'buyer', conversationId: 'c1', sender: 'buyer-1', content: '咨询', createTime: 100 })
  const human = normalizeDouyinMessage({ serverId: 'human', conversationId: 'c1', sender: 'seller-1', content: '人工', isMine: true, ext: { operation_source: 'manual_agent' }, createTime: 101 })
  const unknown = normalizeDouyinMessage({ serverId: 'unknown', conversationId: 'c1', sender: 'seller-1', content: '其他端发送', isMine: true, createTime: 102 })
  const system = normalizeDouyinMessage({ serverId: 'system', conversationId: 'c1', content: '系统通知', ext: { sender_role: '3' }, createTime: 103 })
  assert.equal(buyer.origin, 'customer')
  assert.equal(buyer.direction, 'inbound')
  assert.equal(human.origin, 'human')
  assert.equal(unknown.origin, 'unknown')
  assert.equal(system.origin, 'system')
  assert.equal(system.type, 'system')
  const platformHuman = normalizeDouyinMessage({
    serverId: 'platform-human',
    conversationId: 'c1',
    isMine: true,
    ext: { source: 'pc-web', sender_role: '2', 'p:check_Send': 'manual-send-check-id' },
  })
  assert.equal(platformHuman.origin, 'human')
  assert.equal(platformHuman.raw.attributionMetadata.manualSendCheck, true)
  assert.equal(platformHuman.raw.attributionMetadata['ext.p:check_Send'], undefined)
  const orderCard = normalizeDouyinMessage({
    serverId: 'order-card',
    conversationId: 'c1',
    ext: { sender_role: '3', card_header: JSON.stringify({ cardSourceScene: 'order_detail' }) },
    createTime: 104,
  })
  assert.equal(orderCard.origin, 'system')
  assert.equal(orderCard.type, 'order')
})

test('Douyin products normalize price, inventory, images and SKUs', () => {
  const product = normalizeDouyinProduct({
    product_id: 'goods-1',
    shop_id: 'shop-1',
    product_name: '测试商品',
    discount_price: 1990,
    stock_num: 8,
    product_status: '在售',
    images: [{ url: 'https://example.test/goods.png' }],
    skuList: [{ sku_id: 'sku-1', spec_desc: '大号', price: 990, stock: 3 }],
  })
  assert.equal(product.id, 'douyin:shop-1:goods-1')
  assert.equal(product.externalId, 'goods-1')
  assert.equal(product.status, 'on_sale')
  assert.deepEqual(product.price, { amount: 19.9, currency: 'CNY' })
  assert.equal(product.stockQuantity, 8)
  assert.deepEqual(product.images, ['https://example.test/goods.png'])
  assert.equal(product.skus[0].externalId, 'sku-1')
})

test('Douyin orders normalize statuses and meaningful changes', () => {
  const mappings = new Map([
    ['待付款', 'created'], ['待支付', 'created'], ['已付款', 'paid'], ['待发货', 'processing'], ['已发货', 'shipped'],
    ['交易成功', 'completed'], ['已取消', 'cancelled'], ['退款处理中', 'refunding'], ['退款成功', 'refunded'],
  ])
  for (const [raw, expected] of mappings) assert.equal(normalizeDouyinOrderStatus(raw), expected)
  assert.equal(normalizeDouyinOrderStatus('平台新增状态'), 'unknown')

  const first = normalizeDouyinOrder({
    shop_order_id: 'order-1',
    shop_id: 'shop-1',
    status_desc: '待发货',
    product_id: 'goods-1',
    product_name: '商品',
    sku_id: 'sku-1',
    sku_name: '默认',
    quantity: 1,
    pay_amount: 1990,
    receiver_name: '张三',
    receiver_phone_mask: '138****0000',
  }, { conversationId: 'c1' })
  const next = { ...first, status: 'shipped', items: [{ ...first.items[0], quantity: 2 }] }
  assert.equal(first.externalId, 'order-1')
  assert.deepEqual(first.total, { amount: 19.9, currency: 'CNY' })
  assert.deepEqual(douyinOrderChangedFields(first, next), ['status', 'items'])
})

test('Douyin platform failures map to Hook error protocol', () => {
  assert.equal(mapDouyinError({ errorCode: 'CAPTCHA_REQUIRED', error: '请完成验证' }).code, 'CHALLENGE_REQUIRED')
  assert.equal(mapDouyinError({ errorCode: 'LOGIN_REQUIRED' }).code, 'LOGIN_REQUIRED')
  assert.equal(mapDouyinError({ errorCode: 'TOO_MANY_REQUESTS' }).code, 'RATE_LIMITED')
  assert.equal(mapDouyinError({ errorCode: 'UNSUPPORTED_FILE_TYPE' }).code, 'NOT_SUPPORTED')
  assert.equal(mapDouyinError({ errorCode: 'RUNTIME_NOT_READY' }).code, 'RUNTIME_NOT_READY')
  assert.equal(mapDouyinError({ error: 'unknown failure' }).code, 'PLATFORM_ERROR')
})
