import type { Settings } from '@shared/types'
import { settingsFile } from '../paths'
import { readJson, writeJson } from '../store'

const DEFAULTS: Settings = {
  defaultMemoryMax: 4096,
  optimizedJvmFlags: true,
  jvmGc: 'auto',
  autoMemory: true,
  highProcessPriority: false
}

export function getSettings(): Settings {
  return { ...DEFAULTS, ...readJson<Partial<Settings>>(settingsFile, {}) }
}

export function setSettings(settings: Settings): Settings {
  // pasted API keys often carry stray whitespace, which breaks the auth header
  const curseforgeApiKey = settings.curseforgeApiKey?.trim() || undefined
  writeJson(settingsFile, { ...settings, curseforgeApiKey })
  return getSettings()
}
