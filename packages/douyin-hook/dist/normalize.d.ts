import { type HookAuthState, type HookError, type HookMessage, type HookOrder, type HookOrderStatus, type HookProduct, type HookProductStatus, type HookSessionSummary } from '@platform-hub/core-sdk';
type UnknownRecord = Record<string, unknown>;
export interface DouyinMessageContext {
    conversationId?: string;
    selfId?: string;
    conversationTitle?: string;
}
export declare function asRecord(value: unknown): UnknownRecord;
export declare function normalizeDouyinAuth(value: unknown, checkedAt?: number): HookAuthState;
export declare function normalizeDouyinSession(value: unknown): HookSessionSummary | undefined;
export declare function normalizeDouyinMessage(value: unknown, context?: DouyinMessageContext): HookMessage | undefined;
export declare function normalizeDouyinProduct(value: unknown, fallbackShopId?: string): HookProduct | undefined;
export declare function normalizeDouyinProductStatus(value: unknown): HookProductStatus;
export declare function normalizeDouyinOrder(value: unknown, context?: {
    shopId?: string;
    conversationId?: string;
}): HookOrder | undefined;
export declare function normalizeDouyinOrderStatus(value: unknown): HookOrderStatus;
export declare function douyinOrderChangedFields(previous: HookOrder, next: HookOrder): string[];
export declare function mapDouyinError(value: unknown, fallbackMessage?: string): HookError;
export {};
//# sourceMappingURL=normalize.d.ts.map