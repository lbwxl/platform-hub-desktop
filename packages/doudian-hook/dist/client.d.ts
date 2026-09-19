import type { AuthState, ChatSession, HookEvent, OperationResult, OrderEventPayload, OrderRecord, OrderSyncResult, PlatformMessage, ProductRecord } from './types.js';
export type CdpEvaluate = <T>(expression: string) => Promise<T>;
export interface DoudianClient {
    install(): Promise<void>;
    getAuthState(): Promise<AuthState>;
    waitForLogin(options?: {
        timeoutMs?: number;
        intervalMs?: number;
    }): Promise<AuthState>;
    collectProducts(): Promise<ProductRecord[]>;
    getProductDetail(goodsId: string): Promise<ProductRecord>;
    listSessions(): Promise<ChatSession[]>;
    listMessages(sessionId: string): Promise<PlatformMessage[]>;
    sendMessage(sessionId: string, content: string): Promise<OperationResult>;
    sendFile(sessionId: string, dataUrl: string, fileName?: string): Promise<OperationResult>;
    getOrders(userId?: string): Promise<OrderRecord[] | OperationResult>;
    syncOrders(sessionId?: string, userId?: string): Promise<OrderSyncResult>;
    transferSession(sessionId: string, target: string): Promise<OperationResult>;
    drainEvents(): Promise<HookEvent[]>;
    subscribe(listener: (event: HookEvent) => void, options?: {
        intervalMs?: number;
    }): () => void;
    subscribeOrders(listener: (event: OrderEventPayload) => void, options?: {
        intervalMs?: number;
    }): () => void;
    diagnose(): Promise<Array<{
        path: string;
        methods: string[];
        score: number;
    }>>;
    dispose(): Promise<void>;
}
/** Creates a typed client over any CDP Runtime.evaluate implementation. */
export declare function createDoudianClient(evaluate: CdpEvaluate): DoudianClient;
//# sourceMappingURL=client.d.ts.map