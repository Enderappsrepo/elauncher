/// <reference types="vite/client" />

import type { ElauncherApi } from '../../preload/index'

declare global {
  interface Window {
    elauncher: ElauncherApi
  }
}

export {}
