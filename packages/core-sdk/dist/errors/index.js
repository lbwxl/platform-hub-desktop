export const HOOK_ERROR_CODES = [
    'LOGIN_REQUIRED',
    'CHALLENGE_REQUIRED',
    'RUNTIME_NOT_READY',
    'RATE_LIMITED',
    'NOT_SUPPORTED',
    'INVALID_INPUT',
    'PLATFORM_ERROR',
    'TIMEOUT',
];
export function hookError(code, message, details, retryable) {
    return { code, message, ...(retryable === undefined ? {} : { retryable }), ...(details === undefined ? {} : { details }) };
}
//# sourceMappingURL=index.js.map