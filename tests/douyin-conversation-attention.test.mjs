import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { HookHost } from '../packages/hook-host/dist/index.js'
import { douyinHookManifest, douyinHookRuntimeScript } from '../packages/douyin-hook/dist/index.js'

test('Douyin conversation attention keeps multiple native rows independent across state changes and rerenders', async () => {
  const harness = createAttentionHarness(['conversation-a', 'conversation-b'])
  const { runtime, dom } = harness

  const firstPending = await runtime.invoke('conversation.attention.set', {
    conversationId: 'conversation-a', state: 'pending',
  })
  assert.equal(firstPending.ok, true)
  assert.equal(firstPending.data.conversationId, 'conversation-a')
  assert.equal(firstPending.data.state, 'pending')
  assert.equal(firstPending.data.active, true)
  assertAttention(dom.row('conversation-a'), 'pending')

  await runtime.invoke('conversation.attention.set', { conversationId: 'conversation-b', state: 'pending' })
  assertAttention(dom.row('conversation-a'), 'pending')
  assertAttention(dom.row('conversation-b'), 'pending')
  dom.document.head.removeChild(dom.style('platform-hook-douyin-conversation-attention-style'))
  dom.notifyRerender()
  assert.ok(dom.style('platform-hook-douyin-conversation-attention-style'))

  const recycledRow = dom.row('conversation-a')
  recycledRow.setAttribute('data-conversation-id', 'untracked-conversation')
  dom.notifyRerender()
  assertNoAttention(recycledRow)
  recycledRow.setAttribute('data-conversation-id', 'conversation-a')
  dom.notifyRerender()
  assertAttention(recycledRow, 'pending')

  await runtime.invoke('conversation.attention.set', { conversationId: 'conversation-a', state: 'opened' })
  assertAttention(dom.row('conversation-a'), 'opened')
  assertAttention(dom.row('conversation-b'), 'pending')

  await runtime.invoke('conversation.attention.set', { conversationId: 'conversation-a', state: 'resolved' })
  assertNoAttention(dom.row('conversation-a'))
  assertAttention(dom.row('conversation-b'), 'pending')

  dom.replaceRows(['conversation-a', 'conversation-b'])
  dom.notifyRerender()
  assertNoAttention(dom.row('conversation-a'))
  assertAttention(dom.row('conversation-b'), 'pending')

  await runtime.dispose()
})

test('Douyin conversation attention waits for an unknown native row and never restores a resolved row', async () => {
  const { runtime, dom } = createAttentionHarness([])

  const pending = await runtime.invoke('conversation.attention.set', {
    conversationId: 'future-conversation', state: 'pending',
  })
  assert.equal(pending.ok, true)
  assert.equal(dom.rows.length, 0)

  dom.replaceRows(['future-conversation'])
  dom.notifyRerender()
  assertAttention(dom.row('future-conversation'), 'pending')

  await runtime.invoke('conversation.attention.set', { conversationId: 'future-conversation', state: 'resolved' })
  assertNoAttention(dom.row('future-conversation'))
  dom.replaceRows(['future-conversation'])
  dom.notifyRerender()
  assertNoAttention(dom.row('future-conversation'))

  await runtime.dispose()
})

test('Douyin conversation attention is isolated per runtime and releases native resources on disposal', async () => {
  const first = createAttentionHarness(['shared-conversation'])
  const second = createAttentionHarness(['shared-conversation'])

  await first.runtime.invoke('conversation.attention.set', { conversationId: 'shared-conversation', state: 'pending' })
  assertAttention(first.dom.row('shared-conversation'), 'pending')
  assertNoAttention(second.dom.row('shared-conversation'))

  await second.runtime.invoke('conversation.attention.set', { conversationId: 'shared-conversation', state: 'opened' })
  assertAttention(second.dom.row('shared-conversation'), 'opened')

  const firstObserver = first.dom.observers.at(-1)
  assert.ok(firstObserver)
  assert.ok(first.dom.style('platform-hook-douyin-conversation-attention-style'))
  await first.runtime.dispose()
  assert.equal(firstObserver.disconnected, true)
  assert.equal(first.dom.style('platform-hook-douyin-conversation-attention-style'), undefined)
  assertNoAttention(first.dom.row('shared-conversation'))
  assertAttention(second.dom.row('shared-conversation'), 'opened')

  await second.runtime.dispose()
})

test('Douyin conversation attention resolves a virtual row through its React conversation payload', async () => {
  const { runtime, dom } = createAttentionHarness(['react-conversation'])
  const row = dom.row('react-conversation')
  row.removeAttribute('data-conversation-id')
  row.__reactProps$attention = { conversation: { id: 'react-conversation' } }

  await runtime.invoke('conversation.attention.set', { conversationId: 'react-conversation', state: 'opened' })
  assertAttention(row, 'opened')
  await runtime.dispose()
})

test('Douyin conversation attention resolves a legacy React internal instance payload', async () => {
  const { runtime, dom } = createAttentionHarness(['legacy-react-conversation'])
  const row = dom.row('legacy-react-conversation')
  row.removeAttribute('data-conversation-id')
  row.__reactInternalInstance$attention = {
    memoizedProps: { conversation: { id: 'legacy-react-conversation' } },
  }

  await runtime.invoke('conversation.attention.set', { conversationId: 'legacy-react-conversation', state: 'pending' })
  assertAttention(row, 'pending')
  await runtime.dispose()
})

test('Douyin conversation attention resolves a ConversationCard React key to its full conversation id', async () => {
  const conversationId = 'buyer-card:shop-attention::2:1:pigeon'
  const { runtime, dom } = createAttentionHarness([conversationId])
  const row = dom.row(conversationId)
  row.removeAttribute('data-conversation-id')
  row.__reactInternalInstance$attention = {
    key: '',
    return: {
      key: 'buyer-card',
      return: null,
    },
  }

  await runtime.invoke('conversation.attention.set', { conversationId, state: 'opened' })
  assertAttention(row, 'opened')
  await runtime.dispose()
})

test('Douyin conversation attention coalesces observer echoes and repairs a platform class overwrite', async () => {
  const { runtime, dom } = createAttentionHarness(['conversation-a'])
  const row = dom.row('conversation-a')
  await runtime.invoke('conversation.attention.set', { conversationId: 'conversation-a', state: 'pending' })
  const writesAfterSet = row.attentionWrites()

  dom.notifyRerender()
  assert.equal(row.attentionWrites(), writesAfterSet)

  row.classList.remove('platform-hook-douyin-conversation-attention', 'platform-hook-douyin-conversation-attention--pending')
  row.removeAttribute('data-platform-hook-conversation-attention')
  dom.notifyRerender()
  assertAttention(row, 'pending')
  await runtime.dispose()
})

test('Douyin conversation attention is isolated across HookSessions on one HookHost', async () => {
  const firstDom = createNativeConversationDom(['shared-conversation'])
  const secondDom = createNativeConversationDom(['shared-conversation'])
  const host = new HookHost({
    pageFactory: new AttentionPageFactory(new Map([
      ['attention-shop-a', firstDom],
      ['attention-shop-b', secondDom],
    ])),
  })
  const first = host.createSession(douyinHookManifest, {
    sessionId: 'attention-session-a',
    shopId: 'attention-shop-a',
    partition: 'persist:attention-shop-a',
  })
  const second = host.createSession(douyinHookManifest, {
    sessionId: 'attention-session-b',
    shopId: 'attention-shop-b',
    partition: 'persist:attention-shop-b',
  })
  await Promise.all([first.start(), second.start()])

  assert.equal((await first.invoke('conversation.attention.set', {
    conversationId: 'shared-conversation', state: 'pending',
  })).ok, true)
  assertAttention(firstDom.row('shared-conversation'), 'pending')
  assertNoAttention(secondDom.row('shared-conversation'))

  assert.equal((await second.invoke('conversation.attention.set', {
    conversationId: 'shared-conversation', state: 'opened',
  })).ok, true)
  assertAttention(firstDom.row('shared-conversation'), 'pending')
  assertAttention(secondDom.row('shared-conversation'), 'opened')

  await host.disposeSession(first.sessionId)
  assertNoAttention(firstDom.row('shared-conversation'))
  assertAttention(secondDom.row('shared-conversation'), 'opened')
  await host.dispose()
})

function createAttentionHarness(conversationIds) {
  const dom = createNativeConversationDom(conversationIds)
  const context = attentionVmContext(dom)
  vm.runInContext(douyinHookRuntimeScript, context)
  return { runtime: context.window.__PLATFORM_HOOK__, dom }
}

function attentionVmContext(dom) {
  return vm.createContext({
    location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
    window: {
      __PLATFORM_HOOK_PAGE_ID__: 'primary',
      location: { hostname: 'im.jinritemai.com', pathname: '/pc_seller_v2/main/workspace', search: '' },
      document: dom.document,
      MutationObserver: dom.MutationObserver,
      ss: { _frontStore: { shopInfo: { id: 'shop-attention' }, selfInfo: { id: 'staff-attention' } } },
      localStorage: { getItem() { return null } },
    },
    Date,
    JSON,
    Map,
    Set,
  })
}

class AttentionPageFactory {
  constructor(domByShop) { this.domByShop = domByShop }

  async create(context) {
    const dom = this.domByShop.get(context.shopId)
    if (!dom) throw new Error(`Missing DOM for ${context.shopId}`)
    return new AttentionPage(context, attentionVmContext(dom))
  }
}

class AttentionPage {
  constructor(context, vmContext) {
    this.id = context.definition.id
    this.partition = context.partition
    this.definition = context.definition
    this.vmContext = vmContext
    this.alive = true
  }

  async installRuntime() {
    vm.runInContext(douyinHookRuntimeScript, this.vmContext)
    return this.vmContext.window.__PLATFORM_HOOK__
  }

  async show() {}
  async waitForRuntimeReady() {}
  async close() { this.alive = false }
  isAlive() { return this.alive }
}

function createNativeConversationDom(conversationIds) {
  const styles = new Map()
  const observers = []
  let rows = conversationIds.map(createNativeConversationRow)
  const head = {
    appendChild(node) {
      node.parentNode = head
      styles.set(node.id, node)
      return node
    },
    removeChild(node) {
      if (node.parentNode !== head) throw new Error('node is not attached')
      node.parentNode = null
      styles.delete(node.id)
      return node
    },
  }
  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }

    observe(target, options) {
      this.target = target
      this.options = options
    }

    disconnect() { this.disconnected = true }
  }
  const document = {
    head,
    documentElement: {},
    body: head,
    createElement() { return { id: '', textContent: '', parentNode: null } },
    getElementById(id) { return styles.get(id) },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-kora="conversation"], [data-qa-id="qa-chat-item"]')
      return rows
    },
  }
  return {
    document,
    MutationObserver,
    observers,
    get rows() { return rows },
    row(conversationId) { return rows.find((row) => row.getAttribute('data-conversation-id') === conversationId) },
    replaceRows(conversationIds) { rows = conversationIds.map(createNativeConversationRow) },
    notifyRerender() {
      for (const observer of observers) if (!observer.disconnected) observer.callback([{ type: 'childList' }])
    },
    style(id) { return styles.get(id) },
  }
}

function createNativeConversationRow(conversationId) {
  const attributes = new Map([
    ['data-kora', 'conversation'],
    ['data-conversation-id', conversationId],
  ])
  const classes = new Set()
  let attentionWrites = 0
  const dataset = { conversationId }
  const datasetKey = (name) => name.startsWith('data-')
    ? name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    : undefined
  return {
    dataset,
    get attributes() { return [...attributes].map(([name, value]) => ({ name, value })) },
    getAttribute(name) { return attributes.get(name) ?? null },
    setAttribute(name, value) {
      if (name === 'data-platform-hook-conversation-attention' && attributes.get(name) !== String(value)) attentionWrites += 1
      attributes.set(name, String(value))
      const key = datasetKey(name)
      if (key) dataset[key] = String(value)
    },
    removeAttribute(name) {
      if (name === 'data-platform-hook-conversation-attention' && attributes.has(name)) attentionWrites += 1
      attributes.delete(name)
      const key = datasetKey(name)
      if (key) delete dataset[key]
    },
    classList: {
      add(...names) { names.forEach((name) => { if (!classes.has(name)) { classes.add(name); if (name.startsWith('platform-hook-douyin-conversation-attention')) attentionWrites += 1 } }) },
      remove(...names) { names.forEach((name) => { if (classes.delete(name) && name.startsWith('platform-hook-douyin-conversation-attention')) attentionWrites += 1 }) },
      contains(name) { return classes.has(name) },
    },
    attentionWrites() { return attentionWrites },
  }
}

function assertAttention(row, state) {
  assert.ok(row)
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention'), true)
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention--pending'), state === 'pending')
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention--opened'), state === 'opened')
  assert.equal(row.getAttribute('data-platform-hook-conversation-attention'), state)
}

function assertNoAttention(row) {
  assert.ok(row)
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention'), false)
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention--pending'), false)
  assert.equal(row.classList.contains('platform-hook-douyin-conversation-attention--opened'), false)
  assert.equal(row.getAttribute('data-platform-hook-conversation-attention'), null)
}
