import type { HookSession } from '@platform-hub/core-page-host';
import { type HookEvent, type HookOperation, type HookResult } from '@platform-hub/core-sdk';
import type { HookTransport } from './types.js';
type PageHookSession = Pick<HookSession, 'start' | 'invoke' | 'subscribe'>;
export interface PageHookTransportOptions {
    session: PageHookSession;
    /**
     * The owning HookHost removes the session from its registry before
     * disposing it. The transport never owns or shuts down that shared host.
     */
    disposeSession: () => Promise<unknown>;
}
/**
 * Thin Page Hook adapter. Routing, recovery, scheduling, and page lifecycle
 * remain owned by the existing HookSession and HookHost foundation.
 */
export declare class PageHookTransport implements HookTransport {
    private readonly options;
    private readonly listeners;
    private sessionUnsubscribe?;
    private startPromise?;
    private stopPromise?;
    private started;
    private stopped;
    constructor(options: PageHookTransportOptions);
    start(): Promise<void>;
    invoke<T = unknown>(operation: HookOperation, input: unknown): Promise<HookResult<T>>;
    subscribe(listener: (event: HookEvent) => void): () => void;
    stop(): Promise<void>;
    private ensureSessionSubscription;
}
export {};
//# sourceMappingURL=page-hook-transport.d.ts.map