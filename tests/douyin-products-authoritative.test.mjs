import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { FakeHook } from '../packages/fake-hook/dist/index.js'
import { douyinHookRuntimeScript } from '../packages/douyin-hook/dist/index.js'

function product(index, status = 'on_sale', overrides = {}) {
  return {
    id: `product-${index}`,
    externalId: `external-${index}`,
    title: `商品 ${index}`,
    status,
    price: { amount: index + 1, currency: 'CNY' },
    stockQuantity: 10,
    images: [],
    skus: [],
    ...overrides,
  }
}

test('FakeHook products.list models canonical on-sale scope, pagination and state changes', async () => {
  const hook = new FakeHook('shop-products-authoritative')
  hook.setProducts([
    product(1),
    product(2),
    product(3, 'off_sale'),
  ])
  hook.setProductPageSize(2)
  await hook.start()
  try {
    let result = await hook.session.invoke('products.list')
    assert.equal(result.ok, true)
    assert.deepEqual(result.data.map((item) => item.externalId), ['external-1', 'external-2'])

    hook.setProducts([product(1, 'off_sale'), product(2), product(3)])
    result = await hook.session.invoke('products.list')
    assert.deepEqual(result.data.map((item) => item.externalId), ['external-2', 'external-3'])

    hook.setProducts([product(1), product(2), product(3)])
    result = await hook.session.invoke('products.list')
    assert.deepEqual(result.data.map((item) => item.externalId), ['external-1', 'external-2', 'external-3'])
  } finally {
    await hook.stop()
  }
})

test('FakeHook products.list fails the whole operation when a later page fails', async () => {
  const hook = new FakeHook('shop-products-page-failure')
  hook.setProducts(Array.from({ length: 5 }, (_, index) => product(index + 1)))
  hook.setProductPageSize(2)
  hook.failProductPage(2)
  await hook.start()
  try {
    const result = await hook.session.invoke('products.list')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PLATFORM_ERROR')
  } finally {
    await hook.stop()
  }
})

test('FakeHook products.list challenge recovery never returns a partial list', async () => {
  const hook = new FakeHook('shop-products-challenge', { challengeTimeoutMs: 2_000 })
  hook.setProducts(Array.from({ length: 5 }, (_, index) => product(index + 1)))
  hook.setProductPageSize(2)
  hook.challengeProductPage(1)
  await hook.start()
  try {
    const pending = hook.session.invoke('products.list', {}, { timeoutMs: 2_000 })
    setTimeout(() => hook.completeProductPageChallenge(1), 30)
    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(result.data.length, 5)
  } finally {
    await hook.stop()
  }
})

test('FakeHook products.list deduplicates externalId and isolates shops', async () => {
  const first = new FakeHook('shop-products-a')
  const second = new FakeHook('shop-products-b')
  first.setProducts([product(1), product(2)])
  second.setProducts([product(2, 'on_sale', { title: '店铺 B 商品 2' }), product(3)])
  first.setProductPageSize(1)
  second.setProductPageSize(1)
  first.duplicateProductPage(1)
  await Promise.all([first.start(), second.start()])
  try {
    const [a, b] = await Promise.all([
      first.session.invoke('products.list'),
      second.session.invoke('products.list'),
    ])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.deepEqual(a.data.map((item) => item.externalId), ['external-1', 'external-2'])
    assert.deepEqual(b.data.map((item) => item.externalId), ['external-2', 'external-3'])
    assert.equal(new Set(a.data.map((item) => item.externalId)).size, a.data.length)
    assert.equal(new Set(b.data.map((item) => item.externalId)).size, b.data.length)
    assert.notEqual(a.data[1].title, b.data[0].title)
  } finally {
    await Promise.all([first.stop(), second.stop()])
  }
})

test('Douyin runtime products.list uses the official paginated endpoint, not GOODS_SWR_CACHE_V1', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    product_id: `goods-${index}`,
    name: `官方商品 ${index}`,
    discount_price: 1_990,
    status: 0,
    tab: '售卖中 (已售罄)',
  }))
  rows.push({ product_id: 'rejected-goods', name: '审核驳回商品', discount_price: 1_990, status: 0, tab: '审核驳回' })
  const requests = []
  const fetch = async (input) => {
    const url = new URL(String(input), 'https://fxg.jinritemai.com')
    requests.push(url)
    const page = Number(url.searchParams.get('page'))
    const pageSize = Number(url.searchParams.get('pageSize'))
    return {
      ok: true,
      status: 200,
      url: url.href,
      async json() {
        return { code: 0, page, size: pageSize, total: rows.length, data: rows.slice(page * pageSize, (page + 1) * pageSize) }
      },
    }
  }
  const context = vm.createContext({
    AbortController,
    Date,
    JSON,
    Map,
    Promise,
    Set,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    fetch,
    location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' },
    setInterval,
    setTimeout,
    window: {
      __PLATFORM_HOOK_PAGE_ID__: 'products',
      location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' },
      ss: { _frontStore: { shopInfo: { id: 'shop-authoritative' } } },
      localStorage: { getItem: () => JSON.stringify({ stale: [{ product_id: 'stale-cache-item' }] }) },
    },
  })
  vm.runInContext(douyinHookRuntimeScript, context)
  const result = await context.window.__PLATFORM_HOOK__.invoke('products.list', {})
  assert.equal(result.ok, true)
  assert.equal(result.data.length, 205)
  assert.equal(result.data.some((item) => item.externalId === 'stale-cache-item'), false)
  assert.equal(result.data.some((item) => item.externalId === 'rejected-goods'), false)
  assert.deepEqual(requests.map((request) => Number(request.searchParams.get('page'))), [0, 1, 2])
  for (const request of requests) {
    assert.equal(request.pathname, '/product/tproduct/list')
    assert.equal(request.searchParams.get('is_online'), '1')
    assert.equal(request.searchParams.get('tab'), 'all')
    assert.equal(request.searchParams.get('business_type'), '4')
    assert.equal(request.searchParams.get('from_mng'), '1')
  }
})

test('Douyin runtime products.list does not return partial data after a page challenge', async () => {
  const requests = []
  const fetch = async (input) => {
    const url = new URL(String(input), 'https://fxg.jinritemai.com')
    requests.push(url)
    const page = Number(url.searchParams.get('page'))
    if (page === 1) {
      return { ok: true, status: 200, url: url.href, async json() { return { code: 401, msg: 'captcha required', data: [] } } }
    }
    return { ok: true, status: 200, url: url.href, async json() { return { code: 0, page, size: 1, total: 2, data: [{ product_id: 'goods-' + page, name: '商品', tab: '售卖中' }] } } }
  }
  const context = vm.createContext({
    AbortController, Date, JSON, Map, Promise, Set, URL, URLSearchParams, clearInterval, clearTimeout, fetch,
    location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' }, setInterval, setTimeout,
    window: { __PLATFORM_HOOK_PAGE_ID__: 'products', location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' }, ss: { _frontStore: { shopInfo: { id: 'shop' } } } },
  })
  vm.runInContext(douyinHookRuntimeScript, context)
  const result = await context.window.__PLATFORM_HOOK__.invoke('products.list', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CHALLENGE_REQUIRED')
  assert.equal(requests.length, 2)
})

test('Douyin runtime products.list rejects an unexpected empty middle page', async () => {
  const fetch = async (input) => {
    const url = new URL(String(input), 'https://fxg.jinritemai.com')
    const page = Number(url.searchParams.get('page'))
    return {
      ok: true,
      status: 200,
      url: url.href,
      async json() {
        return page === 0
          ? { code: 0, page, size: 1, total: 3, data: [{ product_id: 'goods-0', name: '商品', tab: '售卖中' }] }
          : { code: 0, page, size: 1, total: 3, data: [] }
      },
    }
  }
  const context = vm.createContext({
    AbortController, Date, JSON, Map, Promise, Set, URL, URLSearchParams, clearInterval, clearTimeout, fetch,
    location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' }, setInterval, setTimeout,
    window: { __PLATFORM_HOOK_PAGE_ID__: 'products', location: { hostname: 'fxg.jinritemai.com', pathname: '/ffa/g/list', search: '' }, ss: { _frontStore: { shopInfo: { id: 'shop' } } } },
  })
  vm.runInContext(douyinHookRuntimeScript, context)
  const result = await context.window.__PLATFORM_HOOK__.invoke('products.list', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLATFORM_ERROR')
})
