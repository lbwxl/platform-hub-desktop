import type { HookPackageManifest, PlatformCapability } from '../../shared/platform'

const capabilities: PlatformCapability[] = ['messages.listen', 'messages.history', 'messages.send', 'messages.file', 'sessions.list', 'products.collect', 'products.detail']

/** Native Goofish adapter metadata; execution is owned by GoofishTransport, not PageHookRuntime. */
export const goofishHook: HookPackageManifest = {
  id: 'goofish', label: '闲鱼', version: '1.0.0', url: 'https://www.goofish.com/im', executionModel: 'native',
  capabilities, source: 'builtin',
}
