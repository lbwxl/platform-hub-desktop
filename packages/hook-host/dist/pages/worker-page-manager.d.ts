import type { HookManifest, HookPageDefinition, PageHookRuntime } from '@platform-hub/hook-sdk';
import type { HookPageFactory, WorkerPageLease } from './types.js';
export interface WorkerPageManagerOptions {
    sessionId: string;
    shopId: string;
    partition: string;
    manifest: HookManifest;
    factory: HookPageFactory;
    maxWorkers?: number;
    defaultIdleTtlMs?: number;
}
export declare class WorkerPageManager {
    private readonly options;
    private readonly workers;
    private readonly waiters;
    private disposed;
    private readonly maxWorkers;
    private readonly defaultIdleTtlMs;
    constructor(options: WorkerPageManagerOptions);
    get size(): number;
    get ids(): string[];
    acquire(definition: HookPageDefinition, signal?: AbortSignal): Promise<WorkerPageLease>;
    show(pageId: string): Promise<void>;
    drainEvents(): Promise<ReturnType<PageHookRuntime['drainEvents']>>;
    dispose(): Promise<void>;
    private leaseFor;
    private scheduleIdleDispose;
    private clearIdleTimer;
    private disposeEntry;
    private contextFor;
    private waitForAvailability;
    private notifyAvailability;
}
//# sourceMappingURL=worker-page-manager.d.ts.map