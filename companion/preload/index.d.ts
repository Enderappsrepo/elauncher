import type { CompanionApp } from './api'

declare global {
  interface Window {
    companion: CompanionApp
  }
}

export {}
