import type { HookPackageManifest, PlatformCapability } from './types.js';
export declare const doudianCapabilities: PlatformCapability[];
/**
 * 抖店 Hook 只和平台暴露在 window 上的运行时交互。
 * 不读取 document、不查找元素、不模拟点击；登录由平台页面完成后自动继续。
 */
export declare const doudianHookScript: string;
export declare const doudianHook: HookPackageManifest;
//# sourceMappingURL=hook.d.ts.map