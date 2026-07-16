import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

/** Root data directory: %APPDATA%/elauncher-data (kept apart from Electron's own userData). */
export const dataRoot = join(app.getPath('appData'), 'elauncher-data')

export const instancesDir = join(dataRoot, 'instances')
/** Shared minecraft assets/libraries/versions, reused across instances. */
export const sharedDir = join(dataRoot, 'shared')
export const javaDir = join(dataRoot, 'java')
/** Local skin library (png files + skins.json metadata). */
export const skinsDir = join(dataRoot, 'skins')

export const instancesFile = join(dataRoot, 'instances.json')
export const accountsFile = join(dataRoot, 'accounts.json')
export const settingsFile = join(dataRoot, 'settings.json')
export const cloudSessionFile = join(dataRoot, 'cloud-session.json')

export function instanceDir(id: string): string {
  return join(instancesDir, id)
}

export function ensureDataDirs(): void {
  for (const dir of [dataRoot, instancesDir, sharedDir, javaDir, skinsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
