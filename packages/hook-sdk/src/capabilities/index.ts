export const HOOK_CAPABILITIES = [
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
  'handoff.transfer',
  'handoff.targets.list',
  'conversation.attention.set',
] as const

export type HookCapability = typeof HOOK_CAPABILITIES[number]
export type HookOperation = HookCapability

export const HOOK_OPERATION_PRIORITIES: Record<HookOperation, 'message' | 'order' | 'product' | 'auth'> = {
  'auth.state': 'auth',
  'sessions.list': 'message',
  'messages.listen': 'message',
  'messages.history': 'message',
  'messages.send.text': 'message',
  'messages.send.file': 'message',
  'products.list': 'product',
  'products.detail': 'product',
  'orders.list': 'order',
  'orders.listen': 'order',
  'handoff.transfer': 'message',
  'handoff.targets.list': 'message',
  'conversation.attention.set': 'message',
}
