import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import type { HookEvent, PageHookRuntime } from '@platform-hub/core-sdk';
import type { HookPageAdapter, HookPageContext, HookPageFactory } from '../pages/types.js';
export interface ElectronPageFactoryOptions {
    /** Injects the platform supplied PageHookRuntime through CDP/window runtime. */
    installRuntime(context: HookPageContext, contents: WebContents): Promise<PageHookRuntime>;
    /** Optional readiness check used after a user completes an official challenge. */
    isRuntimeReady?(context: HookPageContext, contents: WebContents): Promise<boolean>;
    /** Optional native/CDP event bridge. Polling remains the fallback when omitted. */
    subscribeEvents?(context: HookPageContext, contents: WebContents, listener: (event: HookEvent) => void): Promise<() => void> | (() => void);
    createWindow?(context: HookPageContext): BrowserWindow;
    windowOptions?: Omit<BrowserWindowConstructorOptions, 'webPreferences'>;
}
/** BrowserWindow ownership stays in Host; a platform only supplies runtime installation. */
export declare class ElectronHookPageFactory implements HookPageFactory {
    private readonly options;
    constructor(options: ElectronPageFactoryOptions);
    create(context: HookPageContext): Promise<HookPageAdapter>;
}
//# sourceMappingURL=electron-page-factory.d.ts.map