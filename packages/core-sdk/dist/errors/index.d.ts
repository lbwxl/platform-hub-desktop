export declare const HOOK_ERROR_CODES: readonly ["LOGIN_REQUIRED", "CHALLENGE_REQUIRED", "RUNTIME_NOT_READY", "RATE_LIMITED", "NOT_SUPPORTED", "INVALID_INPUT", "PLATFORM_ERROR", "TIMEOUT"];
export type HookErrorCode = typeof HOOK_ERROR_CODES[number];
export interface HookError {
    code: HookErrorCode;
    message: string;
    retryable?: boolean;
    details?: unknown;
}
export declare function hookError(code: HookErrorCode, message: string, details?: unknown, retryable?: boolean): HookError;
//# sourceMappingURL=index.d.ts.map