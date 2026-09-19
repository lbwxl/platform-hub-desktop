import type { HookManifest } from '@platform-hub/hook-sdk';
import { HookSession, type HookSessionOptions } from './session/hook-session.js';
import type { HookPageFactory } from './pages/types.js';
import { WorkerScheduler } from './scheduler/worker-scheduler.js';
export interface HookHostOptions {
    pageFactory: HookPageFactory;
    maxWorkerConcurrency?: number;
}
export declare class HookHost {
    private readonly options;
    readonly scheduler: WorkerScheduler;
    constructor(options: HookHostOptions);
    createSession(manifest: HookManifest, session: Omit<HookSessionOptions, 'manifest' | 'factory' | 'scheduler' | 'partition'> & {
        partition?: string;
    }): HookSession;
    stop(): void;
}
export * from './pages/types.js';
export * from './pages/worker-page-manager.js';
export * from './scheduler/worker-scheduler.js';
export * from './session/hook-session.js';
export * from './transport/electron-page-factory.js';
//# sourceMappingURL=index.d.ts.map