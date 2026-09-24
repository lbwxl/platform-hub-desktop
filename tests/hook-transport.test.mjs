import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeHookPageFactory, fakeHookManifest } from '../packages/fake-hook/dist/index.js'
import { HookHost } from '../packages/core-page-host/dist/index.js'
import { PageHookTransport } from '../packages/core-transport/dist/index.js'

test('PageHookTransport delegates start once and preserves invoke results', async () => {
  const spy = createSpySession()
  const released = []
  const transport = new PageHookTransport({
    session: spy,
    disposeSession: async () => { released.push('session') },
  })
  const input = { conversationId: 'conversation-1', text: 'transport passthrough' }

  await Promise.all([transport.start(), transport.start(), transport.start()])
  assert.equal(spy.startCalls, 1)

  const success = { ok: true, data: { id: 'message-1', deliveryStatus: 'sent' } }
  spy.nextResult = success
  assert.equal(await transport.invoke('messages.send.text', input), success)
  assert.deepEqual(spy.invocations, [{ operation: 'messages.send.text', input }])

  for (const [code, retryable] of [
    ['LOGIN_REQUIRED', true],
    ['CHALLENGE_REQUIRED', true],
    ['RUNTIME_NOT_READY', true],
    ['INVALID_INPUT', false],
    ['PLATFORM_ERROR', true],
    ['TIMEOUT', true],
  ]) {
    const failure = { ok: false, error: { code, message: `${code} preserved`, retryable } }
    spy.nextResult = failure
    assert.equal(await transport.invoke('auth.state', {}), failure)
  }

  await transport.stop()
  assert.deepEqual(released, ['session'])
  const afterStop = await transport.invoke('auth.state', {})
  assert.equal(afterStop.ok, false)
  assert.equal(afterStop.error.code, 'RUNTIME_NOT_READY')
})

test('PageHookTransport subscriptions isolate consumers and stop cleans event forwarding', async () => {
  const spy = createSpySession()
  let disposeCalls = 0
  const transport = new PageHookTransport({
    session: spy,
    disposeSession: async () => { disposeCalls += 1 },
  })
  const first = []
  const second = []
  const unsubscribeFirst = transport.subscribe((event) => first.push(event))
  const unsubscribeSecond = transport.subscribe((event) => second.push(event))
  const firstEvent = messageEvent('first')

  spy.emit(firstEvent)
  assert.deepEqual(first, [firstEvent])
  assert.deepEqual(second, [firstEvent])
  unsubscribeFirst()

  const secondEvent = messageEvent('second')
  spy.emit(secondEvent)
  assert.deepEqual(first, [firstEvent])
  assert.deepEqual(second, [firstEvent, secondEvent])
  unsubscribeSecond()

  await Promise.all([transport.stop(), transport.stop()])
  assert.equal(disposeCalls, 1)
  assert.equal(spy.unsubscribeCalls, 1)
  spy.emit(messageEvent('after-stop'))
  assert.equal(second.length, 2)
  await assert.rejects(transport.start(), /已停止/)
})

test('PageHookTransport uses FakeHook sessions without cross-shop lifecycle or event leakage', async () => {
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 1 })
  const sessionA = host.createSession(fakeHookManifest, {
    sessionId: 'transport-session-a',
    shopId: 'transport-shop-a',
    partition: 'persist:transport-a',
    eventPolling: false,
  })
  const sessionB = host.createSession(fakeHookManifest, {
    sessionId: 'transport-session-b',
    shopId: 'transport-shop-b',
    partition: 'persist:transport-b',
    eventPolling: false,
  })
  const transportA = createPageTransport(host, sessionA)
  const transportB = createPageTransport(host, sessionB)
  const eventsA = []
  const eventsB = []
  transportA.subscribe((event) => eventsA.push(event))
  transportB.subscribe((event) => eventsB.push(event))

  await Promise.all([transportA.start(), transportB.start()])
  assert.equal(host.sessionCount, 2)
  assert.equal((await transportA.invoke('messages.send.text', {
    conversationId: 'conversation-1',
    text: 'transport isolated message',
  })).ok, true)
  assert.equal(eventsA.some((event) => event.payload?.message?.content === 'transport isolated message'), true)
  assert.equal(eventsB.some((event) => event.payload?.message?.content === 'transport isolated message'), false)

  factory.emitIncomingMessage('transport-shop-b', { id: 'transport-b-only', content: 'only B' })
  assert.equal(eventsA.some((event) => event.payload?.message?.id === 'transport-b-only'), false)
  assert.equal(eventsB.some((event) => event.payload?.message?.id === 'transport-b-only'), true)

  await transportA.stop()
  assert.equal(sessionA.isDisposed, true)
  assert.equal(host.getSession(sessionA.sessionId), undefined)
  assert.equal(host.sessionCount, 1)
  assert.equal(sessionB.isStarted, true)
  assert.equal((await transportA.invoke('auth.state', {})).error.code, 'RUNTIME_NOT_READY')
  assert.equal((await transportB.invoke('products.list', {})).ok, true)

  await transportB.stop()
  assert.equal(host.sessionCount, 0)
  await host.dispose()
})

function createPageTransport(host, session) {
  return new PageHookTransport({
    session,
    disposeSession: () => host.disposeSession(session.sessionId),
  })
}

function createSpySession() {
  const listeners = new Set()
  return {
    startCalls: 0,
    unsubscribeCalls: 0,
    invocations: [],
    nextResult: { ok: true, data: undefined },
    async start() { this.startCalls += 1 },
    async invoke(operation, input) {
      this.invocations.push({ operation, input })
      return this.nextResult
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        this.unsubscribeCalls += 1
        listeners.delete(listener)
      }
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

function messageEvent(id) {
  return {
    id,
    type: 'message.created',
    timestamp: 1,
    payload: {
      message: {
        id,
        conversationId: 'conversation-1',
        content: id,
        type: 'text',
        direction: 'inbound',
        origin: 'customer',
        timestamp: 1,
      },
    },
  }
}
