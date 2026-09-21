import type { HookPackageManifest, PlatformDefinition } from '../../shared/platform'
import { douyinHook } from './douyin'
import { goofishHook } from './goofish'
import { kuaishouHook } from './kuaishou'

export const builtinHooks: Record<string, HookPackageManifest> = {
  [douyinHook.id]: douyinHook,
  [kuaishouHook.id]: kuaishouHook,
  [goofishHook.id]: goofishHook,
}

export const builtinPlatforms: PlatformDefinition[] = [douyinHook, kuaishouHook, goofishHook].map((hook) => ({
  id: hook.id,
  label: hook.label,
  url: hook.url,
  executionModel: hook.executionModel,
  capabilities: hook.capabilities,
  hookVersion: hook.version,
  source: 'builtin',
}))
