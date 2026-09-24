import { PlatformRegistry } from './platform-registry.js';
/** Generic per-account runtime owner shared by the Electron manager and tests. */
export class PlatformRuntimeManager {
    registry;
    contextFor;
    adapters = new Map();
    constructor(registry, contextFor) {
        this.registry = registry;
        this.contextFor = contextFor;
    }
    async ensure(account) {
        const existing = this.adapters.get(account.id);
        if (existing)
            return existing;
        const factory = this.registry.require(account.platform);
        const adapter = await factory.create(account, this.contextFor(account));
        if (adapter.id !== account.id) {
            await adapter.dispose().catch(() => undefined);
            throw new Error(`Runtime Adapter id 与账号不匹配: ${account.id}`);
        }
        this.adapters.set(account.id, adapter);
        return adapter;
    }
    get(accountId) { return this.adapters.get(accountId); }
    async start(account) {
        const adapter = await this.ensure(account);
        await adapter.start();
        return adapter;
    }
    async invoke(account, operation, input = {}) {
        const adapter = await this.ensure(account);
        const result = await adapter.transport.invoke(operation, input);
        if (!result.ok) {
            const error = new Error(result.error.message);
            error.code = result.error.code;
            throw error;
        }
        return result.data;
    }
    async attachPrimaryView(account) {
        const adapter = await this.ensure(account);
        await adapter.attachPrimaryView();
    }
    detachPrimaryView(accountId) { this.adapters.get(accountId)?.detachPrimaryView(); }
    async stop(accountId) { await this.adapters.get(accountId)?.stop(); }
    async dispose(accountId) {
        const adapter = this.adapters.get(accountId);
        if (!adapter)
            return;
        this.adapters.delete(accountId);
        await adapter.dispose();
    }
    async disposeAll() {
        const adapters = [...this.adapters.values()];
        this.adapters.clear();
        await Promise.all(adapters.map((adapter) => adapter.dispose().catch(() => undefined)));
    }
}
//# sourceMappingURL=runtime-manager.js.map