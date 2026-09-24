export function isHookError(value) {
    return Boolean(value && typeof value === 'object' && 'code' in value && 'message' in value);
}
export function isHookResult(value) {
    return Boolean(value && typeof value === 'object' && 'ok' in value);
}
//# sourceMappingURL=index.js.map