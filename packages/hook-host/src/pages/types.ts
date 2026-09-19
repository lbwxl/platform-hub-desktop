import type { HookManifest, HookPageDefinition, PageHookRuntime } from '@platform-hub/hook-sdk'

export interface HookPageContext {
  sessionId: string
  shopId: string
  partition: string
  manifest: HookManifest
  definition: HookPageDefinition
}

/** Adapter boundary for Electron BrowserWindow/WebContents or a test runtime. */
export interface HookPageAdapter {
  readonly id: string
  readonly partition: string
  readonly definition: HookPageDefinition
  installRuntime(): Promise<PageHookRuntime>
  show(): Promise<void>
  waitForRuntimeReady(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
  isAlive(): boolean
}

export interface HookPageFactory {
  create(context: HookPageContext): Promise<HookPageAdapter>
}

export interface WorkerPageLease {
  readonly page: HookPageAdapter
  readonly runtime: PageHookRuntime
  refreshRuntime(): Promise<PageHookRuntime>
  release(): void
}
