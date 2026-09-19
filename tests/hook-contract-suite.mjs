import assert from 'node:assert/strict'
import test from 'node:test'

export function registerHookContractTests(name, createHarness) {
  test(`${name}: manifest/capability/routing`, async () => {
    const harness = await createHarness()
    assert.equal(harness.session.manifest.platform, 'fake')
    assert.equal(harness.session.manifest.pages.filter((page) => page.kind === 'primary').length, 1)
    assert.equal(harness.session.manifest.operations['messages.send.text'].page, 'primary')
    assert.equal(harness.session.manifest.operations['products.list'].page, 'products')
    assert.equal(harness.session.manifest.operations['orders.list'].page, 'orders')
    await harness.stop()
  })

  test(`${name}: runtime install/dispose and idempotent start/stop`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    await harness.session.start()
    assert.equal(harness.factory.createCount, 1)
    await harness.session.invoke('auth.state')
    await harness.stop()
    await harness.stop()
    assert.ok(harness.factory.closeCount >= 1)
  })

  test(`${name}: login/logout state is normalized through auth.state`, async () => {
    const harness = await createHarness()
    harness.fake.logout()
    const loggedOut = await harness.session.invoke('auth.state')
    assert.equal(loggedOut.ok, true)
    assert.equal(loggedOut.data.authenticated, false)
    const blocked = await harness.session.invoke('products.list')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'LOGIN_REQUIRED')
    harness.fake.login()
    const recovered = await harness.session.invoke('products.list')
    assert.equal(recovered.ok, true)
    await harness.stop()
  })

  test(`${name}: shop isolation and shared partition`, async () => {
    const a = await createHarness('shop-a')
    const b = await createHarness('shop-b')
    await a.session.start(); await b.session.start()
    assert.notEqual(a.session.partition, b.session.partition)
    const pa = await a.session.invoke('products.list')
    assert.equal(pa.ok, true)
    assert.equal(a.factory.pages.every((page) => page.partition === a.session.partition), true)
    await a.stop(); await b.stop()
  })

  test(`${name}: message/product/order DTO and event contract`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    const sent = await harness.session.invoke('messages.send.text', { sessionId: 'session-1', text: 'hello' })
    assert.equal(sent.ok, true)
    assert.equal(sent.data.type, 'text')
    assert.equal(sent.data.isMine, true)
    const product = await harness.session.invoke('products.list')
    assert.equal(product.ok, true)
    assert.equal(product.data[0].status, 'on_sale')
    const order = { id: 'order-1', status: 'created', totalAmount: 10, createdAt: Date.now() }
    harness.fake.createOrder({ id: 'historic-order', status: 'completed', totalAmount: 3, createdAt: Date.now() - 10_000 })
    await harness.session.invoke('orders.listen')
    const historicalEvents = []
    const unsubscribeHistorical = harness.session.subscribe((event) => historicalEvents.push(event))
    await harness.session.pollEvents()
    unsubscribeHistorical()
    assert.equal(historicalEvents.some((event) => event.type === 'order.created'), false)
    assert.equal(harness.fake.createOrder(order), true)
    assert.equal(harness.fake.createOrder(order), false)
    await harness.session.pollEvents()
    const events = []
    const unsubscribe = harness.session.subscribe((event) => events.push(event))
    const paid = { ...order, status: 'paid', updatedAt: Date.now() }
    harness.fake.updateOrder(paid)
    harness.fake.updateOrder(paid)
    await harness.session.pollEvents()
    unsubscribe()
    assert.equal(events.filter((event) => event.type === 'order.updated').length, 1)
    await harness.stop()
  })

  test(`${name}: worker creation, reuse, idle recycle and routing`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    await harness.session.invoke('products.list')
    assert.deepEqual(harness.fake.workerPageIds(), ['products'])
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(harness.fake.workerPageCount(), 0)
    await harness.session.invoke('products.list')
    assert.equal(harness.fake.workerPageIds()[0], 'products')
    await harness.stop()
  })

  test(`${name}: challenge recovery shows worker and retries original operation`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    harness.fake.requireChallenge('products.list')
    const pending = harness.session.invoke('products.list')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(harness.factory.pages.find((page) => page.id === 'products')?.visible, true)
    harness.fake.completeChallenge('products.list')
    const result = await pending
    assert.equal(result.ok, true)
    assert.ok(harness.factory.installCount >= 3)
    await harness.stop()
  })

  test(`${name}: runtime failure is isolated to one operation`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    harness.fake.failNext('products.list')
    const failed = await harness.session.invoke('products.list')
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'PLATFORM_ERROR')
    const healthy = await harness.session.invoke('auth.state')
    assert.equal(healthy.ok, true)
    await harness.stop()
  })
}
