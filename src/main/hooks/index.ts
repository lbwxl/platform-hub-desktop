import type { HookPackageManifest, PlatformDefinition } from '../../shared/platform'
import { doudianHook } from './doudian'
import { goofishHook } from './goofish'
import { kuaishouHook } from './kuaishou'

export const builtinHooks: Record<string, HookPackageManifest> = {
  [doudianHook.id]: doudianHook,
  [kuaishouHook.id]: kuaishouHook,
  [goofishHook.id]: goofishHook,
}

export const builtinPlatforms: PlatformDefinition[] = [doudianHook, kuaishouHook, goofishHook].map((hook) => ({
  id: hook.id,
  label: hook.label,
  url: hook.url,
  capabilities: hook.capabilities,
  hookVersion: hook.version,
  source: 'builtin',
}))
