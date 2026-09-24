import { noopHookLogger, validateHookManifest, withHookLoggerContext, } from '@platform-hub/core-sdk';
import { HookSession, partitionFor } from './session/hook-session.js';
import { WorkerScheduler } from './scheduler/worker-scheduler.js';
export class HookHost {
    options;
    scheduler;
    sessions = new Map();
    logger;
    disposed = false;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? noopHookLogger;
        this.scheduler = new WorkerScheduler(options.maxWorkerConcurrency ?? 4, this.logger);
    }
    get sessionCount() { return this.sessions.size; }
    createSession(manifest, session) {
        if (this.disposed)
            throw new Error('HookHost 已销毁');
        const errors = validateHookManifest(manifest);
        if (errors.length)
            throw new Error(`HookManifest 无效: ${errors.join('; ')}`);
        if (this.sessions.has(session.sessionId))
            throw new Error(`HookSession 已存在: ${session.sessionId}`);
        const logger = withHookLoggerContext(this.logger, {
            platformId: manifest.platform,
            shopId: session.shopId,
            sessionId: session.sessionId,
        });
        const hookSession = new HookSession({
            ...session,
            manifest,
            factory: this.options.pageFactory,
            scheduler: this.scheduler,
            partition: session.partition || partitionFor(manifest.platform, session.shopId),
            logger,
        });
        this.sessions.set(session.sessionId, hookSession);
        return hookSession;
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    async disposeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        this.sessions.delete(sessionId);
        await session.dispose();
        return true;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map((session) => session.dispose()));
        this.scheduler.stop();
        this.logger.info('Hook host disposed', { sessionCount: sessions.length });
    }
    async stop() {
        await this.dispose();
    }
}
export * from './pages/types.js';
export * from './pages/persistent-page-manager.js';
export * from './pages/worker-page-manager.js';
export * from './scheduler/worker-scheduler.js';
export * from './session/hook-session.js';
export * from './transport/electron-page-factory.js';
//# sourceMappingURL=index.js.map