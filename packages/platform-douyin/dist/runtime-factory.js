import { PageHookRuntimeAdapter } from '@platform-hub/platform-runtime';
import { douyinHook } from './manifest.js';
const DEFINITION = {
    id: douyinHook.id,
    label: douyinHook.label,
    url: douyinHook.url,
    executionModel: 'page',
    capabilities: [...douyinHook.capabilities],
    version: douyinHook.version,
    defaultOnFirstLaunch: true,
};
/** Platform-owned adapter that wraps the existing CdpSession through the shared Page Hook adapter. */
export class DouyinRuntimeAdapter extends PageHookRuntimeAdapter {
}
export function createDouyinRuntimeFactory(options) {
    return {
        definition: DEFINITION,
        create(account, context) {
            let adapter;
            const runtime = options.createCdpSession(account, context, (event) => adapter?.acceptPlatformEvent(event));
            adapter = new DouyinRuntimeAdapter(account, runtime, context);
            return adapter;
        },
    };
}
//# sourceMappingURL=runtime-factory.js.map