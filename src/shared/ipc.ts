import type { PlatformApi } from './platform'

declare global {
  interface Window {
    platformApi: PlatformApi
  }
}

export type { PlatformApi }
