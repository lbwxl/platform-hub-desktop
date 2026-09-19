export declare const HOOK_CAPABILITIES: readonly ["auth.state", "sessions.list", "messages.listen", "messages.history", "messages.send.text", "messages.send.file", "products.list", "products.detail", "orders.list", "orders.listen"];
export type HookCapability = typeof HOOK_CAPABILITIES[number];
export type HookOperation = HookCapability;
export declare const HOOK_OPERATION_PRIORITIES: Record<HookOperation, 'message' | 'order' | 'product' | 'auth'>;
//# sourceMappingURL=index.d.ts.map