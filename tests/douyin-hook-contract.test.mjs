import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {
  createDouyinPageRuntime,
  douyinHookManifest,
  douyinHookRuntimeScript,
} from '../packages/douyin-hook/dist/index.js'
import {
  assertPageHookRuntime,
  HOOK_PROTOCOL_VERSION,
  validateHookManifest,
} from '../packages/hook-sdk/dist/index.js'

test('Douyin manifest routes only supported operations and passes protocol validation', () => {
  assert.deepEqual(validateHookManifest(douyinHookManifest), [])
  assert.equal(douyinHookManifest.platform, 'douyin')
  assert.equal(douyinHookManifest.operations['orders.list'].page, 'orders')
  assert.equal(douyinHookManifest.operations['orders.listen'].page, 'orders')
  assert.equal(douyinHookManifest.operations['products.list'].page, 'products')
  assert.equal(douyinHookManifest.operations['handoff.targets.list'].page, 'primary')
})

test('Douyin package is independent from Legacy and uses no DOM or network interception', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../packages/douyin-hook/package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.dependencies['@platform-hub/hook-sdk'], 'workspace:*')
  assert.equal(packageJson.dependencies['@platform-hub/hook-host'], 'workspace:*')
  assert.doesNotMatch(douyinHookRuntimeScript, /document\.|querySelector|MutationObserver|\.click\(|dispatchEvent|fetch\(|XMLHttpRequest|WebSocket/)
  assert.match(douyinHookRuntimeScript, /pigeon\.jinritemai\.com\/chat\/api\/backstage\/conversation\/transfer_conversation/)
})

test('Douyin runtime rejects logged-out placeholder account identifiers', async () => {
  const context = vm.createContext({
    location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
    window: {
      location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
      ss: { _frontStore: { shopInfo: { id: -1 }, selfInfo: { id: 0 } } },
      __STORE__GETTERS__: { isLogin: false, user: { id: -1, shop_id: 0 } },
      localStorage: { getItem() { return null } },
    },
    setInterval,
    clearInterval,
    Date,
    JSON,
    Map,
    Set,
  })

  vm.runInContext(douyinHookRuntimeScript, context)
  const result = await context.window.__PLATFORM_HOOK__.invoke('auth.state', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'RUNTIME_NOT_READY')
})

test('Douyin primary page identity survives redirect to the official fxg login host', async () => {
  const context = vm.createContext({
    location: { hostname: 'fxg.jinritemai.com', pathname: '/login/common', search: '' },
    window: {
      __PLATFORM_HOOK_PAGE_ID__: 'primary',
      location: { hostname: 'fxg.jinritemai.com', pathname: '/login/common', search: '' },
      localStorage: { getItem() { return null } },
    },
    setInterval,
    clearInterval,
    Date,
    JSON,
    Map,
    Set,
  })

  vm.runInContext(douyinHookRuntimeScript, context)
  const runtime = context.window.__PLATFORM_HOOK__
  assert.equal(runtime.describe().pageId, 'primary')
  const result = await runtime.invoke('auth.state', {})
  assert.equal(result.ok, true)
  assert.equal(result.data.authenticated, false)
})

test('Douyin page runtime handshake, normalized operations, events, handoff and lifecycle', async () => {
  const callbacks = []
  const timers = []
  let unsubscribeCount = 0
  let transferArgs
  const now = Date.now()
  const oldMessage = { serverId: 'old', conversationId: 'conversation-1', sender: 'buyer-1', content: '历史消息', createTime: now - 60_000 }
  const stream = { subscribe(callback) { callbacks.push(callback); return { unsubscribe() { unsubscribeCount += 1 } } } }
  const context = vm.createContext({
    location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
    window: {
      location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
      ss: { _frontStore: {
        shopInfo: { id: 'shop-1' },
        selfInfo: { id: 'seller-1' },
        conversationsInfo: {
          unClosedConversations: new Map([['conversation-1', { id: 'conversation-1', buyerId: 'buyer-1', lastMessage: oldMessage }]]),
          messagesByConversationId: new Map([['conversation-1', { sortedMessages: [oldMessage] }]]),
        },
        talkerMap: { getTalkerInfo: () => ({ id: 'buyer-1', name: '测试买家' }) },
        orderInvitation: { async getOrders() { return platformOrders } },
        uiState: { chatRooms: { transferConv: {
          canTransferServiceList: [
            { id: 'staff-1', name: '客服一' },
            { staffId: 'staff-2', staffName: '客服二' },
          ],
          async transferSession(...args) { transferArgs = args },
        } } },
      } },
      __mona_pigeon_event: { globalStore: { data: { initContextData: { im: {
        _message$: stream,
        async sendText(conversationId, content) { return { id: 'sent-1', conversationId, content } },
      } } } } },
      localStorage: { getItem() { return null } },
    },
    setInterval(callback, interval) { const timer = { callback, interval, cleared: false }; timers.push(timer); return timer },
    clearInterval(timer) { timer.cleared = true },
    Date,
    JSON,
    Map,
    Set,
  })

  vm.runInContext(douyinHookRuntimeScript, context)
  const runtime = context.window.__PLATFORM_HOOK__
  assert.equal(runtime.protocolVersion, HOOK_PROTOCOL_VERSION)
  assertPageHookRuntime(runtime, douyinHookManifest, douyinHookManifest.pages[0])

  assert.equal((await runtime.invoke('auth.state', {})).data.authenticated, true)
  assert.equal((await runtime.invoke('sessions.list', {})).data[0].unreadCount, 0)
  assert.equal((await runtime.invoke('messages.history', { conversationId: 'conversation-1' })).data[0].origin, 'customer')
  await runtime.invoke('messages.listen', {})
  assert.equal(callbacks.length, 1)
  callbacks[0](oldMessage)
  assert.equal((await runtime.drainEvents()).some((event) => event.type === 'message.created'), false)

  const sent = await runtime.invoke('messages.send.text', { conversationId: 'conversation-1', text: '自动回复' })
  assert.equal(sent.ok, true)
  assert.equal(sent.data.origin, 'automation')
  const failed = await runtime.invoke('messages.send.text', { conversationId: 'missing-conversation', text: '失败发送' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'INVALID_INPUT')
  let events = await runtime.drainEvents()
  assert.equal(events.some((event) => event.type === 'message.created'), false)

  callbacks[0]({ clientId: 'local-only', conversationId: 'conversation-1', sender: 'seller-1', content: '自动回复', isMine: true, createTime: now })
  assert.equal((await runtime.drainEvents()).some((event) => event.type === 'message.created'), false)

  callbacks[0]({ serverId: 'manual', conversationId: 'conversation-1', sender: 'seller-1', content: '人工回复', isMine: true, ext: { operation_source: 'manual_agent' }, createTime: now + 1 })
  callbacks[0]({ serverId: 'other-client', conversationId: 'conversation-1', sender: 'seller-1', content: '其他端', isMine: true, createTime: now + 2 })
  callbacks[0]({ serverId: 'system', conversationId: 'conversation-1', content: '系统通知', ext: { sender_role: '3' }, createTime: now + 3 })
  callbacks[0]({ serverId: 'duplicate', conversationId: 'conversation-1', sender: 'buyer-1', content: '去重', createTime: now + 4 })
  callbacks[0]({ serverId: 'duplicate', conversationId: 'conversation-1', sender: 'buyer-1', content: '去重', createTime: now + 4 })
  events = await runtime.drainEvents()
  assert.deepEqual(Array.from(events.filter((event) => event.type === 'message.created'), (event) => event.payload.message.origin), ['human', 'unknown', 'system', 'customer'])

  const targets = await runtime.invoke('handoff.targets.list', {})
  assert.equal(targets.ok, true)
  assert.deepEqual(Array.from(targets.data, (target) => ({ ...target })), [
    { id: 'staff-1', name: '客服一' },
    { id: 'staff-2', name: '客服二' },
  ])
  const transfer = await runtime.invoke('handoff.transfer', { conversationId: 'conversation-1', targetId: 'staff-1' })
  assert.equal(transfer.data.transferred, true)
  assert.deepEqual(Array.from(transferArgs), ['conversation-1', 'staff-1', undefined])
  const unknownTarget = await runtime.invoke('handoff.transfer', { conversationId: 'conversation-1', targetId: 'other-shop' })
  assert.equal(unknownTarget.ok, false)
  assert.equal(unknownTarget.error.code, 'INVALID_INPUT')

  const firstRuntime = runtime
  await runtime.dispose()
  await runtime.dispose()
  assert.equal(unsubscribeCount, 1)
  vm.runInContext(douyinHookRuntimeScript, context)
  assert.notEqual(context.window.__PLATFORM_HOOK__, firstRuntime)
  assertPageHookRuntime(context.window.__PLATFORM_HOOK__, douyinHookManifest, douyinHookManifest.pages[0])
  await context.window.__PLATFORM_HOOK__.dispose()
})

test('Douyin commerce page polls the official shop order API and emits lifecycle changes', async () => {
  const requests = []
  const timers = []
  let clock = Date.now()
  let row = {
    shop_order_id: 'shop-order-1',
    order_status: 1,
    order_status_info: { order_status_text: '待支付' },
    create_time: 1_700_000_000,
    pay_time: 0,
    actual_pay_amount: 1000,
    user_id: 'buyer-1',
    product_item: [{ product_id: 'product-1', product_name: '测试商品', sku_id: 0, combo_num: 1, pay_amount: 1000, sku_spec: ['默认'], after_sale_info: { after_sale_text: '-' } }],
    receiver_info: { post_receiver: '测*', post_tel_mask: '1**********', post_addr: { province: { name: '测试省' }, city: { name: '测试市' }, detail: '***' } },
  }
  const context = vm.createContext({
    location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '?tab=all' },
    window: {
      __PLATFORM_HOOK_PAGE_ID__: 'orders',
      __shop_id: 'shop-1',
      location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '?tab=all' },
      async fetch(url) {
        requests.push(String(url))
        return { ok: true, async json() { return { code: 0, data: [row] } } }
      },
    },
    setInterval(callback, interval) { const timer = { callback, interval, cleared: false }; timers.push(timer); return timer },
    clearInterval(timer) { timer.cleared = true },
    Date: { now: () => clock, parse: Date.parse },
    JSON,
    Map,
    Set,
  })

  vm.runInContext(douyinHookRuntimeScript, context)
  const runtime = context.window.__PLATFORM_HOOK__
  const ordersPage = douyinHookManifest.pages.find((page) => page.id === 'orders')
  assertPageHookRuntime(runtime, douyinHookManifest, ordersPage)

  const initial = await runtime.invoke('orders.list', {})
  assert.equal(initial.ok, true)
  assert.equal(initial.data[0].status, 'created')
  assert.equal(initial.data[0].externalId, 'shop-order-1')
  const listening = await runtime.invoke('orders.listen', {})
  assert.equal(listening.ok, true)
  assert.equal(listening.data.listening, true)
  assert.equal((await runtime.drainEvents()).length, 0)

  const poll = timers.find((timer) => timer.interval === 1000)
  assert.ok(poll)
  const advance = async (next) => { row = { ...row, ...next }; clock += 6_000; await poll.callback(); await new Promise((resolve) => setImmediate(resolve)) }
  await advance({ order_status: 2, order_status_info: { order_status_text: '待发货' }, pay_time: 1_700_000_001 })
  await advance({ product_item: [{ ...row.product_item[0], after_sale_info: { after_sale_text: '退款中' } }] })
  await advance({ product_item: [{ ...row.product_item[0], after_sale_info: { after_sale_text: '退款成功' } }] })
  const events = await runtime.drainEvents()
  assert.deepEqual(
    Array.from(events.filter((event) => event.type === 'order.updated'), (event) => event.payload.order.status),
    ['paid', 'refunding', 'refunded'],
  )
  assert.ok(requests.every((url) => url.includes('/api/order/searchlist?')))
  await runtime.dispose()
})

test('Douyin handoff falls back once to the official page request service when the page store has no transfer action', async () => {
  const requests = []
  const context = vm.createContext({
    location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
    window: {
      location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
      ss: { _frontStore: {
        shopInfo: { id: 'shop-1' },
        selfInfo: { id: 'staff-current' },
        conversationsInfo: {
          unClosedConversations: new Map([['conversation-1', { id: 'conversation-1', buyerId: 'buyer-1' }]]),
        },
        talkerMap: { getTalkerInfo: () => ({ id: 'buyer-1', name: '测试买家' }) },
        uiState: { chatRooms: { transferConv: {
          canTransferServiceList: [{ id: 'staff-target', name: '目标客服' }],
        } } },
      } },
      __mona_pigeon_event: { globalStore: { data: { initContextData: {
        async post(url, data) {
          requests.push({ url, data })
          return { code: 0, message: 'success' }
        },
      } } } },
      localStorage: { getItem() { return null } },
    },
    setInterval,
    clearInterval,
    Date,
    JSON,
    Map,
    Set,
  })

  vm.runInContext(douyinHookRuntimeScript, context)
  const result = await context.window.__PLATFORM_HOOK__.invoke('handoff.transfer', {
    conversationId: 'conversation-1',
    targetId: 'staff-target',
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.transferred, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://pigeon.jinritemai.com/chat/api/backstage/conversation/transfer_conversation?PIGEON_BIZ_TYPE=2')
  assert.deepEqual({ ...requests[0].data }, {
    securityBizConversationId: 'buyer-1:shop-1::2:1:pigeon',
    toCid: 'staff-target',
    extParams: '{}',
  })
  await context.window.__PLATFORM_HOOK__.dispose()
})

test('Douyin host wrapper correlates automation echoes and removes failed sends', async () => {
  const events = []
  let failNext = false
  const now = Date.now()
  const description = {
    protocolVersion: HOOK_PROTOCOL_VERSION,
    platform: 'douyin',
    pageId: 'primary',
    capabilities: ['messages.send.text'],
    operations: ['messages.send.text'],
  }
  const runtime = createDouyinPageRuntime({
    description,
    async evaluate(expression) {
      if (expression.includes('.invoke(')) {
        if (failNext) { failNext = false; return { ok: false, error: { code: 'PLATFORM_ERROR', message: 'failed' } } }
        return { ok: true, data: { id: 'return', conversationId: 'c1', content: '自动', type: 'text', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: now } }
      }
      if (expression.includes('.drainEvents(')) return events.splice(0)
      return undefined
    },
  })
  const sent = await runtime.invoke('messages.send.text', { conversationId: 'c1', text: '自动' })
  assert.equal(sent.data.origin, 'automation')
  events.push({ type: 'message.created', timestamp: now, payload: { message: { id: 'echo', conversationId: 'c1', content: '自动', type: 'text', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: now } } })
  assert.equal((await runtime.drainEvents())[0].payload.message.origin, 'automation')

  failNext = true
  const failed = await runtime.invoke('messages.send.text', { conversationId: 'c1', text: '失败内容' })
  assert.equal(failed.ok, false)
  events.push({ type: 'message.created', timestamp: now + 1, payload: { message: { id: 'unmatched', conversationId: 'c1', content: '失败内容', type: 'text', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: now + 1 } } })
  assert.equal((await runtime.drainEvents())[0].payload.message.origin, 'unknown')

  await runtime.invoke('messages.send.file', { conversationId: 'c1', name: 'test.png', mimeType: 'image/png', data: 'data:image/png;base64,AA==' })
  events.push({ type: 'message.created', timestamp: now + 2, payload: { message: { id: 'image-echo', conversationId: 'c1', content: '[图片]', type: 'image', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: now + 2 } } })
  assert.equal((await runtime.drainEvents())[0].payload.message.origin, 'automation')
  await runtime.dispose()
})

test('Douyin products worker runs from official loaded cache without primary store', async () => {
  const cache = {
    'goods-list-query': {
      __value__: {
        data: {
          list: [{ product_id: 'goods-1', product_name: '缓存商品', discount_price: 1990, product_status: '在售' }],
        },
      },
    },
  }
  const context = vm.createContext({
    location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '?tab=all' },
    window: {
      location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '?tab=all' },
      localStorage: { getItem(key) { return key === 'GOODS_SWR_CACHE_V1' ? JSON.stringify(cache) : null } },
    },
    setInterval,
    clearInterval,
    setTimeout,
    Date,
    JSON,
    Map,
    Set,
  })
  vm.runInContext(douyinHookRuntimeScript, context)
  const runtime = context.window.__PLATFORM_HOOK__
  assertPageHookRuntime(runtime, douyinHookManifest, douyinHookManifest.pages[1])
  const listed = await runtime.invoke('products.list', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.data[0].externalId, 'goods-1')
  assert.deepEqual({ ...listed.data[0].price }, { amount: 19.9, currency: 'CNY' })
  await runtime.dispose()
})
