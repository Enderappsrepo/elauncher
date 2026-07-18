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
/** Locally-hosted dedicated servers, one folder per server. */
export const serversDir = join(dataRoot, 'servers')

export const instancesFile = join(dataRoot, 'instances.json')
export const serversFile = join(dataRoot, 'servers.json')
/** saved entries for the server browser (address book with live pings) */
export const serverBrowserFile = join(dataRoot, 'server-browser.json')
export const accountsFile = join(dataRoot, 'accounts.json')
export const settingsFile = join(dataRoot, 'settings.json')
export const cloudSessionFile = join(dataRoot, 'cloud-session.json')
/** which pool hostname each hosted server was assigned (serverId -> hostname) */
export const hostNamesFile = join(dataRoot, 'host-names.json')

export function instanceDir(id: string): string {
  return join(instancesDir, id)
}

export function serverDir(id: string): string {
  return join(serversDir, id)
}

export function ensureDataDirs(): void {
  for (const dir of [dataRoot, instancesDir, sharedDir, javaDir, skinsDir, serversDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
