import assert from 'node:assert/strict'
import test from 'node:test'
import { HookHost } from '../packages/core-page-host/dist/index.js'
import { FakeHookPageFactory, fakeHookManifest } from '../packages/fake-hook/dist/index.js'
import { HOOK_PROTOCOL_VERSION } from '../packages/core-sdk/dist/index.js'
import { createDouyinPageRuntime } from '../packages/douyin-hook/dist/index.js'

test('two sessions isolate auth, events, workers, restart and disposal on one host', async () => {
  const factory = new FakeHookPageFactory()
  factory.setAuthenticated('shop-a', true)
  factory.setAuthenticated('shop-b', false)
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 1 })
  const createA = () => host.createSession(fakeHookManifest, {
    sessionId: 'multi-session-a',
    shopId: 'shop-a',
    partition: 'persist:multi-shop-a',
    maxWorkers: 1,
    eventPolling: false,
  })
  const a = createA()
  const b = host.createSession(fakeHookManifest, {
    sessionId: 'multi-session-b',
    shopId: 'shop-b',
    partition: 'persist:multi-shop-b',
    maxWorkers: 1,
    eventPolling: false,
  })
  const aEvents = []
  const bEvents = []
  a.subscribe((event) => aEvents.push(event))
  b.subscribe((event) => bEvents.push(event))
  await Promise.all([a.start(), b.start()])

  assert.equal(host.sessionCount, 2)
  assert.notEqual(a.partition, b.partition)
  assert.equal((await a.invoke('auth.state')).data.authenticated, true)
  assert.equal((await b.invoke('auth.state')).data.authenticated, false)
  factory.setAuthenticated('shop-b', true)
  assert.equal((await a.invoke('auth.state')).data.authenticated, true)
  assert.equal((await b.invoke('auth.state')).data.authenticated, true)

  factory.emitIncomingMessage('shop-a', { id: 'only-a', content: 'HOOK_MULTI_A' })
  assert.equal(aEvents.some((event) => event.payload?.message?.id === 'only-a'), true)
  assert.equal(bEvents.some((event) => event.payload?.message?.id === 'only-a'), false)
  factory.emitIncomingMessage('shop-b', { id: 'only-b', content: 'HOOK_MULTI_B' })
  assert.equal(bEvents.some((event) => event.payload?.message?.id === 'only-b'), true)
  assert.equal(aEvents.some((event) => event.payload?.message?.id === 'only-b'), false)

  const sameText = 'same outbound content'
  assert.equal((await a.invoke('messages.send.text', { conversationId: 'conversation-1', text: sameText })).data.origin, 'automation')
  assert.equal((await b.invoke('messages.send.text', { conversationId: 'conversation-1', text: sameText })).data.origin, 'automation')
  assert.equal(aEvents.filter((event) => event.payload?.message?.content === sameText).length, 1)
  assert.equal(bEvents.filter((event) => event.payload?.message?.content === sameText).length, 1)

  factory.setOperationDelay('shop-a', 'products', 'products.list', 30)
  factory.setOperationDelay('shop-b', 'products', 'products.list', 30)
  let maxActive = 0
  const monitor = setInterval(() => { maxActive = Math.max(maxActive, host.scheduler.activeCount) }, 1)
  await Promise.all([a.invoke('products.list'), b.invoke('products.list')])
  clearInterval(monitor)
  assert.equal(maxActive, 1)
  assert.equal(host.scheduler.concurrencyLimit, 1)
  const workerPartitions = factory.pages.filter((page) => page.id === 'products').map((page) => page.partition).sort()
  assert.deepEqual(workerPartitions, ['persist:multi-shop-a', 'persist:multi-shop-b'])

  await host.disposeSession(a.sessionId)
  assert.equal(b.isStarted, true)
  assert.equal((await b.invoke('auth.state')).data.authenticated, true)
  const restartedA = createA()
  await restartedA.start()
  assert.equal(restartedA.partition, 'persist:multi-shop-a')
  assert.equal((await b.invoke('sessions.list')).ok, true)

  await host.disposeSession(restartedA.sessionId)
  assert.equal((await b.invoke('auth.state')).data.authenticated, true)
  const recreatedA = createA()
  await recreatedA.start()
  assert.equal(host.sessionCount, 2)
  assert.equal((await recreatedA.invoke('auth.state')).data.authenticated, true)
  await host.dispose()
})

test('Douyin outbound correlation trackers are independent per runtime', async () => {
  const eventsA = []
  const eventsB = []
  const runtimeA = runtimeWithEvents(eventsA)
  const runtimeB = runtimeWithEvents(eventsB)
  const content = 'same text across shops'

  await runtimeA.invoke('messages.send.text', { conversationId: 'conversation', text: content })
  eventsB.push(messageEvent('b-before-send', content))
  assert.equal((await runtimeB.drainEvents())[0].payload.message.origin, 'unknown')
  eventsA.push(messageEvent('a-echo', content))
  assert.equal((await runtimeA.drainEvents())[0].payload.message.origin, 'automation')

  await runtimeB.invoke('messages.send.text', { conversationId: 'conversation', text: content })
  eventsA.push(messageEvent('a-after-consume', content))
  assert.equal((await runtimeA.drainEvents())[0].payload.message.origin, 'unknown')
  eventsB.push(messageEvent('b-echo', content))
  assert.equal((await runtimeB.drainEvents())[0].payload.message.origin, 'automation')
  await Promise.all([runtimeA.dispose(), runtimeB.dispose()])
})

function runtimeWithEvents(events) {
  return createDouyinPageRuntime({
    description: {
      protocolVersion: HOOK_PROTOCOL_VERSION,
      platform: 'douyin',
      pageId: 'primary',
      capabilities: ['messages.send.text'],
      operations: ['messages.send.text'],
    },
    async evaluate(expression) {
      if (expression.includes('.invoke(')) return {
        ok: true,
        data: { id: 'returned', conversationId: 'conversation', content: 'sent', type: 'text', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: Date.now() },
      }
      if (expression.includes('.drainEvents(')) return events.splice(0)
      return undefined
    },
  })
}

function messageEvent(id, content) {
  return {
    type: 'message.created',
    timestamp: Date.now(),
    payload: {
      message: { id, conversationId: 'conversation', content, type: 'text', direction: 'outbound', origin: 'unknown', deliveryStatus: 'sent', timestamp: Date.now() },
    },
  }
}
