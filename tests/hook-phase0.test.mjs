import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FakeHook, FakeHookPageFactory, fakeHookManifest } from '../packages/fake-hook/dist/index.js'
import { HookHost } from '../packages/hook-host/dist/index.js'
import { validateHookManifest } from '../packages/hook-sdk/dist/index.js'
import { registerHookContractTests } from './hook-contract-suite.mjs'

const createHarness = async (shopId = 'contract-shop', options = {}) => {
  const fake = new FakeHook(shopId, options)
  if (!options.deferStart) await fake.start()
  return { fake, session: fake.session, factory: fake.factory, stop: () => fake.stop() }
}

registerHookContractTests('FakeHook', createHarness)

test('optional capabilities and manifest consistency validation', () => {
  const minimal = {
    platform: 'minimal',
    version: '1.0.0',
    capabilities: ['auth.state'],
    pages: [{ id: 'primary', kind: 'primary' }],
    operations: { 'auth.state': { page: 'primary', capability: 'auth.state' } },
  }
  assert.deepEqual(validateHookManifest(minimal), [])
  assert.deepEqual(validateHookManifest(fakeHookManifest), [])

  const missingRoute = { ...minimal, operations: {} }
  assert.match(validateHookManifest(missingRoute).join('\n'), /缺少 Operation 路由/)
  const undeclaredOperation = {
    ...minimal,
    operations: {
      ...minimal.operations,
      'products.list': { page: 'primary', capability: 'products.list' },
    },
  }
  assert.match(validateHookManifest(undeclaredOperation).join('\n'), /未声明对应 Capability/)
  const unknownPage = {
    ...minimal,
    operations: { 'auth.state': { page: 'missing', capability: 'auth.state' } },
  }
  assert.match(validateHookManifest(unknownPage).join('\n'), /指向未知页面/)
  const mismatch = {
    ...minimal,
    capabilities: ['auth.state', 'sessions.list'],
    operations: {
      'auth.state': { page: 'primary', capability: 'sessions.list' },
      'sessions.list': { page: 'primary', capability: 'sessions.list' },
    },
  }
  assert.match(validateHookManifest(mismatch).join('\n'), /capability 不匹配/)
})

test('async drainEvents provides polling fallback while push remains preferred', async () => {
  const push = await createHarness('push-shop')
  const pushed = []
  push.session.subscribe((event) => pushed.push(event))
  push.fake.receiveMessage({ content: 'push' })
  assert.equal(pushed.length, 1)
  await push.session.pollEvents()
  assert.equal(push.factory.drainCount, 0)
  await push.stop()

  const fallback = await createHarness('fallback-shop', { pushEvents: false })
  const polled = []
  fallback.session.subscribe((event) => polled.push(event))
  fallback.fake.receiveMessage({ content: 'poll' })
  assert.equal(polled.length, 0)
  const pendingDrain = fallback.session.pollEvents()
  assert.equal(pendingDrain instanceof Promise, true)
  assert.equal(await pendingDrain, 1)
  assert.equal(polled.length, 1)
  assert.ok(fallback.factory.drainCount >= 1)
  await fallback.stop()
})

test('adaptive polling prevents reentry and dispose stops timers and listeners', async () => {
  const factory = new FakeHookPageFactory({ pushEvents: false, drainDelayMs: 40 })
  const host = new HookHost({ pageFactory: factory })
  const session = host.createSession(fakeHookManifest, {
    sessionId: 'poll-session',
    shopId: 'poll-shop',
    eventPolling: { initialIntervalMs: 25, activeIntervalMs: 25, idleIntervalMs: 60, backoffMultiplier: 2 },
  })
  await session.start()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(factory.maxActiveDrains, 1)
  await host.dispose()
  const drainsAfterDispose = factory.drainCount
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(factory.drainCount, drainsAfterDispose)
  assert.equal(factory.subscriptionCount, 0)
})

test('HookHost owns sessions and disposes sessions before its global scheduler', async () => {
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 2 })
  const a = host.createSession(fakeHookManifest, { sessionId: 'session-a', shopId: 'shop-a', eventPolling: false })
  const b = host.createSession(fakeHookManifest, { sessionId: 'session-b', shopId: 'shop-b', eventPolling: false })
  await Promise.all([a.start(), b.start()])
  assert.equal(host.sessionCount, 2)
  assert.equal(host.getSession('session-a'), a)
  assert.notEqual(a.partition, b.partition)
  assert.equal(await host.disposeSession('session-a'), true)
  assert.equal(host.getSession('session-a'), undefined)
  assert.equal(host.sessionCount, 1)
  await host.dispose()
  assert.equal(host.sessionCount, 0)
  assert.equal(b.isDisposed, true)
  assert.equal(factory.subscriptionCount, 0)
  await assert.rejects(
    host.scheduler.schedule({
      manager: b.workerPages,
      page: fakeHookManifest.pages.find((page) => page.id === 'products'),
      run: async () => null,
    }),
    (error) => error?.code === 'RUNTIME_NOT_READY',
  )
})

test('one HookHost enforces global worker concurrency across three shops', async () => {
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 2 })
  const sessions = ['a', 'b', 'c'].map((suffix) => host.createSession(fakeHookManifest, {
    sessionId: `session-${suffix}`,
    shopId: `shop-${suffix}`,
    eventPolling: false,
  }))
  await Promise.all(sessions.map((session) => session.start()))
  for (const session of sessions) factory.setOperationDelay(session.shopId, 'products', 'products.list', 35)

  let observedMax = 0
  const monitor = setInterval(() => { observedMax = Math.max(observedMax, host.scheduler.activeCount) }, 1)
  const results = await Promise.all(sessions.map((session) => session.invoke('products.list')))
  clearInterval(monitor)
  observedMax = Math.max(observedMax, host.scheduler.activeCount)
  assert.equal(results.every((result) => result.ok), true)
  assert.equal(observedMax, 2)
  assert.equal(host.scheduler.concurrencyLimit, 2)
  await host.dispose()
})

test('one failed shop operation does not affect sibling sessions', async () => {
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 2 })
  const failedSession = host.createSession(fakeHookManifest, { sessionId: 'failed-session', shopId: 'failed-shop' })
  const healthySession = host.createSession(fakeHookManifest, { sessionId: 'healthy-session', shopId: 'healthy-shop' })
  await Promise.all([failedSession.start(), healthySession.start()])
  factory.failNext('failed-shop', 'products', 'products.list')
  const [failed, healthy] = await Promise.all([
    failedSession.invoke('products.list'),
    healthySession.invoke('products.list'),
  ])
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'PLATFORM_ERROR')
  assert.equal(healthy.ok, true)
  await host.dispose()
})

test('WorkerScheduler honors global priority timeout and queued abort', async () => {
  const fake = new FakeHook('scheduler-shop', { maxWorkerConcurrency: 1 })
  await fake.start()
  const scheduler = fake.host.scheduler
  const manager = fake.session.workerPages
  const page = fakeHookManifest.pages.find((item) => item.id === 'products')
  const orderPage = fakeHookManifest.pages.find((item) => item.id === 'orders')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const order = []
  const blocker = scheduler.schedule({ manager, page, priority: 'product', run: async () => { await gate; order.push('blocker') } })
  const product = scheduler.schedule({ manager, page, priority: 'product', run: async () => { order.push('product') } })
  const orderTask = scheduler.schedule({ manager, page: orderPage, priority: 'order', run: async () => { order.push('order') } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  release()
  await Promise.all([blocker, product, orderTask])
  assert.deepEqual(order, ['blocker', 'order', 'product'])

  await assert.rejects(
    scheduler.schedule({
      manager,
      page,
      timeoutMs: 10,
      run: async (_lease, signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
    }),
    (error) => error?.code === 'TIMEOUT',
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.workerPageIds().includes('products'), false)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    scheduler.schedule({ manager, page, signal: controller.signal, run: async () => null }),
    (error) => error?.code === 'TIMEOUT',
  )
  await fake.stop()
})

test('structured logger receives safe operation context', async () => {
  const entries = []
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [
    level,
    (message, context) => entries.push({ level, message, context }),
  ]))
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, logger })
  const session = host.createSession(fakeHookManifest, { sessionId: 'logged-session', shopId: 'logged-shop' })
  await session.start()
  factory.failNext('logged-shop', 'products', 'products.list')
  await session.invoke('products.list')
  await host.dispose()
  const operationLog = entries.find((entry) => entry.context?.operation === 'products.list')
  assert.equal(operationLog.context.platformId, 'fake')
  assert.equal(operationLog.context.shopId, 'logged-shop')
  assert.equal(operationLog.context.sessionId, 'logged-session')
  assert.equal(JSON.stringify(entries).includes('Fake 商品'), false)
})

test('HookHost foundation contains no platform-specific branch', async () => {
  const sources = await Promise.all([
    '../packages/hook-host/src/index.ts',
    '../packages/hook-host/src/session/hook-session.ts',
    '../packages/hook-host/src/pages/worker-page-manager.ts',
    '../packages/hook-host/src/scheduler/worker-scheduler.ts',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  assert.doesNotMatch(sources.join('\n'), /platform\s*===|switch\s*\(\s*platform|douyin|doudian|kuaishou|pinduoduo|goofish/)
})
