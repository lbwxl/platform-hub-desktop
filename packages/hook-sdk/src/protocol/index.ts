import type { HookCapability, HookOperation } from '../capabilities/index.js'
import type { HookError } from '../errors/index.js'
import type { HookEvent } from '../events/index.js'

export type HookResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: HookError }

export const ok = <T>(data: T): HookResult<T> => ({ ok: true, data })
export const fail = (error: HookError): HookResult<never> => ({ ok: false, error })

export interface HookRuntimeDescription {
  protocolVersion: number
  platform: string
  pageId: string
  capabilities: HookCapability[]
  operations: HookOperation[]
}

/** The only page API the host is allowed to call. */
export interface PageHookRuntime {
  protocolVersion: number
  describe(): HookRuntimeDescription
  invoke(operation: string, input: unknown): Promise<HookResult<unknown>>
  drainEvents(): HookEvent[]
  dispose(): Promise<void>
}

export interface HookPageDefinition {
  id: string
  kind: 'primary' | 'worker'
  url?: string
  idleTtlMs?: number
}

export interface HookOperationDefinition {
  page: string
  capability: HookCapability
}

export interface HookManifest {
  platform: string
  version: string
  capabilities: HookCapability[]
  pages: HookPageDefinition[]
  operations: Record<HookOperation, HookOperationDefinition>
}

export function validateHookManifest(manifest: HookManifest): string[] {
  const errors: string[] = []
  if (!manifest.platform) errors.push('platform 必填')
  if (!manifest.version) errors.push('version 必填')
  const pageIds = new Set(manifest.pages.map((page) => page.id))
  if (manifest.pages.filter((page) => page.kind === 'primary').length !== 1) errors.push('必须且只能声明一个 primary page')
  for (const capability of manifest.capabilities) {
    const route = manifest.operations[capability]
    if (!route) errors.push(`Capability ${capability} 缺少 Operation 路由`)
    else if (!pageIds.has(route.page)) errors.push(`Operation ${capability} 指向未知页面 ${route.page}`)
    else if (route.capability !== capability) errors.push(`Operation ${capability} 的 capability 不匹配`)
  }
  return errors
}
