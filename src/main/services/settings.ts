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
  // hostnames get pasted with whitespace, scheme, or a trailing dot/slash
  const cleanHost = (value: string): string =>
    value
      .trim()
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/[/.]+$/, '')
  const publicHost = settings.publicHost ? cleanHost(settings.publicHost) || undefined : undefined
  const hostPool =
    settings.hostPool
      ?.split(/\r?\n/)
      .map(cleanHost)
      .filter(Boolean)
      .filter((host, i, all) => all.indexOf(host) === i)
      .join('\n') || undefined
  const duckdnsToken = settings.duckdnsToken?.trim() || undefined
  writeJson(settingsFile, { ...settings, curseforgeApiKey, publicHost, hostPool, duckdnsToken })
  return getSettings()
}
