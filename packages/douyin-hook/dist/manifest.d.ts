import type { HookManifest } from '@platform-hub/hook-sdk';
export declare const DOUYIN_PLATFORM_ID = "douyin";
export declare const DOUYIN_PRIMARY_PAGE_ID = "primary";
export declare const DOUYIN_PRODUCTS_PAGE_ID = "products";
export declare const DOUYIN_ORDERS_PAGE_ID = "orders";
export declare const DOUYIN_PRIMARY_OPERATIONS: readonly ["auth.state", "sessions.list", "messages.listen", "messages.history", "messages.send.text", "messages.send.file", "conversation.attention.set", "handoff.targets.list", "handoff.transfer"];
export declare const DOUYIN_PRODUCTS_OPERATIONS: readonly ["products.list", "products.detail"];
export declare const DOUYIN_ORDERS_OPERATIONS: readonly ["orders.list", "orders.listen"];
export declare const douyinHookManifest: HookManifest;
//# sourceMappingURL=manifest.d.ts.map