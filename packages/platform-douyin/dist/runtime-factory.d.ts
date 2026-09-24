import { PageHookRuntimeAdapter, type PageRuntimeEvent, type PageRuntimePort } from '@platform-hub/platform-runtime';
import type { PlatformAccountRecord, PlatformRuntimeHostContext, PlatformRuntimeFactory } from '@platform-hub/platform-runtime';
export interface DouyinRuntimeFactoryOptions {
    createCdpSession(account: PlatformAccountRecord, context: PlatformRuntimeHostContext, emit: (event: PageRuntimeEvent) => void): PageRuntimePort;
}
/** Platform-owned adapter that wraps the existing CdpSession through the shared Page Hook adapter. */
export declare class DouyinRuntimeAdapter extends PageHookRuntimeAdapter {
}
export declare function createDouyinRuntimeFactory(options: DouyinRuntimeFactoryOptions): PlatformRuntimeFactory;
//# sourceMappingURL=runtime-factory.d.ts.map