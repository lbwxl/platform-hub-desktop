import type { HookPackageManifest, PlatformCapability } from './types.js';
export declare const kuaishouCapabilities: PlatformCapability[];
/**
 * 快手小店 Hook 只通过页面 window runtime 工作。
 * 不读取 document、不操作元素、不拦截网络；认证由用户在官方页面完成。
 */
export declare const kuaishouHookScript: string;
export declare const kuaishouHook: HookPackageManifest;
//# sourceMappingURL=hook.d.ts.map