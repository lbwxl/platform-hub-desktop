import { HOOK_CAPABILITIES, type HookCapability, type HookOperation } from '../capabilities/index.js'
import type { HookError } from '../errors/index.js'
import type { HookEvent } from '../events/index.js'

export const HOOK_PROTOCOL_VERSION = 1

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
  drainEvents(): Promise<HookEvent[]>
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
  operations: Partial<Record<HookOperation, HookOperationDefinition>>
}

export class HookProtocolCompatibilityError extends Error {
  constructor(readonly errors: string[]) {
    super(`Hook Runtime 协议不兼容: ${errors.join('; ')}`)
    this.name = 'HookProtocolCompatibilityError'
  }
}

export function validatePageHookRuntime(
  runtime: PageHookRuntime,
  manifest: HookManifest,
  page: HookPageDefinition,
): string[] {
  const errors: string[] = []
  let description: HookRuntimeDescription
  try {
    description = runtime.describe()
  } catch (error) {
    return [`describe() 调用失败: ${error instanceof Error ? error.message : String(error)}`]
  }

  if (runtime.protocolVersion !== HOOK_PROTOCOL_VERSION) {
    errors.push(`Runtime protocolVersion ${runtime.protocolVersion} != ${HOOK_PROTOCOL_VERSION}`)
  }
  if (description.protocolVersion !== HOOK_PROTOCOL_VERSION) {
    errors.push(`Description protocolVersion ${description.protocolVersion} != ${HOOK_PROTOCOL_VERSION}`)
  }
  if (description.platform !== manifest.platform) {
    errors.push(`Runtime platform ${description.platform} != ${manifest.platform}`)
  }
  if (description.pageId !== page.id) {
    errors.push(`Runtime pageId ${description.pageId} != ${page.id}`)
  }

  const expectedOperations = new Set(
    Object.entries(manifest.operations)
      .filter(([, route]) => route?.page === page.id)
      .map(([operation]) => operation),
  )
  const runtimeOperations = new Set<string>()
  for (const operation of description.operations) {
    if (runtimeOperations.has(operation)) errors.push(`Runtime operation 重复: ${operation}`)
    runtimeOperations.add(operation)
    if (!expectedOperations.has(operation)) errors.push(`Runtime operation 不属于页面 ${page.id}: ${operation}`)
  }
  const runtimeCapabilities = new Set<string>()
  for (const capability of description.capabilities) {
    if (runtimeCapabilities.has(capability)) errors.push(`Runtime capability 重复: ${capability}`)
    runtimeCapabilities.add(capability)
    if (!expectedOperations.has(capability)) errors.push(`Runtime capability 不属于页面 ${page.id}: ${capability}`)
  }
  for (const operation of runtimeOperations) {
    if (!runtimeCapabilities.has(operation)) errors.push(`Runtime operation 未声明对应 capability: ${operation}`)
  }
  for (const capability of runtimeCapabilities) {
    if (!runtimeOperations.has(capability)) errors.push(`Runtime capability 未声明对应 operation: ${capability}`)
  }
  return errors
}

export function assertPageHookRuntime(
  runtime: PageHookRuntime,
  manifest: HookManifest,
  page: HookPageDefinition,
): void {
  const errors = validatePageHookRuntime(runtime, manifest, page)
  if (errors.length) throw new HookProtocolCompatibilityError(errors)
}

export function validateHookManifest(manifest: HookManifest): string[] {
  const errors: string[] = []
  if (!manifest.platform) errors.push('platform 必填')
  if (!manifest.version) errors.push('version 必填')
  const pageIds = new Set<string>()
  for (const page of manifest.pages) {
    if (!page.id) errors.push('Page id 必填')
    else if (pageIds.has(page.id)) errors.push(`Page id 重复: ${page.id}`)
    pageIds.add(page.id)
  }
  const capabilities = new Set<HookCapability>()
  const knownCapabilities = new Set<string>(HOOK_CAPABILITIES)
  for (const capability of manifest.capabilities) {
    if (!knownCapabilities.has(capability)) errors.push(`未知 Capability: ${capability}`)
    if (capabilities.has(capability)) errors.push(`Capability 重复: ${capability}`)
    capabilities.add(capability)
  }
  if (manifest.pages.filter((page) => page.kind === 'primary').length !== 1) errors.push('必须且只能声明一个 primary page')
  for (const capability of manifest.capabilities) {
    const route = manifest.operations[capability]
    if (!route) errors.push(`Capability ${capability} 缺少 Operation 路由`)
    else if (!pageIds.has(route.page)) errors.push(`Operation ${capability} 指向未知页面 ${route.page}`)
    else if (route.capability !== capability) errors.push(`Operation ${capability} 的 capability 不匹配`)
  }
  for (const [operation, route] of Object.entries(manifest.operations) as Array<[HookOperation, HookOperationDefinition]>) {
    if (!knownCapabilities.has(operation)) errors.push(`未知 Operation: ${operation}`)
    if (!capabilities.has(operation)) errors.push(`Operation ${operation} 未声明对应 Capability`)
    if (route.capability !== operation) errors.push(`Operation ${operation} 的 capability 不匹配`)
    if (!capabilities.has(route.capability)) errors.push(`Operation ${operation} 引用了未声明 Capability ${route.capability}`)
    if (!pageIds.has(route.page)) errors.push(`Operation ${operation} 指向未知页面 ${route.page}`)
  }
  return errors
}
