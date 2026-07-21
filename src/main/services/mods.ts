import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { basename, join } from 'path'
import AdmZip from 'adm-zip'
import type {
  ContentKind,
  IdentifyResult,
  InstalledMod,
  InstalledPack,
  Instance,
  JarModInfo,
  ModInstallRequest,
  ModLoader,
  ModSearchHit,
  ModSearchQuery,
  ModSearchResult,
  ModSource,
  ModUpdateInfo
} from '@shared/types'
import { instanceDir } from '../paths'
import { readJson, writeJson } from '../store'
import { getInstance } from './instances'
import { getSettings } from './settings'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@shared/cloudConfig'

const MODRINTH = 'https://api.modrinth.com/v2'
const CURSEFORGE = 'https://api.curseforge.com/v1'
const USER_AGENT = 'ELauncher/0.1.0 (custom launcher)'

/**
 * How a CurseForge API call authenticates.
 *  - 'key':   the user's own key from Settings — every desktop CurseForge
 *             feature (create dialog, mod browsers, instance installs).
 *  - 'proxy': the paid-hosting provisioner, which owns no personal key. It goes
 *             through our cf-proxy edge function with the hosting account's
 *             session token; the shared key is injected server-side so the
 *             customer never needs one. See supabase/functions/cf-proxy.
 */
export type CfAccess = { mode: 'key'; key: string } | { mode: 'proxy'; token: string }

/** Default CF access for desktop calls: the personal key from Settings, or a clear error. */
export function cfAccessFromSettings(): CfAccess {
  const key = getSettings().curseforgeApiKey?.trim()
  if (!key) {
    throw new Error('A CurseForge API key is required. Add one in Settings (console.curseforge.com).')
  }
  return { mode: 'key', key }
}

const CF_PROXY = `${SUPABASE_URL}/functions/v1/cf-proxy`

/**
 * Low-level CurseForge request, either straight to the API with a personal key
 * or through the cf-proxy edge function with a session token. Callers layer
 * status handling and JSON parsing on top.
 */
export async function cfRequest(path: string, access: CfAccess, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    ...(init?.headers as Record<string, string> | undefined)
  }
  if (access.mode === 'proxy') {
    headers.Authorization = `Bearer ${access.token}`
    headers.apikey = SUPABASE_ANON_KEY
    return fetch(`${CF_PROXY}${path}`, { ...init, headers })
  }
  headers['x-api-key'] = access.key
  return fetch(`${CURSEFORGE}${path}`, { ...init, headers })
}

/** Metadata for mods installed through the launcher, kept per instance. */
export interface ModRecord {
  source: ModSource
  projectId: string
  versionId: string
  versionNumber: string
  title: string
  iconUrl?: string
  downloadUrl: string
  sha1?: string
  sha512?: string
  fileSize: number
}

type ModsMeta = Record<string, ModRecord>

function modsDir(instanceId: string): string {
  return join(instanceDir(instanceId), 'mods')
}

function modsMetaFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'elauncher-mods.json')
}

export function readModsMeta(instanceId: string): ModsMeta {
  return readJson<ModsMeta>(modsMetaFile(instanceId), {})
}

function writeModsMeta(instanceId: string, meta: ModsMeta): void {
  writeJson(modsMetaFile(instanceId), meta)
}

export async function modrinthFetch(path: string): Promise<unknown> {
  const res = await fetch(`${MODRINTH}${path}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`Modrinth API error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function modrinthPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${MODRINTH}${path}`, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`Modrinth API error ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function curseforgeFetch(path: string, access: CfAccess = cfAccessFromSettings()): Promise<unknown> {
  const res = await cfRequest(path, access)
  if (res.status === 401) {
    // only the proxy path can 401 — the hosting account's session lapsed
    throw new Error('The hosting account is not signed in, so CurseForge could not be reached.')
  }
  if (res.status === 403) {
    throw new Error(
      access.mode === 'proxy'
        ? 'CurseForge rejected the hosting key (403). The launcher owner may need to refresh CURSEFORGE_API_KEY on the cf-proxy function.'
        : 'CurseForge rejected your API key for this request (403). Fresh keys can take a while to fully activate — try regenerating the key at console.curseforge.com and saving the new one in Settings. Modrinth search works without any key in the meantime.'
    )
  }
  if (!res.ok) throw new Error(`CurseForge API error ${res.status}: ${await res.text()}`)
  return res.json()
}

export const CF_LOADER_TYPES: Record<Exclude<ModLoader, 'vanilla'>, number> = {
  forge: 1,
  fabric: 4,
  neoforge: 6
}

// ---------- search ----------

/** CurseForge class ids per content type. */
const CF_CLASS_IDS: Record<'mod' | 'shader' | 'resourcepack' | 'modpack' | 'plugin', string> = {
  mod: '6',
  shader: '6552',
  resourcepack: '12',
  modpack: '4471',
  plugin: '5' // bukkit-plugins
}

const MODRINTH_PROJECT_TYPES: Record<'mod' | 'shader' | 'resourcepack' | 'modpack' | 'plugin', string> = {
  mod: 'mod',
  shader: 'shader',
  resourcepack: 'resourcepack',
  modpack: 'modpack',
  plugin: 'plugin'
}

/** Paper runs the whole Bukkit plugin family. */
const PAPER_PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur']

export async function searchMods(query: ModSearchQuery): Promise<ModSearchResult> {
  const limit = query.limit ?? 20
  const offset = query.offset ?? 0
  const projectType = query.projectType ?? 'mod'
  if (query.source === 'modrinth') {
    const facets: string[][] = [[`project_type:${MODRINTH_PROJECT_TYPES[projectType]}`]]
    if (query.mcVersion) facets.push([`versions:${query.mcVersion}`])
    // loader facet only applies to mods; shaders/resource packs use their own "loaders"
    if (projectType === 'mod' && query.loader && query.loader !== 'vanilla') {
      facets.push([`categories:${query.loader}`])
    }
    // plugins: any of the Paper-compatible loaders (inner array = OR)
    if (projectType === 'plugin') {
      facets.push(PAPER_PLUGIN_LOADERS.map((l) => `categories:${l}`))
    }
    const params = new URLSearchParams({
      query: query.query,
      facets: JSON.stringify(facets),
      limit: String(limit),
      offset: String(offset),
      index: query.query ? 'relevance' : 'downloads'
    })
    const data = (await modrinthFetch(`/search?${params}`)) as {
      hits: {
        project_id: string
        slug: string
        title: string
        description: string
        author: string
        downloads: number
        icon_url?: string
      }[]
      total_hits: number
    }
    return {
      totalHits: data.total_hits,
      hits: data.hits.map((h) => ({
        source: 'modrinth' as const,
        projectId: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        author: h.author,
        downloads: h.downloads,
        iconUrl: h.icon_url,
        pageUrl: `https://modrinth.com/${MODRINTH_PROJECT_TYPES[projectType]}/${h.slug}`
      }))
    }
  }

  const params = new URLSearchParams({
    gameId: '432',
    classId: CF_CLASS_IDS[projectType],
    searchFilter: query.query,
    sortField: '2',
    sortOrder: 'desc',
    index: String(offset),
    pageSize: String(limit)
  })
  if (query.mcVersion) params.set('gameVersion', query.mcVersion)
  if (projectType === 'mod' && query.loader && query.loader !== 'vanilla') {
    params.set('modLoaderType', String(CF_LOADER_TYPES[query.loader]))
  }
  const data = (await curseforgeFetch(`/mods/search?${params}`)) as {
    data: {
      id: number
      slug: string
      name: string
      summary: string
      downloadCount: number
      authors: { name: string }[]
      logo?: { thumbnailUrl?: string }
      links?: { websiteUrl?: string }
    }[]
    pagination: { totalCount: number }
  }
  return {
    totalHits: data.pagination.totalCount,
    hits: data.data.map((m) => ({
      source: 'curseforge' as const,
      projectId: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary,
      author: m.authors[0]?.name ?? '',
      downloads: m.downloadCount,
      iconUrl: m.logo?.thumbnailUrl,
      pageUrl: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
    })) satisfies ModSearchHit[]
  }
}

// ---------- version resolution ----------

interface ResolvedModFile {
  fileName: string
  downloadUrl: string
  versionId: string
  versionNumber: string
  sha1?: string
  sha512?: string
  fileSize: number
  /** required dependency project ids */
  requiredProjects: string[]
  title: string
  iconUrl?: string
}

interface ModrinthVersion {
  id: string
  project_id: string
  version_number: string
  files: {
    url: string
    filename: string
    primary: boolean
    size: number
    hashes: { sha1?: string; sha512?: string }
  }[]
  dependencies: { project_id?: string; dependency_type: string }[]
}

async function resolveModrinth(
  projectId: string,
  instance: Instance,
  versionId?: string,
  constrainLoader = true
): Promise<ResolvedModFile> {
  let version: ModrinthVersion
  if (versionId) {
    version = (await modrinthFetch(`/version/${versionId}`)) as ModrinthVersion
  } else {
    const params = new URLSearchParams({
      game_versions: JSON.stringify([instance.minecraftVersion])
    })
    if (constrainLoader && instance.loader !== 'vanilla') params.set('loaders', JSON.stringify([instance.loader]))
    const versions = (await modrinthFetch(`/project/${projectId}/version?${params}`)) as ModrinthVersion[]
    if (versions.length === 0) {
      throw new Error(`No compatible version found for ${instance.minecraftVersion} (${instance.loader})`)
    }
    version = versions[0]
  }
  const project = (await modrinthFetch(`/project/${projectId}`)) as {
    title: string
    icon_url?: string
  }
  const file = version.files.find((f) => f.primary) ?? version.files[0]
  return {
    fileName: file.filename,
    downloadUrl: file.url,
    versionId: version.id,
    versionNumber: version.version_number,
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    fileSize: file.size,
    requiredProjects: version.dependencies
      .filter((d) => d.dependency_type === 'required' && d.project_id)
      .map((d) => d.project_id!),
    title: project.title,
    iconUrl: project.icon_url
  }
}

interface CurseforgeFile {
  id: number
  fileName: string
  downloadUrl: string | null
  fileLength: number
  displayName: string
  hashes: { value: string; algo: number }[]
  dependencies: { modId: number; relationType: number }[]
}

async function resolveCurseforge(
  projectId: string,
  instance: Instance,
  versionId?: string,
  constrainLoader = true
): Promise<ResolvedModFile> {
  let file: CurseforgeFile
  if (versionId) {
    const data = (await curseforgeFetch(`/mods/${projectId}/files/${versionId}`)) as { data: CurseforgeFile }
    file = data.data
  } else {
    const params = new URLSearchParams({ gameVersion: instance.minecraftVersion, pageSize: '1' })
    if (constrainLoader && instance.loader !== 'vanilla') params.set('modLoaderType', String(CF_LOADER_TYPES[instance.loader]))
    const data = (await curseforgeFetch(`/mods/${projectId}/files?${params}`)) as { data: CurseforgeFile[] }
    if (data.data.length === 0) {
      throw new Error(`No compatible file found for ${instance.minecraftVersion} (${instance.loader})`)
    }
    file = data.data[0]
  }
  if (!file.downloadUrl) {
    throw new Error(
      'This mod cannot be downloaded through the API (its author disabled third-party downloads). Download it manually and drop it in the mods folder.'
    )
  }
  const modData = (await curseforgeFetch(`/mods/${projectId}`)) as {
    data: { name: string; logo?: { thumbnailUrl?: string } }
  }
  return {
    fileName: file.fileName,
    downloadUrl: file.downloadUrl,
    versionId: String(file.id),
    versionNumber: file.displayName,
    sha1: file.hashes.find((h) => h.algo === 1)?.value,
    fileSize: file.fileLength,
    requiredProjects: file.dependencies.filter((d) => d.relationType === 3).map((d) => String(d.modId)),
    title: modData.data.name,
    iconUrl: modData.data.logo?.thumbnailUrl
  }
}

// ---------- install / manage ----------

export async function downloadToFile(
  url: string,
  dest: string,
  onBytes?: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const body = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  if (onBytes) {
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      onBytes(received, total)
    })
  }
  await pipeline(body, createWriteStream(dest))
}

export async function installMod(req: ModInstallRequest, depth = 0): Promise<void> {
  if (depth > 5) return
  const instance = getInstance(req.instanceId)
  const meta = readModsMeta(req.instanceId)

  // skip if this project is already installed (unless a specific version was requested)
  if (!req.versionId && Object.values(meta).some((m) => m.source === req.source && m.projectId === req.projectId)) {
    return
  }

  const resolved =
    req.source === 'modrinth'
      ? await resolveModrinth(req.projectId, instance, req.versionId)
      : await resolveCurseforge(req.projectId, instance, req.versionId)

  const dir = modsDir(req.instanceId)
  mkdirSync(dir, { recursive: true })
  await downloadToFile(resolved.downloadUrl, join(dir, resolved.fileName))

  const freshMeta = readModsMeta(req.instanceId)
  freshMeta[resolved.fileName] = {
    source: req.source,
    projectId: req.projectId,
    versionId: resolved.versionId,
    versionNumber: resolved.versionNumber,
    title: resolved.title,
    iconUrl: resolved.iconUrl,
    downloadUrl: resolved.downloadUrl,
    sha1: resolved.sha1,
    sha512: resolved.sha512,
    fileSize: resolved.fileSize
  }
  writeModsMeta(req.instanceId, freshMeta)

  for (const dep of resolved.requiredProjects) {
    try {
      await installMod({ instanceId: req.instanceId, source: req.source, projectId: dep }, depth + 1)
    } catch (e) {
      // A missing optional-platform dependency shouldn't fail the whole install
      console.warn(`Failed to install dependency ${dep}:`, e)
    }
  }
}

export function listInstalledMods(instanceId: string): InstalledMod[] {
  const dir = modsDir(instanceId)
  if (!existsSync(dir)) return []
  const meta = readModsMeta(instanceId)
  const mods: InstalledMod[] = []
  for (const file of readdirSync(dir)) {
    const enabled = file.endsWith('.jar')
    if (!enabled && !file.endsWith('.jar.disabled')) continue
    const displayName = enabled ? file : file.slice(0, -'.disabled'.length)
    const record = meta[displayName]
    mods.push({
      fileName: file,
      displayName,
      enabled,
      sizeBytes: statSync(join(dir, file)).size,
      source: record?.source,
      projectId: record?.projectId,
      versionId: record?.versionId,
      versionNumber: record?.versionNumber,
      title: record?.title,
      iconUrl: record?.iconUrl
    })
  }
  return mods.sort((a, b) => (a.title ?? a.displayName).localeCompare(b.title ?? b.displayName))
}

/** Rename/delete errors on Windows usually mean the JVM still has the jar locked. */
function friendlyFsError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error('The mod file is locked — this usually means the game is still running. Close it and try again.')
  }
  return e instanceof Error ? e : new Error(String(e))
}

export function toggleMod(instanceId: string, fileName: string): InstalledMod[] {
  const dir = modsDir(instanceId)
  const from = join(dir, fileName)
  const to = fileName.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : `${from}.disabled`
  if (existsSync(to)) {
    throw new Error(`Both "${basename(from)}" and "${basename(to)}" exist in the mods folder — remove one of them first.`)
  }
  try {
    renameSync(from, to)
  } catch (e) {
    throw friendlyFsError(e)
  }
  return listInstalledMods(instanceId)
}

export function removeMod(instanceId: string, fileName: string): InstalledMod[] {
  try {
    rmSync(join(modsDir(instanceId), fileName), { force: true })
  } catch (e) {
    throw friendlyFsError(e)
  }
  const displayName = fileName.endsWith('.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName
  const meta = readModsMeta(instanceId)
  if (meta[displayName]) {
    delete meta[displayName]
    writeModsMeta(instanceId, meta)
  }
  return listInstalledMods(instanceId)
}

// ---------- jar metadata parsing ----------

/**
 * Mods added outside the launcher (manual drops, migrated instances) have no
 * Modrinth/CurseForge metadata, so their rows show a bare file name and no
 * icon. Every mod jar carries its own metadata though — fabric.mod.json,
 * quilt.mod.json, META-INF/(neoforge.)mods.toml, or legacy mcmod.info —
 * including an icon path inside the jar. Parse it once and cache by file
 * size+mtime, and the Mods tab gets real names, versions and icons for
 * everything.
 */

interface JarCacheEntry extends JarModInfo {
  sizeBytes: number
  mtimeMs: number
  /** sha1 of the jar file, computed once for Modrinth identification */
  sha1?: string
  /** set once Modrinth has been asked about this exact file (match or miss) */
  modrinthChecked?: boolean
}

type JarInfoCache = Record<string, JarCacheEntry>

function jarInfoCacheFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'elauncher-jarinfo.json')
}

/** Strip Minecraft § formatting codes that some legacy mods embed in their names. */
function cleanName(name: unknown): string | undefined {
  return typeof name === 'string' && name.trim() ? name.replace(/§./g, '').trim() : undefined
}

function parseJarMeta(jarPath: string): JarModInfo {
  const info: JarModInfo = {}
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch {
    return info
  }

  const readText = (name: string): string | undefined => {
    try {
      const entry = zip.getEntry(name)
      if (!entry) return undefined
      const text = zip.readAsText(entry)
      // strip a UTF-8 BOM if present (some mods save their json with one)
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      return undefined
    }
  }

  const readIconDataUrl = (path: unknown): string | undefined => {
    if (typeof path !== 'string' || !path) return undefined
    try {
      const entry = zip.getEntry(path.replace(/^\//, ''))
      if (!entry) return undefined
      const data = entry.getData()
      // skip empty or absurdly large logos (some mods ship multi-MB banners)
      if (data.length === 0 || data.length > 512 * 1024) return undefined
      return `data:image/png;base64,${data.toString('base64')}`
    } catch {
      return undefined
    }
  }

  // Fabric
  const fabric = readText('fabric.mod.json')
  if (fabric) {
    try {
      const meta = JSON.parse(fabric) as { name?: unknown; version?: unknown; icon?: unknown }
      info.name = cleanName(meta.name)
      if (typeof meta.version === 'string') info.version = meta.version
      // icon is a path, or a { "<size>": path } map — take the largest size
      const icon =
        typeof meta.icon === 'string'
          ? meta.icon
          : meta.icon && typeof meta.icon === 'object'
            ? Object.entries(meta.icon as Record<string, string>).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1]
            : undefined
      info.iconDataUrl = readIconDataUrl(icon)
    } catch {
      // malformed fabric.mod.json — fall through to the other formats
    }
    if (info.name || info.iconDataUrl) return info
  }

  // Quilt
  const quilt = readText('quilt.mod.json')
  if (quilt) {
    try {
      const meta = JSON.parse(quilt) as {
        quilt_loader?: { version?: unknown; metadata?: { name?: unknown; icon?: unknown } }
      }
      info.name = cleanName(meta.quilt_loader?.metadata?.name)
      if (typeof meta.quilt_loader?.version === 'string') info.version = meta.quilt_loader.version
      info.iconDataUrl = readIconDataUrl(meta.quilt_loader?.metadata?.icon)
    } catch {
      // ignore
    }
    if (info.name || info.iconDataUrl) return info
  }

  // Forge / NeoForge
  const toml = readText('META-INF/neoforge.mods.toml') ?? readText('META-INF/mods.toml')
  if (toml) {
    // quote styles matched separately so values like "Alex's Mobs" survive intact
    const pick = (key: string): string | undefined => {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm').exec(toml)
      const value = m?.[1] ?? m?.[2]
      return value?.trim() ? value : undefined
    }
    info.name = cleanName(pick('displayName'))
    info.iconDataUrl = readIconDataUrl(pick('logoFile'))
    let version = pick('version')
    // "${file.jarVersion}" placeholders resolve from the jar manifest
    if (version?.includes('${')) {
      version = /^Implementation-Version:\s*(.+)$/m.exec(readText('META-INF/MANIFEST.MF') ?? '')?.[1]?.trim()
    }
    info.version = version
    if (info.name || info.iconDataUrl) return info
  }

  // Legacy Forge (1.12 and older)
  const legacy = readText('mcmod.info')
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as unknown
      const first = Array.isArray(parsed)
        ? (parsed[0] as Record<string, unknown> | undefined)
        : (parsed as { modList?: Record<string, unknown>[] })?.modList?.[0]
      if (first) {
        info.name = cleanName(first.name)
        if (typeof first.version === 'string') info.version = first.version
        info.iconDataUrl = readIconDataUrl(first.logoFile)
      }
    } catch {
      // mcmod.info is frequently malformed json; ignore
    }
  }
  return info
}

/**
 * name/version/icon for installed mods, parsed from the jars and cached per
 * instance (validated by file size+mtime, which survive enable/disable
 * renames). Mods installed through the launcher already carry API metadata
 * and are skipped. Parsing yields to the event loop between jars so a
 * 300-mod pack never freezes the app.
 */
export async function getJarInfoMap(instanceId: string): Promise<Record<string, JarModInfo>> {
  const cache = readJson<JarInfoCache>(jarInfoCacheFile(instanceId), {})
  const result: Record<string, JarModInfo> = {}
  const dir = modsDir(instanceId)
  let dirty = false
  for (const mod of listInstalledMods(instanceId)) {
    if (mod.iconUrl && mod.title) continue // launcher-installed: already has API metadata
    let size = 0
    let mtimeMs = 0
    try {
      const stat = statSync(join(dir, mod.fileName))
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      continue
    }
    const cached = cache[mod.displayName]
    if (cached && cached.sizeBytes === size && cached.mtimeMs === mtimeMs) {
      result[mod.displayName] = { name: cached.name, version: cached.version, iconDataUrl: cached.iconDataUrl }
      continue
    }
    // keep the main process responsive between zip reads
    await new Promise((resolve) => setImmediate(resolve))
    const info = parseJarMeta(join(dir, mod.fileName))
    cache[mod.displayName] = { ...info, sizeBytes: size, mtimeMs }
    result[mod.displayName] = info
    dirty = true
  }
  if (dirty) writeJson(jarInfoCacheFile(instanceId), cache)
  return result
}

// ---------- Modrinth hash identification ----------

function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/**
 * Identify mods that carry no launcher metadata by asking Modrinth about
 * their file hashes (one bulk request). Matches are adopted into
 * elauncher-mods.json exactly as if they'd been installed through the
 * launcher — real title and icon, plus update checking, from then on.
 * Hashes and match/miss results are cached, so this is a one-time cost per
 * file; offline failures leave everything unchecked to retry next time.
 */
export async function identifyMods(instanceId: string): Promise<IdentifyResult> {
  const dir = modsDir(instanceId)
  const cache = readJson<JarInfoCache>(jarInfoCacheFile(instanceId), {})
  let cacheDirty = false
  const pending: { displayName: string; sha1: string }[] = []

  for (const mod of listInstalledMods(instanceId)) {
    if (mod.projectId) continue // installed through the launcher, or already identified
    const path = join(dir, mod.fileName)
    let size = 0
    let mtimeMs = 0
    try {
      const stat = statSync(path)
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      continue
    }
    let entry = cache[mod.displayName]
    if (!entry || entry.sizeBytes !== size || entry.mtimeMs !== mtimeMs) {
      entry = { ...parseJarMeta(path), sizeBytes: size, mtimeMs }
      cache[mod.displayName] = entry
      cacheDirty = true
    }
    if (entry.modrinthChecked) continue
    if (!entry.sha1) {
      try {
        entry.sha1 = await sha1File(path)
        cacheDirty = true
      } catch {
        continue
      }
    }
    pending.push({ displayName: mod.displayName, sha1: entry.sha1 })
  }

  let identified = 0
  if (pending.length > 0) {
    try {
      const byHash = (await modrinthPost('/version_files', {
        hashes: pending.map((p) => p.sha1),
        algorithm: 'sha1'
      })) as Record<string, ModrinthVersion>
      const projectIds = [...new Set(Object.values(byHash).map((v) => v.project_id))]
      const projects = projectIds.length
        ? ((await modrinthFetch(`/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`)) as {
            id: string
            title: string
            icon_url?: string
          }[])
        : []
      const projectById = new Map(projects.map((p) => [p.id, p]))
      const meta = readModsMeta(instanceId)
      for (const p of pending) {
        const version = byHash[p.sha1]
        const file =
          version &&
          (version.files.find((f) => f.hashes.sha1 === p.sha1) ??
            version.files.find((f) => f.primary) ??
            version.files[0])
        if (version && file) {
          const project = projectById.get(version.project_id)
          meta[p.displayName] = {
            source: 'modrinth',
            projectId: version.project_id,
            versionId: version.id,
            versionNumber: version.version_number,
            title: project?.title ?? p.displayName,
            iconUrl: project?.icon_url,
            downloadUrl: file.url,
            sha1: file.hashes.sha1,
            sha512: file.hashes.sha512,
            fileSize: file.size
          }
          identified++
        }
        const entry = cache[p.displayName]
        if (entry) entry.modrinthChecked = true
        cacheDirty = true
      }
      if (identified > 0) writeModsMeta(instanceId, meta)
    } catch {
      // offline or Modrinth down — leave everything unchecked so a later visit retries
    }
  }

  if (cacheDirty) writeJson(jarInfoCacheFile(instanceId), cache)
  return { identified, mods: listInstalledMods(instanceId) }
}

export async function checkModUpdates(instanceId: string): Promise<ModUpdateInfo[]> {
  const instance = getInstance(instanceId)
  const installed = listInstalledMods(instanceId).filter((m) => m.projectId && m.versionId)
  const hasCfKey = Boolean(getSettings().curseforgeApiKey)
  const updates: ModUpdateInfo[] = []
  for (const mod of installed) {
    if (mod.source === 'curseforge' && !hasCfKey) continue
    try {
      const resolved =
        mod.source === 'modrinth'
          ? await resolveModrinth(mod.projectId!, instance)
          : await resolveCurseforge(mod.projectId!, instance)
      if (resolved.versionId !== mod.versionId) {
        updates.push({
          fileName: mod.fileName,
          projectId: mod.projectId!,
          source: mod.source!,
          currentVersionId: mod.versionId!,
          newVersionId: resolved.versionId,
          newVersionNumber: resolved.versionNumber
        })
      }
    } catch {
      // project removed or no compatible version anymore; skip
    }
  }
  return updates
}

export async function applyModUpdate(instanceId: string, update: ModUpdateInfo): Promise<void> {
  removeMod(instanceId, update.fileName)
  await installMod({
    instanceId,
    source: update.source,
    projectId: update.projectId,
    versionId: update.newVersionId
  })
}

// ---------- shader packs & resource packs ----------

interface PackRecord {
  source: ModSource
  projectId: string
  versionNumber: string
  title: string
  iconUrl?: string
}

/** kind -> fileName -> record */
type PacksMeta = Partial<Record<ContentKind, Record<string, PackRecord>>>

function packsDir(instanceId: string, kind: ContentKind): string {
  return join(instanceDir(instanceId), kind === 'shader' ? 'shaderpacks' : 'resourcepacks')
}

function packsMetaFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'elauncher-packs.json')
}

function readPacksMeta(instanceId: string): PacksMeta {
  return readJson<PacksMeta>(packsMetaFile(instanceId), {})
}

function writePacksMeta(instanceId: string, meta: PacksMeta): void {
  writeJson(packsMetaFile(instanceId), meta)
}

export async function installPack(req: ModInstallRequest, kind: ContentKind): Promise<void> {
  const instance = getInstance(req.instanceId)
  const meta = readPacksMeta(req.instanceId)
  const kindMeta = meta[kind] ?? {}

  if (!req.versionId && Object.values(kindMeta).some((m) => m.source === req.source && m.projectId === req.projectId)) {
    return
  }

  const resolved =
    req.source === 'modrinth'
      ? await resolveModrinth(req.projectId, instance, req.versionId, false)
      : await resolveCurseforge(req.projectId, instance, req.versionId, false)

  const dir = packsDir(req.instanceId, kind)
  mkdirSync(dir, { recursive: true })
  await downloadToFile(resolved.downloadUrl, join(dir, resolved.fileName))

  const freshMeta = readPacksMeta(req.instanceId)
  freshMeta[kind] = {
    ...(freshMeta[kind] ?? {}),
    [resolved.fileName]: {
      source: req.source,
      projectId: req.projectId,
      versionNumber: resolved.versionNumber,
      title: resolved.title,
      iconUrl: resolved.iconUrl
    }
  }
  writePacksMeta(req.instanceId, freshMeta)
}

export function listPacks(instanceId: string, kind: ContentKind): InstalledPack[] {
  const dir = packsDir(instanceId, kind)
  if (!existsSync(dir)) return []
  const meta = readPacksMeta(instanceId)[kind] ?? {}
  const packs: InstalledPack[] = []
  for (const file of readdirSync(dir)) {
    const path = join(dir, file)
    const stat = statSync(path)
    // resource packs may be folders; shader packs are zips
    const enabled = !file.endsWith('.disabled')
    if (!stat.isDirectory() && !/\.zip(\.disabled)?$/i.test(file)) continue
    const displayName = enabled ? file : file.slice(0, -'.disabled'.length)
    const record = meta[displayName]
    packs.push({
      fileName: file,
      displayName,
      enabled,
      sizeBytes: stat.isDirectory() ? 0 : stat.size,
      title: record?.title,
      iconUrl: record?.iconUrl,
      source: record?.source,
      projectId: record?.projectId,
      versionNumber: record?.versionNumber
    })
  }
  return packs.sort((a, b) => (a.title ?? a.displayName).localeCompare(b.title ?? b.displayName))
}

export function togglePack(instanceId: string, kind: ContentKind, fileName: string): InstalledPack[] {
  const dir = packsDir(instanceId, kind)
  const from = join(dir, fileName)
  const to = fileName.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : `${from}.disabled`
  renameSync(from, to)
  return listPacks(instanceId, kind)
}

export function removePack(instanceId: string, kind: ContentKind, fileName: string): InstalledPack[] {
  rmSync(join(packsDir(instanceId, kind), fileName), { recursive: true, force: true })
  const displayName = fileName.endsWith('.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName
  const meta = readPacksMeta(instanceId)
  if (meta[kind]?.[displayName]) {
    delete meta[kind]![displayName]
    writePacksMeta(instanceId, meta)
  }
  return listPacks(instanceId, kind)
}
