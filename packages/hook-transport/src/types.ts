import type { HookEvent, HookOperation, HookResult } from '@platform-hub/hook-sdk'

/**
 * Execution-model-neutral boundary exposed to future PlatformRuntime code.
 * Implementations map their native lifecycle and events to SDK contracts.
 */
export interface HookTransport {
  start(): Promise<void>

  invoke<T = unknown>(
    operation: HookOperation,
    input: unknown,
  ): Promise<HookResult<T>>

  subscribe(listener: (event: HookEvent) => void): () => void

  stop(): Promise<void>
}
