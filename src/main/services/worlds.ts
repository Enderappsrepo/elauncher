import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { dialog, shell } from 'electron'
import AdmZip from 'adm-zip'
import { deserialize } from '@xmcl/nbt'
import type { WorldInfo } from '@shared/types'
import { instanceDir } from '../paths'

function savesDir(instanceId: string): string {
  return join(instanceDir(instanceId), 'saves')
}

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const

interface LevelData {
  Data?: {
    LevelName?: string
    LastPlayed?: bigint | number
    GameType?: number
    hardcore?: number
    allowCommands?: number
    Version?: { Name?: string }
  }
}

function dirSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(path)
      else total += statSync(path).size
    } catch {
      // file vanished mid-scan (game writing); skip
    }
  }
  return total
}

export async function listWorlds(instanceId: string): Promise<WorldInfo[]> {
  const dir = savesDir(instanceId)
  if (!existsSync(dir)) return []
  const worlds: WorldInfo[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const worldDir = join(dir, entry.name)
    const levelDat = join(worldDir, 'level.dat')
    if (!existsSync(levelDat)) continue

    const info: WorldInfo = {
      folderName: entry.name,
      name: entry.name,
      sizeBytes: dirSize(worldDir)
    }
    try {
      const level = await deserialize<LevelData>(readFileSync(levelDat), { compressed: 'gzip' })
      const data = level.Data
      if (data) {
        if (data.LevelName) info.name = data.LevelName
        if (data.LastPlayed != null) info.lastPlayed = Number(data.LastPlayed)
        if (data.GameType != null) info.gameMode = GAME_MODES[data.GameType] ?? undefined
        info.hardcore = data.hardcore === 1
        info.cheats = data.allowCommands === 1
        info.versionName = data.Version?.Name
      }
    } catch {
      // unreadable level.dat; show the folder with defaults
    }
    const iconFile = join(worldDir, 'icon.png')
    if (existsSync(iconFile)) {
      info.icon = `data:image/png;base64,${readFileSync(iconFile).toString('base64')}`
    }
    worlds.push(info)
  }
  return worlds.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
}

/** Zips the world folder to a user-chosen location. Returns false when cancelled. */
export async function backupWorld(instanceId: string, folderName: string): Promise<boolean> {
  const worldDir = join(savesDir(instanceId), folderName)
  if (!existsSync(worldDir)) throw new Error(`World "${folderName}" not found`)
  const stamp = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog({
    title: 'Backup world',
    defaultPath: `${folderName}-backup-${stamp}.zip`,
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return false
  const zip = new AdmZip()
  zip.addLocalFolder(worldDir, folderName)
  await zip.writeZipPromise(result.filePath)
  return true
}

export function deleteWorld(instanceId: string, folderName: string): void {
  rmSync(join(savesDir(instanceId), folderName), { recursive: true, force: true })
}

export function openWorldFolder(instanceId: string, folderName: string): void {
  const dir = join(savesDir(instanceId), folderName)
  if (existsSync(dir)) void shell.openPath(dir)
}
