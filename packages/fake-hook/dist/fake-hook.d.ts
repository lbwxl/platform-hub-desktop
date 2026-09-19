import { HookHost, HookSession, type HookPageAdapter, type HookPageContext, type HookPageFactory } from '@platform-hub/hook-host';
import { type HookEvent, type HookMessage, type HookOperation, type HookOrder, type HookProduct, type PageHookRuntime } from '@platform-hub/hook-sdk';
interface FakeShopState {
    authenticated: boolean;
    messages: HookMessage[];
    products: HookProduct[];
    orders: Map<string, HookOrder>;
    orderFingerprints: Map<string, string>;
    pageEvents: Map<string, HookEvent[]>;
    challengeOperations: Set<string>;
    challengeWaiters: Set<() => void>;
    failNextOperations: Set<string>;
    ordersListening: boolean;
}
export declare class FakeHookPageFactory implements HookPageFactory {
    private readonly shops;
    readonly pages: FakeHookPageAdapter[];
    createCount: number;
    closeCount: number;
    installCount: number;
    create(context: HookPageContext): Promise<HookPageAdapter>;
    setAuthenticated(shopId: string, authenticated: boolean): void;
    emitIncomingMessage(shopId: string, message?: Partial<HookMessage>): HookMessage;
    emitOrder(shopId: string, order: HookOrder): boolean;
    requireChallenge(shopId: string, pageId: string, operation: HookOperation): void;
    solveChallenge(shopId: string, pageId: string, operation: HookOperation): void;
    failNext(shopId: string, pageId: string, operation: HookOperation): void;
    stateFor(shopId: string): FakeShopState;
    private pushEvent;
}
export declare class FakeHook {
    readonly shopId: string;
    readonly factory: FakeHookPageFactory;
    readonly host: HookHost;
    readonly session: HookSession;
    constructor(shopId?: string, options?: {
        sessionId?: string;
        maxWorkerConcurrency?: number;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    login(): void;
    logout(): void;
    receiveMessage(message?: Partial<HookMessage>): HookMessage;
    createOrder(order: HookOrder): boolean;
    updateOrder(order: HookOrder): boolean;
    requireChallenge(operation: HookOperation, pageId?: string): void;
    completeChallenge(operation: HookOperation, pageId?: string): void;
    failNext(operation: HookOperation, pageId?: string): void;
    workerPageCount(): number;
    workerPageIds(): string[];
}
declare class FakeHookPageAdapter implements HookPageAdapter {
    private readonly context;
    private readonly state;
    private readonly owner;
    readonly id: string;
    readonly partition: string;
    readonly definition: HookPageContext['definition'];
    visible: boolean;
    private alive;
    private runtime?;
    constructor(context: HookPageContext, state: FakeShopState, owner: FakeHookPageFactory);
    installRuntime(): Promise<PageHookRuntime>;
    show(): Promise<void>;
    waitForRuntimeReady(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    isAlive(): boolean;
}
export {};
//# sourceMappingURL=fake-hook.d.ts.map