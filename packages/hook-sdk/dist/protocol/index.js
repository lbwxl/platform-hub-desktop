export const ok = (data) => ({ ok: true, data });
export const fail = (error) => ({ ok: false, error });
export function validateHookManifest(manifest) {
    const errors = [];
    if (!manifest.platform)
        errors.push('platform 必填');
    if (!manifest.version)
        errors.push('version 必填');
    const pageIds = new Set(manifest.pages.map((page) => page.id));
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
    return errors;
}
//# sourceMappingURL=index.js.map