import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeHook } from '../packages/fake-hook/dist/index.js'
import { PageHookTransport } from '../packages/core-transport/dist/index.js'
import {
  DEFAULT_REPLY_API_URL,
  HttpShopReplyApi,
  parseReplyApiBody,
  ReplyApiError,
  ShopRuntimeManager,
} from '../src/main/runtime/ShopRuntimeManager.ts'

const input = {
  accountId: 'account-1',
  platform: 'douyin-shop',
  shopId: 'shop-123',
  shopName: '测试抖店',
  conversationId: 'conversation-1',
  content: '你好，想了解商品',
  customerId: 'buyer-123',
  customerName: '测试买家',
  message: { id: 'message-123', type: 'text', direction: 'inbound', content: '你好，想了解商品' },
}

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function replyBody(data) { return { code: 200, message: 'result', data } }

async function eventually(assertion, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { return assertion() } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw lastError || new Error('timed out')
}

test('Reply API sends the documented platform_data request and parses normal reply', async () => {
  let captured
  const api = new HttpShopReplyApi({
    fetcher: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) }
      return response(replyBody({ ai_reply: { reply_parts: ['Mock 默认回复'] } }))
    },
  })

  const decision = await api.reply(input)

  assert.equal(captured.url, DEFAULT_REPLY_API_URL)
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.headers['content-type'], 'application/json')
  assert.deepEqual(captured.body.platform_data, {
    platform_en: 'douyin-shop',
    shop_id: 'shop-123',
    shop_name: '测试抖店',
    customer_name: '测试买家',
    customer_id: 'buyer-123',
    messages: [{
      user_id: 'buyer-123',
      name: '测试买家',
      content: '你好，想了解商品',
      message_type: 'text',
      type: 'text',
      from: { id: 'buyer-123', name: '测试买家' },
    }],
    extra_context: { account_id: 'account-1', conversation_id: 'conversation-1', message_id: 'message-123' },
  })
  assert.deepEqual(decision, { type: 'reply', texts: ['Mock 默认回复'], fileUrls: [] })
})

test('Reply API parser handles multi-reply, silence, lifecycle, transfer, turn, malformed shapes', () => {
  assert.deepEqual(parseReplyApiBody(JSON.stringify(replyBody({ ai_reply: { reply_parts: ['您好', '有货'] } }))), {
    type: 'reply', texts: ['您好', '有货'], fileUrls: [],
  })
  assert.deepEqual(parseReplyApiBody(JSON.stringify(replyBody({ ai_reply: null }))), { type: 'ignore', reason: 'no-ai-reply' })

  const greeting = parseReplyApiBody(JSON.stringify(replyBody({
    ai_reply: null,
    lifecycle: { action: { kind: 'greeting', action_id: 'greeting-1', messages: ['欢迎'] } },
  })))
  assert.equal(greeting.type, 'reply')
  assert.equal(greeting.lifecycleAction.kind, 'greeting')
  assert.deepEqual(greeting.lifecycleAction.messages, ['欢迎'])

  const transfer = parseReplyApiBody(JSON.stringify(replyBody({
    ai_reply: { reply_parts: ['我帮您确认'], transfer: { is_transfer: true, transfer_person: { id: 'agent-1', name: '客服' }, transfer_messages: ['转接中'] } },
  })))
  assert.equal(transfer.type, 'reply')
  assert.equal(transfer.transfer.target.id, 'agent-1')
  assert.deepEqual(transfer.transfer.messages, ['转接中'])

  const withTurn = parseReplyApiBody(JSON.stringify(replyBody({
    turn: { turn_id: 'turn-1', should_process: true },
    ai_reply: { reply_parts: ['继续处理'] },
  })))
  assert.deepEqual(withTurn.turn, { turn_id: 'turn-1', should_process: true })
  assert.deepEqual(withTurn.texts, ['继续处理'])

  const skippedTurn = parseReplyApiBody(JSON.stringify(replyBody({
    turn: { turn_id: 'turn-2', should_process: false },
    ai_reply: { reply_parts: ['不能发送'] },
  })))
  assert.equal(skippedTurn.type, 'ignore')
  assert.equal(skippedTurn.turn.turn_id, 'turn-2')

  const malformedFields = parseReplyApiBody(JSON.stringify(replyBody({ ai_reply: { reply_parts: '不是数组', file_urls: 9 } })))
  assert.equal(malformedFields.type, 'ignore')
  assert.equal(malformedFields.warnings.length, 2)
  assert.equal(parseReplyApiBody(JSON.stringify({ code: 200, data: { foo: 'bar' } })).reason, 'unrecognized-response')
  assert.throws(() => parseReplyApiBody(''), (error) => error instanceof ReplyApiError && error.code === 'EMPTY_BODY')
  assert.throws(() => parseReplyApiBody('{ invalid mock JSON'), (error) => error instanceof ReplyApiError && error.code === 'INVALID_JSON')
})

test('Reply API retries 429/5xx only a bounded number of times and honors Retry-After', async () => {
  for (const status of [429, 500, 502, 503]) {
    let calls = 0
    const delays = []
    const api = new HttpShopReplyApi({
      fetcher: async () => { calls += 1; return response({ detail: `Mock ${status}` }, status, { 'retry-after': '0' }) },
      waitBeforeRetry: async (ms) => { delays.push(ms) },
    })
    await assert.rejects(api.reply(input), (error) => error instanceof ReplyApiError && error.code === `HTTP_${status}`)
    assert.equal(calls, 3, `HTTP ${status} should stop after three attempts`)
    assert.deepEqual(delays, [0, 0])
  }

  let calls = 0
  const noRetryApi = new HttpShopReplyApi({ fetcher: async () => { calls += 1; return response({ detail: 'Mock Bad Request' }, 400) } })
  await assert.rejects(noRetryApi.reply(input), (error) => error.code === 'HTTP_400')
  assert.equal(calls, 1)

  for (const status of [401, 403, 404]) {
    calls = 0
    const nonRetryApi = new HttpShopReplyApi({ fetcher: async () => { calls += 1; return response({ detail: `Mock ${status}` }, status) } })
    await assert.rejects(nonRetryApi.reply(input), (error) => error.code === `HTTP_${status}`)
    assert.equal(calls, 1, `HTTP ${status} must not be retried`)
  }

  calls = 0
  const respectLongRetryAfter = new HttpShopReplyApi({
    fetcher: async () => { calls += 1; return response({ detail: 'busy' }, 429, { 'retry-after': '60' }) },
    waitBeforeRetry: async () => assert.fail('must not retry before a 60s Retry-After'),
  })
  await assert.rejects(respectLongRetryAfter.reply(input), (error) => error.code === 'HTTP_429')
  assert.equal(calls, 1)
})

test('Reply API bounds network retries and turns empty/invalid bodies into typed errors', async () => {
  let calls = 0
  const networkApi = new HttpShopReplyApi({
    fetcher: async () => { calls += 1; throw new TypeError('socket disconnected') },
    waitBeforeRetry: async () => {},
  })
  await assert.rejects(networkApi.reply(input), (error) => error.code === 'NETWORK_ERROR')
  assert.equal(calls, 3)

  calls = 0
  const timeoutApi = new HttpShopReplyApi({
    fetcher: async () => { calls += 1; throw new DOMException('timed out', 'TimeoutError') },
    waitBeforeRetry: async () => {},
  })
  await assert.rejects(timeoutApi.reply(input), (error) => error.code === 'TIMEOUT')
  assert.equal(calls, 3)

  const emptyApi = new HttpShopReplyApi({ fetcher: async () => response('') })
  await assert.rejects(emptyApi.reply(input), (error) => error.code === 'EMPTY_BODY')
  const invalidApi = new HttpShopReplyApi({ fetcher: async () => response('{ invalid mock JSON') })
  await assert.rejects(invalidApi.reply(input), (error) => error.code === 'INVALID_JSON')
})

test('controlled Reply API responses exercise Hook send, file, attention and official handoff operations', async () => {
  const prompts = new Map([
    ['normal', replyBody({ ai_reply: { reply_parts: ['Mock 默认回复'] } })],
    ['multi', replyBody({ ai_reply: { reply_parts: ['第一条', '第二条', '第三条'] } })],
    ['silent', replyBody({ ai_reply: null })],
    ['greeting', replyBody({ ai_reply: null, lifecycle: { action: { kind: 'greeting', messages: ['欢迎光临'] } } })],
    ['farewell', replyBody({ ai_reply: null, lifecycle: { action: { kind: 'farewell', messages: ['祝您生活愉快'] } } })],
    ['map-card', replyBody({ ai_reply: null, lifecycle: { action: { kind: 'greeting', action_code: 2, messages: [], payload: { map_card: { title: '到店地址', latitude: 31.23, longitude: 121.47 } } } } })],
    ['turn', replyBody({ turn: { turn_id: 'turn-3', should_process: true }, ai_reply: { reply_parts: ['Turn mock response'] } })],
    ['bad-type', replyBody({ ai_reply: { reply_parts: '不能作为一条回复' } })],
    ['file', replyBody({ ai_reply: { reply_parts: ['图片资料在这里'], file_urls: ['https://cdn.example.test/guide.png'] } })],
    ['pdf', replyBody({ ai_reply: { reply_parts: ['PDF 资料'], file_urls: ['https://cdn.example.test/demo.pdf'] } })],
    ['handoff', replyBody({ ai_reply: { reply_parts: ['我帮您转接'], transfer: { is_transfer: true, transfer_person: { id: 'agent-1', name: 'Fake 客服' }, transfer_messages: ['请稍等'] } } })],
    ['unknown-target', replyBody({ ai_reply: { transfer: { is_transfer: true, transfer_person: { id: 'not-official', name: '未知客服' }, transfer_messages: ['正在处理'] } } })],
  ])
  const requests = []
  const api = new HttpShopReplyApi({
    endpoint: 'http://127.0.0.1:18021/api/v1/chats/reply',
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      return response(prompts.get(body.platform_data.messages.at(-1).content) || { unexpected: true })
    },
  })
  const manager = new ShopRuntimeManager(api, {
    fileLoader: async (url) => {
      if (url.endsWith('.pdf')) throw new Error('当前 Douyin Hook 暂不支持此附件类型: application/pdf')
      return { dataUrl: 'data:image/png;base64,aGVsbG8=', name: url.split('/').at(-1), mimeType: 'image/png' }
    },
  })
  const hook = new FakeHook('real-shop-123', { sessionId: 'reply-test-session' })
  manager.register('account-1', new PageHookTransport({ session: hook.session, disposeSession: () => hook.host.disposeSession(hook.session.sessionId) }), {
    platform: 'douyin-shop', shopName: '测试抖店',
  })
  const events = []
  manager.onEvent((event) => events.push(event))
  await manager.setOnline('account-1', true)
  const platformState = hook.factory.stateFor('real-shop-123')
  const sendMessage = async (content) => {
    const before = events.filter((event) => event.type === 'reply').length
    hook.receiveMessage({ id: `in-${content}`, conversationId: 'conversation-1', senderId: 'buyer-123', senderName: '测试买家', content })
    await eventually(() => assert.equal(events.filter((event) => event.type === 'reply').length, before + 1))
  }
  const outboundTexts = () => platformState.messages.filter((message) => message.direction === 'outbound' && message.type === 'text').map((message) => message.content)

  await sendMessage('normal')
  assert.equal(outboundTexts().at(-1), 'Mock 默认回复')
  await sendMessage('multi')
  assert.deepEqual(outboundTexts().slice(-3), ['第一条', '第二条', '第三条'])
  const beforeSilent = outboundTexts().length
  await sendMessage('silent')
  assert.equal(outboundTexts().length, beforeSilent)
  await sendMessage('greeting')
  assert.equal(outboundTexts().at(-1), '欢迎光临')
  await sendMessage('farewell')
  assert.equal(outboundTexts().at(-1), '祝您生活愉快')
  await sendMessage('map-card')
  const mapEvent = events.filter((event) => event.type === 'reply').at(-1)
  assert.equal(mapEvent.payload.unsupportedLifecycleAction, 'map-card')
  assert.equal(mapEvent.payload.lifecycleAction.payload.map_card.title, '到店地址')
  const beforeBadType = outboundTexts().length
  await sendMessage('bad-type')
  assert.equal(outboundTexts().length, beforeBadType)
  assert.ok(events.filter((event) => event.type === 'reply').at(-1).payload.warnings.length)

  await sendMessage('file')
  const uploaded = platformState.messages.filter((message) => message.direction === 'outbound' && message.type === 'file').at(-1)
  assert.equal(uploaded.content, 'guide.png')
  assert.equal(uploaded.attachments[0].mimeType, 'image/png')
  assert.equal(uploaded.attachments[0].url, undefined, 'base64 attachment data must not leak into FakeHook message events')
  const beforePdfFiles = platformState.messages.filter((message) => message.direction === 'outbound' && message.type === 'file').length
  await sendMessage('pdf')
  assert.equal(platformState.messages.filter((message) => message.direction === 'outbound' && message.type === 'file').length, beforePdfFiles)
  assert.match(events.filter((event) => event.type === 'reply').at(-1).payload.fileErrors[0], /不支持此附件类型/)

  await sendMessage('handoff')
  assert.equal(platformState.handoffs.length, 1)
  assert.equal(platformState.handoffs[0].transferred, true)
  assert.deepEqual(platformState.handoffs[0].target, { id: 'agent-1', name: 'Fake 客服' })
  assert.deepEqual(outboundTexts().slice(-2), ['我帮您转接', '请稍等'])
  await sendMessage('unknown-target')
  assert.equal(platformState.handoffs.length, 1, 'only a target in the official list may be transferred')
  assert.equal(manager.snapshot('account-1').attention['conversation-1'], 'pending')

  await sendMessage('turn')
  const turnEvent = events.filter((event) => event.type === 'reply').at(-1)
  assert.equal(turnEvent.payload.decision.turn.turn_id, 'turn-3')
  assert.equal(outboundTexts().at(-1), 'Turn mock response')
  assert.equal(requests.length, 12)
  assert.equal(requests[0].platform_data.shop_id, 'real-shop-123', 'auth.state shop id must replace the account-id fallback')

  await manager.stop('account-1')
  await hook.stop()
})

test('handoff history replay is deduped across accounts within one shop, but not across shops', async () => {
  const calls = []
  const manager = new ShopRuntimeManager({
    async reply(input) {
      calls.push(input)
      return { type: 'ignore', reason: 'test-only' }
    },
  })
  const source = new FakeHook('shared-shop', { sessionId: 'handoff-source' })
  const destination = new FakeHook('shared-shop', { sessionId: 'handoff-destination' })
  const separateShop = new FakeHook('separate-shop', { sessionId: 'handoff-separate-shop' })
  const register = (accountId, hook) => manager.register(accountId, new PageHookTransport({
    session: hook.session,
    disposeSession: () => hook.host.disposeSession(hook.session.sessionId),
  }), { platform: 'douyin-shop', shopName: accountId })
  register('source-account', source)
  register('destination-account', destination)
  register('separate-shop-account', separateShop)

  await Promise.all(['source-account', 'destination-account', 'separate-shop-account'].map((accountId) => manager.setOnline(accountId, true)))

  const oldMessages = [
    { id: 'before-transfer-1', conversationId: 'transferred-conversation', content: 'old message one' },
    { id: 'before-transfer-2', conversationId: 'transferred-conversation', content: 'old message two' },
  ]
  for (const [index, message] of oldMessages.entries()) {
    source.receiveMessage(message)
    await eventually(() => assert.equal(calls.length, index + 1))
  }

  // The destination account receives the conversation history again after
  // transfer, then a genuinely new buyer message. Only the new id may invoke
  // Reply API on the destination account.
  for (const message of oldMessages) destination.receiveMessage(message)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(calls.length, 2)
  destination.receiveMessage({ id: 'after-transfer-1', conversationId: 'transferred-conversation', content: 'new after transfer' })
  await eventually(() => assert.equal(calls.length, 3))
  assert.equal(calls[2].accountId, 'destination-account')
  assert.equal(calls[2].message.id, 'after-transfer-1')

  // Message ids are scoped by actual shop identity, so a different shop may
  // legitimately have the same conversation/message ids.
  separateShop.receiveMessage({ ...oldMessages[0], content: 'same ids, separate shop' })
  await eventually(() => assert.equal(calls.length, 4))
  assert.equal(calls[3].accountId, 'separate-shop-account')
  assert.deepEqual(calls.map((call) => call.message.id), [
    'before-transfer-1', 'before-transfer-2', 'after-transfer-1', 'before-transfer-1',
  ])

  await Promise.all(['source-account', 'destination-account', 'separate-shop-account'].map((accountId) => manager.stop(accountId)))
})

test('late Reply API response is not sent after shop goes offline', async () => {
  let resolveReply
  const replyApi = { reply: () => new Promise((resolve) => { resolveReply = resolve }) }
  const manager = new ShopRuntimeManager(replyApi)
  const hook = new FakeHook('real-shop-offline', { sessionId: 'offline-reply-session' })
  manager.register('account-offline', new PageHookTransport({ session: hook.session, disposeSession: () => hook.host.disposeSession(hook.session.sessionId) }))
  await manager.setOnline('account-offline', true)
  hook.receiveMessage({ id: 'pending-reply', conversationId: 'conversation-1', content: 'wait for reply api' })
  await eventually(() => assert.equal(typeof resolveReply, 'function'))
  await manager.setOnline('account-offline', false)
  resolveReply({ type: 'reply', texts: ['must not go out'] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(hook.factory.stateFor('real-shop-offline').messages.filter((message) => message.direction === 'outbound').length, 0)
  await manager.stop('account-offline')
  await hook.stop()
})

test('an unauthenticated Hook does not start the Reply API listener', async () => {
  let calls = 0
  const hook = new FakeHook('real-shop-logged-out', { sessionId: 'logged-out-reply-session' })
  hook.logout()
  const manager = new ShopRuntimeManager({ reply: async () => { calls += 1; return { type: 'reply', texts: ['must not send'] } } })
  manager.register('account-logged-out', new PageHookTransport({ session: hook.session, disposeSession: () => hook.host.disposeSession(hook.session.sessionId) }))

  await assert.rejects(manager.setOnline('account-logged-out', true), /LOGIN_REQUIRED/)
  hook.receiveMessage({ id: 'while-logged-out', content: 'hello' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 0)
  assert.equal(hook.factory.stateFor('real-shop-logged-out').messages.filter((message) => message.direction === 'outbound').length, 0)

  await manager.stop('account-logged-out')
  await hook.stop()
})
