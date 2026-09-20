import { type HookEvent, type HookLogger, type HookManifest, type HookOperation, type HookResult } from '@platform-hub/hook-sdk';
import type { HookPageFactory } from '../pages/types.js';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
import { WorkerScheduler } from '../scheduler/worker-scheduler.js';
export interface HookEventPollingOptions {
    initialIntervalMs?: number;
    activeIntervalMs?: number;
    idleIntervalMs?: number;
    backoffMultiplier?: number;
}
export interface HookSessionOptions {
    sessionId: string;
    shopId: string;
    manifest: HookManifest;
    factory: HookPageFactory;
    scheduler: WorkerScheduler;
    partition?: string;
    maxWorkers?: number;
    workerIdleTtlMs?: number;
    eventPolling?: false | HookEventPollingOptions;
    challengeTimeoutMs?: number;
    logger?: HookLogger;
}
export type HookEventListener = (event: HookEvent) => void;
export declare class HookSession {
    private readonly options;
    readonly partition: string;
    readonly workerPages: WorkerPageManager;
    private primaryPage?;
    private primaryRuntime?;
    private primaryPushUnsubscribe?;
    private readonly listeners;
    private readonly lifecycleController;
    private eventTimer?;
    private eventPollBusy;
    private started;
    private disposed;
    private readonly polling;
    private eventPollDelayMs;
    private readonly challengeTimeoutMs;
    private readonly logger;
    constructor(options: HookSessionOptions);
    get isStarted(): boolean;
    get isDisposed(): boolean;
    get sessionId(): string;
    get shopId(): string;
    get manifest(): HookManifest;
    start(): Promise<void>;
    invoke<T>(operation: HookOperation | string, input?: unknown, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<HookResult<T>>;
    subscribe(listener: HookEventListener): () => void;
    pollEvents(): Promise<number>;
    dispose(): Promise<void>;
    private invokeWithRecovery;
    private emit;
    private scheduleEventPoll;
    private primaryDefinition;
    private definitionFor;
    private runtimeError;
}
export declare function partitionFor(platform: string, shopId: string): string;
//# sourceMappingURL=hook-session.d.ts.map