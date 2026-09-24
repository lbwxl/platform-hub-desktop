import { PageHookRuntimeAdapter, type PageRuntimeEvent, type PageRuntimePort } from '@platform-hub/platform-runtime'
import type { PlatformAccountRecord, PlatformDefinition, PlatformRuntimeHostContext, PlatformRuntimeFactory } from '@platform-hub/platform-runtime'
import { douyinHook } from './manifest.js'

export interface DouyinRuntimeFactoryOptions {
  createCdpSession(
    account: PlatformAccountRecord,
    context: PlatformRuntimeHostContext,
    emit: (event: PageRuntimeEvent) => void,
  ): PageRuntimePort
}

const DEFINITION: PlatformDefinition = {
  id: douyinHook.id,
  label: douyinHook.label,
  url: douyinHook.url,
  executionModel: 'page',
  capabilities: [...douyinHook.capabilities],
  version: douyinHook.version,
  defaultOnFirstLaunch: true,
}

/** Platform-owned adapter that wraps the existing CdpSession through the shared Page Hook adapter. */
export class DouyinRuntimeAdapter extends PageHookRuntimeAdapter {}

export function createDouyinRuntimeFactory(options: DouyinRuntimeFactoryOptions): PlatformRuntimeFactory {
  return {
    definition: DEFINITION,
    create(account, context) {
      let adapter: DouyinRuntimeAdapter | undefined
      const runtime = options.createCdpSession(account, context, (event) => adapter?.acceptPlatformEvent(event))
      adapter = new DouyinRuntimeAdapter(account, runtime, context)
      return adapter
    },
  }
}
