import type { HookError } from '../errors/index.js'
import type { HookResult } from '../protocol/index.js'

export function isHookError(value: unknown): value is HookError {
  return Boolean(value && typeof value === 'object' && 'code' in value && 'message' in value)
}

export function isHookResult<T>(value: unknown): value is HookResult<T> {
  return Boolean(value && typeof value === 'object' && 'ok' in value)
}
