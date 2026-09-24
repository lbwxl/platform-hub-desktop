/** Platform packages register factories here; the application core only knows ids. */
export class PlatformRegistry {
    factories = new Map();
    register(factory) {
        const id = factory.definition.id.trim();
        if (!id)
            throw new Error('平台 Factory 必须声明 id');
        if (this.factories.has(id))
            throw new Error(`平台 Factory 已注册: ${id}`);
        this.factories.set(id, factory);
        return () => {
            if (this.factories.get(id) === factory)
                this.factories.delete(id);
        };
    }
    get(platformId) {
        return this.factories.get(platformId);
    }
    require(platformId) {
        const factory = this.get(platformId);
        if (!factory)
            throw new Error(`未注册平台 Runtime Factory: ${platformId}`);
        return factory;
    }
    has(platformId) { return this.factories.has(platformId); }
    list() { return [...this.factories.values()]; }
}
//# sourceMappingURL=platform-registry.js.map