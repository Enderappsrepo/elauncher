import type { ElauncherApi } from './index'

declare global {
  interface Window {
    elauncher: ElauncherApi
  }
}

export {}
