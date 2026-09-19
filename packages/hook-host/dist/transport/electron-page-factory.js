import { createRequire } from 'node:module';
/** BrowserWindow ownership stays in Host; a platform only supplies runtime installation. */
export class ElectronHookPageFactory {
    options;
    constructor(options) {
        this.options = options;
    }
    async create(context) {
        const window = this.options.createWindow?.(context) || newBrowserWindow({
            ...this.options.windowOptions,
            show: context.definition.kind === 'primary',
            title: `${context.manifest.platform} · ${context.definition.id}`,
            webPreferences: {
                partition: context.partition,
                contextIsolation: false,
                nodeIntegration: false,
                webSecurity: true,
            },
        });
        const page = new ElectronHookPageAdapter(context, window, this.options);
        await page.load();
        return page;
    }
}
function newBrowserWindow(options) {
    // Keep the generic Host importable in Node test processes; Electron is loaded only when a page is created.
    const require = createRequire(import.meta.url);
    const { BrowserWindow: ElectronBrowserWindow } = require('electron');
    return new ElectronBrowserWindow(options);
}
class ElectronHookPageAdapter {
    context;
    window;
    options;
    id;
    partition;
    definition;
    alive = true;
    runtime;
    constructor(context, window, options) {
        this.context = context;
        this.window = window;
        this.options = options;
        this.id = context.definition.id;
        this.partition = context.partition;
        this.definition = context.definition;
        this.window.on('closed', () => { this.alive = false; });
    }
    async load() {
        if (this.definition.url)
            await this.window.loadURL(this.definition.url);
    }
    async installRuntime() {
        if (!this.alive || this.window.isDestroyed())
            throw new Error(`页面 ${this.id} 已关闭`);
        this.runtime = await this.options.installRuntime(this.context, this.window.webContents);
        return this.runtime;
    }
    async show() {
        if (this.alive && !this.window.isDestroyed())
            this.window.show();
    }
    async waitForRuntimeReady(signal) {
        if (!this.options.isRuntimeReady)
            return;
        while (this.alive && !this.window.isDestroyed()) {
            if (signal?.aborted)
                throw new Error('Runtime 等待已取消');
            if (await this.options.isRuntimeReady(this.context, this.window.webContents))
                return;
            await new Promise((resolve, reject) => {
                const cleanup = () => signal?.removeEventListener('abort', abort);
                const done = () => { cleanup(); resolve(); };
                const timer = setTimeout(done, 100);
                const abort = () => { clearTimeout(timer); cleanup(); reject(new Error('Runtime 等待已取消')); };
                signal?.addEventListener('abort', abort, { once: true });
            });
        }
        throw new Error(`页面 ${this.id} 已关闭`);
    }
    async close() {
        if (!this.window.isDestroyed())
            this.window.close();
        try {
            await this.runtime?.dispose();
        }
        catch { /* renderer teardown */ }
        this.runtime = undefined;
        this.alive = false;
    }
    isAlive() { return this.alive && !this.window.isDestroyed(); }
}
//# sourceMappingURL=electron-page-factory.js.map