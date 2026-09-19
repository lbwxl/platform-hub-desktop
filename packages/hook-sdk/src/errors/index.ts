export const HOOK_ERROR_CODES = [
  'LOGIN_REQUIRED',
  'CHALLENGE_REQUIRED',
  'RUNTIME_NOT_READY',
  'RATE_LIMITED',
  'NOT_SUPPORTED',
  'INVALID_INPUT',
  'PLATFORM_ERROR',
  'TIMEOUT',
] as const

export type HookErrorCode = typeof HOOK_ERROR_CODES[number]

export interface HookError {
  code: HookErrorCode
  message: string
  retryable?: boolean
  details?: unknown
}

export function hookError(
  code: HookErrorCode,
  message: string,
  details?: unknown,
  retryable?: boolean,
): HookError {
  return { code, message, ...(retryable === undefined ? {} : { retryable }), ...(details === undefined ? {} : { details }) }
}
