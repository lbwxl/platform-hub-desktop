import type { HookTransport } from '@platform-hub/hook-transport';
import type { PlatformAccountRecord, PlatformRuntimeAdapter, PlatformRuntimeFactory, PlatformRuntimeStatus, PlatformViewBounds } from '@platform-hub/platform-runtime';
export declare const fakePlatformDefinition: {
    id: string;
    label: string;
    url: string;
    executionModel: "service";
    capabilities: readonly ["messages.listen"];
    version: string;
};
export declare class FakePlatformAdapter implements PlatformRuntimeAdapter {
    private readonly account;
    readonly transport: HookTransport;
    readonly calls: string[];
    private readonly listeners;
    private running;
    constructor(account: PlatformAccountRecord);
    get id(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): Promise<PlatformRuntimeStatus>;
    attachPrimaryView(): Promise<void>;
    detachPrimaryView(): void;
    updatePrimaryViewBounds(_bounds: PlatformViewBounds): void;
    dispose(): Promise<void>;
}
export declare function createFakePlatformFactory(): PlatformRuntimeFactory;
//# sourceMappingURL=index.d.ts.map