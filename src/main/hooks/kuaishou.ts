import { kuaishouCapabilities as packageCapabilities, kuaishouHook as packageHook, kuaishouHookScript as packageScript } from '@platform-hub/kuaishou-hook'
import type { HookPackageManifest } from '../../shared/platform'

/**
 * Keep the web execution model explicit at the shell boundary. Native/service
 * adapters can use the same manifest metadata later without changing the
 * acceptance UI or pretending to be a BrowserWindow runtime.
 */
export const kuaishouHook: HookPackageManifest = { ...packageHook, executionModel: 'page' }
export const kuaishouCapabilities = packageCapabilities
export const kuaishouHookScript = packageScript
