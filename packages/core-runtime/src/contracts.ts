import type { HookTransport } from '@platform-hub/core-transport'

export interface PlatformAccountRecord {
  id: string
  platform: string
  label: string
  url: string
  partition: string
  adapterMetadata?: Record<string, unknown>
  online?: boolean
  connected?: boolean
  authenticated?: boolean
  webContentsId?: number
  runtimeState?: 'stopped' | 'starting' | 'running' | 'error'
  messageListening?: boolean
  lastSeenAt?: string
  createdAt?: string
}

export interface PlatformDefinition {
  id: string
  label: string
  url: string
  executionModel: 'page' | 'native' | 'service'
  capabilities: readonly string[]
  version?: string
  defaultOnFirstLaunch?: boolean
}

export interface PageHookManifest {
  id: string
  label: string
  version: string
  url: string
  executionModel?: 'page'
  loginUrl?: string
  loginMatch?: string[]
  capabilities: readonly string[]
  script?: string
  runtimePages?: Array<{
    id: string
    url: string
    methods: string[]
    refreshBeforeInvoke?: boolean
    persistent?: boolean
  }>
  source?: 'builtin' | 'imported'
}

export interface PlatformRuntimeStatus {
  connected: boolean
  authenticated: boolean
  url: string
  title?: string
  message: string
  webContentsId?: number
}

export interface PlatformViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Small host bridge; platform packages never own the main BrowserWindow. */
export interface PlatformRuntimeHostContext {
  getAccount?(): PlatformAccountRecord
  getHostWindow(): unknown | null
  getPrimaryViewBounds(): PlatformViewBounds | null
  updateAccount(patch: Partial<PlatformAccountRecord>): void
}

export interface PlatformRuntimeAdapter {
  readonly id: string
  readonly transport: HookTransport
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): Promise<PlatformRuntimeStatus>
  attachPrimaryView(): Promise<void>
  detachPrimaryView(): void
  dispose(): Promise<void>
  updatePrimaryViewBounds?(bounds: PlatformViewBounds): void
  getPrimaryWebContentsId?(): number | undefined
  bindHostWindow?(window: unknown): void
  showOperationPage?(operation: string): Promise<void>
  waitForLogin?(operation: string): Promise<void>
}

export interface PlatformAccountSetup {
  url?: string
  partition?: string
  adapterMetadata?: Record<string, unknown>
}

export interface PlatformRuntimeFactory {
  readonly definition: PlatformDefinition
  prepareAccount?(account: PlatformAccountRecord): Promise<PlatformAccountSetup>
  create(account: PlatformAccountRecord, context: PlatformRuntimeHostContext): Promise<PlatformRuntimeAdapter> | PlatformRuntimeAdapter
  removeAccount?(account: PlatformAccountRecord): Promise<void>
  dispose?(): Promise<void>
}
