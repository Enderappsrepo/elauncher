import { randomUUID } from 'crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { extname, join } from 'path'
import { dialog, shell } from 'electron'
import type { CopySettingsRequest, CreateInstanceOptions, Instance } from '@shared/types'
import { instanceDir, instancesFile } from '../paths'
import { readJson, writeJson } from '../store'

function load(): Instance[] {
  return readJson<Instance[]>(instancesFile, [])
}

function save(instances: Instance[]): void {
  writeJson(instancesFile, instances)
}

export function listInstances(): Instance[] {
  return load().sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.createdAt - a.createdAt)
}

export function getInstance(id: string): Instance {
  const instance = load().find((i) => i.id === id)
  if (!instance) throw new Error(`Instance ${id} not found`)
  return instance
}

export function createInstance(opts: CreateInstanceOptions): Instance {
  const instance: Instance = {
    id: randomUUID(),
    name: opts.name.trim() || 'New Instance',
    minecraftVersion: opts.minecraftVersion,
    loader: opts.loader,
    loaderVersion: opts.loader === 'vanilla' ? undefined : opts.loaderVersion,
    memoryMax: 0,
    createdAt: Date.now()
  }
  mkdirSync(instanceDir(instance.id), { recursive: true })
  const instances = load()
  instances.push(instance)
  save(instances)
  return instance
}

export function updateInstance(updated: Instance): Instance {
  const instances = load()
  const idx = instances.findIndex((i) => i.id === updated.id)
  if (idx < 0) throw new Error(`Instance ${updated.id} not found`)
  instances[idx] = updated
  save(instances)
  return updated
}

export function removeInstance(id: string): void {
  save(load().filter((i) => i.id !== id))
  rmSync(instanceDir(id), { recursive: true, force: true })
}

export function duplicateInstance(id: string): Instance {
  const source = getInstance(id)
  const copy: Instance = {
    ...source,
    id: randomUUID(),
    name: `${source.name} (copy)`,
    createdAt: Date.now(),
    lastPlayedAt: undefined
  }
  cpSync(instanceDir(source.id), instanceDir(copy.id), { recursive: true })
  const instances = load()
  instances.push(copy)
  save(instances)
  return copy
}

export function openInstanceFolder(id: string): void {
  getInstance(id)
  const dir = instanceDir(id)
  mkdirSync(dir, { recursive: true })
  void shell.openPath(dir)
}

/** Copy selected settings files from one instance's game dir into another's. */
export function copySettings(req: CopySettingsRequest): string[] {
  const from = instanceDir(getInstance(req.fromId).id)
  const to = instanceDir(getInstance(req.toId).id)
  mkdirSync(to, { recursive: true })

  const copied: string[] = []
  const copy = (rel: string): void => {
    const src = join(from, rel)
    if (!existsSync(src)) return
    cpSync(src, join(to, rel), { recursive: true, force: true })
    copied.push(rel)
  }

  if (req.options) copy('options.txt')
  if (req.servers) copy('servers.dat')
  if (req.configs) copy('config')
  if (req.resourcePacks) copy('resourcepacks')
  return copied
}

export function touchLastPlayed(id: string): void {
  const instances = load()
  const idx = instances.findIndex((i) => i.id === id)
  if (idx >= 0) {
    instances[idx].lastPlayedAt = Date.now()
    save(instances)
  }
}

export function addPlaytime(id: string, ms: number): void {
  if (ms <= 0) return
  const instances = load()
  const idx = instances.findIndex((i) => i.id === id)
  if (idx >= 0) {
    instances[idx].totalPlayMs = (instances[idx].totalPlayMs ?? 0) + ms
    save(instances)
  }
}

// ---------- instance cover art ----------

const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function customIconPath(instance: Instance): string | null {
  if (!instance.icon?.startsWith('file:')) return null
  const path = join(instanceDir(instance.id), instance.icon.slice('file:'.length))
  return existsSync(path) ? path : null
}

/** Returns the custom icon image as a data url, or null when the instance uses a cover/auto gradient. */
export function getIconData(id: string): string | null {
  const instance = getInstance(id)
  const path = customIconPath(instance)
  if (!path) return null
  const mime = ICON_MIME[extname(path).toLowerCase()] ?? 'image/png'
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

/** Opens a file dialog and copies the chosen image into the instance folder. Returns the updated instance or null when cancelled. */
export async function pickIcon(id: string): Promise<Instance | null> {
  const instance = getInstance(id)
  const result = await dialog.showOpenDialog({
    title: 'Choose an instance image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const source = result.filePaths[0]
  const ext = extname(source).toLowerCase() || '.png'
  const fileName = `elauncher-icon${ext}`
  mkdirSync(instanceDir(id), { recursive: true })
  copyFileSync(source, join(instanceDir(id), fileName))
  return updateInstance({ ...instance, icon: `file:${fileName}` })
}

/** Sets a curated cover ("cover:<id>") or clears back to the auto gradient (undefined). */
export function setIcon(id: string, icon: string | undefined): Instance {
  const instance = getInstance(id)
  return updateInstance({ ...instance, icon })
}
