import { GoofishMessagingClient } from '@idle-fish/goofish-messaging';
import { GoofishTransport } from '@platform-hub/goofish-transport';
import type { HookEvent, HookOperation, HookResult } from '@platform-hub/core-sdk';
import type { HookTransport } from '@platform-hub/core-transport';
import type { PlatformAccountRecord, PlatformDefinition, PlatformRuntimeAdapter, PlatformRuntimeFactory, PlatformRuntimeHostContext, PlatformRuntimeStatus, PlatformViewBounds } from '@platform-hub/core-runtime';
/** All Goofish account, migration, transport and visible-view ownership stays here. */
export declare class GoofishRuntimeFactory implements PlatformRuntimeFactory {
    private readonly userDataPath;
    readonly definition: PlatformDefinition;
    readonly client: GoofishMessagingClient;
    private readonly contexts;
    constructor(userDataPath?: string);
    prepareAccount(account: PlatformAccountRecord): Promise<{
        url?: string;
        partition?: string;
        adapterMetadata?: Record<string, unknown>;
    }>;
    create(account: PlatformAccountRecord, context: PlatformRuntimeHostContext): PlatformRuntimeAdapter;
    removeAccount(account: PlatformAccountRecord): Promise<void>;
    dispose(): Promise<void>;
    private findClientAccount;
    private ensureClientAccount;
}
export declare class GoofishRuntimeAdapter implements PlatformRuntimeAdapter {
    private readonly account;
    private readonly context;
    private readonly client;
    readonly transport: GoofishAdapterTransport;
    private view;
    private viewLoad?;
    private attachedWindow;
    private clientAccountId;
    private started;
    private disposed;
    private readonly clientListener;
    constructor(account: PlatformAccountRecord, clientAccountId: string, context: PlatformRuntimeHostContext, client: GoofishMessagingClient);
    get id(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): Promise<PlatformRuntimeStatus>;
    attachPrimaryView(): Promise<void>;
    detachPrimaryView(): void;
    updatePrimaryViewBounds(bounds: PlatformViewBounds): void;
    getPrimaryWebContentsId(): number | undefined;
    dispose(): Promise<void>;
    private ensureView;
    private waitForPrimary;
    private onClientEvent;
    private emitRuntimeError;
}
declare class GoofishAdapterTransport implements HookTransport {
    private readonly inner;
    private readonly listeners;
    private readonly unsubscribe;
    constructor(inner: GoofishTransport);
    start(): Promise<void>;
    invoke<T = unknown>(operation: HookOperation | string, input: unknown): Promise<HookResult<T>>;
    subscribe(listener: (event: HookEvent) => void): () => void;
    stop(): Promise<void>;
    emit(event: HookEvent): void;
}
export declare function createGoofishRuntimeFactory(userDataPath?: string): GoofishRuntimeFactory;
export {};
//# sourceMappingURL=goofish-runtime-adapter.d.ts.map