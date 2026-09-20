import { type HookErrorCode, type HookLogger } from '@platform-hub/hook-sdk';
import type { HookPageDefinition } from '@platform-hub/hook-sdk';
import type { WorkerPageLease } from '../pages/types.js';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
export type WorkerPriority = 'auth' | 'message' | 'order' | 'product' | number;
export declare class WorkerSchedulerError extends Error {
    readonly code: HookErrorCode;
    constructor(code: HookErrorCode, message: string);
}
export interface WorkerTaskOptions<T> {
    manager: WorkerPageManager;
    page: HookPageDefinition;
    priority?: WorkerPriority;
    timeoutMs?: number;
    signal?: AbortSignal;
    run: (lease: WorkerPageLease, signal: AbortSignal) => Promise<T>;
}
export declare class WorkerScheduler {
    private readonly maxConcurrency;
    private readonly queue;
    private active;
    private sequence;
    private stopped;
    private readonly activeControllers;
    private readonly logger;
    constructor(maxConcurrency?: number, logger?: HookLogger);
    get activeCount(): number;
    get queuedCount(): number;
    get concurrencyLimit(): number;
    schedule<T>(options: WorkerTaskOptions<T>): Promise<T>;
    stop(): void;
    private priorityOf;
    private pump;
    private run;
    private removeQueueAbortListener;
}
export declare function schedulerErrorResult(error: unknown): import("@platform-hub/hook-sdk").HookError;
//# sourceMappingURL=worker-scheduler.d.ts.map