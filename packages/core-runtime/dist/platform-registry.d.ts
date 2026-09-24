import type { PlatformRuntimeFactory } from './contracts.js';
/** Platform packages register factories here; the application core only knows ids. */
export declare class PlatformRegistry {
    private readonly factories;
    register(factory: PlatformRuntimeFactory): () => void;
    get(platformId: string): PlatformRuntimeFactory | undefined;
    require(platformId: string): PlatformRuntimeFactory;
    has(platformId: string): boolean;
    list(): PlatformRuntimeFactory[];
}
//# sourceMappingURL=platform-registry.d.ts.map