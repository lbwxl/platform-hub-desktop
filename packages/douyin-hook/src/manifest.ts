import type { HookManifest, HookOperation } from '@platform-hub/hook-sdk'

export const DOUYIN_PLATFORM_ID = 'douyin'
export const DOUYIN_PRIMARY_PAGE_ID = 'primary'
export const DOUYIN_PRODUCTS_PAGE_ID = 'products'
export const DOUYIN_ORDERS_PAGE_ID = 'orders'

export const DOUYIN_PRIMARY_OPERATIONS = [
  'auth.state',
  'sessions.list',
  'messages.listen',
  'messages.history',
  'messages.send.text',
  'messages.send.file',
  'handoff.targets.list',
  'handoff.transfer',
] as const satisfies readonly HookOperation[]

export const DOUYIN_PRODUCTS_OPERATIONS = [
  'products.list',
  'products.detail',
] as const satisfies readonly HookOperation[]

export const DOUYIN_ORDERS_OPERATIONS = [
  'orders.list',
  'orders.listen',
] as const satisfies readonly HookOperation[]

export const douyinHookManifest: HookManifest = {
  platform: DOUYIN_PLATFORM_ID,
  version: '1.0.0',
  capabilities: [...DOUYIN_PRIMARY_OPERATIONS, ...DOUYIN_PRODUCTS_OPERATIONS, ...DOUYIN_ORDERS_OPERATIONS],
  pages: [
    {
      id: DOUYIN_PRIMARY_PAGE_ID,
      kind: 'primary',
      url: 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
    },
    {
      id: DOUYIN_PRODUCTS_PAGE_ID,
      kind: 'worker',
      url: 'https://fxg.jinritemai.com/ffa/g/list?tab=all',
      idleTtlMs: 30_000,
    },
    {
      id: DOUYIN_ORDERS_PAGE_ID,
      kind: 'worker',
      // This is the confirmed commerce page target. The order API is
      // available in this same authenticated fxg partition even when the
      // page is not navigated to the order-management sub-route.
      url: 'https://fxg.jinritemai.com/ffa/g/list?tab=all',
      idleTtlMs: 30_000,
    },
  ],
  operations: {
    'auth.state': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'auth.state' },
    'sessions.list': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'sessions.list' },
    'messages.listen': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'messages.listen' },
    'messages.history': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'messages.history' },
    'messages.send.text': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'messages.send.text' },
    'messages.send.file': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'messages.send.file' },
    'products.list': { page: DOUYIN_PRODUCTS_PAGE_ID, capability: 'products.list' },
    'products.detail': { page: DOUYIN_PRODUCTS_PAGE_ID, capability: 'products.detail' },
    'orders.list': { page: DOUYIN_ORDERS_PAGE_ID, capability: 'orders.list' },
    'orders.listen': { page: DOUYIN_ORDERS_PAGE_ID, capability: 'orders.listen' },
    'handoff.targets.list': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'handoff.targets.list' },
    'handoff.transfer': { page: DOUYIN_PRIMARY_PAGE_ID, capability: 'handoff.transfer' },
  },
}
