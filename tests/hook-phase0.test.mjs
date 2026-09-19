import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FakeHook, FakeHookPageFactory, fakeHookManifest } from '../packages/fake-hook/dist/index.js'
import { HookHost } from '../packages/hook-host/dist/index.js'
import { validateHookManifest } from '../packages/hook-sdk/dist/index.js'
import { registerHookContractTests } from './hook-contract-suite.mjs'

const createHarness = async (shopId = 'contract-shop') => {
  const fake = new FakeHook(shopId)
  await fake.start()
  return { fake, session: fake.session, factory: fake.factory, stop: () => fake.stop() }
}

registerHookContractTests('FakeHook', createHarness)

test('Phase 0 manifest passes SDK validation', () => {
  assert.deepEqual(validateHookManifest(fakeHookManifest), [])
})

test('WorkerScheduler applies message > order > product priority and timeout', async () => {
  const factory = new FakeHookPageFactory()
  const host = new HookHost({ pageFactory: factory, maxWorkerConcurrency: 1 })
  const first = new FakeHook('scheduler-shop', { maxWorkerConcurrency: 1 })
  await first.start()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const order = []
  const manager = first.session.workerPages
  const page = fakeHookManifest.pages.find((item) => item.id === 'products')
  const orderPage = fakeHookManifest.pages.find((item) => item.id === 'orders')
  const p1 = host.scheduler.schedule({ manager, page, priority: 'product', run: async () => { await gate; order.push('product-1'); return 1 } })
  const p2 = host.scheduler.schedule({ manager, page, priority: 'product', run: async () => { order.push('product-2'); return 2 } })
  const p3 = host.scheduler.schedule({ manager, page: orderPage, priority: 'order', run: async () => { order.push('order'); return 3 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  await Promise.all([p1, p2, p3])
  assert.deepEqual(order, ['product-1', 'order', 'product-2'])
  await assert.rejects(
    host.scheduler.schedule({ manager, page, timeoutMs: 10, run: async (_lease, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted'))) }),
    (error) => error?.code === 'TIMEOUT',
  )
  await first.stop()
  host.stop()
})

test('HookHost contains no platform-specific branch', async () => {
  const source = await readFile(new URL('../packages/hook-host/src/index.ts', import.meta.url), 'utf8')
  const session = await readFile(new URL('../packages/hook-host/src/session/hook-session.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(`${source}\n${session}`, /platform\s*===|switch\s*\(\s*platform|douyin|doudian|kuaishou|pinduoduo|goofish/)
})
