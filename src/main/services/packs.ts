import AdmZip from 'adm-zip'
import { dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Instance, ModLoader, ModSource, PackLink, PackTaskEvent } from '@shared/types'
import { instanceDir } from '../paths'
import { readJson, writeJson } from '../store'
import { createInstance, getInstance, removeInstance, updateInstance } from './instances'
import { curseforgeFetch, downloadToFile, listInstalledMods, modrinthFetch, readModsMeta, type ModRecord } from './mods'
import { getSettings } from './settings'
import { broadcast, emitProgress, setInstallingState } from './game'

/** How many pack files download in parallel. */
const DOWNLOAD_CONCURRENCY = 6
const DOWNLOAD_RETRIES = 3

export type PackProgressFn = (phase: string, progress: number) => void

/** Progress channel for installs that don't have an instance yet (cloud installs, imports). */
export function emitPackTask(taskId: string, phase: string, progress: number, done?: boolean): void {
  broadcast('packs:progress', { taskId, phase, progress, done } satisfies PackTaskEvent)
}

interface MrpackFile {
  path: string
  hashes: { sha1: string; sha512: string }
  downloads: string[]
  fileSize: number
  env?: { client: string; server: string }
}

interface MrpackIndex {
  formatVersion: 1
  game: 'minecraft'
  versionId: string
  name: string
  files: MrpackFile[]
  dependencies: Record<string, string>
}

/** Per-instance metadata file, shared with the install worker (which owns `versionId`). */
interface InstanceMeta {
  versionId?: string
  pack?: PackLink & { files: string[] }
}

const LOADER_TO_DEP: Record<Exclude<ModLoader, 'vanilla'>, string> = {
  fabric: 'fabric-loader',
  forge: 'forge',
  neoforge: 'neoforge'
}

function metaFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'elauncher-meta.json')
}

export function getPackLink(instanceId: string): PackLink | null {
  const meta = readJson<InstanceMeta>(metaFile(instanceId), {})
  if (!meta.pack) return null
  const { name, versionId, url, cloudPackId, importedAt } = meta.pack
  return { name, versionId, url, cloudPackId, importedAt }
}

// ---------- export ----------

function hashFile(path: string): { sha1: string; sha512: string; size: number } {
  const buffer = readFileSync(path)
  return {
    sha1: createHash('sha1').update(buffer).digest('hex'),
    sha512: createHash('sha512').update(buffer).digest('hex'),
    size: buffer.length
  }
}

interface ModrinthVersionFile {
  hashes: { sha1: string; sha512: string }
  url: string
  filename: string
  size: number
}

/** Batch-identify local jars on Modrinth by sha1. Returns sha1 -> file info. */
async function lookupModrinthByHash(sha1s: string[]): Promise<Map<string, ModrinthVersionFile>> {
  const found = new Map<string, ModrinthVersionFile>()
  if (sha1s.length === 0) return found
  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ELauncher/0.1.0 (custom launcher)' },
      body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' })
    })
    if (!res.ok) return found
    const data = (await res.json()) as Record<string, { files: ModrinthVersionFile[] }>
    for (const [hash, version] of Object.entries(data)) {
      const file = version.files.find((f) => f.hashes.sha1 === hash)
      if (file) found.set(hash, file)
    }
  } catch {
    // offline or Modrinth down: fall back to embedding the jars
  }
  return found
}

/**
 * Build a .mrpack for an instance and return it as an in-memory zip.
 * Mods are referenced by download URL wherever possible (Modrinth metadata,
 * CurseForge CDN, or a Modrinth hash lookup for manually-added jars) so the
 * pack file stays small; only unidentifiable files are embedded.
 */
export async function buildMrpack(instanceId: string, version?: string, nameOverride?: string): Promise<AdmZip> {
  const instance = getInstance(instanceId)
  const dir = instanceDir(instanceId)
  const meta = readModsMeta(instanceId)
  const zip = new AdmZip()

  const files: MrpackFile[] = []
  const unknown: { fileName: string; sha1: string; sha512: string; size: number }[] = []

  for (const mod of listInstalledMods(instanceId)) {
    if (!mod.enabled) continue
    const record = meta[mod.displayName]
    const filePath = join(dir, 'mods', mod.fileName)

    if (record && record.source === 'modrinth' && record.sha1 && record.sha512) {
      files.push({
        path: `mods/${mod.displayName}`,
        hashes: { sha1: record.sha1, sha512: record.sha512 },
        downloads: [record.downloadUrl],
        fileSize: record.fileSize,
        env: { client: 'required', server: 'required' }
      })
    } else if (record && record.source === 'curseforge' && record.downloadUrl) {
      // reference the CurseForge CDN instead of embedding; hash the local file for integrity
      const { sha1, sha512, size } = hashFile(filePath)
      files.push({
        path: `mods/${mod.displayName}`,
        hashes: { sha1, sha512 },
        downloads: [record.downloadUrl],
        fileSize: size,
        env: { client: 'required', server: 'required' }
      })
    } else {
      // manually-added jar: try to identify it on Modrinth by hash before embedding
      const { sha1, sha512, size } = hashFile(filePath)
      unknown.push({ fileName: mod.displayName, sha1, sha512, size })
    }
  }

  const identified = await lookupModrinthByHash(unknown.map((u) => u.sha1))
  for (const u of unknown) {
    const match = identified.get(u.sha1)
    if (match) {
      files.push({
        path: `mods/${u.fileName}`,
        hashes: { sha1: u.sha1, sha512: u.sha512 },
        downloads: [match.url],
        fileSize: u.size,
        env: { client: 'required', server: 'required' }
      })
    } else {
      // last resort: this jar exists nowhere public, so it travels inside the pack
      zip.addLocalFile(join(dir, 'mods', u.fileName), 'overrides/mods')
    }
  }

  // settings travel with the pack: game options/keybinds, server list, mod configs, resource packs
  for (const extra of ['options.txt', 'servers.dat']) {
    const p = join(dir, extra)
    if (existsSync(p)) zip.addLocalFile(p, 'overrides')
  }
  for (const folder of ['config', 'resourcepacks']) {
    const p = join(dir, folder)
    if (existsSync(p)) zip.addLocalFolder(p, `overrides/${folder}`)
  }

  const index: MrpackIndex = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: version || new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    name: nameOverride || instance.name,
    files,
    dependencies: {
      minecraft: instance.minecraftVersion,
      ...(instance.loader !== 'vanilla' && instance.loaderVersion
        ? { [LOADER_TO_DEP[instance.loader]]: instance.loaderVersion }
        : {})
    }
  }
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf-8'))
  return zip
}

export async function exportInstance(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  const instance = getInstance(instanceId)
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export modpack',
    defaultPath: `${instance.name.replace(/[<>:"/\\|?*]/g, '_')}.mrpack`,
    filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]
  })
  if (canceled || !filePath) return { ok: false, error: 'cancelled' }
  ;(await buildMrpack(instanceId)).writeZip(filePath)
  return { ok: true }
}

// ---------- import / update ----------

/** Rebuild launcher mod metadata from a Modrinth CDN url so updates keep working after import. */
function recordFromCdnUrl(file: MrpackFile): ModRecord | null {
  const match = file.downloads[0]?.match(/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//)
  if (!match) return null
  return {
    source: 'modrinth',
    projectId: match[1],
    versionId: match[2],
    versionNumber: '',
    title: file.path.replace(/^mods\//, ''),
    downloadUrl: file.downloads[0],
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    fileSize: file.fileSize
  }
}

function parseIndex(zip: AdmZip): MrpackIndex {
  const indexEntry = zip.getEntry('modrinth.index.json')
  if (!indexEntry) throw new Error('Not a valid .mrpack: missing modrinth.index.json')
  return JSON.parse(indexEntry.getData().toString('utf-8')) as MrpackIndex
}

function parseDependencies(index: MrpackIndex): {
  mcVersion: string
  loader: ModLoader
  loaderVersion?: string
} {
  let loader: ModLoader = 'vanilla'
  let loaderVersion: string | undefined
  for (const [key, value] of Object.entries(index.dependencies)) {
    if (key === 'fabric-loader') (loader = 'fabric'), (loaderVersion = value)
    else if (key === 'forge') (loader = 'forge'), (loaderVersion = value)
    else if (key === 'neoforge') (loader = 'neoforge'), (loaderVersion = value)
    else if (key === 'quilt-loader') throw new Error('Quilt modpacks are not supported')
  }
  const mcVersion = index.dependencies.minecraft
  if (!mcVersion) throw new Error('Modpack does not declare a Minecraft version')
  return { mcVersion, loader, loaderVersion }
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sha1Matches(path: string, expected: string): boolean {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex') === expected
  } catch {
    return false
  }
}

async function downloadWithRetries(url: string, dest: string, sha1?: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      await downloadToFile(url, dest)
      if (sha1 && !sha1Matches(dest, sha1)) {
        throw new Error('Checksum mismatch after download')
      }
      return
    } catch (e) {
      lastError = e
      if (attempt < DOWNLOAD_RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
  rmSync(dest, { force: true })
  throw new Error(
    `Failed to download ${dest.split(/[\\/]/).pop()}: ${lastError instanceof Error ? lastError.message : lastError}`
  )
}

/**
 * Download pack files + extract overrides into an instance dir.
 * Files download in parallel, are checksum-verified, and files that already
 * exist with the right hash are skipped (fast updates).
 * Returns the list of file paths the pack manages (for clean updates later).
 */
async function applyPackFiles(
  instanceId: string,
  zip: AdmZip,
  index: MrpackIndex,
  onProgress?: PackProgressFn
): Promise<string[]> {
  const dir = instanceDir(instanceId)
  const managed: string[] = []

  const report = (phase: string, progress: number): void => {
    emitProgress(instanceId, phase, progress)
    onProgress?.(phase, progress)
  }

  const files = index.files.filter((f) => f.env?.client !== 'unsupported')
  const modsMetaFile = join(dir, 'elauncher-mods.json')
  const modsMeta = readJson<Record<string, ModRecord>>(modsMetaFile, {})

  // validate every path before touching the network
  const jobs = files.map((file) => {
    const dest = resolve(dir, file.path)
    if (!dest.startsWith(resolve(dir))) throw new Error(`Unsafe path in modpack: ${file.path}`)
    return { file, dest }
  })

  const totalBytes = jobs.reduce((sum, j) => sum + (j.file.fileSize || 0), 0)
  let doneBytes = 0
  let doneCount = 0
  let skippedCount = 0

  report(`Preparing ${jobs.length} files (${fmtMB(totalBytes)})`, 0)

  const queue = [...jobs]
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      const { file, dest } = job

      // already there from a previous version? skip the download entirely
      if (existsSync(dest) && sha1Matches(dest, file.hashes.sha1)) {
        skippedCount++
      } else {
        mkdirSync(dirname(dest), { recursive: true })
        await downloadWithRetries(file.downloads[0], dest, file.hashes.sha1)
      }

      managed.push(file.path)
      const record = recordFromCdnUrl(file)
      if (record && file.path.startsWith('mods/')) {
        modsMeta[file.path.slice('mods/'.length)] = record
      }
      doneCount++
      doneBytes += file.fileSize || 0
      report(
        `Downloading mods (${doneCount}/${jobs.length} · ${fmtMB(doneBytes)} of ${fmtMB(totalBytes)})`,
        totalBytes > 0 ? doneBytes / totalBytes : doneCount / jobs.length
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, () => worker()))
  if (skippedCount > 0) {
    console.log(`[packs] ${skippedCount}/${jobs.length} files already up to date, skipped`)
  }
  writeJson(modsMetaFile, modsMeta)

  report('Applying configs & overrides', -1)
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
      const rel = entry.entryName.slice(prefix.length)
      const dest = resolve(dir, rel)
      if (!dest.startsWith(resolve(dir))) continue
      mkdirSync(dirname(dest), { recursive: true })
      zip.extractEntryTo(entry, dirname(dest), false, true)
      managed.push(rel.replace(/\\/g, '/'))
    }
  }
  return managed
}

export async function importFromZip(
  zip: AdmZip,
  link?: { url?: string; cloudPackId?: string },
  onProgress?: PackProgressFn
): Promise<Instance> {
  const index = parseIndex(zip)
  const { mcVersion, loader, loaderVersion } = parseDependencies(index)

  const instance = createInstance({
    name: index.name || 'Imported pack',
    minecraftVersion: mcVersion,
    loader,
    loaderVersion
  })

  setInstallingState(instance.id, true)
  try {
    const managed = await applyPackFiles(instance.id, zip, index, onProgress)
    const meta = readJson<InstanceMeta>(metaFile(instance.id), {})
    meta.pack = {
      name: index.name,
      versionId: index.versionId,
      url: link?.url,
      cloudPackId: link?.cloudPackId,
      importedAt: Date.now(),
      files: managed
    }
    writeJson(metaFile(instance.id), meta)
    return instance
  } catch (e) {
    // don't leave a broken half-downloaded instance behind
    setInstallingState(instance.id, false)
    try {
      removeInstance(instance.id)
    } catch {
      // ignore cleanup failure; the instance dir stays but the error below is the real problem
    }
    throw e
  } finally {
    setInstallingState(instance.id, false)
  }
}

/** Runs an import task with progress events on the shared 'import' task channel. */
async function runImportTask<T>(fn: (report: PackProgressFn) => Promise<T>): Promise<T> {
  const report: PackProgressFn = (phase, progress) => emitPackTask('import', phase, progress)
  try {
    return await fn(report)
  } finally {
    emitPackTask('import', 'Done', 1, true)
  }
}

export async function importPack(): Promise<Instance | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import modpack',
    filters: [{ name: 'Modrinth modpack', extensions: ['mrpack', 'zip'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null
  return runImportTask((report) => importFromZip(new AdmZip(filePaths[0]), undefined, report))
}

export async function downloadPackToTemp(url: string, onProgress?: PackProgressFn): Promise<string> {
  const tmp = join(tmpdir(), `elauncher-pack-${randomUUID()}.mrpack`)
  onProgress?.('Downloading modpack file', -1)
  let lastReport = 0
  await downloadToFile(url, tmp, (received, total) => {
    const now = Date.now()
    if (total > 0 && now - lastReport > 200) {
      lastReport = now
      onProgress?.(`Downloading modpack file (${fmtMB(received)} of ${fmtMB(total)})`, received / total)
    }
  })
  return tmp
}

export async function importPackFromUrl(url: string): Promise<Instance> {
  return runImportTask(async (report) => {
    const tmp = await downloadPackToTemp(url, report)
    try {
      return await importFromZip(new AdmZip(tmp), { url }, report)
    } finally {
      rmSync(tmp, { force: true })
    }
  })
}

// ---------- modpack install from the mod browser (Modrinth + CurseForge) ----------

const CF_API = 'https://api.curseforge.com/v1'
const CF_UA = 'ELauncher/0.1.0 (custom launcher)'

/** Newest downloadable .mrpack URL for a Modrinth modpack project. */
async function resolveModrinthModpackUrl(projectId: string): Promise<string> {
  const versions = (await modrinthFetch(`/project/${projectId}/version`)) as {
    files: { url: string; filename: string; primary: boolean }[]
  }[]
  for (const v of versions) {
    const file =
      v.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ??
      v.files.find((f) => f.filename.endsWith('.mrpack'))
    if (file) return file.url
  }
  throw new Error('This Modrinth project has no installable .mrpack file.')
}

interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] }
  name: string
  version?: string
  files: { projectID: number; fileID: number; required?: boolean }[]
  overrides?: string
}

interface CfFile {
  id: number
  modId: number
  fileName: string
  downloadUrl: string | null
}

/** CurseForge manifest loader id ("forge-47.2.0") → launcher loader + version. */
function parseCfLoader(id: string): { loader: ModLoader; loaderVersion?: string } {
  const idx = id.indexOf('-')
  const name = idx >= 0 ? id.slice(0, idx) : id
  const version = idx >= 0 ? id.slice(idx + 1) : undefined
  if (name === 'fabric') return { loader: 'fabric', loaderVersion: version }
  if (name === 'forge') return { loader: 'forge', loaderVersion: version }
  if (name === 'neoforge') return { loader: 'neoforge', loaderVersion: version }
  if (name === 'quilt') throw new Error('Quilt modpacks are not supported.')
  return { loader: 'vanilla' }
}

/** edge.forgecdn.net fallback used when the API omits a file's downloadUrl. */
function forgeCdnUrl(fileId: number, fileName: string): string {
  const s = String(fileId)
  return `https://edge.forgecdn.net/files/${Number(s.slice(0, 4))}/${Number(s.slice(4))}/${encodeURIComponent(fileName)}`
}

/** Resolve many CurseForge file ids to their download info in one (chunked) call. */
async function curseforgeFilesBulk(fileIds: number[]): Promise<CfFile[]> {
  if (fileIds.length === 0) return []
  const key = getSettings().curseforgeApiKey?.trim()
  if (!key) throw new Error('A CurseForge API key is required to install CurseForge modpacks. Add one in Settings.')
  const out: CfFile[] = []
  for (let i = 0; i < fileIds.length; i += 250) {
    const res = await fetch(`${CF_API}/mods/files`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'User-Agent': CF_UA },
      body: JSON.stringify({ fileIds: fileIds.slice(i, i + 250) })
    })
    if (!res.ok) throw new Error(`CurseForge API error ${res.status}: ${await res.text()}`)
    out.push(...((await res.json()) as { data: CfFile[] }).data)
  }
  return out
}

/** Latest pack-file download URL for a CurseForge modpack project. */
async function resolveCurseforgeModpackUrl(projectId: string): Promise<string> {
  const { data } = (await curseforgeFetch(`/mods/${projectId}`)) as {
    data: { mainFileId: number; latestFiles: CfFile[] }
  }
  const files = data.latestFiles ?? []
  const file = files.find((f) => f.id === data.mainFileId) ?? [...files].sort((a, b) => b.id - a.id)[0]
  if (!file) throw new Error('This CurseForge modpack has no downloadable file.')
  return file.downloadUrl ?? forgeCdnUrl(file.id, file.fileName)
}

/**
 * Install a CurseForge modpack zip: read manifest.json, create an instance for its
 * Minecraft version + loader, resolve & download every mod file (with a CDN fallback
 * for files the API won't hand out), then lay down the overrides folder.
 */
async function importCurseforgePack(zipPath: string, onProgress?: PackProgressFn): Promise<Instance> {
  const zip = new AdmZip(zipPath)
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry) throw new Error('Not a CurseForge modpack: manifest.json is missing.')
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as CfManifest
  if (!manifest.minecraft?.version) throw new Error('CurseForge modpack does not declare a Minecraft version.')

  const primary = manifest.minecraft.modLoaders?.find((l) => l.primary) ?? manifest.minecraft.modLoaders?.[0]
  const { loader, loaderVersion } = primary ? parseCfLoader(primary.id) : { loader: 'vanilla' as ModLoader }

  const instance = createInstance({
    name: manifest.name || 'CurseForge pack',
    minecraftVersion: manifest.minecraft.version,
    loader,
    loaderVersion
  })

  setInstallingState(instance.id, true)
  try {
    const dir = instanceDir(instance.id)
    const managed: string[] = []

    const report = (phase: string, progress: number): void => {
      emitProgress(instance.id, phase, progress)
      onProgress?.(phase, progress)
    }

    report('Resolving modpack files', -1)
    const files = await curseforgeFilesBulk(manifest.files.map((f) => f.fileID))
    const modsDir = join(dir, 'mods')
    mkdirSync(modsDir, { recursive: true })

    let done = 0
    const skipped: string[] = []
    const queue = [...files]
    const tick = (): void => report(`Downloading mods (${done}/${files.length})`, files.length ? done / files.length : -1)
    tick()
    const worker = async (): Promise<void> => {
      for (;;) {
        const f = queue.shift()
        if (!f) return
        const dest = join(modsDir, f.fileName)
        try {
          await downloadWithRetries(f.downloadUrl ?? forgeCdnUrl(f.id, f.fileName), dest)
          managed.push(`mods/${f.fileName}`)
        } catch {
          skipped.push(f.fileName)
        }
        done++
        tick()
      }
    }
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, () => worker()))

    // overrides ship configs, extra bundled jars, resource packs, etc.
    report('Applying configs & overrides', -1)
    const prefix = `${manifest.overrides || 'overrides'}/`
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
      const dest = resolve(dir, entry.entryName.slice(prefix.length))
      if (!dest.startsWith(resolve(dir))) continue
      mkdirSync(dirname(dest), { recursive: true })
      zip.extractEntryTo(entry, dirname(dest), false, true)
      managed.push(entry.entryName.slice(prefix.length).replace(/\\/g, '/'))
    }

    const meta = readJson<InstanceMeta>(metaFile(instance.id), {})
    meta.pack = {
      name: manifest.name || 'CurseForge pack',
      versionId: manifest.version || new Date().toISOString().slice(0, 10),
      importedAt: Date.now(),
      files: managed
    }
    writeJson(metaFile(instance.id), meta)

    if (skipped.length > 0) {
      console.warn(`[packs] CurseForge pack: ${skipped.length} file(s) could not be downloaded:`, skipped)
    }
    return instance
  } catch (e) {
    setInstallingState(instance.id, false)
    try {
      removeInstance(instance.id)
    } catch {
      // best-effort cleanup; surface the original error
    }
    throw e
  } finally {
    setInstallingState(instance.id, false)
  }
}

/** Install a whole modpack from the mod browser as a brand-new instance. */
export async function installModpack(source: ModSource, projectId: string): Promise<Instance> {
  if (source === 'modrinth') {
    // Modrinth packs are .mrpack — reuse the fully-featured importer
    return importPackFromUrl(await resolveModrinthModpackUrl(projectId))
  }
  return runImportTask(async (report) => {
    const url = await resolveCurseforgeModpackUrl(projectId)
    const tmp = join(tmpdir(), `elauncher-cfpack-${randomUUID()}.zip`)
    report('Downloading modpack file', -1)
    await downloadToFile(url, tmp)
    try {
      return await importCurseforgePack(tmp, report)
    } finally {
      rmSync(tmp, { force: true })
    }
  })
}

/**
 * Core of a pack update: removes files managed by the previous pack version
 * that are gone from the new one (keeping worlds and manually-added mods),
 * then applies the new version. Files that didn't change between versions are
 * kept in place and skipped by the checksum check in applyPackFiles, so
 * updates only download what actually changed.
 * The caller owns the installing state and zip file lifetime.
 */
export async function applyPackUpdate(instanceId: string, zipPath: string): Promise<{ version: string }> {
  const instance = getInstance(instanceId)
  const meta = readJson<InstanceMeta>(metaFile(instanceId), {})
  if (!meta.pack) throw new Error('This instance is not linked to a modpack.')

  const zip = new AdmZip(zipPath)
  const index = parseIndex(zip)
  const { mcVersion, loader, loaderVersion } = parseDependencies(index)

  // remove previously managed files that the new version no longer ships
  emitProgress(instanceId, 'Removing outdated modpack files', -1)
  const keep = new Set(index.files.map((f) => f.path))
  const dir = instanceDir(instanceId)
  const modsMetaFile = join(dir, 'elauncher-mods.json')
  const modsMeta = readJson<Record<string, ModRecord>>(modsMetaFile, {})
  for (const rel of meta.pack.files) {
    if (keep.has(rel)) continue
    const p = resolve(dir, rel)
    if (!p.startsWith(resolve(dir))) continue
    rmSync(p, { force: true })
    if (rel.startsWith('mods/')) delete modsMeta[rel.slice('mods/'.length)]
  }
  writeJson(modsMetaFile, modsMeta)

  // apply version / loader changes
  if (
    mcVersion !== instance.minecraftVersion ||
    loader !== instance.loader ||
    loaderVersion !== instance.loaderVersion
  ) {
    updateInstance({ ...instance, minecraftVersion: mcVersion, loader, loaderVersion })
    delete meta.versionId // force the loader profile to be re-installed on next launch
  }

  const managed = await applyPackFiles(instanceId, zip, index)
  meta.pack = { ...meta.pack, versionId: index.versionId, files: managed, importedAt: Date.now() }
  writeJson(metaFile(instanceId), meta)
  return { version: index.versionId }
}

/**
 * One-click update for url/file-linked packs. Cloud-linked packs are updated
 * through the cloud service instead (see ipc.ts routing).
 */
export async function updatePack(instanceId: string): Promise<{ ok: boolean; error?: string; version?: string }> {
  const meta = readJson<InstanceMeta>(metaFile(instanceId), {})
  if (!meta.pack) return { ok: false, error: 'This instance is not linked to a modpack.' }

  // re-fetch from the original link, or ask for a new file when it was imported locally
  let zipPath: string | null = null
  let temp = false
  if (meta.pack.url) {
    setInstallingState(instanceId, true)
    emitProgress(instanceId, 'Downloading modpack', -1)
    try {
      zipPath = await downloadPackToTemp(meta.pack.url, (phase, progress) =>
        emitProgress(instanceId, phase, progress)
      )
      temp = true
    } catch (e) {
      setInstallingState(instanceId, false)
      return { ok: false, error: `Could not download the modpack: ${e instanceof Error ? e.message : e}` }
    }
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: `Select the new version of "${meta.pack.name}"`,
      filters: [{ name: 'Modrinth modpack', extensions: ['mrpack', 'zip'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { ok: false, error: 'cancelled' }
    zipPath = filePaths[0]
    setInstallingState(instanceId, true)
  }

  try {
    const { version } = await applyPackUpdate(instanceId, zipPath)
    return { ok: true, version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (temp && zipPath) rmSync(zipPath, { force: true })
    setInstallingState(instanceId, false)
  }
}