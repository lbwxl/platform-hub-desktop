import type { PageHookManifest as HookPackageManifest } from '@platform-hub/platform-runtime';
/**
 * The desktop shell still exposes the legacy package-manifest shape to its
 * CDP session. The runtime itself is the formal Douyin Hook; this small
 * compatibility layer only translates the shell's old method calls into the
 * Page Hook operation protocol.
 */
export declare const douyinHook: HookPackageManifest;
export declare const douyinCapabilities: string[];
export declare const douyinHookScript: string;
//# sourceMappingURL=manifest.d.ts.map