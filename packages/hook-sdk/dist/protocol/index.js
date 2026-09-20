import { HOOK_CAPABILITIES } from '../capabilities/index.js';
export const ok = (data) => ({ ok: true, data });
export const fail = (error) => ({ ok: false, error });
export function validateHookManifest(manifest) {
    const errors = [];
    if (!manifest.platform)
        errors.push('platform 必填');
    if (!manifest.version)
        errors.push('version 必填');
    const pageIds = new Set();
    for (const page of manifest.pages) {
        if (!page.id)
            errors.push('Page id 必填');
        else if (pageIds.has(page.id))
            errors.push(`Page id 重复: ${page.id}`);
        pageIds.add(page.id);
    }
    const capabilities = new Set();
    const knownCapabilities = new Set(HOOK_CAPABILITIES);
    for (const capability of manifest.capabilities) {
        if (!knownCapabilities.has(capability))
            errors.push(`未知 Capability: ${capability}`);
        if (capabilities.has(capability))
            errors.push(`Capability 重复: ${capability}`);
        capabilities.add(capability);
    }
    if (manifest.pages.filter((page) => page.kind === 'primary').length !== 1)
        errors.push('必须且只能声明一个 primary page');
    for (const capability of manifest.capabilities) {
        const route = manifest.operations[capability];
        if (!route)
            errors.push(`Capability ${capability} 缺少 Operation 路由`);
        else if (!pageIds.has(route.page))
            errors.push(`Operation ${capability} 指向未知页面 ${route.page}`);
        else if (route.capability !== capability)
            errors.push(`Operation ${capability} 的 capability 不匹配`);
    }
    for (const [operation, route] of Object.entries(manifest.operations)) {
        if (!knownCapabilities.has(operation))
            errors.push(`未知 Operation: ${operation}`);
        if (!capabilities.has(operation))
            errors.push(`Operation ${operation} 未声明对应 Capability`);
        if (route.capability !== operation)
            errors.push(`Operation ${operation} 的 capability 不匹配`);
        if (!capabilities.has(route.capability))
            errors.push(`Operation ${operation} 引用了未声明 Capability ${route.capability}`);
        if (!pageIds.has(route.page))
            errors.push(`Operation ${operation} 指向未知页面 ${route.page}`);
    }
    return errors;
}
//# sourceMappingURL=index.js.map