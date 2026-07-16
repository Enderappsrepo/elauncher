import { existsSync, readdirSync, readFileSync } from 'fs'
import { cp } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { Instance, MigrateRequest, MigrationCandidate, ModLoader } from '@shared/types'
import { instanceDir } from '../paths'
import { createInstance } from './instances'
import { getMinecraftVersions } from './versions'
import { emitProgress, setInstallingState } from './game'

function countFiles(dir: string, extensions?: string[]): number {
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((f) => !extensions || extensions.some((ext) => f.endsWith(ext))).length
  } catch {
    return 0
  }
}

function hasWorlds(gameDir: string): boolean {
  return countFiles(join(gameDir, 'saves')) > 0
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

// ---------- CurseForge app ----------

interface CurseForgeInstanceJson {
  name?: string
  gameVersion?: string
  baseModLoader?: {
    name?: string
    minecraftVersion?: string
    forgeVersion?: string
    fabricVersion?: string
  }
}

/** baseModLoader.name looks like "forge-47.2.20", "fabric-0.15.7", "neoforge-20.4.109" */
function parseCurseForgeLoader(json: CurseForgeInstanceJson): { loader: ModLoader; loaderVersion?: string } {
  const raw = json.baseModLoader?.name ?? ''
  const dash = raw.indexOf('-')
  if (dash < 0) return { loader: 'vanilla' }
  const kind = raw.slice(0, dash).toLowerCase()
  const version = raw.slice(dash + 1)
  if (kind === 'forge') return { loader: 'forge', loaderVersion: json.baseModLoader?.forgeVersion || version }
  if (kind === 'fabric') return { loader: 'fabric', loaderVersion: json.baseModLoader?.fabricVersion || version }
  if (kind === 'neoforge') return { loader: 'neoforge', loaderVersion: version }
  return { loader: 'vanilla' }
}

function scanCurseForge(): MigrationCandidate[] {
  const root = join(homedir(), 'curseforge', 'minecraft', 'Instances')
  if (!existsSync(root)) return []
  const candidates: MigrationCandidate[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const json = readJsonFile<CurseForgeInstanceJson>(join(dir, 'minecraftinstance.json'))
    if (!json) continue
    const { loader, loaderVersion } = parseCurseForgeLoader(json)
    candidates.push({
      path: dir,
      launcher: 'curseforge',
      name: json.name || entry.name,
      minecraftVersion: json.gameVersion || json.baseModLoader?.minecraftVersion,
      loader,
      loaderVersion,
      hasWorlds: hasWorlds(dir),
      modCount: countFiles(join(dir, 'mods'), ['.jar'])
    })
  }
  return candidates
}

// ---------- Modrinth app ----------

interface TheseusProfileJson {
  metadata?: {
    name?: string
    game_version?: string
    loader?: string
    loader_version?: { id?: string } | string
  }
  // newer flat shape
  name?: string
  game_version?: string
  loader?: string
  loader_version?: string
}

function toModLoader(raw: string | undefined): ModLoader {
  if (raw === 'fabric' || raw === 'forge' || raw === 'neoforge') return raw
  return 'vanilla'
}

function scanModrinth(): MigrationCandidate[] {
  const appData = app.getPath('appData')
  const roots = [join(appData, 'ModrinthApp', 'profiles'), join(appData, 'com.modrinth.theseus', 'profiles')]
  const candidates: MigrationCandidate[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const json = readJsonFile<TheseusProfileJson>(join(dir, 'profile.json'))
      const meta = json?.metadata ?? json
      const loaderVersionRaw = json?.metadata?.loader_version ?? json?.loader_version
      const loaderVersion =
        typeof loaderVersionRaw === 'string' ? loaderVersionRaw : loaderVersionRaw?.id ?? undefined
      // Newer Modrinth builds keep metadata in a database instead of profile.json;
      // still offer the folder for import — settings and mods copy fine either way.
      candidates.push({
        path: dir,
        launcher: 'modrinth',
        name: meta?.name || entry.name,
        minecraftVersion: meta?.game_version,
        loader: toModLoader(meta?.loader),
        loaderVersion,
        hasWorlds: hasWorlds(dir),
        modCount: countFiles(join(dir, 'mods'), ['.jar'])
      })
    }
  }
  return candidates
}

// ---------- vanilla launcher ----------

function scanVanilla(): MigrationCandidate[] {
  const dir = join(app.getPath('appData'), '.minecraft')
  if (!existsSync(join(dir, 'options.txt')) && !existsSync(join(dir, 'saves'))) return []
  return [
    {
      path: dir,
      launcher: 'vanilla',
      name: 'Minecraft (official launcher)',
      minecraftVersion: undefined,
      loader: 'vanilla',
      hasWorlds: hasWorlds(dir),
      modCount: countFiles(join(dir, 'mods'), ['.jar'])
    }
  ]
}

// ---------- public API ----------

export function scanLaunchers(): MigrationCandidate[] {
  return [...scanCurseForge(), ...scanModrinth(), ...scanVanilla()]
}

export async function migrate(req: MigrateRequest): Promise<Instance> {
  const candidate = scanLaunchers().find((c) => c.path === req.path)
  if (!candidate) throw new Error('That instance could not be found anymore. Re-open the migration window.')

  let mcVersion = candidate.minecraftVersion
  if (!mcVersion) {
    const versions = await getMinecraftVersions()
    mcVersion = versions.find((v) => v.type === 'release')?.id
    if (!mcVersion) throw new Error('Could not determine a Minecraft version for this instance.')
  }

  const instance = createInstance({
    name: candidate.name,
    minecraftVersion: mcVersion,
    loader: candidate.loader,
    loaderVersion: candidate.loaderVersion
  })

  const dest = instanceDir(instance.id)
  const parts: { enabled: boolean; rel: string; label: string }[] = [
    { enabled: req.mods, rel: 'mods', label: 'mods' },
    { enabled: req.configs, rel: 'config', label: 'mod configs' },
    { enabled: req.options, rel: 'options.txt', label: 'options' },
    { enabled: req.servers, rel: 'servers.dat', label: 'servers' },
    { enabled: req.resourcePacks, rel: 'resourcepacks', label: 'resource packs' },
    { enabled: req.worlds, rel: 'saves', label: 'worlds' }
  ]

  setInstallingState(instance.id, true)
  try {
    for (const part of parts) {
      if (!part.enabled) continue
      const src = join(candidate.path, part.rel)
      if (!existsSync(src)) continue
      emitProgress(instance.id, `Copying ${part.label} from ${candidate.launcher}`, -1)
      await cp(src, join(dest, part.rel), { recursive: true, force: true })
    }
    return instance
  } finally {
    setInstallingState(instance.id, false)
  }
}
