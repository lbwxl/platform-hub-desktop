import { HookHost, HookSession, type HookPageAdapter, type HookPageContext, type HookPageFactory } from '@platform-hub/hook-host';
import { OutboundCorrelationTracker, type HookEvent, type HookHandoffTarget, type HookHandoffTransferResult, type HookMessage, type HookMessageType, type HookOperation, type HookOrder, type HookProduct, type PageHookRuntime } from '@platform-hub/hook-sdk';
interface FakeShopState {
    authenticated: boolean;
    messages: HookMessage[];
    products: HookProduct[];
    orders: Map<string, HookOrder>;
    pageEvents: Map<string, HookEvent[]>;
    pageListeners: Map<string, Set<(event: HookEvent) => void>>;
    challengeOperations: Set<string>;
    challengeWaiters: Set<() => void>;
    failNextOperations: Set<string>;
    operationDelays: Map<string, number>;
    ordersListening: boolean;
    outbound: OutboundCorrelationTracker;
    handoffTargets: HookHandoffTarget[];
    handoffs: HookHandoffTransferResult[];
    failStart: boolean;
    failStop: boolean;
}
export interface FakeHookPageFactoryOptions {
    pushEvents?: boolean;
    drainDelayMs?: number;
}
export declare class FakeHookPageFactory implements HookPageFactory {
    private readonly shops;
    readonly pages: FakeHookPageAdapter[];
    readonly pushEvents: boolean;
    readonly drainDelayMs: number;
    createCount: number;
    closeCount: number;
    installCount: number;
    drainCount: number;
    subscriptionCount: number;
    activeDrains: number;
    maxActiveDrains: number;
    constructor(options?: FakeHookPageFactoryOptions);
    create(context: HookPageContext): Promise<HookPageAdapter>;
    setAuthenticated(shopId: string, authenticated: boolean): void;
    emitIncomingMessage(shopId: string, message?: Partial<HookMessage>): HookMessage;
    emitHumanOutgoingMessage(shopId: string, input?: {
        conversationId?: string;
        content?: string;
        type?: HookMessageType;
    }): HookMessage;
    emitOrder(shopId: string, order: HookOrder): boolean;
    requireChallenge(shopId: string, pageId: string, operation: HookOperation): void;
    solveChallenge(shopId: string, pageId: string, operation: HookOperation): void;
    failNext(shopId: string, pageId: string, operation: HookOperation): void;
    setOperationDelay(shopId: string, pageId: string, operation: HookOperation, delayMs: number): void;
    failNextStart(shopId: string): void;
    failNextStop(shopId: string): void;
    stateFor(shopId: string): FakeShopState;
    subscribe(state: FakeShopState, pageId: string, listener: (event: HookEvent) => void): () => void;
    pushEvent(state: FakeShopState, pageId: string, event: HookEvent): void;
    private appendMessage;
    private emitPlatformOutgoing;
    sendAutomation(state: FakeShopState, input: {
        conversationId: string;
        content: string;
        type: HookMessageType;
        attachments?: HookMessage['attachments'];
    }): HookMessage;
}
export declare class FakeHook {
    readonly shopId: string;
    readonly factory: FakeHookPageFactory;
    readonly host: HookHost;
    readonly session: HookSession;
    constructor(shopId?: string, options?: {
        sessionId?: string;
        maxWorkerConcurrency?: number;
        pushEvents?: boolean;
        challengeTimeoutMs?: number;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    login(): void;
    logout(): void;
    receiveMessage(message?: Partial<HookMessage>): HookMessage;
    sendHumanMessage(input?: {
        conversationId?: string;
        content?: string;
        type?: HookMessageType;
    }): HookMessage;
    createOrder(order: HookOrder): boolean;
    updateOrder(order: HookOrder): boolean;
    requireChallenge(operation: HookOperation, pageId?: string): void;
    completeChallenge(operation: HookOperation, pageId?: string): void;
    failNext(operation: HookOperation, pageId?: string): void;
    setOperationDelay(operation: HookOperation, delayMs: number, pageId?: string): void;
    failNextStart(): void;
    failNextStop(): void;
    workerPageCount(): number;
    workerPageIds(): string[];
}
export declare class FakeHookPageAdapter implements HookPageAdapter {
    private readonly context;
    private readonly state;
    private readonly owner;
    readonly id: string;
    readonly partition: string;
    readonly definition: HookPageContext['definition'];
    readonly subscribeEvents?: (listener: (event: HookEvent) => void) => () => void;
    visible: boolean;
    private alive;
    constructor(context: HookPageContext, state: FakeShopState, owner: FakeHookPageFactory);
    installRuntime(): Promise<PageHookRuntime>;
    show(): Promise<void>;
    waitForRuntimeReady(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    isAlive(): boolean;
}
export {};
//# sourceMappingURL=fake-hook.d.ts.map