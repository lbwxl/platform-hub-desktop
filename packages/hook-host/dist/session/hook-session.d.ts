import { type HookEvent, type HookManifest, type HookOperation, type HookResult } from '@platform-hub/hook-sdk';
import type { HookPageFactory } from '../pages/types.js';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
import { WorkerScheduler } from '../scheduler/worker-scheduler.js';
export interface HookSessionOptions {
    sessionId: string;
    shopId: string;
    manifest: HookManifest;
    factory: HookPageFactory;
    scheduler: WorkerScheduler;
    partition?: string;
    maxWorkers?: number;
    workerIdleTtlMs?: number;
    eventPollMs?: number;
}
export type HookEventListener = (event: HookEvent) => void;
export declare class HookSession {
    private readonly options;
    readonly partition: string;
    readonly workerPages: WorkerPageManager;
    private primaryPage?;
    private primaryRuntime?;
    private readonly listeners;
    private eventTimer?;
    private eventPollBusy;
    private started;
    private disposed;
    private readonly eventPollMs;
    constructor(options: HookSessionOptions);
    get isStarted(): boolean;
    get sessionId(): string;
    get shopId(): string;
    get manifest(): HookManifest;
    start(): Promise<void>;
    invoke<T>(operation: HookOperation | string, input?: unknown, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<HookResult<T>>;
    subscribe(listener: HookEventListener): () => void;
    pollEvents(): Promise<void>;
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