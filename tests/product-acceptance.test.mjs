import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProductSyncFailure,
  applyProductSyncSuccess,
  calculateProductDiff,
  createProductAcceptanceState,
  productStats,
  filterProducts,
} from '../src/renderer/src/productAcceptance.ts'

function product(id, overrides = {}) {
  return {
    id: `douyin:shop:${id}`,
    goodsId: id,
    name: `商品 ${id}`,
    price: 10,
    stockQuantity: 5,
    status: 'on_sale',
    images: [],
    platform: 'douyin-shop',
    raw: { authoritativeScope: 'is_online=1' },
    ...overrides,
  }
}

test('PRODUCT_DIFF_ADD detects a newly listed product', () => {
  const diff = calculateProductDiff([product('a'), product('b')], [product('a'), product('b'), product('c')])
  assert.deepEqual(diff.added.map((item) => item.goodsId), ['c'])
  assert.equal(diff.removed.length, 0)
  assert.equal(diff.changed.length, 0)
})

test('PRODUCT_DIFF_REMOVE detects an item that left the on-sale scope', () => {
  const diff = calculateProductDiff([product('a'), product('b')], [product('a')])
  assert.deepEqual(diff.removed.map((item) => item.goodsId), ['b'])
  assert.equal(diff.added.length, 0)
})

test('PRODUCT_DIFF_CHANGE reports changed fields without treating an unchanged item as changed', () => {
  const diff = calculateProductDiff(
    [product('a'), product('b')],
    [product('a', { price: 20, stockQuantity: 3 }), product('b')],
  )
  assert.deepEqual(diff.changed[0].changedFields, ['price', 'stockQuantity'])
  assert.equal(diff.unchangedCount, 1)
})

test('PRODUCT_DIFF_NO_CHANGE returns an empty material diff', () => {
  const diff = calculateProductDiff([product('a')], [product('a')])
  assert.deepEqual(diff, { added: [], removed: [], changed: [], unchangedCount: 1 })
})

test('PRODUCT_DUPLICATE_DETECTION counts duplicate external ids', () => {
  const stats = productStats([product('a'), product('a', { id: 'duplicate-row' }), product('b')])
  assert.equal(stats.count, 3)
  assert.equal(stats.uniqueCount, 2)
  assert.equal(stats.duplicateCount, 1)
  assert.equal(stats.allOnSale, true)
})

test('PRODUCT_SEARCH filters by external id or title', () => {
  const products = [product('123456', { name: '蓝色杯子' }), product('999999', { name: '红色盘子' })]
  assert.deepEqual(filterProducts(products, '123456').map((item) => item.goodsId), ['123456'])
  assert.deepEqual(filterProducts(products, '盘子').map((item) => item.goodsId), ['999999'])
  assert.equal(filterProducts(products, 'missing').length, 0)
})

test('PRODUCT_FAILED_SYNC_KEEPS_LAST_SUCCESS', () => {
  let state = createProductAcceptanceState()
  state = applyProductSyncSuccess(state, [product('a'), product('b')], 100, 250)
  const failed = applyProductSyncFailure(state, { code: 'CHALLENGE_REQUIRED', message: '需要验证' }, 300, 360)
  assert.equal(failed.syncState, 'failed')
  assert.deepEqual(failed.currentProducts.map((item) => item.goodsId), ['a', 'b'])
  assert.equal(failed.lastSyncAt, 250)
  assert.equal(failed.error.code, 'CHALLENGE_REQUIRED')
})

test('PRODUCT_ACCOUNT_ISOLATION keeps product acceptance snapshots independent', () => {
  let shopA = createProductAcceptanceState()
  let shopB = createProductAcceptanceState()
  shopA = applyProductSyncSuccess(shopA, [product('a')], 0, 10)
  shopB = applyProductSyncSuccess(shopB, [product('b')], 0, 20)
  assert.deepEqual(shopA.currentProducts.map((item) => item.goodsId), ['a'])
  assert.deepEqual(shopB.currentProducts.map((item) => item.goodsId), ['b'])
})
