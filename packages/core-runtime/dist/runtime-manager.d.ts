import type { HookOperation } from '@platform-hub/core-sdk';
import type { PlatformRuntimeAdapter, PlatformRuntimeHostContext, PlatformAccountRecord } from './contracts.js';
import { PlatformRegistry } from './platform-registry.js';
/** Generic per-account runtime owner shared by the Electron manager and tests. */
export declare class PlatformRuntimeManager {
    private readonly registry;
    private readonly contextFor;
    private readonly adapters;
    constructor(registry: PlatformRegistry, contextFor: (account: PlatformAccountRecord) => PlatformRuntimeHostContext);
    ensure(account: PlatformAccountRecord): Promise<PlatformRuntimeAdapter>;
    get(accountId: string): PlatformRuntimeAdapter | undefined;
    start(account: PlatformAccountRecord): Promise<PlatformRuntimeAdapter>;
    invoke<T = unknown>(account: PlatformAccountRecord, operation: HookOperation | string, input?: unknown): Promise<T>;
    attachPrimaryView(account: PlatformAccountRecord): Promise<void>;
    detachPrimaryView(accountId: string): void;
    stop(accountId: string): Promise<void>;
    dispose(accountId: string): Promise<void>;
    disposeAll(): Promise<void>;
}
//# sourceMappingURL=runtime-manager.d.ts.map