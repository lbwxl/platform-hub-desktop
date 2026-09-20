import assert from 'node:assert/strict'
import test from 'node:test'

export function registerHookContractTests(name, createHarness) {
  test(`${name}: manifest capabilities route only declared operations`, async () => {
    const harness = await createHarness()
    const { manifest } = harness.session
    assert.equal(manifest.platform, 'fake')
    assert.equal(manifest.pages.filter((page) => page.kind === 'primary').length, 1)
    assert.equal(manifest.operations['messages.send.text'].page, 'primary')
    assert.equal(manifest.operations['products.list'].page, 'products')
    assert.equal(manifest.operations['orders.list'].page, 'orders')
    assert.equal(manifest.operations['handoff.transfer'].page, 'primary')
    await harness.stop()
  })

  test(`${name}: runtime install/dispose and idempotent lifecycle`, async () => {
    const harness = await createHarness()
    await harness.session.start()
    assert.equal(harness.factory.createCount, 1)
    await harness.stop()
    await harness.stop()
    assert.equal(harness.session.isDisposed, true)
    assert.equal(harness.factory.subscriptionCount, 0)
    assert.ok(harness.factory.closeCount >= 1)
  })

  test(`${name}: login and sessions use normalized contracts`, async () => {
    const harness = await createHarness()
    harness.fake.logout()
    const loggedOut = await harness.session.invoke('auth.state')
    assert.equal(loggedOut.ok, true)
    assert.equal(loggedOut.data.authenticated, false)
    const blocked = await harness.session.invoke('products.list')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'LOGIN_REQUIRED')
    harness.fake.login()
    const sessions = await harness.session.invoke('sessions.list')
    assert.equal(sessions.ok, true)
    assert.equal(sessions.data[0].id, 'conversation-1')
    await harness.stop()
  })

  test(`${name}: message origin attribution separates automation and human`, async () => {
    const harness = await createHarness()
    const events = []
    const unsubscribe = harness.session.subscribe((event) => events.push(event))
    harness.fake.receiveMessage({ content: '买家消息' })
    const automated = await harness.session.invoke('messages.send.text', { conversationId: 'conversation-1', text: '自动回复' })
    const human = harness.fake.sendHumanMessage({ content: '人工回复' })
    const beforeFailure = events.length
    const failed = await harness.session.invoke('messages.send.text', {
      conversationId: 'conversation-1',
      text: '发送失败',
      simulateFailure: true,
    })
    unsubscribe()

    assert.equal(automated.ok, true)
    assert.equal(automated.data.origin, 'automation')
    assert.equal(automated.data.deliveryStatus, 'sent')
    assert.equal(human.origin, 'human')
    assert.equal(failed.ok, false)
    assert.equal(events.length, beforeFailure)
    assert.deepEqual(events.filter((event) => event.type === 'message.created').map((event) => event.payload.message.origin), [
      'customer', 'automation', 'human',
    ])
    await harness.stop()
  })

  test(`${name}: product DTO exposes normalized product and SKU fields`, async () => {
    const harness = await createHarness()
    const listed = await harness.session.invoke('products.list')
    assert.equal(listed.ok, true)
    const product = listed.data[0]
    assert.equal(product.externalId, 'external-product-1')
    assert.equal(product.title, 'Fake 商品')
    assert.deepEqual(product.price, { amount: 19.9, currency: 'CNY' })
    assert.equal(product.images.length, 1)
    assert.equal(product.skus[0].name, '默认')
    assert.equal(product.skus[0].externalId, 'external-sku-1')
    const detail = await harness.session.invoke('products.detail', { id: product.id })
    assert.equal(detail.ok, true)
    assert.equal(detail.data.id, product.id)
    await harness.stop()
  })

  test(`${name}: order snapshot watermark dedupe and meaningful updates`, async () => {
    const harness = await createHarness()
    const historic = order('historic', 'completed')
    harness.fake.createOrder(historic)
    const listening = await harness.session.invoke('orders.listen')
    assert.equal(listening.ok, true)

    const events = []
    const unsubscribe = harness.session.subscribe((event) => events.push(event))
    const created = order('order-1', 'created')
    assert.equal(harness.fake.createOrder(created), true)
    assert.equal(harness.fake.createOrder({ ...created, updatedAt: Date.now() }), false)
    for (const status of ['paid', 'shipped', 'cancelled', 'refunded']) {
      assert.equal(harness.fake.updateOrder({ ...created, status, updatedAt: Date.now() }), true)
    }
    const quantityChanged = { ...created, status: 'refunded', items: [{ ...created.items[0], quantity: 2 }] }
    assert.equal(harness.fake.updateOrder(quantityChanged), true)
    const skuChanged = { ...quantityChanged, items: [{ ...quantityChanged.items[0], skuId: 'sku-2', skuName: '大号' }] }
    assert.equal(harness.fake.updateOrder(skuChanged), true)
    assert.equal(harness.fake.updateOrder(skuChanged), false)
    unsubscribe()

    assert.equal(events.some((event) => event.payload?.order?.id === 'historic'), false)
    assert.equal(events.filter((event) => event.type === 'order.created').length, 1)
    assert.deepEqual(events.filter((event) => event.type === 'order.updated').map((event) => event.payload.order.status), [
      'paid', 'shipped', 'cancelled', 'refunded', 'refunded', 'refunded',
    ])
    assert.deepEqual(events.filter((event) => event.type === 'order.updated').slice(-2).map((event) => event.payload.changedFields), [
      ['items'], ['items'],
    ])
    await harness.stop()
  })

  test(`${name}: worker creation reuse idle reap and routing`, async () => {
    const harness = await createHarness()
    await harness.session.invoke('products.list')
    const firstProductsPage = harness.factory.pages.find((page) => page.id === 'products')
    await harness.session.invoke('products.detail', { id: 'product-1' })
    assert.equal(harness.factory.pages.filter((page) => page.id === 'products').length, 1)
    assert.equal(firstProductsPage?.isAlive(), true)
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.equal(harness.fake.workerPageCount(), 0)
    await harness.session.invoke('products.list')
    assert.equal(harness.fake.workerPageIds()[0], 'products')
    await harness.stop()
  })

  test(`${name}: challenge recovery reinstalls runtime and retries`, async () => {
    const harness = await createHarness()
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

  test(`${name}: challenge timeout and abort release scheduler slots`, async () => {
    const timeoutHarness = await createHarness('challenge-timeout', { challengeTimeoutMs: 15 })
    timeoutHarness.fake.requireChallenge('products.list')
    const timedOut = await timeoutHarness.session.invoke('products.list')
    assert.equal(timedOut.ok, false)
    assert.equal(timedOut.error.code, 'TIMEOUT')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(timeoutHarness.fake.host.scheduler.activeCount, 0)
    timeoutHarness.fake.completeChallenge('products.list')
    await timeoutHarness.stop()

    const abortHarness = await createHarness('challenge-abort')
    abortHarness.fake.requireChallenge('products.list')
    const controller = new AbortController()
    const pending = abortHarness.session.invoke('products.list', {}, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const aborted = await pending
    assert.equal(aborted.ok, false)
    assert.equal(aborted.error.code, 'TIMEOUT')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(abortHarness.fake.host.scheduler.activeCount, 0)
    abortHarness.fake.completeChallenge('products.list')
    await abortHarness.stop()
  })

  test(`${name}: handoff transfer and optional target listing`, async () => {
    const harness = await createHarness()
    const targets = await harness.session.invoke('handoff.targets.list')
    assert.equal(targets.ok, true)
    assert.deepEqual(targets.data[0], { id: 'agent-1', name: 'Fake 客服' })
    const transfer = await harness.session.invoke('handoff.transfer', {
      conversationId: 'conversation-1',
      targetId: 'agent-1',
      remark: '需要人工处理',
    })
    assert.equal(transfer.ok, true)
    assert.equal(transfer.data.transferred, true)
    assert.equal(transfer.data.target.id, 'agent-1')
    await harness.stop()
  })

  test(`${name}: runtime start operation and stop failures stay contained`, async () => {
    const startFailure = await createHarness('start-failure', { deferStart: true })
    startFailure.fake.failNextStart()
    await assert.rejects(startFailure.session.start(), /Fake start failure/)
    assert.equal(startFailure.factory.closeCount, 1)
    await startFailure.stop()

    const operationFailure = await createHarness('operation-failure')
    operationFailure.fake.failNext('products.list')
    const failed = await operationFailure.session.invoke('products.list')
    const healthy = await operationFailure.session.invoke('auth.state')
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'PLATFORM_ERROR')
    assert.equal(healthy.ok, true)
    operationFailure.fake.failNextStop()
    await operationFailure.stop()
    assert.ok(operationFailure.factory.closeCount >= 1)
  })
}

function order(id, status) {
  return {
    id,
    externalId: `external-${id}`,
    shopId: 'contract-shop',
    conversationId: 'conversation-1',
    buyer: { id: 'buyer-1', name: 'Fake 买家' },
    status,
    items: [{
      productId: 'product-1',
      externalProductId: 'external-product-1',
      skuId: 'sku-1',
      skuName: '默认',
      title: 'Fake 商品',
      quantity: 1,
      price: { amount: 10, currency: 'CNY' },
    }],
    total: { amount: 10, currency: 'CNY' },
    receiver: { name: '张三', phoneMasked: '138****0000', address: '测试地址' },
    createdAt: Date.now(),
  }
}
