import type { ProductRecord } from '../../shared/platform'

export const PRODUCT_CHANGED_FIELDS = ['name', 'price', 'stockQuantity', 'status', 'updatedAt'] as const

export type ProductChangedField = typeof PRODUCT_CHANGED_FIELDS[number]
export type ProductSyncState = 'idle' | 'syncing' | 'success' | 'failed'

export interface ProductChange {
  before: ProductRecord
  after: ProductRecord
  changedFields: ProductChangedField[]
}

export interface ProductDiff {
  added: ProductRecord[]
  removed: ProductRecord[]
  changed: ProductChange[]
  unchangedCount: number
}

export interface ProductSyncError {
  code?: string
  message: string
}

export interface ProductAcceptanceState {
  currentProducts: ProductRecord[]
  previousProducts: ProductRecord[]
  syncState: ProductSyncState
  lastSyncAt?: number
  lastAttemptAt?: number
  durationMs?: number
  error?: ProductSyncError
  diff: ProductDiff
}

export interface ProductStats {
  count: number
  uniqueCount: number
  duplicateCount: number
  allOnSale: boolean
}

export function emptyProductDiff(): ProductDiff {
  return { added: [], removed: [], changed: [], unchangedCount: 0 }
}

export function createProductAcceptanceState(): ProductAcceptanceState {
  return {
    currentProducts: [],
    previousProducts: [],
    syncState: 'idle',
    diff: emptyProductDiff(),
  }
}

export function beginProductSync(state: ProductAcceptanceState, startedAt = Date.now()): ProductAcceptanceState {
  return {
    ...state,
    syncState: 'syncing',
    lastAttemptAt: startedAt,
    durationMs: undefined,
    error: undefined,
  }
}

export function applyProductSyncSuccess(
  state: ProductAcceptanceState,
  products: ProductRecord[],
  startedAt: number,
  finishedAt = Date.now(),
): ProductAcceptanceState {
  const nextProducts = [...products]
  return {
    ...state,
    currentProducts: nextProducts,
    previousProducts: [...state.currentProducts],
    syncState: 'success',
    lastSyncAt: finishedAt,
    lastAttemptAt: finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    error: undefined,
    diff: calculateProductDiff(state.currentProducts, nextProducts),
  }
}

export function applyProductSyncFailure(
  state: ProductAcceptanceState,
  error: ProductSyncError,
  startedAt: number,
  finishedAt = Date.now(),
): ProductAcceptanceState {
  return {
    ...state,
    syncState: 'failed',
    lastAttemptAt: finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    error,
  }
}

export function productKey(product: ProductRecord): string {
  return String(product.goodsId || product.id || '').trim()
}

export function productStats(products: ProductRecord[]): ProductStats {
  const keys = products.map(productKey)
  const uniqueKeys = new Set(keys)
  return {
    count: products.length,
    uniqueCount: uniqueKeys.size,
    duplicateCount: Math.max(0, products.length - uniqueKeys.size),
    allOnSale: products.every((product) => {
      const scope = product.raw && typeof product.raw === 'object'
        ? (product.raw as Record<string, unknown>).authoritativeScope
        : undefined
      return product.status === 'on_sale' || scope === 'is_online=1'
    }),
  }
}

export function calculateProductDiff(previous: ProductRecord[], current: ProductRecord[]): ProductDiff {
  const previousByKey = new Map(previous.map((product) => [productKey(product), product]))
  const currentByKey = new Map(current.map((product) => [productKey(product), product]))
  const added: ProductRecord[] = []
  const changed: ProductChange[] = []
  let unchangedCount = 0

  for (const product of current) {
    const key = productKey(product)
    const before = previousByKey.get(key)
    if (!before) {
      added.push(product)
      continue
    }
    const changedFields = PRODUCT_CHANGED_FIELDS.filter((field) => !sameProductField(before, product, field))
    if (changedFields.length) changed.push({ before, after: product, changedFields: [...changedFields] })
    else unchangedCount += 1
  }

  const removed = previous.filter((product) => !currentByKey.has(productKey(product)))
  return { added, removed, changed, unchangedCount }
}

export function filterProducts(products: ProductRecord[], query: string): ProductRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return products
  return products.filter((product) => [product.goodsId, product.id, product.name, product.status]
    .some((value) => String(value || '').toLowerCase().includes(needle)))
}

function sameProductField(before: ProductRecord, after: ProductRecord, field: ProductChangedField): boolean {
  return Object.is(before[field], after[field])
}
