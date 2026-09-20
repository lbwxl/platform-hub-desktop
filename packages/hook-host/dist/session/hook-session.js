import { fail, hookError, HOOK_OPERATION_PRIORITIES, noopHookLogger, } from '@platform-hub/hook-sdk';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
import { schedulerErrorResult, WorkerScheduler, WorkerSchedulerError } from '../scheduler/worker-scheduler.js';
export class HookSession {
    options;
    partition;
    workerPages;
    primaryPage;
    primaryRuntime;
    primaryPushUnsubscribe;
    listeners = new Set();
    lifecycleController = new AbortController();
    eventTimer;
    eventPollBusy = false;
    started = false;
    disposed = false;
    polling;
    eventPollDelayMs;
    challengeTimeoutMs;
    logger;
    constructor(options) {
        this.options = options;
        this.partition = options.partition || partitionFor(options.manifest.platform, options.shopId);
        this.polling = options.eventPolling === false ? false : normalizePolling(options.eventPolling);
        this.eventPollDelayMs = this.polling ? this.polling.initialIntervalMs : 0;
        this.challengeTimeoutMs = Math.max(1, options.challengeTimeoutMs ?? 120_000);
        this.logger = options.logger ?? noopHookLogger;
        this.workerPages = new WorkerPageManager({
            sessionId: options.sessionId,
            shopId: options.shopId,
            partition: this.partition,
            manifest: options.manifest,
            factory: options.factory,
            maxWorkers: options.maxWorkers,
            defaultIdleTtlMs: options.workerIdleTtlMs,
            logger: this.logger,
            onEvent: (event) => this.emit(event),
            onEventError: (error) => this.emit(this.runtimeError(error)),
        });
    }
    get isStarted() { return this.started && !this.disposed; }
    get isDisposed() { return this.disposed; }
    get sessionId() { return this.options.sessionId; }
    get shopId() { return this.options.shopId; }
    get manifest() { return this.options.manifest; }
    async start() {
        if (this.disposed)
            throw new Error('HookSession 已销毁');
        if (this.started)
            return;
        const definition = this.primaryDefinition();
        let page;
        let runtime;
        let unsubscribe;
        try {
            page = await this.options.factory.create({
                sessionId: this.options.sessionId,
                shopId: this.options.shopId,
                partition: this.partition,
                manifest: this.options.manifest,
                definition,
            });
            runtime = await page.installRuntime();
            if (page.subscribeEvents) {
                try {
                    unsubscribe = await page.subscribeEvents((event) => this.emit(event));
                }
                catch (error) {
                    this.logger.warn('Primary push event subscription failed; polling fallback remains active', { error: errorMessage(error) });
                }
            }
            this.primaryPage = page;
            this.primaryRuntime = runtime;
            this.primaryPushUnsubscribe = unsubscribe;
            this.started = true;
            this.scheduleEventPoll();
            this.logger.info('Hook session started');
        }
        catch (error) {
            try {
                unsubscribe?.();
            }
            catch { /* start cleanup */ }
            try {
                await runtime?.dispose();
            }
            catch { /* start cleanup */ }
            try {
                await page?.close();
            }
            catch { /* start cleanup */ }
            this.logger.error('Hook session start failed', { error: errorMessage(error) });
            throw error;
        }
    }
    async invoke(operation, input = {}, options) {
        if (!this.isStarted)
            return fail(hookError('RUNTIME_NOT_READY', 'HookSession 尚未启动'));
        if (options?.signal?.aborted)
            return fail(hookError('TIMEOUT', 'Operation 已取消', undefined, true));
        const definition = this.definitionFor(operation);
        if (!definition)
            return fail(hookError('NOT_SUPPORTED', `Manifest 未声明 Operation: ${operation}`));
        const linked = linkAbortSignals(this.lifecycleController.signal, options?.signal);
        try {
            if (definition.kind === 'primary') {
                return await this.invokeWithRecovery(this.primaryPage, this.primaryRuntime, operation, input, linked.signal, async () => {
                    this.primaryRuntime = await this.primaryPage.installRuntime();
                    return this.primaryRuntime;
                }, options?.timeoutMs);
            }
            return await this.options.scheduler.schedule({
                manager: this.workerPages,
                page: definition,
                priority: HOOK_OPERATION_PRIORITIES[operation],
                timeoutMs: options?.timeoutMs,
                signal: linked.signal,
                run: async (lease, signal) => this.invokeWithRecovery(lease.page, lease.runtime, operation, input, signal, lease.refreshRuntime, options?.timeoutMs),
            });
        }
        catch (error) {
            if (error instanceof WorkerSchedulerError)
                return fail(schedulerErrorResult(error));
            this.logger.warn('Hook operation failed', { operation, error: errorMessage(error) });
            return fail(hookError('PLATFORM_ERROR', errorMessage(error), undefined, true));
        }
        finally {
            linked.cleanup();
        }
    }
    subscribe(listener) {
        if (this.disposed)
            return () => { };
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async pollEvents() {
        if (!this.isStarted || this.eventPollBusy)
            return 0;
        this.eventPollBusy = true;
        let count = 0;
        try {
            if (!this.primaryPushUnsubscribe && this.primaryRuntime) {
                try {
                    const events = await this.primaryRuntime.drainEvents();
                    count += events.length;
                    for (const event of events)
                        this.emit(event);
                }
                catch (error) {
                    this.emit(this.runtimeError(error));
                }
            }
            const workerEvents = await this.workerPages.drainEvents();
            count += workerEvents.length;
            for (const event of workerEvents)
                this.emit(event);
            return count;
        }
        finally {
            this.eventPollBusy = false;
        }
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.started = false;
        this.lifecycleController.abort();
        if (this.eventTimer)
            clearTimeout(this.eventTimer);
        this.eventTimer = undefined;
        try {
            this.primaryPushUnsubscribe?.();
        }
        catch (error) {
            this.logger.warn('Primary event subscription cleanup failed', { error: errorMessage(error) });
        }
        this.primaryPushUnsubscribe = undefined;
        await this.workerPages.dispose();
        try {
            await this.primaryRuntime?.dispose();
        }
        catch (error) {
            this.logger.warn('Primary runtime dispose failed', { error: errorMessage(error) });
        }
        try {
            await this.primaryPage?.close();
        }
        catch (error) {
            this.logger.warn('Primary page close failed', { error: errorMessage(error) });
        }
        this.primaryRuntime = undefined;
        this.primaryPage = undefined;
        this.listeners.clear();
        this.logger.info('Hook session disposed');
    }
    async invokeWithRecovery(page, runtime, operation, input, signal, refresh, timeoutMs) {
        if (signal.aborted)
            return fail(hookError('TIMEOUT', 'Operation 已取消', undefined, true));
        let result = await runtime.invoke(operation, input);
        if (result.ok || result.error.code !== 'CHALLENGE_REQUIRED')
            return result;
        await page.show();
        const recovery = challengeSignal(signal, timeoutMs ?? this.challengeTimeoutMs);
        try {
            await page.waitForRuntimeReady(recovery.signal);
            if (recovery.signal.aborted)
                return fail(hookError('TIMEOUT', recovery.timedOut() ? 'Challenge Recovery 超时' : 'Challenge Recovery 已取消', undefined, true));
            result = await (await refresh()).invoke(operation, input);
            return result;
        }
        catch (error) {
            if (recovery.signal.aborted) {
                return fail(hookError('TIMEOUT', recovery.timedOut() ? 'Challenge Recovery 超时' : 'Challenge Recovery 已取消', undefined, true));
            }
            throw error;
        }
        finally {
            recovery.cleanup();
        }
    }
    emit(event) {
        if (this.disposed)
            return;
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch (error) {
                this.logger.warn('Hook event listener failed', { eventType: event.type, error: errorMessage(error) });
            }
        }
    }
    scheduleEventPoll() {
        if (this.disposed || !this.polling)
            return;
        this.eventTimer = setTimeout(async () => {
            const eventCount = await this.pollEvents();
            if (!this.polling || this.disposed)
                return;
            this.eventPollDelayMs = eventCount > 0
                ? this.polling.activeIntervalMs
                : Math.min(this.polling.idleIntervalMs, Math.max(this.polling.activeIntervalMs, this.eventPollDelayMs * this.polling.backoffMultiplier));
            this.scheduleEventPoll();
        }, this.eventPollDelayMs);
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
        return { type: 'runtime.error', timestamp: Date.now(), payload: { message: errorMessage(error), error } };
    }
}
function normalizePolling(options) {
    const activeIntervalMs = Math.max(25, options?.activeIntervalMs ?? 250);
    const idleIntervalMs = Math.max(activeIntervalMs, options?.idleIntervalMs ?? 5_000);
    return {
        initialIntervalMs: Math.max(25, options?.initialIntervalMs ?? 1_000),
        activeIntervalMs,
        idleIntervalMs,
        backoffMultiplier: Math.max(1, options?.backoffMultiplier ?? 1.8),
    };
}
function linkAbortSignals(...signals) {
    const controller = new AbortController();
    const active = signals.filter((signal) => Boolean(signal));
    const abort = () => controller.abort();
    for (const signal of active) {
        if (signal.aborted)
            controller.abort();
        else
            signal.addEventListener('abort', abort, { once: true });
    }
    return {
        signal: controller.signal,
        cleanup: () => active.forEach((signal) => signal.removeEventListener('abort', abort)),
    };
}
function challengeSignal(parent, timeoutMs) {
    const controller = new AbortController();
    let timeoutReached = false;
    const abort = () => controller.abort();
    if (parent.aborted)
        controller.abort();
    else
        parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
        timeoutReached = true;
        controller.abort();
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    return {
        signal: controller.signal,
        timedOut: () => timeoutReached,
        cleanup: () => {
            clearTimeout(timer);
            parent.removeEventListener('abort', abort);
        },
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function partitionFor(platform, shopId) {
    return `persist:platform-hook-${platform}-${shopId.replace(/[^a-z0-9_-]/gi, '_')}`;
}
//# sourceMappingURL=hook-session.js.map