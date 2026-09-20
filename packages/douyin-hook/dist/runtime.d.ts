import { type HookLogger, type HookManifest, type HookPageDefinition, type HookRuntimeDescription, type PageHookRuntime } from '@platform-hub/hook-sdk';
import { douyinHookRuntimeScript } from './runtime-source.js';
export type DouyinEvaluate = <T>(expression: string) => Promise<T>;
export interface DouyinPageRuntimeOptions {
    description: HookRuntimeDescription;
    evaluate: DouyinEvaluate;
    runtimeScript?: string;
    logger?: HookLogger;
}
export declare function createDouyinPageRuntime(options: DouyinPageRuntimeOptions): PageHookRuntime;
export declare function installDouyinPageRuntime(evaluate: DouyinEvaluate, page: HookPageDefinition, manifest: HookManifest, logger?: HookLogger): Promise<PageHookRuntime>;
export { douyinHookRuntimeScript };
//# sourceMappingURL=runtime.d.ts.map