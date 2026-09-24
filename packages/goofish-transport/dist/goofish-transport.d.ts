import { type HookEvent, type HookOperation, type HookResult } from '@platform-hub/core-sdk';
export declare const GOOFISH_OPERATIONS: HookOperation[];
export interface GoofishMessagingClientLike {
    listAccounts(): unknown[];
    snapshot(accountId: string): Promise<unknown>;
    listSessions(accountId: string): Promise<unknown>;
    listMessages(accountId: string, sessionId: string, options?: Record<string, unknown>): Promise<unknown>;
    sendText(accountId: string, sessionId: string, text: string, options?: Record<string, unknown>): Promise<unknown>;
    sendImage(accountId: string, sessionId: string, image: Record<string, unknown>): Promise<unknown>;
    listOnSaleProducts(accountId: string, options?: Record<string, unknown>): Promise<unknown>;
    on(event: 'event', listener: (event: GoofishClientEvent) => void): unknown;
    off?(event: 'event', listener: (event: GoofishClientEvent) => void): unknown;
    removeListener?(event: 'event', listener: (event: GoofishClientEvent) => void): unknown;
}
export interface GoofishClientEvent {
    accountId: string;
    eventType: string;
    payload?: unknown;
}
export interface GoofishTransportOptions {
    /** Stable Platform Hub account identity; never changes during migration. */
    accountId: string;
    /** Legacy client key. It is re-keyed in place when Goofish discovers shop_id. */
    clientAccountId: string;
    client: GoofishMessagingClientLike;
    now?: () => number;
}
/**
 * Adapts the mature Electron Goofish client to the shared Hook Transport
 * contract. It owns no BrowserWindow, WebContents or Electron partition.
 */
export declare class GoofishTransport {
    readonly accountId: string;
    private clientAccountId;
    private readonly client;
    private readonly now;
    private readonly outbound;
    private readonly listeners;
    private readonly seenMessages;
    private clientListener?;
    private listening;
    private started;
    private stopped;
    private listenWatermark?;
    private selfId;
    private shopId;
    constructor(options: GoofishTransportOptions);
    get underlyingAccountId(): string;
    get capabilities(): readonly HookOperation[];
    start(): Promise<void>;
    subscribe(listener: (event: HookEvent) => void): () => void;
    invoke<T = unknown>(operation: HookOperation | string, input?: unknown): Promise<HookResult<T>>;
    stop(): Promise<void>;
    private invokeOperation;
    private readAuth;
    private sendText;
    private sendImage;
    private onClientEvent;
    private emitAuthChanged;
    private emit;
    private pruneSeenMessages;
}
//# sourceMappingURL=goofish-transport.d.ts.map