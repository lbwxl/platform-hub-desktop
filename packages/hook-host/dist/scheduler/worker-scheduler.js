import { hookError } from '@platform-hub/hook-sdk';
import { WorkerPageManager } from '../pages/worker-page-manager.js';
const PRIORITY = { message: 300, order: 200, product: 100 };
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
    constructor(maxConcurrency = 4) {
        this.maxConcurrency = maxConcurrency;
    }
    get activeCount() { return this.active; }
    get queuedCount() { return this.queue.length; }
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
            this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
            this.pump();
        });
    }
    stop() {
        this.stopped = true;
        const error = new WorkerSchedulerError('RUNTIME_NOT_READY', 'WorkerScheduler 已停止');
        while (this.queue.length)
            this.queue.shift()?.reject(error);
    }
    priorityOf(priority) {
        if (typeof priority === 'number')
            return priority;
        return PRIORITY[priority || 'product'] || 0;
    }
    pump() {
        while (!this.stopped && this.active < this.maxConcurrency && this.queue.length) {
            const item = this.queue.shift();
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
        const abortForwarder = () => controller.abort();
        options.signal?.addEventListener('abort', abortForwarder, { once: true });
        try {
            lease = await options.manager.acquire(options.page, controller.signal);
            const operation = options.run(lease, controller.signal);
            const timeout = options.timeoutMs && options.timeoutMs > 0
                ? new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new WorkerSchedulerError('TIMEOUT', `Worker 操作超过 ${options.timeoutMs}ms`));
                    }, options.timeoutMs);
                    timer.unref?.();
                })
                : undefined;
            item.resolve(await (timeout ? Promise.race([operation, timeout]) : operation));
        }
        catch (error) {
            if (error instanceof WorkerSchedulerError)
                item.reject(error);
            else
                item.reject(error);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', abortForwarder);
            lease?.release();
        }
    }
}
export function schedulerErrorResult(error) {
    if (error instanceof WorkerSchedulerError)
        return hookError(error.code, error.message, undefined, error.code === 'TIMEOUT');
    return hookError('PLATFORM_ERROR', String(error instanceof Error ? error.message : error), undefined, true);
}
//# sourceMappingURL=worker-scheduler.js.map