import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeHook } from '../packages/fake-hook/dist/index.js'
import { PageHookTransport } from '../packages/hook-transport/dist/index.js'
import { ShopRuntimeManager } from '../src/main/runtime/ShopRuntimeManager.ts'

function setup() {
  const replyCalls = []
  const replyApi = {
    async reply(input) {
      replyCalls.push(input)
      if (input.content === 'need-human') return { type: 'human_required', reason: 'operator-requested' }
      return { type: 'reply', text: `AI:${input.content}` }
    },
  }
  const manager = new ShopRuntimeManager(replyApi)
  const hooks = new Map()
  for (const accountId of ['shop-a', 'shop-b', 'shop-c']) {
    const hook = new FakeHook(accountId, { sessionId: `runtime-${accountId}` })
    hooks.set(accountId, hook)
    manager.register(accountId, new PageHookTransport({
      session: hook.session,
      disposeSession: () => hook.host.disposeSession(hook.session.sessionId),
    }))
  }
  return { manager, hooks, replyCalls }
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

test('INACTIVE_ONLINE_SHOP_AI_REPLY', async () => {
  const { manager, hooks, replyCalls } = setup()
  await manager.setOnline('shop-a', true)
  await manager.setOnline('shop-b', true)
  // The selected account belongs to the renderer; B must still work while A is selected.
  const activeAccountId = 'shop-a'
  hooks.get('shop-b').receiveMessage({ id: 'b-inactive', conversationId: 'conversation-b', content: 'B buyer' })
  await eventually(() => assert.equal(replyCalls.some((call) => call.accountId === 'shop-b'), true))
  assert.equal(activeAccountId, 'shop-a')
  assert.equal(manager.snapshot('shop-b').runtimeState, 'running')
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('ACTIVE_SWITCH_KEEPALIVE', async () => {
  const { manager, hooks, replyCalls } = setup()
  await manager.setOnline('shop-a', true)
  await manager.setOnline('shop-b', true)
  let activeAccountId = 'shop-a'
  activeAccountId = 'shop-b'
  hooks.get('shop-a').receiveMessage({ id: 'a-after-switch', conversationId: 'conversation-a', content: 'A buyer' })
  await eventually(() => assert.equal(replyCalls.some((call) => call.accountId === 'shop-a'), true))
  assert.equal(activeAccountId, 'shop-b')
  assert.equal(manager.snapshot('shop-a').runtimeState, 'running')
  assert.equal(manager.snapshot('shop-b').runtimeState, 'running')
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('OFFLINE_SHOP_NO_AI_REPLY', async () => {
  const { manager, hooks, replyCalls } = setup()
  await manager.setOnline('shop-a', true)
  hooks.get('shop-c').receiveMessage({ id: 'c-offline', conversationId: 'conversation-c', content: 'offline buyer' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(replyCalls.some((call) => call.accountId === 'shop-c'), false)
  assert.equal(manager.snapshot('shop-c').online, false)
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('MULTI_SHOP_CONCURRENT_REPLY', async () => {
  const { manager, hooks, replyCalls } = setup()
  await Promise.all(['shop-a', 'shop-b'].map((accountId) => manager.setOnline(accountId, true)))
  hooks.get('shop-a').receiveMessage({ id: 'a-concurrent', conversationId: 'conversation-a', content: 'A concurrent' })
  hooks.get('shop-b').receiveMessage({ id: 'b-concurrent', conversationId: 'conversation-b', content: 'B concurrent' })
  await eventually(() => assert.deepEqual(new Set(replyCalls.map((call) => call.accountId)), new Set(['shop-a', 'shop-b'])))
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('AUTOMATION_ECHO_NO_REENTRY', async () => {
  const { manager, hooks, replyCalls } = setup()
  await manager.setOnline('shop-a', true)
  hooks.get('shop-a').receiveMessage({ id: 'echo-source', conversationId: 'conversation-a', content: 'one reply only' })
  await eventually(() => assert.equal(replyCalls.length, 1))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(replyCalls.length, 1)
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('HUMAN_ATTENTION_LIFECYCLE', async () => {
  const { manager, hooks } = setup()
  await manager.setOnline('shop-a', true)
  hooks.get('shop-a').receiveMessage({ id: 'human-source', conversationId: 'conversation-a', content: 'need-human' })
  await eventually(() => assert.equal(manager.snapshot('shop-a').attention['conversation-a'], 'pending'))
  hooks.get('shop-a').sendHumanMessage({ conversationId: 'conversation-a', content: 'operator reply' })
  await eventually(() => assert.equal(manager.snapshot('shop-a').attention['conversation-a'], 'resolved'))
  await manager.stop('shop-a'); await manager.stop('shop-b'); await manager.stop('shop-c')
})

test('SHOP_LIFECYCLE_ISOLATION', async () => {
  const { manager, hooks, replyCalls } = setup()
  await manager.setOnline('shop-a', true)
  await manager.setOnline('shop-b', true)
  await manager.stop('shop-a')
  assert.equal(manager.snapshot('shop-a'), undefined)
  assert.equal(manager.snapshot('shop-b').runtimeState, 'running')
  hooks.get('shop-b').receiveMessage({ id: 'b-after-a-stop', conversationId: 'conversation-b', content: 'still alive' })
  await eventually(() => assert.equal(replyCalls.some((call) => call.accountId === 'shop-b'), true))
  await manager.stop('shop-b'); await manager.stop('shop-c')
})
