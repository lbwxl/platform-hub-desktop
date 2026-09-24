import { app, type BrowserWindow } from 'electron'
import { CdpSession } from '../cdp/CdpSession'
import type { HookPackageManifest } from '../../shared/platform'
import {
  createPageRuntimeFactory,
  PlatformRegistry,
  type PageHookManifest,
  type PageRuntimeEvent,
  type PlatformAccountRecord,
  type PlatformRuntimeHostContext,
} from '@platform-hub/platform-runtime'
import { createDouyinRuntimeFactory, douyinHook } from '@platform-hub/douyin'
import { createGoofishRuntimeFactory } from '@platform-hub/goofish'
import { kuaishouHook } from '@platform-hub/kuaishou-hook'

export function createPlatformRegistry(): PlatformRegistry {
  const registry = new PlatformRegistry()
  registry.register(createDouyinRuntimeFactory({ createCdpSession: (account, context, emit) => createCdpSession(account, context, douyinHook, emit) }))
  registry.register(createPageRuntimeFactory({
    manifest: kuaishouHook as PageHookManifest,
    createRuntime: (account, context, emit) => createCdpSession(account, context, kuaishouHook as HookPackageManifest, emit),
  }))
  registry.register(createGoofishRuntimeFactory(app.getPath('userData')))
  return registry
}

export function createImportedHookFactory(manifest: HookPackageManifest) {
  return createPageRuntimeFactory({
    manifest: { ...manifest, capabilities: [...manifest.capabilities], source: 'imported' } as PageHookManifest,
    createRuntime: (account, context, emit) => createCdpSession(account, context, manifest, emit),
  })
}

function createCdpSession(
  account: PlatformAccountRecord,
  context: PlatformRuntimeHostContext,
  hook: HookPackageManifest | PageHookManifest,
  emit: (event: PageRuntimeEvent) => void,
): CdpSession {
  const window = context.getHostWindow() as BrowserWindow | null
  if (!window || window.isDestroyed()) throw new Error('主工作台窗口尚未就绪')
  return new CdpSession({
    accountId: account.id,
    platform: account.platform,
    url: account.url,
    partition: account.partition,
    hook: hook as HookPackageManifest,
    hostWindow: window,
    emit: (event) => emit(event),
  })
}
