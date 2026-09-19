import type { HookManifest } from '@platform-hub/hook-sdk'

export const fakeHookManifest: HookManifest = {
  platform: 'fake',
  version: '0.1.0',
  capabilities: [
    'auth.state',
    'sessions.list',
    'messages.listen',
    'messages.history',
    'messages.send.text',
    'messages.send.file',
    'products.list',
    'products.detail',
    'orders.list',
    'orders.listen',
  ],
  pages: [
    { id: 'primary', kind: 'primary', url: 'fake://messages' },
    { id: 'products', kind: 'worker', url: 'fake://products', idleTtlMs: 40 },
    { id: 'orders', kind: 'worker', url: 'fake://orders', idleTtlMs: 40 },
  ],
  operations: {
    'auth.state': { page: 'primary', capability: 'auth.state' },
    'sessions.list': { page: 'primary', capability: 'sessions.list' },
    'messages.listen': { page: 'primary', capability: 'messages.listen' },
    'messages.history': { page: 'primary', capability: 'messages.history' },
    'messages.send.text': { page: 'primary', capability: 'messages.send.text' },
    'messages.send.file': { page: 'primary', capability: 'messages.send.file' },
    'products.list': { page: 'products', capability: 'products.list' },
    'products.detail': { page: 'products', capability: 'products.detail' },
    'orders.list': { page: 'orders', capability: 'orders.list' },
    'orders.listen': { page: 'orders', capability: 'orders.listen' },
  },
}
