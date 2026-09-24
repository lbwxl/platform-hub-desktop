import assert from 'node:assert/strict'
import test from 'node:test'
import { PlatformRegistry, PlatformRuntimeManager } from '../packages/platform-runtime/dist/index.js'
import { createFakePlatformFactory } from '../packages/platform-fake/dist/index.js'

test('FakePlatform 插件可经 Registry 完成创建、启动、invoke、展示、停止和释放', async () => {
  const registry = new PlatformRegistry()
  const factory = createFakePlatformFactory()
  const unregister = registry.register(factory)
  const runtimeManager = new PlatformRuntimeManager(registry, () => ({
    getHostWindow: () => ({ id: 'fake-host' }),
    getPrimaryViewBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    updateAccount: () => {},
  }))
  const account = {
    id: 'fake-account-1',
    platform: 'fake-platform',
    label: 'Fake shop',
    url: 'fake://shop',
    partition: 'fake-account-1',
  }

  const adapter = await runtimeManager.start(account)
  assert.equal(adapter.id, account.id)

  const result = await runtimeManager.invoke(account, 'messages.listen', { watermark: 12 })
  assert.deepEqual(result, { operation: 'messages.listen', input: { watermark: 12 } })
  assert.deepEqual(await adapter.getStatus(), { connected: true, authenticated: true, url: 'fake://shop', message: 'ready' })
  await runtimeManager.attachPrimaryView(account)
  runtimeManager.detachPrimaryView(account.id)
  await runtimeManager.stop(account.id)
  await runtimeManager.dispose(account.id)

  assert.deepEqual(adapter.calls, [
    'start', 'transport.start', 'getStatus', 'attachPrimaryView', 'detachPrimaryView',
    'stop', 'transport.stop', 'dispose', 'stop', 'transport.stop',
  ])
  unregister()
  assert.equal(registry.has('fake-platform'), false)
})
