import { assertPageHookRuntime, noopHookLogger } from '@platform-hub/hook-sdk';
/** Owns pages which stay alive for the lifetime of one HookSession. */
export class PersistentPageManager {
    options;
    pages = new Map();
    disposed = false;
    started = false;
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? noopHookLogger;
    }
    get size() { return this.pages.size; }
    get ids() { return [...this.pages.keys()]; }
    async start() {
        if (this.disposed)
            throw new Error('PersistentPageManager 已停止');
        if (this.started)
            return;
        this.started = true;
        try {
            for (const definition of this.options.manifest.pages.filter((page) => page.kind === 'persistent')) {
                await this.ensure(definition);
            }
        }
        catch (error) {
            await this.dispose();
            throw error;
        }
    }
    async ensure(definition) {
        if (definition.kind !== 'persistent')
            throw new Error(`页面 ${definition.id} 不是 Persistent Page`);
        if (this.disposed)
            throw new Error('PersistentPageManager 已停止');
        const current = this.pages.get(definition.id);
        if (current?.runtime && current.page.isAlive())
            return this.handleFor(definition.id, current);
        if (current)
            await this.disposeEntry(definition.id, current);
        const page = await this.options.factory.create(this.contextFor(definition));
        let runtime;
        try {
            runtime = await page.installRuntime();
            assertPageHookRuntime(runtime, this.options.manifest, definition);
            if (this.disposed)
                throw new Error('PersistentPageManager 已停止');
            const entry = { page, runtime };
            entry.unsubscribeEvents = await this.subscribeToPage(page);
            this.pages.set(definition.id, entry);
            return this.handleFor(definition.id, entry);
        }
        catch (error) {
            try {
                await runtime?.dispose();
            }
            catch { /* creation failure cleanup */ }
            try {
                await page.close();
            }
            catch { /* creation failure cleanup */ }
            throw error;
        }
    }
    async show(pageId) {
        const entry = this.pages.get(pageId);
        if (entry)
            await entry.page.show();
    }
    async drainEvents() {
        const events = [];
        for (const [pageId, entry] of this.pages) {
            if (entry.unsubscribeEvents || !entry.runtime)
                continue;
            try {
                events.push(...await entry.runtime.drainEvents());
            }
            catch (error) {
                this.options.onEventError?.(error);
                this.logger.warn('Persistent event drain failed', { pageId, error: errorMessage(error) });
            }
        }
        return events;
    }
    async refreshRuntime(pageId, entry) {
        if (this.disposed || this.pages.get(pageId) !== entry)
            throw new Error('PersistentPageManager 已停止');
        const previous = entry.runtime;
        entry.runtime = undefined;
        try {
            entry.unsubscribeEvents?.();
        }
        catch (error) {
            this.logger.warn('Persistent event subscription cleanup failed', { pageId, error: errorMessage(error) });
        }
        entry.unsubscribeEvents = undefined;
        if (previous) {
            try {
                await previous.dispose();
            }
            catch (error) {
                this.logger.warn('Previous persistent runtime dispose failed during refresh', { pageId, error: errorMessage(error) });
            }
        }
        let next;
        try {
            next = await entry.page.installRuntime();
            assertPageHookRuntime(next, this.options.manifest, entry.page.definition);
            if (this.disposed || this.pages.get(pageId) !== entry || !entry.page.isAlive())
                throw new Error('PersistentPageManager 已停止');
            entry.runtime = next;
            entry.unsubscribeEvents = await this.subscribeToPage(entry.page);
            return next;
        }
        catch (error) {
            try {
                await next?.dispose();
            }
            catch (disposeError) {
                this.logger.warn('Invalid persistent runtime dispose failed', { pageId, error: errorMessage(disposeError) });
            }
            await this.disposeEntry(pageId, entry);
            throw error;
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.started = false;
        await Promise.all([...this.pages.entries()].map(([id, entry]) => this.disposeEntry(id, entry)));
        this.pages.clear();
    }
    handleFor(id, entry) {
        return {
            page: entry.page,
            get runtime() {
                if (!entry.runtime)
                    throw new Error(`Persistent Runtime 不可用: ${id}`);
                return entry.runtime;
            },
            refreshRuntime: () => this.refreshRuntime(id, entry),
        };
    }
    async disposeEntry(id, entry) {
        this.pages.delete(id);
        try {
            entry.unsubscribeEvents?.();
        }
        catch (error) {
            this.logger.warn('Persistent event subscription cleanup failed', { pageId: id, error: errorMessage(error) });
        }
        entry.unsubscribeEvents = undefined;
        const runtime = entry.runtime;
        entry.runtime = undefined;
        try {
            await runtime?.dispose();
        }
        catch (error) {
            this.logger.warn('Persistent runtime dispose failed', { pageId: id, error: errorMessage(error) });
        }
        try {
            await entry.page.close();
        }
        catch (error) {
            this.logger.warn('Persistent page close failed', { pageId: id, error: errorMessage(error) });
        }
    }
    async subscribeToPage(page) {
        if (!page.subscribeEvents || !this.options.onEvent)
            return undefined;
        try {
            return await page.subscribeEvents(this.options.onEvent);
        }
        catch (error) {
            this.logger.warn('Persistent push event subscription failed; polling fallback remains active', { pageId: page.id, error: errorMessage(error) });
            return undefined;
        }
    }
    contextFor(definition) {
        return {
            sessionId: this.options.sessionId,
            shopId: this.options.shopId,
            partition: this.options.partition,
            manifest: this.options.manifest,
            definition,
        };
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=persistent-page-manager.js.map