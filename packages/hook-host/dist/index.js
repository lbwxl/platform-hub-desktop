import { HookSession, partitionFor } from './session/hook-session.js';
import { WorkerScheduler } from './scheduler/worker-scheduler.js';
export class HookHost {
    options;
    scheduler;
    constructor(options) {
        this.options = options;
        this.scheduler = new WorkerScheduler(options.maxWorkerConcurrency ?? 4);
    }
    createSession(manifest, session) {
        return new HookSession({
            ...session,
            manifest,
            factory: this.options.pageFactory,
            scheduler: this.scheduler,
            partition: session.partition || partitionFor(manifest.platform, session.shopId),
        });
    }
    stop() { this.scheduler.stop(); }
}
export * from './pages/types.js';
export * from './pages/worker-page-manager.js';
export * from './scheduler/worker-scheduler.js';
export * from './session/hook-session.js';
export * from './transport/electron-page-factory.js';
//# sourceMappingURL=index.js.map