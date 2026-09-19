import type { HookAuthState, HookMessage, HookOrder } from '../contracts/index.js';
export type HookEventType = 'message.created' | 'order.created' | 'order.updated' | 'auth.changed' | 'runtime.error';
export interface HookEventPayloadMap {
    'message.created': {
        message: HookMessage;
    };
    'order.created': {
        order: HookOrder;
    };
    'order.updated': {
        order: HookOrder;
        previous?: HookOrder;
    };
    'auth.changed': {
        auth: HookAuthState;
    };
    'runtime.error': {
        message: string;
        error?: unknown;
    };
}
export interface HookEvent<T extends HookEventType = HookEventType> {
    id?: string;
    type: T;
    payload: HookEventPayloadMap[T];
    timestamp: number;
}
//# sourceMappingURL=index.d.ts.map