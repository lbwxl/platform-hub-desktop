import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { createDoudianClient, doudianHook, doudianHookScript } from '@platform-hub/doudian-hook'
import { createKuaishouClient, kuaishouHook, kuaishouHookScript } from '@platform-hub/kuaishou-hook'

test('抖店 package 暴露 manifest 和独立 runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/doudian-hook/manifest.json', import.meta.url), 'utf8'))
  const runtime = await readFile(new URL('../packages/doudian-hook/dist/runtime.js', import.meta.url), 'utf8')
  assert.equal(manifest.id, doudianHook.id)
  assert.equal(manifest.entry, 'dist/runtime.js')
  assert.equal(manifest.version, '3.5.0')
  assert.ok(manifest.capabilities.includes('orders.listen'))
  assert.match(runtime, /__platformHub/)
  assert.equal(runtime.includes('document.querySelector'), false)
  await import('../packages/doudian-hook/dist/runtime.js')
  assert.match(doudianHookScript, /_messageUpsert\$/)
})

test('typed client translates calls into CDP expressions', async () => {
  const calls = []
  const client = createDoudianClient(async (expression) => {
    calls.push(expression)
    if (expression.includes('getAuthState')) return { authenticated: true }
    return []
  })
  await client.install()
  await client.waitForLogin({ timeoutMs: 10 })
  await client.listSessions()
  await client.syncOrders('session-1')
  assert.match(calls[0], /__platformHub/)
  assert.match(calls.at(-1), /syncOrders/)
})

test('抖店订单历史建立水位线，新订单消息同时发布 message 和 order 事件', async () => {
  const callbacks = []
  const stream = { subscribe(callback) { callbacks.push(callback); return { unsubscribe() {} } } }
  const orderMessage = (messageId, orderId, status, timestamp) => ({
    serverId: messageId,
    conversationId: 'session-1',
    sender: 'buyer-1',
    createTime: timestamp,
    content: '',
    ext: {
      sender_role: '3',
      card_header: JSON.stringify({ cardSourceScene: 'order_detail' }),
      point_info: JSON.stringify({ shop_order_id: orderId }),
      static_data: JSON.stringify({ order_status: status, sell_num_desc: '¥1 共1件', product_name: '测试商品' }),
    },
  })
  const oldMessage = orderMessage('message-old', 'order-old', '待发货', 100)
  const conversation = { id: 'session-1', buyerId: 'buyer-1', lastMessage: oldMessage }
  const store = {
    shopInfo: { id: 'shop-1' },
    selfInfo: { id: 'seller-1' },
    conversationsInfo: {
      unClosedConversations: new Map([['session-1', conversation]]),
      messagesByConversationId: new Map([['session-1', { sortedMessages: [oldMessage] }]]),
    },
    talkerMap: { getTalkerInfo: () => ({ id: 'buyer-1', name: '.ai' }) },
    uiState: { workstation: { currentOrder: 'order-old', currentOrderMsgId: 'message-old' } },
  }
  const context = vm.createContext({
    window: {
      ss: { _frontStore: store },
      __mona_pigeon_event: { globalStore: { data: { initContextData: { im: { _message$: stream, _messageUpsert$: stream, _batchUpsert$: stream } } } } },
    },
    setInterval,
    clearInterval,
    URL,
  })

  vm.runInContext(doudianHookScript, context)
  const api = context.window.__platformHub
  const initial = api.drainEvents()
  assert.equal(initial.some((event) => event.type === 'order'), false)
  const history = await api.listMessages('session-1')
  assert.equal(history[0].type, 'order')

  callbacks[0](orderMessage('message-replayed', 'order-replayed', '待发货', 50))
  assert.equal(api.drainEvents().length, 0)

  const freshMessage = orderMessage('message-new', 'order-new', '待发货', 200)
  callbacks[0](freshMessage)
  const events = api.drainEvents()
  assert.deepEqual(Array.from(events, (event) => event.type).sort(), ['message', 'order'])
  assert.equal(events.find((event) => event.type === 'order').payload.order.orderId, 'order-new')
  assert.equal(events.find((event) => event.type === 'order').payload.userId, 'buyer-1')

  callbacks[0](freshMessage)
  assert.equal(api.drainEvents().length, 0)
  callbacks[0](orderMessage('message-new-card', 'order-new', '待发货', 200))
  const duplicateCardEvents = api.drainEvents()
  assert.equal(duplicateCardEvents.some((event) => event.type === 'order'), false)
  callbacks[0](orderMessage('message-new', 'order-new', '已发货', 202))
  const statusEvents = api.drainEvents()
  assert.equal(statusEvents.length, 1)
  assert.equal(statusEvents[0].type, 'order')
  assert.equal(statusEvents[0].payload.order.status, '已发货')
  const synced = await api.syncOrders('session-1')
  assert.equal(synced.authoritative, true)
  assert.equal(synced.orders[0].orderId, 'order-old')
  api.dispose()
})

test('快手 package 暴露 manifest、独立 runtime 和 typed client', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/kuaishou-hook/manifest.json', import.meta.url), 'utf8'))
  const runtime = await readFile(new URL('../packages/kuaishou-hook/dist/runtime.js', import.meta.url), 'utf8')
  assert.equal(manifest.id, kuaishouHook.id)
  assert.equal(manifest.version, kuaishouHook.version)
  assert.equal(manifest.version, '1.2.5')
  assert.ok(manifest.capabilities.includes('orders.listen'))
  assert.equal(manifest.entry, 'dist/runtime.js')
  assert.equal(manifest.runtimePages, undefined)
  assert.match(runtime, /__platformHub/)
  assert.equal(/document\.|querySelector|fetch\(/.test(runtime), false)
  await import('../packages/kuaishou-hook/dist/runtime.js')
  assert.match(kuaishouHookScript, /currentSessionMessageListStore/)
  assert.match(kuaishouHookScript, /sessionModel\?\.sessionAllModel\?\.allSessionMap/)
  assert.match(kuaishouHookScript, /chatWithTarget\(\{ targetSession: session \}\)/)
  assert.match(kuaishouHookScript, /system\.session\.newMessageFromBuyer/)
  assert.match(kuaishouHookScript, /messagesUpdate/)
  assert.match(kuaishouHookScript, /receiptRequired: false/)
  assert.match(kuaishouHookScript, /session\?\.chatTargetType/)
  assert.match(kuaishouHookScript, /realFromRole:/)
  assert.match(kuaishouHookScript, /device: 4/)
  assert.match(kuaishouHookScript, /senderUserId:/)

  const calls = []
  const client = createKuaishouClient(async (expression) => {
    calls.push(expression)
    if (expression.includes('getAuthState')) return { authenticated: true, shopId: 'shop-1' }
    return []
  })
  await client.install()
  await client.waitForLogin({ timeoutMs: 10 })
  await client.listSessions()
  await client.syncOrders('session-1')
  assert.match(calls[0], /__platformHub/)
  assert.match(calls.at(-1), /syncOrders/)
})

test('快手商品采集兼容官方 SDK 返回的 catalog dataSource 形状', async () => {
  const context = vm.createContext({
    window: {
      __chat_sdk: {
        appInfo: { extraLoginInfo: { shopId: 'shop-1', userId: 'seller-1', shopName: '测试店铺' } },
        commonRequest: {
          async getGoodsListNew() {
            return {
              data: {
                data: {
                  total: 1,
                  dataSource: [{
                    itemId: 'goods-1',
                    itemDesc: { title: { text: '目录商品' }, mainImage: ['https://img.example/goods-1.jpg'] },
                    managerPrice: { price: ['19.90'] },
                    createTime: '2026-09-18T10:00:00.000Z',
                  }],
                },
              },
            }
          },
        },
        currentSessionMessageListStore: null,
      },
      frames: [],
      location: { hostname: 'im.kwaixiaodian.com', pathname: '/workbench' },
    },
    setInterval,
    clearInterval,
    URL,
  })

  vm.runInContext(kuaishouHookScript, context)
  const product = (await context.window.__platformHub.collectProducts())[0]
  assert.equal(product.id, 'kuaishou-shop;shop-1;goods-1')
  assert.equal(product.goodsId, 'goods-1')
  assert.equal(product.name, '目录商品')
  assert.equal(product.price, 19.9)
  assert.deepEqual(Array.from(product.images), ['https://img.example/goods-1.jpg'])
  assert.match(product.goodsUrl, /kwaishop-goods-detail-page-app\?id=goods-1/)
  assert.match(product.editUrl, /goods\/config\/release\/detail\?itemId=goods-1/)
  context.window.__platformHub.dispose()
})

test('快手未登录 SDK 外壳不会绕过登录门槛', async () => {
  const context = vm.createContext({
    window: {
      __chat_sdk: { appInfo: {}, currentSessionMessageListStore: null },
      frames: [],
      location: { hostname: 'im.kwaixiaodian.com', pathname: '/workbench' },
    },
    setInterval,
    clearInterval,
    URL,
  })
  vm.runInContext(kuaishouHookScript, context)
  const auth = await context.window.__platformHub.getAuthState()
  assert.equal(auth.authenticated, false)
  assert.equal(auth.errorCode, 'LOGIN_REQUIRED')
  const result = await context.window.__platformHub.collectProducts()
  assert.equal(result.errorCode, 'LOGIN_REQUIRED')
  context.window.__platformHub.dispose()
})

test('快手商品卡片从买家查看商品系统消息的详情链接提取商品', async () => {
  const context = vm.createContext({
    window: {
      __chat_sdk: {
        appInfo: { extraLoginInfo: { shopId: 'shop-1', userId: 'seller-1' } },
        currentSessionMessageListStore: {
          session: { targetId: 'buyer-1' },
          messages: [{
            id: 'message-card',
            eMessageType: 1000000,
            sessionTargetId: 'buyer-1',
            kMsg: {
              id: 'card-1',
              eContent: {
                fields: {
                  title: '买家正在查看商品',
                  content: {
                    itemDetailUrl: 'https://app.kwaixiaodian.com/web/kwaishop-goods-detail-page-app?itemId=goods-card',
                    itemPicUrl: 'https://img.example/card.jpg',
                    description: '¥29.90',
                    title: '卡片商品',
                  },
                },
              },
              rawMsg: { id: 'card-1', sessionTargetId: 'buyer-1', timestampMs: 1000 },
            },
          }],
        },
      },
      frames: [],
      location: { hostname: 'im.kwaixiaodian.com', pathname: '/workbench' },
    },
    setInterval,
    clearInterval,
    URL,
  })
  vm.runInContext(kuaishouHookScript, context)
  const message = (await context.window.__platformHub.listMessages('buyer-1'))[0]
  assert.equal(message.type, 'product')
  assert.equal(message.product.goodsId, 'goods-card')
  assert.equal(message.product.name, '卡片商品')
  assert.equal(message.product.price, 29.9)
  context.window.__platformHub.dispose()
})

test('快手订单历史建立水位线，新订单消息和状态变化发布 order 事件', async () => {
  const callbacks = new Map()
  const intervals = []
  let now = 1_000_000
  let orderQueryCount = 0
  class TestDate extends Date {
    static now() { return now }
  }
  let apiOrders = [{
    orderBaseInfo: { oid: 'order-api', status: 30, orderStatusTag: { text: '待发货' } },
    itemAndPriceInfo: { paymentInfo: { price: 100 }, itemNum: 1, itemTitle: '接口商品' },
  }]
  const orderMessage = (messageId, orderId, status, timestamp) => ({
    id: messageId,
    eMessageType: 10,
    sessionTargetId: 'buyer-1',
    kMsg: {
      id: messageId,
      eContent: {
        fields: {
          type: 'order_card',
          orderId,
          orderStatusDesc: status,
          payAmount: '¥1',
          quantity: 1,
          itemTitle: '测试商品',
        },
      },
      rawMsg: { id: messageId, sessionTargetId: 'buyer-1', fromUserId: 'buyer-1', timestampMs: timestamp },
    },
  })
  const oldMessage = orderMessage('message-old', 'order-old', '待发货', 100)
  const sdk = {
    appInfo: { extraLoginInfo: { shopId: 'shop-1', userId: 'seller-1', shopName: '测试店铺' } },
    currentSessionMessageListStore: { session: { targetId: 'buyer-1' }, messages: [oldMessage] },
    sessionModel: { sessionAllModel: { allSessionMap: new Map([['buyer-1', { targetId: 'buyer-1', nickname: '拾一见月', chatTargetType: 1 }]]) } },
    https: {
      post: async () => { orderQueryCount += 1; return { data: { orderInfoList: apiOrders } } },
    },
    messageSender: {
      async sendTextMsg() {
        callbacks.get('es:messagesUpdate')?.({
          id: 'message-sent',
          eMessageType: 0,
          sessionTargetId: 'buyer-1',
          kMsg: {
            id: 'message-sent',
            rawMsg: { id: 'message-sent', sessionTargetId: 'buyer-1', fromUserId: 'seller-1', timestampMs: now / 1000 },
          },
        })
        return { id: 'message-sent' }
      },
    },
    on(eventName, callback) { callbacks.set(`sdk:${eventName}`, callback); return this },
    off(eventName) { callbacks.delete(`sdk:${eventName}`) },
    esImSdk: {
      on(eventName, callback) { callbacks.set(`es:${eventName}`, callback); return this },
      off(eventName) { callbacks.delete(`es:${eventName}`) },
    },
  }
  const context = vm.createContext({
    window: { __chat_sdk: sdk, frames: [], location: { hostname: 'im.kwaixiaodian.com', pathname: '/workbench' } },
    setInterval(callback) { intervals.push(callback); return callback },
    clearInterval() {},
    Date: TestDate,
    URL,
  })

  vm.runInContext(kuaishouHookScript, context)
  const api = context.window.__platformHub
  const initial = api.drainEvents()
  assert.equal(initial.some((event) => event.type === 'order'), false)
  const history = await api.listMessages('buyer-1')
  assert.equal(history[0].type, 'order')

  const sentResult = await api.sendMessage('buyer-1', '发送成功后的正文')
  assert.equal(sentResult.success, true)
  const sentEvent = api.drainEvents().find((event) => event.type === 'message' && event.payload.id === 'message-sent')
  assert.equal(sentEvent.payload.content, '发送成功后的正文')
  assert.equal(sentEvent.payload.isMine, true)

  callbacks.get('es:messagesUpdate')(orderMessage('message-replayed', 'order-replayed', '待发货', 50))
  assert.equal(api.drainEvents().length, 0)

  const freshMessage = orderMessage('message-new', 'order-new', '待发货', 200)
  callbacks.get('sdk:system.session.newMessageFromBuyer')(freshMessage)
  const events = api.drainEvents()
  assert.deepEqual(Array.from(events, (event) => event.type).sort(), ['message', 'order'])
  assert.equal(events.find((event) => event.type === 'order').payload.order.orderId, 'order-new')

  callbacks.get('sdk:system.session.newMessageFromBuyer')(freshMessage)
  assert.equal(api.drainEvents().length, 0)
  callbacks.get('es:messagesUpdate')(orderMessage('message-new', 'order-new', '已发货', 200))
  const statusEvents = api.drainEvents()
  assert.equal(statusEvents.length, 1)
  assert.equal(statusEvents[0].type, 'order')
  assert.equal(statusEvents[0].payload.order.status, '已发货')

  const synced = await api.syncOrders('buyer-1')
  assert.equal(synced.authoritative, true)
  assert.equal(synced.source, 'combined')
  assert.deepEqual(Array.from(synced.orders, (order) => order.orderId).sort(), ['order-api', 'order-old'])
  const apiOrder = synced.orders.find((order) => order.orderId === 'order-api')
  assert.equal(apiOrder.status, '待发货')
  assert.equal(apiOrder.totalAmount, 1)
  assert.equal(apiOrder.quantity, 1)
  assert.equal(apiOrder.productName, '接口商品')

  apiOrders = [...apiOrders, {
    orderBaseInfo: { oid: 'order-polled', status: 30, orderStatusTag: { text: '待发货' } },
    itemAndPriceInfo: { paymentInfo: { price: '10.00' }, itemNum: 1, itemTitle: '轮询商品' },
  }]
  now += 6_000
  await intervals.at(-1)()
  await new Promise((resolve) => setImmediate(resolve))
  const polledEvents = api.drainEvents()
  assert.equal(polledEvents.length, 1)
  assert.equal(polledEvents[0].type, 'order')
  assert.equal(polledEvents[0].payload.source, 'platform-runtime')
  assert.equal(polledEvents[0].payload.order.status, '待发货')
  assert.equal(polledEvents[0].payload.order.productName, '轮询商品')

  for (let index = 0; index < 55; index += 1) await api.syncOrders(`buyer-${index}`)
  const beforeBoundedPoll = orderQueryCount
  now += 6_000
  await intervals.at(-1)()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(orderQueryCount, beforeBoundedPoll + 1)

  const beforeExpiryPoll = orderQueryCount
  now += 31 * 60 * 1000
  await intervals.at(-1)()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(orderQueryCount, beforeExpiryPoll)
  api.dispose()
})
