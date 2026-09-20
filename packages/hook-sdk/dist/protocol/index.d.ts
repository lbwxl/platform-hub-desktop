import { type HookCapability, type HookOperation } from '../capabilities/index.js';
import type { HookError } from '../errors/index.js';
import type { HookEvent } from '../events/index.js';
export declare const HOOK_PROTOCOL_VERSION = 1;
export type HookResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: HookError;
};
export declare const ok: <T>(data: T) => HookResult<T>;
export declare const fail: (error: HookError) => HookResult<never>;
export interface HookRuntimeDescription {
    protocolVersion: number;
    platform: string;
    pageId: string;
    capabilities: HookCapability[];
    operations: HookOperation[];
}
/** The only page API the host is allowed to call. */
export interface PageHookRuntime {
    protocolVersion: number;
    describe(): HookRuntimeDescription;
    invoke(operation: string, input: unknown): Promise<HookResult<unknown>>;
    drainEvents(): Promise<HookEvent[]>;
    dispose(): Promise<void>;
}
export interface HookPageDefinition {
    id: string;
    kind: 'primary' | 'worker';
    url?: string;
    idleTtlMs?: number;
}
export interface HookOperationDefinition {
    page: string;
    capability: HookCapability;
}
export interface HookManifest {
    platform: string;
    version: string;
    capabilities: HookCapability[];
    pages: HookPageDefinition[];
    operations: Partial<Record<HookOperation, HookOperationDefinition>>;
}
export declare class HookProtocolCompatibilityError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
export declare function validatePageHookRuntime(runtime: PageHookRuntime, manifest: HookManifest, page: HookPageDefinition): string[];
export declare function assertPageHookRuntime(runtime: PageHookRuntime, manifest: HookManifest, page: HookPageDefinition): void;
export declare function validateHookManifest(manifest: HookManifest): string[];
//# sourceMappingURL=index.d.ts.map