import { fail, hookError, HOOK_OPERATION_PRIORITIES, ok, } from '@platform-hub/hook-sdk';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
import { schedulerErrorResult, WorkerScheduler, WorkerSchedulerError } from '../scheduler/worker-scheduler.js';
export class HookSession {
    options;
    partition;
    workerPages;
    primaryPage;
    primaryRuntime;
    listeners = new Set();
    eventTimer;
    eventPollBusy = false;
    started = false;
    disposed = false;
    eventPollMs;
    constructor(options) {
        this.options = options;
        this.partition = options.partition || partitionFor(options.manifest.platform, options.shopId);
        this.eventPollMs = Math.max(50, options.eventPollMs ?? 500);
        this.workerPages = new WorkerPageManager({
            sessionId: options.sessionId,
            shopId: options.shopId,
            partition: this.partition,
            manifest: options.manifest,
            factory: options.factory,
            maxWorkers: options.maxWorkers,
            defaultIdleTtlMs: options.workerIdleTtlMs,
        });
    }
    get isStarted() { return this.started && !this.disposed; }
    get sessionId() { return this.options.sessionId; }
    get shopId() { return this.options.shopId; }
    get manifest() { return this.options.manifest; }
    async start() {
        if (this.disposed)
            throw new Error('HookSession 已销毁');
        if (this.started)
            return;
        const definition = this.primaryDefinition();
        this.primaryPage = await this.options.factory.create({
            sessionId: this.options.sessionId,
            shopId: this.options.shopId,
            partition: this.partition,
            manifest: this.options.manifest,
            definition,
        });
        this.primaryRuntime = await this.primaryPage.installRuntime();
        this.started = true;
        this.scheduleEventPoll();
    }
    async invoke(operation, input = {}, options) {
        if (!this.isStarted)
            return fail(hookError('RUNTIME_NOT_READY', 'HookSession 尚未启动'));
        const definition = this.definitionFor(operation);
        if (!definition)
            return fail(hookError('NOT_SUPPORTED', `Manifest 未声明 Operation: ${operation}`));
        if (definition.kind === 'primary') {
            try {
                return await this.invokeWithRecovery(this.primaryPage, this.primaryRuntime, operation, input, options?.signal, async () => {
                    this.primaryRuntime = await this.primaryPage.installRuntime();
                    return this.primaryRuntime;
                });
            }
            catch (error) {
                return fail(hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true));
            }
        }
        try {
            return await this.options.scheduler.schedule({
                manager: this.workerPages,
                page: definition,
                priority: HOOK_OPERATION_PRIORITIES[operation],
                timeoutMs: options?.timeoutMs,
                signal: options?.signal,
                run: async (lease, signal) => this.invokeWithRecovery(lease.page, lease.runtime, operation, input, signal, lease.refreshRuntime),
            });
        }
        catch (error) {
            if (error instanceof WorkerSchedulerError)
                return fail(schedulerErrorResult(error));
            return fail(hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true));
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async pollEvents() {
        if (!this.isStarted || this.eventPollBusy)
            return;
        this.eventPollBusy = true;
        try {
            const events = [];
            try {
                events.push(...(this.primaryRuntime?.drainEvents() || []));
            }
            catch (error) {
                events.push(this.runtimeError(error));
            }
            try {
                events.push(...await this.workerPages.drainEvents());
            }
            catch (error) {
                events.push(this.runtimeError(error));
            }
            for (const event of events)
                this.emit(event);
        }
        finally {
            this.eventPollBusy = false;
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.eventTimer)
            clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        await this.workerPages.dispose();
        try {
            await this.primaryRuntime?.dispose();
        }
        catch { /* renderer teardown */ }
        try {
            await this.primaryPage?.close();
        }
        catch { /* renderer teardown */ }
        this.primaryRuntime = undefined;
        this.primaryPage = undefined;
        this.listeners.clear();
    }
    async invokeWithRecovery(page, runtime, operation, input, signal, refresh) {
        let result = await runtime.invoke(operation, input);
        if (result.ok && result.data !== undefined)
            return result;
        if (!result.ok && result.error.code === 'CHALLENGE_REQUIRED') {
            await page.show();
            await page.waitForRuntimeReady(signal);
            result = await (await refresh()).invoke(operation, input);
        }
        return result;
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch { /* subscriber failures cannot stop the host */ }
        }
    }
    scheduleEventPoll() {
        if (this.disposed)
            return;
        this.eventTimer = setTimeout(async () => {
            await this.pollEvents();
            this.scheduleEventPoll();
        }, this.eventPollMs);
        this.eventTimer.unref?.();
    }
    primaryDefinition() {
        const definition = this.options.manifest.pages.find((page) => page.kind === 'primary');
        if (!definition)
            throw new Error('HookManifest 必须声明一个 primary page');
        return definition;
    }
    definitionFor(operation) {
        const route = this.options.manifest.operations[operation];
        return route ? this.options.manifest.pages.find((page) => page.id === route.page) : undefined;
    }
    runtimeError(error) {
        return { type: 'runtime.error', timestamp: Date.now(), payload: { message: String(error instanceof Error ? error.message : error), error } };
    }
}
export function partitionFor(platform, shopId) {
    return `persist:platform-hook-${platform}-${shopId.replace(/[^a-z0-9_-]/gi, '_')}`;
}
//# sourceMappingURL=hook-session.js.map