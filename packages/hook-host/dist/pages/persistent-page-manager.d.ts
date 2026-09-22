import { type HookEvent, type HookLogger, type HookManifest, type HookPageDefinition, type PageHookRuntime } from '@platform-hub/hook-sdk';
import type { HookPageAdapter, HookPageFactory } from './types.js';
export interface PersistentPageManagerOptions {
    sessionId: string;
    shopId: string;
    partition: string;
    manifest: HookManifest;
    factory: HookPageFactory;
    logger?: HookLogger;
    onEvent?: (event: HookEvent) => void;
    onEventError?: (error: unknown) => void;
}
/** Owns pages which stay alive for the lifetime of one HookSession. */
export declare class PersistentPageManager {
    private readonly options;
    private readonly pages;
    private readonly pending;
    private disposed;
    private started;
    private readonly logger;
    constructor(options: PersistentPageManagerOptions);
    get size(): number;
    get ids(): string[];
    start(): Promise<void>;
    ensure(definition: HookPageDefinition): Promise<PersistentPageHandle>;
    private create;
    show(pageId: string): Promise<void>;
    drainEvents(): Promise<HookEvent[]>;
    private refreshRuntime;
    dispose(): Promise<void>;
    private handleFor;
    private disposeEntry;
    private subscribeToPage;
    private contextFor;
}
export interface PersistentPageHandle {
    readonly page: HookPageAdapter;
    readonly runtime: PageHookRuntime;
    refreshRuntime(): Promise<PageHookRuntime>;
}
//# sourceMappingURL=persistent-page-manager.d.ts.map