import type { HookAuthState, HookMessage, HookProduct, HookSessionSummary } from '@platform-hub/core-sdk';
type Row = Record<string, unknown>;
export declare function normalizeGoofishAuth(value: unknown, account?: unknown, checkedAt?: number): HookAuthState;
export declare function normalizeGoofishSession(value: unknown): HookSessionSummary | undefined;
export declare function normalizeGoofishMessage(value: unknown, context?: {
    conversationId?: string;
    selfId?: string;
    sentByHook?: boolean;
    receivedAt?: number;
}): HookMessage | undefined;
export declare function normalizeGoofishProduct(value: unknown, fallbackShopId?: string): HookProduct | undefined;
export declare function asRow(value: unknown): Row;
export declare function array(value: unknown): unknown[];
export declare function text(value: unknown): string;
export declare function timestamp(value: unknown): number | undefined;
export {};
//# sourceMappingURL=normalize.d.ts.map