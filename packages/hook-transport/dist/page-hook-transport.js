import { fail, hookError } from '@platform-hub/hook-sdk';
/**
 * Thin Page Hook adapter. Routing, recovery, scheduling, and page lifecycle
 * remain owned by the existing HookSession and HookHost foundation.
 */
export class PageHookTransport {
    options;
    listeners = new Set();
    sessionUnsubscribe;
    startPromise;
    stopPromise;
    started = false;
    stopped = false;
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.stopped)
            throw new Error('PageHookTransport 已停止，不能重新启动');
        if (this.started)
            return;
        if (!this.startPromise) {
            this.startPromise = this.options.session.start().then(() => { this.started = true; }, (error) => {
                this.startPromise = undefined;
                throw error;
            });
        }
        await this.startPromise;
    }
    invoke(operation, input) {
        if (this.stopped)
            return Promise.resolve(fail(hookError('RUNTIME_NOT_READY', 'PageHookTransport 已停止')));
        return this.options.session.invoke(operation, input);
    }
    subscribe(listener) {
        if (this.stopped)
            return () => { };
        this.listeners.add(listener);
        this.ensureSessionSubscription();
        return () => this.listeners.delete(listener);
    }
    async stop() {
        if (!this.stopPromise) {
            this.stopped = true;
            this.listeners.clear();
            this.sessionUnsubscribe?.();
            this.sessionUnsubscribe = undefined;
            this.stopPromise = (async () => {
                try {
                    await this.startPromise;
                }
                catch {
                    // A failed start still leaves session ownership with the host.
                }
                await this.options.disposeSession();
            })();
        }
        await this.stopPromise;
    }
    ensureSessionSubscription() {
        if (this.sessionUnsubscribe)
            return;
        this.sessionUnsubscribe = this.options.session.subscribe((event) => {
            if (this.stopped)
                return;
            for (const listener of this.listeners) {
                try {
                    listener(event);
                }
                catch {
                    // One consumer must not block delivery to the remaining consumers.
                }
            }
        });
    }
}
//# sourceMappingURL=page-hook-transport.js.map