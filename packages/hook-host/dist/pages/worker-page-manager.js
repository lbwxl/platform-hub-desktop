import { assertPageHookRuntime, noopHookLogger } from '@platform-hub/hook-sdk';
export class WorkerPageManager {
    options;
    workers = new Map();
    waiters = [];
    disposed = false;
    maxWorkers;
    defaultIdleTtlMs;
    logger;
    constructor(options) {
        this.options = options;
        this.maxWorkers = Math.max(1, options.maxWorkers ?? 2);
        this.defaultIdleTtlMs = Math.max(1, options.defaultIdleTtlMs ?? 30_000);
        this.logger = options.logger ?? noopHookLogger;
    }
    get size() { return this.workers.size; }
    get ids() { return [...this.workers.keys()]; }
    async acquire(definition, signal) {
        if (definition.kind !== 'worker')
            throw new Error(`页面 ${definition.id} 不是 Worker Page`);
        while (!this.disposed) {
            if (signal?.aborted)
                throw new Error('Worker 获取已取消');
            const existing = this.workers.get(definition.id);
            if (existing && existing.page.isAlive() && !existing.inUse) {
                existing.inUse = true;
                existing.lastUsedAt = Date.now();
                this.clearIdleTimer(existing);
                return this.leaseFor(definition.id, existing);
            }
            if (!existing && this.workers.size < this.maxWorkers) {
                const page = await this.options.factory.create(this.contextFor(definition));
                let runtime;
                try {
                    runtime = await page.installRuntime();
                    assertPageHookRuntime(runtime, this.options.manifest, definition);
                }
                catch (error) {
                    try {
                        await runtime?.dispose();
                    }
                    catch { /* invalid runtime cleanup */ }
                    try {
                        await page.close();
                    }
                    catch { /* creation failure cleanup */ }
                    throw error;
                }
                if (this.disposed) {
                    try {
                        await runtime.dispose();
                    }
                    catch { /* manager is stopping */ }
                    try {
                        await page.close();
                    }
                    catch { /* manager is stopping */ }
                    throw new Error('WorkerPageManager 已停止');
                }
                const entry = { page, runtime, inUse: true, lastUsedAt: Date.now() };
                entry.unsubscribeEvents = await this.subscribeToPage(page);
                this.workers.set(definition.id, entry);
                return this.leaseFor(definition.id, entry);
            }
            const idle = [...this.workers.entries()].find(([, value]) => !value.inUse);
            if (idle) {
                await this.disposeEntry(idle[0], idle[1]);
                continue;
            }
            await this.waitForAvailability(signal);
        }
        throw new Error('WorkerPageManager 已停止');
    }
    async show(pageId) {
        const entry = this.workers.get(pageId);
        if (entry)
            await entry.page.show();
    }
    async drainEvents() {
        const events = [];
        for (const entry of this.workers.values()) {
            if (entry.unsubscribeEvents)
                continue;
            if (!entry.runtime)
                continue;
            try {
                events.push(...await entry.runtime.drainEvents());
            }
            catch (error) {
                this.options.onEventError?.(error);
            }
        }
        return events;
    }
    async dispose() {
        this.disposed = true;
        while (this.waiters.length)
            this.waiters.shift()?.();
        await Promise.all([...this.workers.entries()].map(([id, entry]) => this.disposeEntry(id, entry)));
        this.workers.clear();
    }
    leaseFor(id, entry) {
        return {
            page: entry.page,
            get runtime() {
                if (!entry.runtime)
                    throw new Error(`Worker Runtime 不可用: ${id}`);
                return entry.runtime;
            },
            refreshRuntime: () => this.refreshRuntime(id, entry),
            release: () => {
                if (!entry.inUse)
                    return;
                entry.inUse = false;
                if (this.disposed || this.workers.get(id) !== entry)
                    return;
                entry.lastUsedAt = Date.now();
                this.scheduleIdleDispose(id, entry);
                this.notifyAvailability();
            },
            discard: async () => {
                entry.inUse = false;
                if (this.workers.get(id) === entry)
                    await this.disposeEntry(id, entry);
            },
        };
    }
    scheduleIdleDispose(id, entry) {
        this.clearIdleTimer(entry);
        const ttl = entry.page.definition.idleTtlMs ?? this.defaultIdleTtlMs;
        entry.idleTimer = setTimeout(() => {
            if (!entry.inUse && Date.now() - entry.lastUsedAt >= ttl)
                void this.disposeEntry(id, entry);
        }, ttl);
        entry.idleTimer.unref?.();
    }
    clearIdleTimer(entry) {
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }
    async disposeEntry(id, entry) {
        this.clearIdleTimer(entry);
        this.workers.delete(id);
        const runtime = entry.runtime;
        entry.runtime = undefined;
        try {
            entry.unsubscribeEvents?.();
        }
        catch (error) {
            this.logger.warn('Worker event subscription cleanup failed', { pageId: id, error: errorMessage(error) });
        }
        try {
            await runtime?.dispose();
        }
        catch (error) {
            this.logger.warn('Worker runtime dispose failed', { pageId: id, error: errorMessage(error) });
        }
        try {
            await entry.page.close();
        }
        catch (error) {
            this.logger.warn('Worker page close failed', { pageId: id, error: errorMessage(error) });
        }
        this.notifyAvailability();
    }
    async refreshRuntime(id, entry) {
        const previous = entry.runtime;
        entry.runtime = undefined;
        if (previous) {
            try {
                await previous.dispose();
            }
            catch (error) {
                this.logger.warn('Previous worker runtime dispose failed during refresh', { pageId: id, error: errorMessage(error) });
            }
        }
        let next;
        try {
            next = await entry.page.installRuntime();
            assertPageHookRuntime(next, this.options.manifest, entry.page.definition);
            if (this.disposed || this.workers.get(id) !== entry)
                throw new Error('WorkerPageManager 已停止');
            entry.runtime = next;
            return next;
        }
        catch (error) {
            try {
                await next?.dispose();
            }
            catch (disposeError) {
                this.logger.warn('Invalid worker runtime dispose failed', { pageId: id, error: errorMessage(disposeError) });
            }
            this.clearIdleTimer(entry);
            this.workers.delete(id);
            try {
                entry.unsubscribeEvents?.();
            }
            catch { /* refresh failure cleanup */ }
            try {
                await entry.page.close();
            }
            catch (closeError) {
                this.logger.warn('Worker page close failed after refresh failure', { pageId: id, error: errorMessage(closeError) });
            }
            this.notifyAvailability();
            throw error;
        }
    }
    async subscribeToPage(page) {
        if (!page.subscribeEvents || !this.options.onEvent)
            return undefined;
        try {
            return await page.subscribeEvents(this.options.onEvent);
        }
        catch (error) {
            this.logger.warn('Worker push event subscription failed; polling fallback remains active', { pageId: page.id, error: errorMessage(error) });
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
    waitForAvailability(signal) {
        return new Promise((resolve, reject) => {
            const wake = () => { cleanup(); resolve(); };
            const onAbort = () => { cleanup(); reject(new Error('Worker 获取已取消')); };
            const cleanup = () => {
                signal?.removeEventListener('abort', onAbort);
                const index = this.waiters.indexOf(wake);
                if (index >= 0)
                    this.waiters.splice(index, 1);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(wake);
        });
    }
    notifyAvailability() { this.waiters.splice(0).forEach((wake) => wake()); }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=worker-page-manager.js.map