import { type HookLogger, type HookManifest } from '@platform-hub/hook-sdk';
import { HookSession, type HookSessionOptions } from './session/hook-session.js';
import type { HookPageFactory } from './pages/types.js';
import { WorkerScheduler } from './scheduler/worker-scheduler.js';
export interface HookHostOptions {
    pageFactory: HookPageFactory;
    maxWorkerConcurrency?: number;
    logger?: HookLogger;
}
export declare class HookHost {
    private readonly options;
    readonly scheduler: WorkerScheduler;
    private readonly sessions;
    private readonly logger;
    private disposed;
    constructor(options: HookHostOptions);
    get sessionCount(): number;
    createSession(manifest: HookManifest, session: Omit<HookSessionOptions, 'manifest' | 'factory' | 'scheduler' | 'partition' | 'logger'> & {
        partition?: string;
    }): HookSession;
    getSession(sessionId: string): HookSession | undefined;
    disposeSession(sessionId: string): Promise<boolean>;
    dispose(): Promise<void>;
    stop(): Promise<void>;
}
export * from './pages/types.js';
export * from './pages/worker-page-manager.js';
export * from './scheduler/worker-scheduler.js';
export * from './session/hook-session.js';
export * from './transport/electron-page-factory.js';
//# sourceMappingURL=index.d.ts.map