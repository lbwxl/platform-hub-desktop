import { type HookEvent, type HookLogger, type HookManifest, type HookPageDefinition } from '@platform-hub/core-sdk';
import type { HookPageFactory, WorkerPageLease } from './types.js';
export interface WorkerPageManagerOptions {
    sessionId: string;
    shopId: string;
    partition: string;
    manifest: HookManifest;
    factory: HookPageFactory;
    maxWorkers?: number;
    defaultIdleTtlMs?: number;
    logger?: HookLogger;
    onEvent?: (event: HookEvent) => void;
    onEventError?: (error: unknown) => void;
}
export declare class WorkerPageManager {
    private readonly options;
    private readonly workers;
    private readonly waiters;
    private disposed;
    private readonly maxWorkers;
    private readonly defaultIdleTtlMs;
    private readonly logger;
    constructor(options: WorkerPageManagerOptions);
    get size(): number;
    get ids(): string[];
    acquire(definition: HookPageDefinition, signal?: AbortSignal): Promise<WorkerPageLease>;
    show(pageId: string): Promise<void>;
    drainEvents(): Promise<HookEvent[]>;
    dispose(): Promise<void>;
    private leaseFor;
    private scheduleIdleDispose;
    private clearIdleTimer;
    private disposeEntry;
    private refreshRuntime;
    private subscribeToPage;
    private contextFor;
    private waitForAvailability;
    private notifyAvailability;
}
//# sourceMappingURL=worker-page-manager.d.ts.map