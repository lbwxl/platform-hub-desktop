import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { GoofishTransport } from '../packages/goofish-transport/dist/index.js'
import { ShopRuntimeManager } from '../src/main/runtime/ShopRuntimeManager.ts'

function makeFixture(options = {}) {
  const client = new FakeGoofishClient(options)
  const transport = new GoofishTransport({
    accountId: options.accountId || 'platform-account-a',
    clientAccountId: options.clientAccountId || '10001',
    client,
    now: options.now || (() => Date.now()),
  })
  return { client, transport }
}

async function eventually(assertion, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { return assertion() } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw lastError || new Error('timed out')
}

test('GOOFISH_AUTH_STATE', async () => {
  const { transport } = makeFixture()
  await transport.start()
  const result = await transport.invoke('auth.state', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, {
    authenticated: true,
    shopId: '10001',
    userId: '10001',
    checkedAt: result.data.checkedAt,
  })
  await transport.stop()
})

test('GOOFISH_SESSIONS_LIST uses the official session id rather than a buyer id', async () => {
  const { transport } = makeFixture({ sessions: [{ sessionId: 'conversation-1@goofish', userId: 'buyer-1', peerUserInfo: { nick: 'Buyer' }, unreadNum: 3, lastMessage: { content: '你好' }, updateTime: 1_700_000_000 }] })
  await transport.start()
  const result = await transport.invoke('sessions.list', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, [{ id: 'conversation-1', title: 'Buyer', unreadCount: 3, lastMessage: '你好', updatedAt: 1_700_000_000_000 }])
  await transport.stop()
})

test('GOOFISH_MESSAGE_HISTORY', async () => {
  const { client, transport } = makeFixture({ messages: [{ id: 'm1', sessionId: 'conversation-1@goofish', senderId: 'buyer-1', senderName: 'Buyer', content: { contentType: 1, text: { text: '你好' } }, createTime: 1_700_000_000 }] })
  await transport.start()
  const result = await transport.invoke('messages.history', { conversationId: 'conversation-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(client.lastHistoryQuery, { accountId: '10001', conversationId: 'conversation-1' })
  assert.deepEqual(result.data[0], {
    id: 'm1', conversationId: 'conversation-1', senderId: 'buyer-1', senderName: 'Buyer', content: '你好',
    type: 'text', direction: 'inbound', origin: 'customer', deliveryStatus: 'sent', timestamp: 1_700_000_000_000,
    raw: { source: undefined, platformType: '1' },
  })
  await transport.stop()
})

test('GOOFISH_MESSAGE_LISTEN and GOOFISH_NO_HISTORY_REPLAY', async () => {
  const { client, transport } = makeFixture()
  const events = []
  transport.subscribe((event) => events.push(event))
  await transport.start()
  client.emitMessage({ id: 'history-before-listen', sessionId: 'conversation-1', senderId: 'buyer-1', content: 'old' })
  assert.equal(events.length, 0)
  const started = await transport.invoke('messages.listen', {})
  assert.equal(started.ok, true)
  assert.equal(started.data.listening, true)
  client.emitMessage({ id: 'late-history-replay', sessionId: 'conversation-1', senderId: 'buyer-1', createTime: Date.now() - 10_000, content: 'old replay' })
  client.emitMessage({ id: 'new-inbound', sessionId: 'conversation-1', senderId: 'buyer-1', content: { contentType: 1, text: { text: 'new' } } })
  client.emitMessage({ id: 'new-inbound', sessionId: 'conversation-1', senderId: 'buyer-1', content: { contentType: 1, text: { text: 'new' } } })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'message.created')
  assert.equal(events[0].payload.message.origin, 'customer')
  assert.equal(events[0].payload.message.direction, 'inbound')
  await transport.stop()
})

test('GOOFISH_SEND_TEXT and GOOFISH_AUTOMATION_ORIGIN correlate the official echo', async () => {
  const { client, transport } = makeFixture()
  const events = []
  transport.subscribe((event) => events.push(event))
  await transport.start()
  await transport.invoke('messages.listen', {})
  client.onSendText = (accountId, conversationId, content) => {
    client.emitMessage({ id: 'echo-auto', sessionId: conversationId, senderId: '10001', content: { contentType: 1, text: { text: content } } })
    return { id: 'send-result-id' }
  }
  const result = await transport.invoke('messages.send.text', { conversationId: 'conversation-1', text: '好的' })
  assert.equal(result.ok, true)
  assert.equal(result.data.direction, 'outbound')
  assert.equal(result.data.origin, 'automation')
  assert.equal(events.at(-1).payload.message.origin, 'automation')
  assert.deepEqual(client.lastSendText, { accountId: '10001', conversationId: 'conversation-1', text: '好的' })
  await transport.stop()
})

test('GOOFISH_HUMAN_ORIGIN requires explicit manual evidence and repeated text does not consume automation twice', async () => {
  const { client, transport } = makeFixture()
  const events = []
  transport.subscribe((event) => events.push(event))
  await transport.start()
  await transport.invoke('messages.listen', {})
  client.onSendText = (accountId, conversationId, content) => {
    client.emitMessage({ id: 'echo-auto-same-text', sessionId: conversationId, senderId: '10001', content: { contentType: 1, text: { text: content } } })
    return { id: 'send-result-id' }
  }
  await transport.invoke('messages.send.text', { conversationId: 'conversation-1', text: '好的' })
  client.emitMessage({ id: 'manual-ambiguous', sessionId: 'conversation-1', senderId: '10001', content: { contentType: 1, text: { text: '好的' } } })
  client.emitMessage({ id: 'manual-explicit', sessionId: 'conversation-1', senderId: '10001', isManual: true, content: { contentType: 1, text: { text: '好的' } } })
  assert.deepEqual(events.map((event) => event.payload.message.origin), ['automation', 'unknown', 'human'])
  await transport.stop()
})

test('GOOFISH_SEND_IMAGE only supports image MIME types', async () => {
  const { client, transport } = makeFixture()
  await transport.start()
  const unsupported = await transport.invoke('messages.send.file', { conversationId: 'conversation-1', data: 'Zm9v', name: 'x.pdf', mimeType: 'application/pdf' })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'NOT_SUPPORTED')
  const result = await transport.invoke('messages.send.file', { conversationId: 'conversation-1', dataUrl: 'data:image/png;base64,aGVsbG8=', name: 'x.png', mimeType: 'image/png' })
  assert.equal(result.ok, true)
  assert.equal(result.data.origin, 'automation')
  assert.equal(client.lastSendImage.image.data, 'aGVsbG8=')
  await transport.stop()
})

test('GOOFISH_PRODUCT_LIST, GOOFISH_PRODUCT_DEDUP, GOOFISH_PRODUCT_COMPLETE and detail use current catalog results', async () => {
  const product = { goodsId: 'g1', shopId: '10001', name: 'chair', price: 12.5, images: ['https://img.test/a.png'], onSale: true }
  const { client, transport } = makeFixture({ products: [product, product, { ...product, goodsId: 'g2', onSale: false }] })
  await transport.start()
  const list = await transport.invoke('products.list', {})
  assert.equal(list.ok, true)
  assert.equal(list.data.length, 1)
  assert.equal(list.data[0].externalId, 'g1')
  assert.equal(list.data[0].status, 'on_sale')
  const detail = await transport.invoke('products.detail', { id: 'g1' })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.externalId, 'g1')
  client.productError = new Error('商品分页未完成')
  const failed = await transport.invoke('products.list', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'PLATFORM_ERROR')
  await transport.stop()
})

test('GOOFISH_ACCOUNT_ISOLATION and GOOFISH_TRANSPORT_STOP_ISOLATION', async () => {
  const client = new FakeGoofishClient()
  const a = new GoofishTransport({ accountId: 'platform-a', clientAccountId: '10001', client })
  const b = new GoofishTransport({ accountId: 'platform-b', clientAccountId: '10002', client })
  const aEvents = []
  const bEvents = []
  a.subscribe((event) => aEvents.push(event))
  b.subscribe((event) => bEvents.push(event))
  await Promise.all([a.start(), b.start()])
  await Promise.all([a.invoke('messages.listen', {}), b.invoke('messages.listen', {})])
  client.emitMessage({ id: 'a-only', sessionId: 'c-a', senderId: 'buyer-a', content: 'A' }, '10001')
  assert.equal(aEvents.length, 1)
  assert.equal(bEvents.length, 0)
  await a.stop()
  client.emitMessage({ id: 'b-only', sessionId: 'c-b', senderId: 'buyer-b', content: 'B' }, '10002')
  assert.equal(aEvents.length, 1)
  assert.equal(bEvents.length, 1)
  await b.stop()
})

test('GOOFISH_ACCOUNT_MIGRATION preserves the transport account and partition-owned events', async () => {
  const { client, transport } = makeFixture()
  await transport.start()
  client.emit('event', { accountId: '10001', eventType: 'account-migrated', payload: { previousAccountId: '10001', accountId: '20002', account: { id: '20002', userId: '20002', status: 'authenticated' } } })
  assert.equal(transport.accountId, 'platform-account-a')
  assert.equal(transport.underlyingAccountId, '20002')
  assert.equal((await transport.invoke('auth.state', {})).ok, true)
  await transport.stop()
})

test('GOOFISH_MAIN_RUNTIME_INTEGRATION keeps two account transports isolated and replying in background', async () => {
  const client = new FakeGoofishClient()
  const replyCalls = []
  const manager = new ShopRuntimeManager({
    async reply(input) {
      replyCalls.push(input)
      return { type: 'reply', text: `AI:${input.content}` }
    },
  })
  const a = new GoofishTransport({ accountId: 'hub-a', clientAccountId: '10001', client })
  const b = new GoofishTransport({ accountId: 'hub-b', clientAccountId: '10002', client })
  manager.register('hub-a', a, { platform: 'goofish', shopName: '闲鱼 A' })
  manager.register('hub-b', b, { platform: 'goofish', shopName: '闲鱼 B' })
  await Promise.all([manager.setOnline('hub-a', true), manager.setOnline('hub-b', true)])

  let activeAccountId = 'hub-a'
  client.emitMessage({ id: 'b-inactive', sessionId: 'conversation-b', senderId: 'buyer-b', content: 'B 买家消息' }, '10002')
  await eventually(() => assert.equal(replyCalls.some((call) => call.accountId === 'hub-b'), true))
  await eventually(() => assert.equal(client.sentTexts.length, 1))
  assert.equal(activeAccountId, 'hub-a')
  assert.deepEqual(client.sentTexts.at(-1), { accountId: '10002', conversationId: 'conversation-b', text: 'AI:B 买家消息' })

  activeAccountId = 'hub-b'
  client.emitMessage({ id: 'a-after-switch', sessionId: 'conversation-a', senderId: 'buyer-a', content: 'A 买家消息' }, '10001')
  await eventually(() => assert.equal(replyCalls.some((call) => call.accountId === 'hub-a'), true))
  await eventually(() => assert.equal(client.sentTexts.length, 2))
  assert.equal(activeAccountId, 'hub-b')
  assert.deepEqual(client.sentTexts.at(-1), { accountId: '10001', conversationId: 'conversation-a', text: 'AI:A 买家消息' })

  await manager.stop('hub-a')
  const bCount = replyCalls.filter((call) => call.accountId === 'hub-b').length
  client.emitMessage({ id: 'b-after-a-stop', sessionId: 'conversation-b', senderId: 'buyer-b', content: 'B 仍在线' }, '10002')
  await eventually(() => assert.equal(replyCalls.filter((call) => call.accountId === 'hub-b').length, bCount + 1))
  await eventually(() => assert.equal(client.sentTexts.length, 3))
  assert.equal(manager.snapshot('hub-b').runtimeState, 'running')
  await manager.stop('hub-b')
})

test('GOOFISH_UNSUPPORTED_ORDER_HANDOFF_AND_ATTENTION_are explicit and do not break human reply decisions', async () => {
  const { client, transport } = makeFixture()
  await transport.start()
  assert.equal((await transport.invoke('orders.listen', {})).error.code, 'NOT_SUPPORTED')
  assert.equal((await transport.invoke('handoff.transfer', {})).error.code, 'NOT_SUPPORTED')
  assert.equal((await transport.invoke('conversation.attention.set', { conversationId: 'c', state: 'pending' })).error.code, 'NOT_SUPPORTED')
  await transport.stop()

  const manager = new ShopRuntimeManager({ async reply() { return { type: 'human_required', reason: 'operator-needed' } } })
  const humanTransport = new GoofishTransport({ accountId: 'hub-human', clientAccountId: '10001', client })
  manager.register('hub-human', humanTransport, { platform: 'goofish' })
  await manager.setOnline('hub-human', true)
  client.emitMessage({ id: 'human-required', sessionId: 'conversation-human', senderId: 'buyer', content: '请人工处理' })
  await eventually(() => assert.equal(manager.snapshot('hub-human').lastReplyType, 'human_required'))
  assert.equal(manager.snapshot('hub-human').runtimeState, 'running')
  await manager.stop('hub-human')
})

class FakeGoofishClient extends EventEmitter {
  constructor({ sessions = [], messages = [], products = [] } = {}) {
    super()
    this.sessions = sessions
    this.messages = messages
    this.products = products
    this.sentTexts = []
  }
  listAccounts() { return [{ id: '10001', userId: '10001', status: 'authenticated' }, { id: '10002', userId: '10002', status: 'authenticated' }] }
  async snapshot(accountId) { return { accountId, authenticated: true, userId: accountId, connected: true } }
  async listSessions() { return this.sessions }
  async listMessages(accountId, conversationId) {
    this.lastHistoryQuery = { accountId, conversationId }
    return this.messages
  }
  async sendText(accountId, conversationId, text) {
    this.lastSendText = { accountId, conversationId, text }
    this.sentTexts.push(this.lastSendText)
    return this.onSendText ? this.onSendText(accountId, conversationId, text) : { id: 'send-result' }
  }
  async sendImage(accountId, sessionId, image) {
    this.lastSendImage = { accountId, sessionId, image }
    return { content: {}, image: { url: 'https://img.test/upload.png' } }
  }
  async listOnSaleProducts() {
    if (this.productError) throw this.productError
    return this.products
  }
  emitMessage(payload, accountId = '10001') { this.emit('event', { accountId, eventType: 'message-added', payload }) }
}
