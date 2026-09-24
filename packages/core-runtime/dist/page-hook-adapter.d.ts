import { type HookEvent, type HookOperation, type HookResult } from '@platform-hub/core-sdk';
import type { HookTransport } from '@platform-hub/core-transport';
import type { PageHookManifest, PlatformAccountRecord, PlatformRuntimeAdapter, PlatformRuntimeFactory, PlatformRuntimeHostContext, PlatformRuntimeStatus, PlatformViewBounds } from './contracts.js';
export interface PageRuntimeStatusLike {
    connected: boolean;
    authenticated: boolean;
    url: string;
    title?: string;
    message: string;
    webContentsId?: number;
}
export interface PageRuntimePort {
    open(show?: boolean): Promise<void>;
    invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
    attachPrimaryView(): void;
    detachPrimaryView(): void;
    setPrimaryBounds(bounds: PlatformViewBounds): void;
    getStatus(): PageRuntimeStatusLike;
    refreshStatus(): Promise<PageRuntimeStatusLike>;
    getWebContentsId(): number | undefined;
    bindHostWindow(window: unknown): void;
    showRuntimePageFor(method: string): Promise<void>;
    waitForLogin(timeoutMs?: number, method?: string): Promise<void>;
    close(): void;
}
export interface PageRuntimeFactoryOptions {
    manifest: PageHookManifest;
    createRuntime(account: PlatformAccountRecord, context: PlatformRuntimeHostContext, emit: (event: PageRuntimeEvent) => void): PageRuntimePort;
    operationMethods?: Record<string, string>;
}
export interface PageRuntimeEvent {
    id: string;
    accountId: string;
    platform: string;
    type: string;
    timestamp: number;
    payload: unknown;
}
export declare function createPageRuntimeFactory(options: PageRuntimeFactoryOptions): PlatformRuntimeFactory;
export declare class PageHookRuntimeAdapter implements PlatformRuntimeAdapter {
    private readonly account;
    private readonly runtime;
    private readonly context;
    readonly transport: PageRuntimeHookTransport;
    constructor(account: PlatformAccountRecord, runtime: PageRuntimePort, context: PlatformRuntimeHostContext, operationMethods?: Record<string, string>);
    get id(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): Promise<PlatformRuntimeStatus>;
    attachPrimaryView(): Promise<void>;
    detachPrimaryView(): void;
    updatePrimaryViewBounds(bounds: PlatformViewBounds): void;
    getPrimaryWebContentsId(): number | undefined;
    bindHostWindow(window: unknown): void;
    showOperationPage(operation: string): Promise<void>;
    waitForLogin(operation: string): Promise<void>;
    dispose(): Promise<void>;
    acceptPlatformEvent(event: PageRuntimeEvent): void;
}
declare class PageRuntimeHookTransport implements HookTransport {
    private readonly runtime;
    private readonly account;
    private readonly operationMethods;
    private readonly listeners;
    private started;
    private stopped;
    private startPromise?;
    constructor(runtime: PageRuntimePort, account: PlatformAccountRecord, operationMethods?: Record<string, string>);
    start(): Promise<void>;
    invoke<T = unknown>(operation: HookOperation | string, input: unknown): Promise<HookResult<T>>;
    subscribe(listener: (event: HookEvent) => void): () => void;
    stop(): Promise<void>;
    acceptPlatformEvent(source: PageRuntimeEvent): void;
}
export {};
//# sourceMappingURL=page-hook-adapter.d.ts.map