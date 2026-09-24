import { hookError, noopHookLogger } from '@platform-hub/core-sdk';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
const PRIORITY = { auth: 400, message: 300, order: 200, product: 100 };
export class WorkerSchedulerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'WorkerSchedulerError';
        this.code = code;
    }
}
export class WorkerScheduler {
    maxConcurrency;
    queue = [];
    active = 0;
    sequence = 0;
    stopped = false;
    activeControllers = new Set();
    logger;
    constructor(maxConcurrency = 4, logger = noopHookLogger) {
        this.maxConcurrency = maxConcurrency;
        this.maxConcurrency = Math.max(1, maxConcurrency);
        this.logger = logger;
    }
    get activeCount() { return this.active; }
    get queuedCount() { return this.queue.length; }
    get concurrencyLimit() { return this.maxConcurrency; }
    schedule(options) {
        if (this.stopped)
            return Promise.reject(new WorkerSchedulerError('RUNTIME_NOT_READY', 'WorkerScheduler 已停止'));
        return new Promise((resolve, reject) => {
            const item = {
                sequence: this.sequence++,
                priority: this.priorityOf(options.priority),
                options,
                resolve,
                reject,
            };
            if (options.signal?.aborted) {
                reject(new WorkerSchedulerError('TIMEOUT', '任务在排队时已取消'));
                return;
            }
            this.queue.push(item);
            if (options.signal) {
                item.abortListener = () => {
                    const index = this.queue.indexOf(item);
                    if (index < 0)
                        return;
                    this.queue.splice(index, 1);
                    reject(new WorkerSchedulerError('TIMEOUT', '任务在排队时已取消'));
                };
                options.signal.addEventListener('abort', item.abortListener, { once: true });
            }
            this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
            this.pump();
        });
    }
    stop() {
        this.stopped = true;
        const error = new WorkerSchedulerError('RUNTIME_NOT_READY', 'WorkerScheduler 已停止');
        while (this.queue.length) {
            const item = this.queue.shift();
            this.removeQueueAbortListener(item);
            item.reject(error);
        }
        for (const controller of this.activeControllers)
            controller.abort();
    }
    priorityOf(priority) {
        if (typeof priority === 'number')
            return priority;
        return PRIORITY[priority || 'product'] || 0;
    }
    pump() {
        while (!this.stopped && this.active < this.maxConcurrency && this.queue.length) {
            const item = this.queue.shift();
            this.removeQueueAbortListener(item);
            this.active += 1;
            void this.run(item).finally(() => {
                this.active -= 1;
                this.pump();
            });
        }
    }
    async run(item) {
        const { options } = item;
        if (options.signal?.aborted) {
            item.reject(new WorkerSchedulerError('TIMEOUT', '任务已取消'));
            return;
        }
        let lease;
        let timer;
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const abortForwarder = () => controller.abort();
        options.signal?.addEventListener('abort', abortForwarder, { once: true });
        try {
            lease = await options.manager.acquire(options.page, controller.signal);
            const operation = options.run(lease, controller.signal);
            const aborted = new Promise((_, reject) => {
                const rejectAborted = () => reject(new WorkerSchedulerError('TIMEOUT', 'Worker 操作已取消'));
                if (controller.signal.aborted)
                    rejectAborted();
                else
                    controller.signal.addEventListener('abort', rejectAborted, { once: true });
            });
            const timeout = options.timeoutMs && options.timeoutMs > 0
                ? new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new WorkerSchedulerError('TIMEOUT', `Worker 操作超过 ${options.timeoutMs}ms`));
                    }, options.timeoutMs);
                    timer.unref?.();
                })
                : undefined;
            item.resolve(await Promise.race(timeout ? [operation, timeout, aborted] : [operation, aborted]));
        }
        catch (error) {
            if (error instanceof WorkerSchedulerError)
                item.reject(error);
            else {
                this.logger.warn('Worker task failed', { pageId: options.page.id, error: error instanceof Error ? error.message : String(error) });
                item.reject(error);
            }
        }
        finally {
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', abortForwarder);
            this.activeControllers.delete(controller);
            if (controller.signal.aborted)
                await lease?.discard();
            else
                lease?.release();
        }
    }
    removeQueueAbortListener(item) {
        if (item.abortListener)
            item.options.signal?.removeEventListener('abort', item.abortListener);
        item.abortListener = undefined;
    }
}
export function schedulerErrorResult(error) {
    if (error instanceof WorkerSchedulerError)
        return hookError(error.code, error.message, undefined, error.code === 'TIMEOUT');
    return hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true);
}
//# sourceMappingURL=worker-scheduler.js.map