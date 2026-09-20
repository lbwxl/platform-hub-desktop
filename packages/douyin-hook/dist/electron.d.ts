import { ElectronHookPageFactory, type ElectronPageFactoryOptions } from '@platform-hub/hook-host';
import type { WebContents } from 'electron';
import type { HookPageContext } from '@platform-hub/hook-host';
import type { HookLogger } from '@platform-hub/hook-sdk';
import { type DouyinEvaluate } from './runtime.js';
export interface DouyinElectronPageFactoryOptions extends Omit<ElectronPageFactoryOptions, 'installRuntime'> {
    evaluate?(context: HookPageContext, contents: WebContents, expression: string): Promise<unknown>;
    logger?: HookLogger;
}
export declare function createDouyinElectronPageFactory(options: DouyinElectronPageFactoryOptions): ElectronHookPageFactory;
export declare function createCdpEvaluator(contents: WebContents): DouyinEvaluate;
//# sourceMappingURL=electron.d.ts.map