import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { cp } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { cpus, tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { app, dialog, shell } from 'electron'
import AdmZip from 'adm-zip'
import { fetchJavaRuntimeManifest, installJavaRuntimeTask } from '@xmcl/installer'
import type {
  CreateServerOptions,
  LocalServer,
  LocalServerState,
  PalworldModerationAction,
  PalworldPlayerDetail,
  PlanLimits,
  PlayerListEntry,
  ServerAutomation,
  ServerFileEntry,
  ServerGame,
  ServerLogEvent,
  ServerMod,
  ServerSource,
  ServerStateEvent,
  ServerTaskEvent
} from '@shared/types'
import { archivedServersFile, instanceDir, javaDir, serverArchivesDir, serverDir, serversFile } from '../paths'
import { readJson, writeJson } from '../store'
import { killProcessTree } from './proctree'
import { downloadAgent, withRetries } from '../net'
import { downloadToFile, listInstalledMods, modrinthFetch, readModsMeta } from './mods'
import {
  curseforgeFilesBulk,
  downloadPackToTemp,
  downloadWithRetries,
  forgeCdnUrl,
  lookupModrinthByHash,
  parseCfLoader,
  parseDependencies,
  parseIndex,
  resolveCurseforgeModpackUrl,
  resolveModrinthModpackUrl,
  type CfManifest,
  type MrpackFile
} from './packs'
import { downloadCloudPackToTemp } from './cloud'
import { getInstance } from './instances'
import { getLoaderVersions } from './versions'
import { searchSkin } from './skins'
import { broadcast } from './game'
import { headlessLog, LOG_CONSOLE } from './headless'
import { getShareInfo, getTunnelAddress, onTunnelClosed, stopTunnel } from './hosting'
import {
  PALWORLD_BASE_PORT,
  PALWORLD_PORT_STEP,
  getPalworldPlayers,
  getPalworldSettings,
  installPalworld,
  moderatePalworld,
  sendPalworldCommand,
  setPalworldSettings,
  startPalworld,
  type PalworldHandle
} from './palworld'
import {
  getSteamGameSettings,
  installSteamGame,
  isSteamGame,
  setSteamGameSettings,
  startSteamGame,
  STEAM_GAMES,
  type SteamGameHandle
} from './steamgames'
import { closePort, getMapping } from './upnp'
import { getAssignedHost, releaseHost } from './hostNames'
import { getSettings } from './settings'
import { notifyPhones, setNotificationLogSink } from './notifications'

// notification problems (missing tables, no phones enrolled) print into the server console
setNotificationLogSink((serverId, line) => pushLog(serverId, line))

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** PaperMC "Fill" API — the old api.papermc.io/v2 endpoint was retired (410). */
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'
const UA = 'ELauncher/0.1.0 (custom launcher)'
const MAX_LOG_LINES = 1000
const BASE_PORT = 25565

// ---------- records ----------

function loadServers(): LocalServer[] {
  return readJson<LocalServer[]>(serversFile, [])
}

function saveServers(servers: LocalServer[]): void {
  writeJson(serversFile, servers)
}

export function listLocalServers(): LocalServer[] {
  return loadServers().sort((a, b) => b.createdAt - a.createdAt)
}

function getServer(id: string): LocalServer {
  const server = loadServers().find((s) => s.id === id)
  if (!server) throw new Error('Server not found')
  return server
}

/** Which game a record runs (records predate the field, so undefined = minecraft). */
function gameOf(server: LocalServer): ServerGame {
  return server.game ?? 'minecraft'
}

/**
 * Public address for a server: router mapping first (stable, direct), bore
 * tunnel as the minecraft fallback. Mapped addresses show the server's own
 * pool hostname when one is assigned, then the global custom host, then the
 * raw external IP. Tunnel addresses are always the relay's real host.
 */
function publicAddress(server: LocalServer): string | null {
  const mapping = getMapping(server.port, gameOf(server) === 'minecraft' ? 'TCP' : 'UDP')
  if (mapping) {
    const host = getAssignedHost(server.id) ?? getSettings().publicHost ?? mapping.externalIp
    return `${host}:${mapping.port}`
  }
  // direct-public-IP host (a VPS): the port is reachable at the public host with no
  // NAT mapping to traverse — publish the assigned/configured host directly
  const directHost = getAssignedHost(server.id) ?? getSettings().publicHost
  if (directHost) return `${directHost}:${server.port}`
  // only minecraft's TCP traffic can ride the relay tunnel
  return gameOf(server) === 'minecraft' ? getTunnelAddress(server.port) : null
}

/** Public join address for a server, if it's currently exposed. */
export function getServerPublicAddress(id: string): string | null {
  const server = loadServers().find((s) => s.id === id)
  return server ? publicAddress(server) : null
}

// ---------- runtime state ----------

const procs = new Map<string, ChildProcess>()
const states = new Map<string, LocalServerState>()
const players = new Map<string, Set<string>>()
const logs = new Map<string, string[]>()

/** Buffered log broadcast so a chatty server doesn't flood IPC (same pattern as game.ts). */
const pendingLogs = new Map<string, string[]>()
let logFlushTimer: NodeJS.Timeout | null = null

/** Server display name for journal lines, cached — pushLog can run hundreds of times a second. */
const logNames = new Map<string, string>()
function logName(id: string): string {
  let name = logNames.get(id)
  if (!name) {
    name = loadServers().find((s) => s.id === id)?.name ?? id.slice(0, 8)
    logNames.set(id, name)
  }
  return name
}

function pushLog(id: string, line: string): void {
  if (LOG_CONSOLE) console.log(`[${logName(id)}] ${line}`)
  const buffer = logs.get(id) ?? []
  buffer.push(line)
  if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES)
  logs.set(id, buffer)

  const pending = pendingLogs.get(id) ?? []
  pending.push(line)
  pendingLogs.set(id, pending)
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null
      for (const [serverId, lines] of pendingLogs) {
        broadcast('server:log', { serverId, line: lines.join('\n') } satisfies ServerLogEvent)
      }
      pendingLogs.clear()
    }, 250)
  }
}

function emitTask(phase: string, progress: number, done?: boolean): void {
  broadcast('server:task', { phase, progress, done } satisfies ServerTaskEvent)
}

/** Live per-run info: sampled process stats + the version the server reported. */
const resourceStats = new Map<string, { memoryMB: number; cpuPercent: number | null }>()
const serverVersions = new Map<string, string>()

function setState(id: string, state: LocalServerState, error?: string): void {
  const prev = states.get(id)
  states.set(id, state)
  const server = loadServers().find((s) => s.id === id)
  // journal the lifecycle on headless hosts — but only real transitions
  // (joins/tunnel changes re-announce the same state and would spam)
  if (prev !== state) {
    const address = server ? publicAddress(server) : null
    headlessLog(
      `[${server?.name ?? id}] ${state}` +
        (state === 'running' && address ? ` — join at ${address}` : '') +
        (error ? ` — ${error}` : '')
    )
  }
  broadcast('server:state', {
    serverId: id,
    state,
    players: [...(players.get(id) ?? [])],
    tunnelAddress: server ? publicAddress(server) : null,
    memoryMB: resourceStats.get(id)?.memoryMB ?? null,
    cpuPercent: resourceStats.get(id)?.cpuPercent ?? null,
    startedAt: procs.has(id) ? (lastStartAt.get(id) ?? null) : null,
    version: serverVersions.get(id) ?? null,
    health: healthOf(id),
    error
  } satisfies ServerStateEvent)
}

/** Re-broadcast the state of the server on `port` so the UI picks up tunnel changes. */
export function announceServerByPort(port: number): void {
  const record = loadServers().find((s) => s.port === port)
  if (record) setState(record.id, states.get(record.id) ?? 'stopped')
}

// keep the visible address in sync when a tunnel stops or the relay drops it
onTunnelClosed((port) => announceServerByPort(port))

export interface ServerStateSnapshot {
  state: LocalServerState
  players: string[]
  tunnelAddress: string | null
  memoryMB: number | null
  cpuPercent: number | null
  startedAt: number | null
  version: string | null
  health: 'smooth' | 'fair' | 'poor' | null
}

export function getServerStates(): Record<string, ServerStateSnapshot> {
  const out: Record<string, ServerStateSnapshot> = {}
  for (const server of loadServers()) {
    out[server.id] = {
      state: states.get(server.id) ?? 'stopped',
      players: [...(players.get(server.id) ?? [])],
      tunnelAddress: publicAddress(server),
      memoryMB: resourceStats.get(server.id)?.memoryMB ?? null,
      cpuPercent: resourceStats.get(server.id)?.cpuPercent ?? null,
      startedAt: procs.has(server.id) ? (lastStartAt.get(server.id) ?? null) : null,
      version: serverVersions.get(server.id) ?? null,
      health: healthOf(server.id)
    }
  }
  return out
}

export function getServerLogs(id: string): string[] {
  return logs.get(id) ?? []
}

// ---------- creation: resolve + download the server jar ----------

interface MojangVersionJson {
  downloads?: { server?: { url: string } }
  javaVersion?: { component?: string }
}

/** Mojang manifest lookup: server jar url (when one exists) + required java runtime. */
async function mojangServerMeta(version: string): Promise<{ url?: string; javaComponent: string }> {
  const manifest = (await (await fetch(MANIFEST_URL)).json()) as {
    versions: { id: string; url: string }[]
  }
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) throw new Error(`Unknown Minecraft version: ${version}`)
  const json = (await (await fetch(entry.url)).json()) as MojangVersionJson
  return { url: json.downloads?.server?.url, javaComponent: json.javaVersion?.component ?? 'jre-legacy' }
}

/** PaperMC Fill API lookup: the latest build's jar for a version. */
async function resolvePaper(version: string): Promise<string> {
  const res = await fetch(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds/latest`, {
    headers: { 'User-Agent': UA }
  })
  if (res.status === 404) throw new Error(`Paper has no builds for Minecraft ${version} yet (try vanilla).`)
  if (!res.ok) throw new Error(`PaperMC API error ${res.status}`)
  const build = (await res.json()) as { downloads?: Record<string, { url?: string }> }
  const url = build.downloads?.['server:default']?.url
  if (!url) throw new Error(`Paper has no downloadable build for ${version}.`)
  return url
}

const FABRIC_META = 'https://meta.fabricmc.net/v2'

/** Fabric's meta service serves a ready-to-run server launcher jar — no installer step. */
async function fabricServerJarUrl(mc: string, loaderVersion: string): Promise<string> {
  const res = await fetch(`${FABRIC_META}/versions/installer`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Fabric meta error ${res.status}`)
  const installers = (await res.json()) as { version: string; stable: boolean }[]
  const installer = installers.find((i) => i.stable) ?? installers[0]
  if (!installer) throw new Error('Fabric has no installer versions.')
  return `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`
}

function installerUrl(kind: 'forge' | 'neoforge', mc: string, loaderVersion: string): string {
  if (kind === 'neoforge') {
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
  }
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${loaderVersion}/forge-${mc}-${loaderVersion}-installer.jar`
}

/**
 * The newest loader version whose installer is actually published. NeoForge/Forge
 * occasionally list a version in maven metadata with no working installer.jar
 * (a broken/incomplete release), so verify and step back to the newest that 404s.
 * Fabric has no installer step — its newest is always fine.
 */
async function pickInstallableLoaderVersion(
  kind: 'fabric' | 'neoforge' | 'forge',
  mc: string,
  versions: string[]
): Promise<string> {
  if (kind === 'fabric') return versions[0]
  for (const version of versions.slice(0, 8)) {
    try {
      const res = await fetch(installerUrl(kind, mc, version), { method: 'HEAD' })
      // only a definitive 404 disqualifies a version; anything else, assume it's fine
      if (res.status !== 404) return version
    } catch {
      // network hiccup — try the next candidate
    }
  }
  return versions[0] // nothing verified; let the download surface a clear error
}

/** Run the Forge/NeoForge installer's --installServer step (downloads the server libraries). */
function runInstaller(dir: string, installerName: string, java: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(java, ['-jar', installerName, '--installServer'], { cwd: dir, windowsHide: true })
    let lastLine = ''
    const timer = setTimeout(() => {
      proc.kill()
      rejectPromise(new Error('The server installer timed out (10 minutes). Check your connection and try again.'))
    }, 10 * 60_000)
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) lastLine = line.trim().slice(0, 120)
      }
      emitTask(`Installing server — ${lastLine}`, -1)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => {
      clearTimeout(timer)
      rejectPromise(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`Server installer failed (exit ${code})${lastLine ? `: ${lastLine}` : ''}`))
    })
  })
}

/** Modern Forge/NeoForge servers launch via a generated JVM @args file instead of a jar. */
function findArgsFile(dir: string): string | null {
  const argName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt'
  for (const vendor of [join('net', 'neoforged', 'neoforge'), join('net', 'minecraftforge', 'forge')]) {
    const base = join(dir, 'libraries', vendor)
    if (!existsSync(base)) continue
    for (const version of readdirSync(base)) {
      const file = join(base, version, argName)
      if (existsSync(file)) return relative(dir, file).replace(/\\/g, '/')
    }
  }
  return null
}

/** Ports a server occupies: its game port plus per-game neighbors (palworld REST, sdtd telnet, valheim query). */
function claimedPorts(server: LocalServer): number[] {
  const game = gameOf(server)
  const span = game === 'palworld' ? 2 : isSteamGame(game) ? STEAM_GAMES[game].portStep : 1
  return Array.from({ length: span }, (_, i) => server.port + i)
}

/** First free port for a game, avoiding every port claimed by existing servers. */
function nextFreePort(servers: LocalServer[], game: ServerGame = 'minecraft'): number {
  const used = new Set<number>(servers.flatMap(claimedPorts))
  const [base, step] =
    game === 'palworld'
      ? [PALWORLD_BASE_PORT, PALWORLD_PORT_STEP]
      : isSteamGame(game)
        ? [STEAM_GAMES[game].basePort, STEAM_GAMES[game].portStep]
        : [BASE_PORT, 1]
  let port = base
  while (Array.from({ length: step }, (_, i) => port + i).some((p) => used.has(p))) port += step
  return port
}

/** What a new server will be, resolved from its source (fresh pick, modpack, or instance). */
interface CreationPlan {
  kind: LocalServer['kind']
  minecraftVersion: string
  loaderVersion?: string
  packName?: string
  /** modpack whose server-side content gets installed after the server binary */
  zip?: AdmZip
  /** CurseForge pack zip (manifest.json format) applied after the server binary */
  cfZip?: AdmZip
  /** instance whose mods/configs get mirrored onto the server */
  instanceId?: string
  /** temp .mrpack to delete afterwards (cloud downloads) */
  tempZipPath?: string
}

/** CF packs use manifest.json instead of the mrpack index; map it onto a plan. */
function planFromCfZip(zip: AdmZip): CreationPlan {
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('Not a CurseForge modpack: manifest.json is missing.')
  const manifest = JSON.parse(entry.getData().toString('utf-8')) as CfManifest
  if (!manifest.minecraft?.version) throw new Error('CurseForge modpack does not declare a Minecraft version.')
  const primary = manifest.minecraft.modLoaders?.find((l) => l.primary) ?? manifest.minecraft.modLoaders?.[0]
  const { loader, loaderVersion } = primary ? parseCfLoader(primary.id) : { loader: 'vanilla' as const, loaderVersion: undefined }
  return {
    kind: loader,
    minecraftVersion: manifest.minecraft.version,
    loaderVersion,
    packName: manifest.name || 'CurseForge pack',
    cfZip: zip
  }
}

function planFromZip(zip: AdmZip): CreationPlan {
  const index = parseIndex(zip)
  const { mcVersion, loader, loaderVersion } = parseDependencies(index)
  return { kind: loader, minecraftVersion: mcVersion, loaderVersion, packName: index.name, zip }
}

/** Resolves the source into a concrete plan. Returns null when the user cancels a file dialog. */
async function planFromSource(source: ServerSource): Promise<CreationPlan | null> {
  switch (source.type) {
    case 'fresh':
      return { kind: source.kind, minecraftVersion: source.minecraftVersion }
    case 'mrpack': {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a modpack to host',
        filters: [{ name: 'Modrinth modpack', extensions: ['mrpack', 'zip'] }],
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      return planFromZip(new AdmZip(picked.filePaths[0]))
    }
    case 'cloudPack': {
      emitTask('Downloading modpack from the cloud', -1)
      const tmp = await downloadCloudPackToTemp(source.packId, (phase, progress) => emitTask(phase, progress))
      const plan = planFromZip(new AdmZip(tmp))
      plan.tempZipPath = tmp
      return plan
    }
    case 'modrinthPack': {
      emitTask('Resolving modpack on Modrinth', -1)
      const url = await resolveModrinthModpackUrl(source.projectId)
      const tmp = await downloadPackToTemp(url, (phase, progress) => emitTask(phase, progress))
      const plan = planFromZip(new AdmZip(tmp))
      plan.tempZipPath = tmp
      return plan
    }
    case 'curseforgePack': {
      emitTask('Resolving modpack on CurseForge', -1)
      const url = await resolveCurseforgeModpackUrl(source.projectId)
      const tmp = join(tmpdir(), `elauncher-cfsrv-${randomUUID()}.zip`)
      emitTask('Downloading modpack file', -1)
      await downloadToFile(url, tmp, (received, total) => {
        if (total > 0) emitTask('Downloading modpack file', received / total)
      })
      const plan = planFromCfZip(new AdmZip(tmp))
      plan.tempZipPath = tmp
      return plan
    }
    case 'instance': {
      const inst = getInstance(source.instanceId)
      return {
        kind: inst.loader,
        minecraftVersion: inst.minecraftVersion,
        loaderVersion: inst.loaderVersion,
        packName: inst.name,
        instanceId: inst.id
      }
    }
    default:
      // source variants that exist in types but aren't implemented here yet (e.g. palworld)
      throw new Error('This server type is not supported yet.')
  }
}

/** Put the right server binary in place: a jar for vanilla/paper/fabric, an installer run for forge/neoforge. */
async function ensureServerBinary(
  dir: string,
  plan: CreationPlan,
  vanillaUrl: string | undefined,
  javaComponent: string
): Promise<void> {
  const withProgress = (phase: string) => (received: number, total: number) => {
    if (total > 0) emitTask(phase, received / total)
  }
  if (plan.kind === 'vanilla') {
    if (!vanillaUrl) throw new Error(`Minecraft ${plan.minecraftVersion} has no dedicated server download.`)
    emitTask('Downloading server jar', -1)
    await downloadToFile(vanillaUrl, join(dir, 'server.jar'), withProgress('Downloading server jar'))
  } else if (plan.kind === 'paper') {
    const url = await resolvePaper(plan.minecraftVersion)
    emitTask('Downloading Paper server', -1)
    await downloadToFile(url, join(dir, 'server.jar'), withProgress('Downloading Paper server'))
  } else if (plan.kind === 'fabric') {
    emitTask('Downloading Fabric server', -1)
    await downloadToFile(await fabricServerJarUrl(plan.minecraftVersion, plan.loaderVersion!), join(dir, 'server.jar'))
  } else {
    // forge / neoforge: download + run the official installer once
    const installerName = `${plan.kind}-installer.jar`
    emitTask(`Downloading ${plan.kind} installer`, -1)
    await downloadToFile(
      installerUrl(plan.kind, plan.minecraftVersion, plan.loaderVersion!),
      join(dir, installerName),
      withProgress(`Downloading ${plan.kind} installer`)
    )
    const java = await ensureServerJava(javaComponent)
    emitTask(`Installing ${plan.kind} server — this takes a few minutes`, -1)
    await runInstaller(dir, installerName, java)
    if (!findArgsFile(dir) && !existsSync(join(dir, 'server.jar'))) {
      throw new Error(
        `${plan.kind} installed but no launch files were found — Minecraft ${plan.minecraftVersion} may be too old (1.17+ supported).`
      )
    }
    rmSync(join(dir, installerName), { force: true })
    rmSync(join(dir, `${installerName}.log`), { force: true })
  }
}

/** Install a modpack's server-side files: skips client-only mods and client-only override folders. */
async function applyPackToServer(dir: string, zip: AdmZip): Promise<void> {
  const index = parseIndex(zip)
  const files = index.files.filter((f) => f.env?.server !== 'unsupported')
  const jobs = files.map((file) => {
    const dest = resolve(dir, file.path)
    if (!dest.startsWith(resolve(dir))) throw new Error(`Unsafe path in modpack: ${file.path}`)
    return { file, dest }
  })
  let done = 0
  const queue = [...jobs]
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      mkdirSync(dirname(job.dest), { recursive: true })
      await downloadWithRetries(job.file.downloads[0], job.dest, job.file.hashes.sha1)
      done++
      emitTask(`Downloading pack mods (${done}/${jobs.length})`, jobs.length ? done / jobs.length : -1)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, () => worker()))

  emitTask('Applying configs & overrides', -1)
  const clientOnlyDirs = ['resourcepacks/', 'shaderpacks/']
  for (const prefix of ['overrides/', 'server-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
      const rel = entry.entryName.slice(prefix.length)
      if (clientOnlyDirs.some((d) => rel.startsWith(d))) continue
      const dest = resolve(dir, rel)
      if (!dest.startsWith(resolve(dir))) continue
      mkdirSync(dirname(dest), { recursive: true })
      zip.extractEntryTo(entry, dirname(dest), false, true)
    }
  }
}

/**
 * Install a CurseForge pack's files onto the server: every manifest file is
 * resolved through the CF API (with the forgecdn fallback) into mods/, then the
 * overrides folder is applied minus client-only directories. CF manifests carry
 * no client/server flags, so a client-only mod may need removing via Files if
 * the console complains on first start.
 */
async function applyCfPackToServer(dir: string, zip: AdmZip): Promise<void> {
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('Not a CurseForge modpack: manifest.json is missing.')
  const manifest = JSON.parse(entry.getData().toString('utf-8')) as CfManifest

  emitTask('Resolving pack files on CurseForge', -1)
  const files = await curseforgeFilesBulk(manifest.files.map((f) => f.fileID))
  const modsDir = join(dir, 'mods')
  mkdirSync(modsDir, { recursive: true })

  let done = 0
  const skipped: string[] = []
  const queue = [...files]
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      try {
        await downloadWithRetries(file.downloadUrl ?? forgeCdnUrl(file.id, file.fileName), join(modsDir, file.fileName))
      } catch {
        skipped.push(file.fileName)
      }
      done++
      emitTask(`Downloading pack mods (${done}/${files.length})`, files.length ? done / files.length : -1)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, () => worker()))
  if (skipped.length > 0) {
    console.warn(`[server] CurseForge pack: ${skipped.length} file(s) could not be downloaded:`, skipped)
  }

  emitTask('Applying configs & overrides', -1)
  const clientOnlyDirs = ['resourcepacks/', 'shaderpacks/']
  const prefix = `${manifest.overrides || 'overrides'}/`
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue
    const rel = e.entryName.slice(prefix.length)
    if (clientOnlyDirs.some((d) => rel.startsWith(d))) continue
    const dest = resolve(dir, rel)
    if (!dest.startsWith(resolve(dir))) continue
    mkdirSync(dirname(dest), { recursive: true })
    zip.extractEntryTo(e, dirname(dest), false, true)
  }
}

/** Mirror an instance onto the server: its enabled mods (minus client-only ones) and configs. */
async function copyInstanceToServer(dir: string, instanceId: string): Promise<void> {
  const meta = readModsMeta(instanceId)
  const mods = listInstalledMods(instanceId).filter((m) => m.enabled)

  // client-only mods (Sodium & friends) crash dedicated servers — Modrinth knows which they are
  const ids = [
    ...new Set(
      mods
        .map((m) => meta[m.displayName])
        .filter((r) => r?.source === 'modrinth')
        .map((r) => r!.projectId)
    )
  ]
  const clientOnly = new Set<string>()
  if (ids.length > 0) {
    try {
      const projects = (await modrinthFetch(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)) as {
        id: string
        server_side: string
      }[]
      for (const p of projects) if (p.server_side === 'unsupported') clientOnly.add(p.id)
    } catch {
      // offline: copy everything; the console will show any offender
    }
  }

  const srcMods = join(instanceDir(instanceId), 'mods')
  const destMods = join(dir, 'mods')
  mkdirSync(destMods, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const mod of mods) {
    const record = meta[mod.displayName]
    if (record && clientOnly.has(record.projectId)) {
      skipped++
      continue
    }
    copyFileSync(join(srcMods, mod.fileName), join(destMods, mod.displayName))
    copied++
    emitTask(`Copying mods (${copied}${skipped ? ` · ${skipped} client-only skipped` : ''})`, -1)
  }
  const srcConfig = join(instanceDir(instanceId), 'config')
  if (existsSync(srcConfig)) {
    emitTask('Copying configs', -1)
    cpSync(srcConfig, join(dir, 'config'), { recursive: true })
  }
}

const LOADER_KINDS = new Set(['fabric', 'neoforge', 'forge'])

export async function createServer(opts: CreateServerOptions): Promise<LocalServer | null> {
  if (opts.source.type === 'palworld') return createPalworldServer(opts, opts.source)
  if (opts.source.type === 'steamgame') return createSteamGameServer(opts, opts.source)
  if (!opts.acceptEula) {
    throw new Error('You must accept the Minecraft EULA to run a server.')
  }
  const servers = loadServers()
  try {
    const plan = await planFromSource(opts.source)
    if (!plan) {
      emitTask('Cancelled', 1, true)
      return null
    }

    // instances created before loader versions were recorded may lack one — use the newest
    if (LOADER_KINDS.has(plan.kind) && !plan.loaderVersion) {
      emitTask(`Resolving ${plan.kind} for ${plan.minecraftVersion}`, -1)
      const versions = await getLoaderVersions(plan.kind as 'fabric' | 'neoforge' | 'forge', plan.minecraftVersion)
      if (versions.length === 0) throw new Error(`${plan.kind} is not available for Minecraft ${plan.minecraftVersion}.`)
      plan.loaderVersion = await pickInstallableLoaderVersion(plan.kind as 'fabric' | 'neoforge' | 'forge', plan.minecraftVersion, versions)
    }

    emitTask(`Resolving ${plan.kind} server for ${plan.minecraftVersion}`, -1)
    const meta = await mojangServerMeta(plan.minecraftVersion)
    const name = opts.name.trim() || plan.packName?.trim() || 'My Server'
    const modded = Boolean(plan.zip || plan.instanceId)
    const server: LocalServer = {
      id: randomUUID(),
      name,
      kind: plan.kind,
      minecraftVersion: plan.minecraftVersion,
      loaderVersion: plan.loaderVersion,
      packName: plan.zip || plan.instanceId ? plan.packName : undefined,
      port: nextFreePort(servers),
      memoryMax: opts.memoryMax && opts.memoryMax >= 1024 ? opts.memoryMax : modded ? 4096 : 2048,
      javaComponent: meta.javaComponent,
      eulaAccepted: true,
      createdAt: Date.now()
    }

    const dir = serverDir(server.id)
    mkdirSync(dir, { recursive: true })
    try {
      await ensureServerBinary(dir, plan, meta.url, server.javaComponent)
      if (plan.zip) await applyPackToServer(dir, plan.zip)
      if (plan.cfZip) await applyCfPackToServer(dir, plan.cfZip)
      if (plan.instanceId) await copyInstanceToServer(dir, plan.instanceId)

      // the checkbox in the create dialog is the user's EULA acceptance
      writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf-8')
      writeFileSync(
        join(dir, 'server.properties'),
        [`server-port=${server.port}`, `motd=${name}`, 'online-mode=true', 'max-players=10', 'view-distance=10', ''].join('\n'),
        'utf-8'
      )

      saveServers([...servers, server])
      emitTask('Server created', 1, true)
      return server
    } catch (e) {
      // don't leave a broken half-installed server behind
      rmSync(dir, { recursive: true, force: true })
      throw e
    } finally {
      if (plan.tempZipPath) rmSync(plan.tempZipPath, { force: true })
    }
  } catch (e) {
    emitTask('Failed', 1, true)
    throw e
  }
}

/**
 * Rebuild a Minecraft server with a different loader/version. This DELETES every
 * file for the server (world, mods, configs, old binaries) and reinstalls fresh,
 * keeping only the record's id, name, port, and memory. The caller must have
 * warned the user — there is no undo.
 */
export async function rebuildServer(
  id: string,
  kind: LocalServer['kind'],
  minecraftVersion: string
): Promise<LocalServer> {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) throw new Error('Server not found')
  if (gameOf(record) === 'palworld') throw new Error('Palworld servers cannot change loader.')

  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    stopServer(id)
    if (!(await waitForState(id, 'stopped', 60_000))) throw new Error('The server would not stop — try again.')
    await sleep(1_000)
  }

  emitTask(`Rebuilding as ${kind} ${minecraftVersion}`, -1)
  const plan = await planFromSource({ type: 'fresh', kind, minecraftVersion })
  if (!plan) throw new Error('Could not resolve the new server type.')
  if (LOADER_KINDS.has(plan.kind) && !plan.loaderVersion) {
    const versions = await getLoaderVersions(plan.kind as 'fabric' | 'neoforge' | 'forge', plan.minecraftVersion)
    if (versions.length === 0) throw new Error(`${plan.kind} is not available for Minecraft ${plan.minecraftVersion}.`)
    plan.loaderVersion = versions[0]
  }
  const meta = await mojangServerMeta(plan.minecraftVersion)

  const dir = serverDir(id)
  rmSync(dir, { recursive: true, force: true }) // wipe world, mods, configs, binaries
  mkdirSync(dir, { recursive: true })
  await ensureServerBinary(dir, plan, meta.url, meta.javaComponent)
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf-8')
  writeFileSync(
    join(dir, 'server.properties'),
    [`server-port=${record.port}`, `motd=${record.name}`, 'online-mode=true', 'max-players=10', 'view-distance=10', ''].join('\n'),
    'utf-8'
  )

  record.kind = kind
  record.minecraftVersion = minecraftVersion
  record.loaderVersion = plan.loaderVersion
  record.javaComponent = meta.javaComponent
  saveServers(servers)
  logs.delete(id)
  emitTask('Server rebuilt', 1, true)
  return record
}

/** Create a Palworld dedicated server: SteamCMD download + seeded PalWorldSettings.ini. */
async function createPalworldServer(
  opts: CreateServerOptions,
  source: Extract<ServerSource, { type: 'palworld' }>
): Promise<LocalServer> {
  if (!opts.acceptEula) {
    throw new Error("You must accept Palworld's dedicated server terms to run a server.")
  }
  const servers = loadServers()
  const name = opts.name.trim() || 'My Palworld Server'
  const server: LocalServer = {
    id: randomUUID(),
    name,
    game: 'palworld',
    kind: 'vanilla', // placeholder — kind/minecraftVersion/java are minecraft-only fields
    minecraftVersion: '',
    port: nextFreePort(servers, 'palworld'),
    memoryMax: 0,
    javaComponent: '',
    eulaAccepted: true,
    communityServer: Boolean(source.communityServer),
    createdAt: Date.now()
  }
  const dir = serverDir(server.id)
  mkdirSync(dir, { recursive: true })
  try {
    await installPalworld(
      dir,
      { serverName: name, serverPassword: source.serverPassword, maxPlayers: source.maxPlayers, port: server.port },
      (phase, progress) => emitTask(phase, progress)
    )
    saveServers([...servers, server])
    emitTask('Server created', 1, true)
    return server
  } catch (e) {
    // don't leave a broken half-installed server behind
    rmSync(dir, { recursive: true, force: true })
    emitTask('Failed', 1, true)
    throw e
  }
}

/** Create any registry Steam game server (valheim, 7dtd): SteamCMD download + seeded config. */
async function createSteamGameServer(
  opts: CreateServerOptions,
  source: Extract<ServerSource, { type: 'steamgame' }>
): Promise<LocalServer> {
  const spec = STEAM_GAMES[source.game]
  if (!opts.acceptEula) {
    throw new Error(`You must accept the ${spec.label} dedicated server terms to run a server.`)
  }
  const servers = loadServers()
  const name = opts.name.trim() || `My ${spec.label} Server`
  const server: LocalServer = {
    id: randomUUID(),
    name,
    game: source.game,
    kind: 'vanilla', // placeholder — kind/minecraftVersion/java are minecraft-only fields
    minecraftVersion: '',
    port: nextFreePort(servers, source.game),
    memoryMax: 0,
    javaComponent: '',
    eulaAccepted: true,
    createdAt: Date.now()
  }
  const dir = serverDir(server.id)
  mkdirSync(dir, { recursive: true })
  try {
    await installSteamGame(
      source.game,
      dir,
      { serverName: name, serverPassword: source.serverPassword, maxPlayers: source.maxPlayers, port: server.port },
      (phase, progress) => emitTask(phase, progress)
    )
    saveServers([...servers, server])
    emitTask('Server created', 1, true)
    return server
  } catch (e) {
    // don't leave a broken half-installed server behind
    rmSync(dir, { recursive: true, force: true })
    emitTask('Failed', 1, true)
    throw e
  }
}

async function ensureStopped(id: string): Promise<void> {
  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    stopServer(id)
    if (!(await waitForState(id, 'stopped', 60_000))) throw new Error('The server would not stop — try again.')
    await sleep(1_000)
  }
}

/**
 * Panel-initiated delete: stop the server first if it's running, then remove
 * it. Also purges archived servers. (The launcher UI calls removeServer
 * directly — its flow asks the user to stop the server themselves.)
 */
export async function deleteServer(id: string): Promise<LocalServer[]> {
  const archived = loadArchivedServers()
  if (archived.some((a) => a.id === id)) {
    rmSync(archiveDirOf(id), { recursive: true, force: true })
    writeJson(
      archivedServersFile,
      archived.filter((a) => a.id !== id)
    )
    return listLocalServers()
  }
  await ensureStopped(id)
  return removeServer(id)
}

// ---------- archive (suspended hosting — e.g. a customer's payment lapsed) ----------

export interface ArchivedServer extends LocalServer {
  archivedAt: number
}

function archiveDirOf(id: string): string {
  return join(serverArchivesDir, id)
}

function loadArchivedServers(): ArchivedServer[] {
  return readJson<ArchivedServer[]>(archivedServersFile, [])
}

export function listArchivedServers(): ArchivedServer[] {
  return loadArchivedServers()
}

/**
 * Take a server out of the active pool but keep it restorable: its folder
 * moves to server-archives/ and its record to servers-archived.json. The port
 * and pool hostname free up right away — an archive costs only disk space.
 */
export async function archiveServer(id: string): Promise<void> {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) throw new Error('Server not found')
  await ensureStopped(id)
  void closePort(record.port, gameOf(record) === 'palworld' ? 'UDP' : 'TCP')
  releaseHost(id)
  mkdirSync(serverArchivesDir, { recursive: true })
  renameSync(serverDir(id), archiveDirOf(id))
  saveServers(servers.filter((s) => s.id !== id))
  writeJson(archivedServersFile, [
    ...loadArchivedServers().filter((a) => a.id !== id),
    { ...record, archivedAt: Date.now() }
  ])
  logs.delete(id)
  players.delete(id)
}

/**
 * Bring an archived server back into the active pool. If its old port was
 * handed to another server meanwhile, it gets the next free one.
 */
export async function restoreServer(id: string): Promise<LocalServer> {
  const archived = loadArchivedServers()
  const entry = archived.find((a) => a.id === id)
  if (!entry) throw new Error('No archive exists for that server.')
  if (!existsSync(archiveDirOf(id))) throw new Error('The archived files are missing from server-archives/.')
  if (existsSync(serverDir(id))) throw new Error('An active server folder with this id already exists.')
  const servers = loadServers()
  const { archivedAt: _archivedAt, ...record } = entry
  renameSync(archiveDirOf(id), serverDir(id))
  if (servers.some((s) => s.port === record.port)) {
    record.port = nextFreePort(servers, gameOf(record))
    // palworld needs nothing here — startPalworld pins the ini ports on every launch
    if (gameOf(record) !== 'palworld') {
      try {
        setServerProperties(id, { 'server-port': String(record.port) })
      } catch {
        // no server.properties in the archive — the next start seeds it
      }
    }
  }
  saveServers([...servers, record])
  writeJson(
    archivedServersFile,
    archived.filter((a) => a.id !== id)
  )
  return record
}

export function removeServer(id: string): LocalServer[] {
  const state = states.get(id) ?? 'stopped'
  if (state !== 'stopped') throw new Error('Stop the server before deleting it.')
  const record = loadServers().find((s) => s.id === id)
  if (record) void closePort(record.port, gameOf(record) === 'palworld' ? 'UDP' : 'TCP')
  releaseHost(id) // the pool name becomes available for the next hosted server
  rmSync(serverDir(id), { recursive: true, force: true })
  const remaining = loadServers().filter((s) => s.id !== id)
  saveServers(remaining)
  logs.delete(id)
  players.delete(id)
  return listLocalServers()
}

export function openServerFolder(id: string): void {
  const dir = serverDir(id)
  if (existsSync(dir)) void shell.openPath(dir)
}

// ---------- java ----------

/** Reuse a runtime installed by the game installer, or download it (marker matches installWorker's). */
async function ensureServerJava(component: string): Promise<string> {
  const destination = join(javaDir, component)
  const exe =
    process.platform === 'win32' ? join(destination, 'bin', 'java.exe') : join(destination, 'bin', 'java')
  const javaw = join(destination, 'bin', 'javaw.exe')
  const marker = join(destination, '.elauncher-complete')
  if (existsSync(marker)) {
    if (existsSync(exe)) return exe
    if (existsSync(javaw)) return javaw
  }

  emitTask(`Downloading Java (${component})`, -1)
  const manifest = await fetchJavaRuntimeManifest({ target: component, dispatcher: downloadAgent })
  const task = installJavaRuntimeTask({ destination, manifest, dispatcher: downloadAgent })
  const timer = setInterval(() => {
    emitTask(`Downloading Java (${component})`, task.total > 0 ? Math.min(task.progress / task.total, 1) : -1)
  }, 300)
  try {
    await withRetries(() => task.startAndWait())
  } finally {
    clearInterval(timer)
  }
  if (!existsSync(exe) && !existsSync(javaw)) throw new Error('Java runtime installation failed.')
  // the extracted runtime may not carry the executable bit on Linux
  if (process.platform !== 'win32' && existsSync(exe)) {
    try {
      chmodSync(exe, 0o755)
    } catch {
      // best-effort; a noexec mount is the more likely culprit and is fixed by HOME/paths
    }
  }
  writeFileSync(marker, new Date().toISOString())
  emitTask('Java ready', 1, true)
  return existsSync(exe) ? exe : javaw
}

// ---------- automation: scheduled saves, restarts, backups ----------

const automationTimers = new Map<string, NodeJS.Timeout[]>()
/** last start per server — guards automatic crash-restarts against crash loops */
const lastStartAt = new Map<string, number>()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function saveCommandFor(server: LocalServer): string {
  const game = gameOf(server)
  if (game === 'palworld') return 'save'
  if (game === 'sdtd') return 'saveworld'
  if (game === 'valheim') return '' // no console — valheim autosaves on its own schedule
  return 'save-all'
}

/** Best-effort console command — the server may have stopped between checks. */
function tryCommand(id: string, command: string): void {
  try {
    sendServerCommand(id, command)
  } catch {
    // not running — the surrounding state checks own this
  }
}

function msUntilDaily(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const next = new Date()
  next.setHours(Number.isFinite(h) ? h : 4, Number.isFinite(m) ? m : 0, 0, 0)
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1)
  return next.getTime() - Date.now()
}

function waitForState(id: string, wanted: LocalServerState, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if ((states.get(id) ?? 'stopped') === wanted) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 1000)
  })
}

/** Guards against overlapping restart sequences (timer + memory guard can both fire). */
const restartInFlight = new Set<string>()

/** Warn players, save, stop, wait, start again. Bails out if someone stops the server manually. */
async function scheduledRestart(id: string, reason: string): Promise<void> {
  if (restartInFlight.has(id)) return
  restartInFlight.add(id)
  try {
    await runScheduledRestart(id, reason)
  } finally {
    restartInFlight.delete(id)
  }
}

async function runScheduledRestart(id: string, reason: string): Promise<void> {
  const server = loadServers().find((s) => s.id === id)
  if (!server || (states.get(id) ?? 'stopped') !== 'running') return
  const warn = Math.max(1, server.automation?.restartWarningMin ?? 5)
  pushLog(id, `[ELauncher] ${reason} — restarting in ${warn} minute${warn === 1 ? '' : 's'}`)
  notifyPhones(server.name, `${reason} — restarting in ${warn} min`, `${id}:auto`)
  tryCommand(id, `say Server restart in ${warn} minute${warn === 1 ? '' : 's'}`)
  if (warn > 1) {
    await sleep((warn - 1) * 60_000)
    if ((states.get(id) ?? 'stopped') !== 'running') return
    tryCommand(id, 'say Server restart in 1 minute — find a safe spot!')
  }
  await sleep(60_000)
  if ((states.get(id) ?? 'stopped') !== 'running') return
  tryCommand(id, saveCommandFor(server))
  await sleep(3_000)
  stopServer(id)
  if (!(await waitForState(id, 'stopped', 90_000))) {
    pushLog(id, '[ELauncher] Automated restart aborted — the server did not stop in time.')
    return
  }
  await sleep(2_000)
  pushLog(id, `[ELauncher] ${reason} — starting back up`)
  await startServer(id).catch((e) =>
    pushLog(id, `[ELauncher] Automated restart could not start the server: ${e instanceof Error ? e.message : String(e)}`)
  )
}

/** Manifest written beside every backup so a restore knows where each folder came from. */
const BACKUP_MANIFEST = '.elauncher-backup.json'
type BackupManifest = { game: ServerGame; createdAt: string; sources: string[] }

/**
 * Save folders for a game, as paths relative to the server dir.
 *
 * Relative on purpose: palworld nests its saves at Pal/Saved/SaveGames, so a
 * backup keyed on basename alone can't be put back where it came from.
 */
function backupSources(server: LocalServer): string[] {
  const dir = serverDir(server.id)
  const rel: string[] = []
  if (gameOf(server) === 'palworld') rel.push(join('Pal', 'Saved', 'SaveGames'))
  else if (gameOf(server) === 'valheim') rel.push('save')
  else if (gameOf(server) === 'sdtd') rel.push('UserData')
  else {
    const level = getServerProperties(server.id)['level-name']?.trim() || 'world'
    for (const suffix of ['', '_nether', '_the_end']) rel.push(level + suffix)
  }
  return rel.filter((r) => existsSync(join(dir, r)))
}

/**
 * Copy world/save folders into backups/<stamp> and prune old ones (copies, not
 * zips, to keep the app responsive). Throws on failure — callers that must not
 * fail (the automation timer) use backupServer() instead.
 */
export async function makeServerBackup(id: string): Promise<{ stamp: string }> {
  const server = loadServers().find((s) => s.id === id)
  if (!server) throw new Error('server not found')
  const dir = serverDir(id)
  const sources = backupSources(server)
  if (sources.length === 0) throw new Error('Nothing to back up yet — the world is created on first start.')

  const running = (states.get(id) ?? 'stopped') === 'running'
  if (running) {
    // flush and pause writes so the copy isn't torn mid-write
    if (gameOf(server) === 'minecraft') {
      tryCommand(id, 'save-off')
      tryCommand(id, 'save-all')
    } else if (saveCommandFor(server)) {
      tryCommand(id, saveCommandFor(server))
    }
    await sleep(3_000)
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  const destRoot = join(dir, 'backups')
  try {
    for (const rel of sources) await cp(join(dir, rel), join(destRoot, stamp, basename(rel)), { recursive: true })
    const manifest: BackupManifest = { game: gameOf(server), createdAt: new Date().toISOString(), sources }
    writeJson(join(destRoot, stamp, BACKUP_MANIFEST), manifest)
  } finally {
    if (running && gameOf(server) === 'minecraft') tryCommand(id, 'save-on')
  }
  pushLog(id, `[ELauncher] World backed up to backups/${stamp}`)

  const keep = Math.max(1, server.automation?.backupKeep ?? 5)
  const old = readdirSync(destRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const name of old.slice(0, Math.max(0, old.length - keep))) {
    rmSync(join(destRoot, name), { recursive: true, force: true })
  }
  return { stamp }
}

/** Fire-and-forget wrapper for the automation timer: a failed backup logs, never throws. */
async function backupServer(id: string): Promise<void> {
  try {
    await makeServerBackup(id)
  } catch (e) {
    pushLog(id, `[ELauncher] Backup failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** (Re)arm a server's automation timers from its record — called when it reaches 'running'. */
function startAutomation(id: string): void {
  stopAutomation(id)
  const server = loadServers().find((s) => s.id === id)
  const auto = server?.automation
  if (!server || !auto) return
  const timers: NodeJS.Timeout[] = []

  if (auto.saveIntervalMin && auto.saveIntervalMin > 0) {
    timers.push(
      setInterval(() => {
        if ((states.get(id) ?? 'stopped') !== 'running') return
        tryCommand(id, saveCommandFor(server))
        pushLog(id, '[ELauncher] Auto-save')
      }, auto.saveIntervalMin * 60_000)
    )
  }
  if (auto.restartMode === 'interval' && auto.restartEveryHours && auto.restartEveryHours > 0) {
    timers.push(setInterval(() => void scheduledRestart(id, 'Scheduled restart'), auto.restartEveryHours * 3_600_000))
  } else if (auto.restartMode === 'daily' && auto.restartDailyAt) {
    const arm = (): void => {
      timers.push(
        setTimeout(() => {
          void scheduledRestart(id, 'Daily restart')
          arm()
        }, msUntilDaily(auto.restartDailyAt!))
      )
    }
    arm()
  }
  if (auto.backupIntervalHours && auto.backupIntervalHours > 0) {
    timers.push(setInterval(() => void backupServer(id), auto.backupIntervalHours * 3_600_000))
  }
  automationTimers.set(id, timers)
}

function stopAutomation(id: string): void {
  for (const timer of automationTimers.get(id) ?? []) clearTimeout(timer)
  automationTimers.delete(id)
}

/** Crash follow-up shared by both games' exit paths. */
function handleCrashRestart(id: string): void {
  const server = loadServers().find((s) => s.id === id)
  if (!server?.automation?.restartOnCrash) return
  if (Date.now() - (lastStartAt.get(id) ?? 0) < 90_000) {
    pushLog(id, '[ELauncher] Crashed right after starting — automatic restart skipped to avoid a crash loop.')
    return
  }
  pushLog(id, '[ELauncher] Restarting automatically after the crash (5s)…')
  setTimeout(() => {
    if ((states.get(id) ?? 'stopped') === 'stopped') {
      void startServer(id).catch((e) =>
        pushLog(id, `[ELauncher] Automatic restart failed: ${e instanceof Error ? e.message : String(e)}`)
      )
    }
  }, 5_000)
}

/** Current automation config for a server (empty object when none set). */
export function getServerAutomation(id: string): ServerAutomation {
  return loadServers().find((s) => s.id === id)?.automation ?? {}
}

/** Persist automation config; re-arms timers live when the server is already running. */
export function setServerAutomation(id: string, automation: ServerAutomation): LocalServer[] {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (record) {
    record.automation = automation
    saveServers(servers)
    if ((states.get(id) ?? 'stopped') === 'running') startAutomation(id)
    else stopAutomation(id)
  }
  return listLocalServers()
}

// ---------- live process stats: memory/cpu sampling + memory guard ----------

const cpuSecondsPrev = new Map<number, { seconds: number; at: number }>()
let sampling = false

/** One PowerShell call samples every running server's working set + CPU time. */
async function sampleProcessStats(): Promise<void> {
  if (sampling || process.platform !== 'win32') return
  const entries = [...procs.entries()].filter(([, proc]) => proc.pid !== undefined)
  if (entries.length === 0) {
    resourceStats.clear()
    return
  }
  sampling = true
  try {
    const pids = entries.map(([, proc]) => proc.pid as number)
    const json = await new Promise<string>((resolve, reject) => {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,@{n='CpuSeconds';e={$_.TotalProcessorTime.TotalSeconds}} | ConvertTo-Json -Compress`
        ],
        { windowsHide: true }
      )
      let out = ''
      ps.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
      ps.on('error', reject)
      ps.on('exit', () => resolve(out.trim()))
    })
    if (!json) return
    const parsed = JSON.parse(json) as
      | { Id: number; WorkingSet64: number; CpuSeconds: number }
      | { Id: number; WorkingSet64: number; CpuSeconds: number }[]
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const byPid = new Map(rows.map((row) => [row.Id, row]))
    const cores = cpus().length || 1
    const now = Date.now()

    for (const [id, proc] of entries) {
      const row = byPid.get(proc.pid as number)
      if (!row) {
        resourceStats.delete(id)
        continue
      }
      const prev = cpuSecondsPrev.get(row.Id)
      let cpuPercent: number | null = null
      if (prev && now > prev.at) {
        cpuPercent = Math.round(
          Math.max(0, Math.min(100, (((row.CpuSeconds - prev.seconds) * 1000) / (now - prev.at) / cores) * 100))
        )
      }
      cpuSecondsPrev.set(row.Id, { seconds: row.CpuSeconds, at: now })
      const memoryMB = Math.round(row.WorkingSet64 / 1048576)
      resourceStats.set(id, { memoryMB, cpuPercent })
      // push fresh stats to the UI (and the phone, via the next heartbeat)
      setState(id, states.get(id) ?? 'running')

      // memory guard: warned restart when the process crosses the configured limit
      const record = loadServers().find((s) => s.id === id)
      const limit = record?.automation?.restartAboveMemoryMB ?? 0
      if (limit > 0 && memoryMB >= limit && (states.get(id) ?? 'stopped') === 'running' && !restartInFlight.has(id)) {
        pushLog(
          id,
          `[ELauncher] Memory ${(memoryMB / 1024).toFixed(1)} GB crossed the ${(limit / 1024).toFixed(1)} GB limit — restarting to reclaim it`
        )
        void scheduledRestart(id, 'Memory limit reached')
      }
    }
  } catch {
    // sampling is best-effort; the next tick tries again
  } finally {
    sampling = false
  }
}

setInterval(() => void sampleProcessStats(), 10_000)

/** Start servers flagged autoStart shortly after the launcher boots. */
export function autoStartConfiguredServers(): void {
  setTimeout(() => {
    for (const server of loadServers()) {
      if (server.automation?.autoStart && (states.get(server.id) ?? 'stopped') === 'stopped') {
        pushLog(server.id, '[ELauncher] Auto-starting with the launcher')
        void startServer(server.id).catch(() => {
          // surfaced through the server's own state/error events
        })
      }
    }
  }, 4_000)
}

// ---------- run ----------

const DONE_RE = /\]: Done \([\d.,]+s\)!/
const JOIN_RE = /\]: ([A-Za-z0-9_]{1,16}) joined the game/
const LEAVE_RE = /\]: ([A-Za-z0-9_]{1,16}) (?:left the game|lost connection)/
const BIND_RE = /FAILED TO BIND TO PORT|Address already in use/i
/** The universal Minecraft "server is lagging" signal (vanilla/paper/forge all print it). */
const LAG_RE = /Can't keep up.*Running (\d+)ms.*behind|Running (\d+)ms or (\d+) ticks behind/i

/**
 * Aikar's tuned G1GC flags — the community-standard JVM tuning that keeps a
 * dedicated Minecraft server's garbage collection from causing tick lag. Region
 * sizes scale with the heap (Aikar's >12 GB profile for big modded servers).
 * Applied to every Minecraft server automatically; it's a strict win for a
 * long-running dedicated process.
 */
function aikarFlags(memoryMB: number): string[] {
  const big = memoryMB >= 12288
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? 16 : 8}M`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true'
  ]
}

// ---------- performance health (lag detection) ----------

/** Recent "can't keep up" timestamps per server, for a live smooth/fair/poor reading. */
const lagEvents = new Map<string, number[]>()
/** Throttle the in-console "server is lagging" nudge so it doesn't spam. */
const lastLagNudge = new Map<string, number>()

function recordLag(id: string): void {
  const now = Date.now()
  const list = (lagEvents.get(id) ?? []).filter((t) => now - t < 300_000)
  list.push(now)
  lagEvents.set(id, list)
  // if it's persistently behind, nudge once every 5 min with an actionable tip
  const recent = list.filter((t) => now - t < 120_000).length
  if (recent >= 3 && now - (lastLagNudge.get(id) ?? 0) > 300_000) {
    lastLagNudge.set(id, now)
    pushLog(
      id,
      '[ELauncher] Performance: the server is running behind. Try lowering view-distance / simulation-distance in Settings, or reduce loaded chunks. Fewer players and mods also help.'
    )
  }
}

/** Live performance reading for a running server. */
function healthOf(id: string): 'smooth' | 'fair' | 'poor' | null {
  if ((states.get(id) ?? 'stopped') !== 'running') return null
  const now = Date.now()
  const recent = (lagEvents.get(id) ?? []).filter((t) => now - t < 120_000).length
  const cpu = resourceStats.get(id)?.cpuPercent ?? 0
  if (recent >= 3 || cpu >= 95) return 'poor'
  if (recent >= 1 || cpu >= 80) return 'fair'
  return 'smooth'
}

/**
 * On a Linux host (VPS), open the server's port in ufw automatically so players
 * can connect without manual firewall edits. Best-effort: if ufw isn't installed
 * or isn't active, the ports are simply already reachable and this is a no-op.
 */
function ensureFirewallPort(id: string, port: number, protocol: 'tcp' | 'udp'): void {
  if (process.platform !== 'linux') return
  try {
    const proc = spawn('ufw', ['allow', `${port}/${protocol}`])
    proc.on('error', () => {
      // ufw not installed — nothing to open, ports are already exposed
    })
    proc.on('exit', (code) => {
      if (code === 0) pushLog(id, `[ELauncher] Opened ${protocol.toUpperCase()} port ${port} in the firewall`)
    })
  } catch {
    // best-effort
  }
}

// ---------- hosted-plan limits (stamped by the provisioner, enforced here) ----------

/** The plan's caps with an admin override merged over them, field by field. */
export function effectiveLimits(
  plan: PlanLimits | undefined,
  override: PlanLimits | undefined
): PlanLimits | undefined {
  const merged = { ...(plan ?? {}), ...(override ?? {}) }
  return Object.keys(merged).length ? merged : undefined
}

/** Stamp (or clear) plan resource caps on a server record; clamps the heap allocation immediately. */
export function setServerLimits(id: string, limits: PlanLimits | undefined): void {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) return
  record.limitsPlan = limits
  // an admin override outranks the plan, and the provisioner re-stamps these every tick
  record.limits = effectiveLimits(limits, record.limitsOverride)
  // the minecraft heap allocation is plan-priced — keep the record itself inside it
  const cap = record.limits?.memoryMb
  if (cap && record.memoryMax > cap) record.memoryMax = cap
  saveServers(servers)
}

/**
 * Admin resource override: lift one server above its plan, or clear the lift.
 *
 * Kept apart from `limits` because the provisioner reconciles those against the
 * purchased plan every tick — an override written there would be reverted within
 * a minute. Raising the ceiling raises `memoryMax` with it, since the heap in
 * force is min(memoryMax, cap) and lifting only the cap would change nothing.
 */
export function setServerLimitsOverride(id: string, override: PlanLimits | undefined): PlanLimits | undefined {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) throw new Error('This server is no longer on this host.')
  // first override on an older record: whatever is in force now is the plan baseline
  if (!record.limitsPlan) record.limitsPlan = record.limits
  const wanted = override && Object.keys(override).length ? override : undefined
  record.limitsOverride = wanted
  record.limits = effectiveLimits(record.limitsPlan, wanted)
  const cap = record.limits?.memoryMb
  // a lift is meant to be spent; a cut still clamps
  if (cap && wanted?.memoryMb) record.memoryMax = cap
  else if (cap && record.memoryMax > cap) record.memoryMax = cap
  saveServers(servers)
  pushLog(
    id,
    wanted
      ? `[ELauncher] Admin override — ${wanted.memoryMb ? `${(wanted.memoryMb / 1024).toFixed(1)} GB RAM` : 'plan RAM'}, ${wanted.cpuCores ? `${wanted.cpuCores} core${wanted.cpuCores === 1 ? '' : 's'}` : 'plan CPU'}. Restart to apply.`
      : '[ELauncher] Admin override cleared — back to the plan allowance. Restart to apply.'
  )
  return record.limits
}

/** The per-game settings key that carries the player cap (null = the game has a fixed cap). */
export function playerCapKey(game: ServerGame): string | null {
  if (game === 'palworld') return 'ServerPlayerMaxNum'
  if (game === 'sdtd') return 'ServerMaxPlayerCount'
  if (game === 'valheim') return null // valheim is hard-capped at 10 by the game itself
  return 'max-players'
}

/**
 * Clamp plan-capped settings just before launch. This is the authoritative
 * enforcement point: whatever path an edit took (panel, file manager, desktop,
 * hand-edited config), the values in force never exceed the purchased plan.
 */
function enforcePlanLimits(server: LocalServer): void {
  const limits = server.limits
  if (!limits) return
  if (limits.maxPlayers && limits.maxPlayers > 0 && playerCapKey(gameOf(server))) {
    const key = playerCapKey(gameOf(server))!
    try {
      const current = Number(getServerProperties(server.id)[key])
      if (!Number.isFinite(current) || current > limits.maxPlayers) {
        setServerProperties(server.id, { [key]: String(limits.maxPlayers) })
        pushLog(server.id, `[ELauncher] Player slots set to ${limits.maxPlayers} — the plan's included amount`)
      }
    } catch {
      // config not readable yet (first boot) — install already seeded the plan value
    }
  }
  if (limits.memoryMb && gameOf(server) !== 'minecraft') {
    // non-java games have no heap flag — the memory guard IS the ceiling: restart above the plan
    const automation = getServerAutomation(server.id)
    if (!automation.restartAboveMemoryMB || automation.restartAboveMemoryMB > limits.memoryMb) {
      setServerAutomation(server.id, { ...automation, restartAboveMemoryMB: limits.memoryMb })
      pushLog(server.id, `[ELauncher] Memory guard pinned to the plan's ${(limits.memoryMb / 1024).toFixed(1)} GB`)
    }
  }
}

/**
 * Linux: pin a plan-capped server onto its first N cores (children inherit the
 * affinity, so the whole tree is capped). Windows has no dependency-free hard
 * cap — there the memory guard and priority of the game itself still apply.
 */
function cpuWrap(server: LocalServer, exe: string, args: string[]): [string, string[]] {
  const list = planCoreList(server)
  if (list) return ['taskset', ['-c', list, exe, ...args]]
  return [exe, args]
}

/**
 * The core list a plan-capped server is pinned to. Each server starts at a
 * stable id-derived offset and wraps around the box, so capped servers spread
 * across all cores instead of piling onto core 0 together.
 */
export function planCoreList(server: LocalServer): string | null {
  const cores = server.limits?.cpuCores
  const total = cpus().length
  if (process.platform !== 'linux' || !cores || cores <= 0 || cores >= total) return null
  const offset = [...server.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % total
  return Array.from({ length: cores }, (_, i) => (offset + i) % total).join(',')
}

export async function startServer(id: string): Promise<void> {
  const current = states.get(id) ?? 'stopped'
  if (current !== 'stopped') throw new Error('This server is already running.')
  const server = getServer(id)
  enforcePlanLimits(server)
  if (gameOf(server) === 'palworld') return startPalworldServer(server)
  if (isSteamGame(gameOf(server))) return runSteamGameServer(server)
  const dir = serverDir(id)
  // vanilla/paper/fabric run a jar; modern forge/neoforge run via the installer's @args file
  const hasJar = existsSync(join(dir, 'server.jar'))
  const argsFile = hasJar ? null : findArgsFile(dir)
  if (!hasJar && !argsFile) throw new Error('Server launch files are missing — delete and recreate the server.')

  logs.set(id, [])
  players.set(id, new Set())
  setState(id, 'starting')
  try {
    const java = await ensureServerJava(server.javaComponent)
    // the heap never exceeds the plan even if the record drifted
    const heap = server.limits?.memoryMb ? Math.min(server.memoryMax || server.limits.memoryMb, server.limits.memoryMb) : server.memoryMax
    pushLog(id, `[ELauncher] Starting ${server.kind} server on port ${server.port} (${heap} MiB) — optimized GC flags on`)
    if (server.limits?.cpuCores && process.platform === 'linux') {
      pushLog(id, `[ELauncher] CPU pinned to ${server.limits.cpuCores} core${server.limits.cpuCores === 1 ? '' : 's'} (plan limit)`)
    }

    const [launchExe, launchArgs] = cpuWrap(server, java, [
      `-Xms${heap}M`,
      `-Xmx${heap}M`,
      ...aikarFlags(heap),
      ...(argsFile ? [`@${argsFile}`] : ['-jar', 'server.jar']),
      'nogui'
    ])
    const proc = spawn(launchExe, launchArgs, { cwd: dir, windowsHide: true })
    procs.set(id, proc)
    lastStartAt.set(id, Date.now())
    lagEvents.delete(id)
    ensureFirewallPort(id, server.port, 'tcp')

    const onLine = (line: string): void => {
      pushLog(id, line)
      if (LAG_RE.test(line)) recordLag(id)
      if ((states.get(id) === 'starting') && DONE_RE.test(line)) {
        pushLog(id, `[ELauncher] Server is ready — friends on your network can join localhost:${server.port}`)
        setState(id, 'running')
        startAutomation(id)
        notifyPhones(server.name, 'Server is online', `${id}:state`)
      }
      if (BIND_RE.test(line)) {
        pushLog(id, `[ELauncher] Port ${server.port} is taken — edit server-port in Settings or stop the other app.`)
      }
      const join_ = line.match(JOIN_RE)
      if (join_) {
        players.get(id)?.add(join_[1])
        setState(id, states.get(id) ?? 'running')
        notifyPhones(server.name, `${join_[1]} joined the game`, `${id}:join`)
      }
      const leave = line.match(LEAVE_RE)
      if (leave) {
        players.get(id)?.delete(leave[1])
        setState(id, states.get(id) ?? 'running')
      }
    }
    proc.stdout?.setEncoding('utf-8')
    proc.stderr?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line) onLine(line)
    })
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line) onLine(line)
    })

    proc.on('exit', (code) => {
      procs.delete(id)
      resourceStats.delete(id)
      serverVersions.delete(id)
      players.set(id, new Set())
      const wasStopping = states.get(id) === 'stopping'
      pushLog(id, `[ELauncher] Server exited${code != null ? ` (code ${code})` : ''}`)
      stopTunnel(server.port)
      stopAutomation(id)
      const crashed = !wasStopping && code !== 0
      setState(id, 'stopped', crashed ? `The server crashed (exit code ${code}). Check the console.` : undefined)
      notifyPhones(server.name, crashed ? `Crashed (exit code ${code}) — check the console` : 'Server stopped', `${id}:state`)
      if (crashed) handleCrashRestart(id)
    })
    proc.on('error', (err) => {
      procs.delete(id)
      pushLog(id, `[ELauncher] Failed to start: ${err}`)
      setState(id, 'stopped', String(err))
    })
  } catch (e) {
    setState(id, 'stopped', e instanceof Error ? e.message : String(e))
    throw e
  }
}

// ---------- run: palworld ----------

const palworldHandles = new Map<string, PalworldHandle>()
const steamGameHandles = new Map<string, SteamGameHandle>()

/** Start a registry Steam game (valheim/7dtd) with the shared lifecycle plumbing. */
async function runSteamGameServer(server: LocalServer): Promise<void> {
  const id = server.id
  const game = gameOf(server) as 'valheim' | 'sdtd'
  const spec = STEAM_GAMES[game]
  const dir = serverDir(id)
  logs.set(id, [])
  players.set(id, new Set())
  setState(id, 'starting')
  pushLog(id, `[ELauncher] Starting ${spec.label} server on ${spec.protocol} port ${server.port} — first boot can take a few minutes`)
  try {
    const handle = startSteamGame(game, dir, server.port, planCoreList(server), {
      onLog: (line) => pushLog(id, line),
      onReady: () => {
        setState(id, 'running')
        startAutomation(id)
        notifyPhones(server.name, `${spec.label} server is online`, `${id}:state`)
      },
      onPlayers: (names) => {
        const before = players.get(id) ?? new Set<string>()
        const now = new Set(names)
        for (const n of now) if (!before.has(n)) pushLog(id, `[ELauncher] ${n} joined the game`)
        for (const n of before) if (!now.has(n)) pushLog(id, `[ELauncher] ${n} left the game`)
        players.set(id, now)
      },
      onExit: (code) => {
        procs.delete(id)
        steamGameHandles.delete(id)
        resourceStats.delete(id)
        players.set(id, new Set())
        const wasStopping = states.get(id) === 'stopping'
        pushLog(id, `[ELauncher] Server exited${code != null ? ` (code ${code})` : ''}`)
        void closePort(server.port, spec.protocol)
        stopAutomation(id)
        const crashed = !wasStopping && code !== 0 && code !== null
        notifyPhones(server.name, crashed ? `Crashed (exit code ${code}) — check the console` : 'Server stopped', `${id}:state`)
        if (crashed) handleCrashRestart(id)
        setState(id, 'stopped', crashed ? `The server crashed (exit code ${code}). Check the console.` : undefined)
      }
    })
    procs.set(id, handle.proc)
    steamGameHandles.set(id, handle)
    lastStartAt.set(id, Date.now())
    ensureFirewallPort(id, server.port, spec.protocol.toLowerCase() as 'tcp' | 'udp')
  } catch (e) {
    setState(id, 'stopped', e instanceof Error ? e.message : String(e))
    throw e
  }
}

async function startPalworldServer(server: LocalServer): Promise<void> {
  const id = server.id
  const dir = serverDir(id)
  if (!existsSync(join(dir, 'Pal'))) {
    throw new Error('Palworld server files are missing — delete and recreate the server.')
  }
  logs.set(id, [])
  players.set(id, new Set())
  setState(id, 'starting')
  pushLog(id, `[ELauncher] Starting Palworld server on UDP port ${server.port} — first boot can take a couple of minutes`)

  // community servers announce their WAN address to the official lobby list
  const community = Boolean(server.communityServer)
  const publicIp = community ? (await getShareInfo()).publicIp : null
  if (community) {
    pushLog(
      id,
      publicIp
        ? `[ELauncher] Community listing on — announcing ${publicIp}:${server.port} (make sure UDP ${server.port} is reachable)`
        : '[ELauncher] Community listing on — could not detect your public IP; the lobby will try to auto-detect it'
    )
  }
  try {
    const handle = await startPalworld(dir, server.port, { publicLobby: community, publicIp, cpuList: planCoreList(server) }, {
      onLog: (line) => pushLog(id, line),
      onReady: (version) => {
        if (version) serverVersions.set(id, version)
        pushLog(id, `[ELauncher] Friends on your network join via this PC's IP, port ${server.port}`)
        setState(id, 'running')
        startAutomation(id)
        notifyPhones(server.name, `Palworld server is online${version ? ` (${version})` : ''}`, `${id}:state`)
      },
      onPlayers: (names) => {
        const before = players.get(id) ?? new Set<string>()
        const now = new Set(names)
        for (const n of now) {
          if (!before.has(n)) {
            pushLog(id, `[ELauncher] ${n} joined the game`)
            notifyPhones(server.name, `${n} joined the game`, `${id}:join`)
          }
        }
        for (const n of before) if (!now.has(n)) pushLog(id, `[ELauncher] ${n} left the game`)
        players.set(id, now)
        setState(id, states.get(id) ?? 'running')
      },
      onExit: (code) => {
        procs.delete(id)
        palworldHandles.delete(id)
        resourceStats.delete(id)
        serverVersions.delete(id)
        players.set(id, new Set())
        const wasStopping = states.get(id) === 'stopping'
        pushLog(id, `[ELauncher] Server exited${code != null ? ` (code ${code})` : ''}`)
        void closePort(server.port, 'UDP')
        stopAutomation(id)
        const palCrashed = !wasStopping && code !== 0 && code !== null
        notifyPhones(
          server.name,
          palCrashed ? `Crashed (exit code ${code}) — check the console` : 'Server stopped',
          `${id}:state`
        )
        if (palCrashed) handleCrashRestart(id)
        setState(
          id,
          'stopped',
          !wasStopping && code !== 0 && code !== null ? `The server crashed (exit code ${code}). Check the console.` : undefined
        )
      }
    })
    procs.set(id, handle.proc)
    palworldHandles.set(id, handle)
    lastStartAt.set(id, Date.now())
    ensureFirewallPort(id, server.port, 'udp')
  } catch (e) {
    setState(id, 'stopped', e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** Graceful stop via the server's own `stop` command, with a kill fallback. */
export function stopServer(id: string): void {
  const handle = palworldHandles.get(id) ?? steamGameHandles.get(id)
  if (handle) {
    setState(id, 'stopping')
    handle.stop()
    return
  }
  const proc = procs.get(id)
  if (!proc) {
    setState(id, 'stopped')
    return
  }
  setState(id, 'stopping')
  try {
    proc.stdin?.write('stop\n')
  } catch {
    killProcessTree(proc)
    return
  }
  setTimeout(() => {
    if (procs.get(id) === proc) killProcessTree(proc)
  }, 12_000)
}

/**
 * Force stop: kill the process tree now, skipping the graceful save.
 *
 * The escape hatch for a server that ignored `stop` — a Palworld server whose
 * REST admin never came up, a Valheim process that outlived its grace window, a
 * JVM wedged mid-save. It is also the only way out of a stuck 'stopping', since
 * startServer refuses unless the state is 'stopped' and nothing else resets it.
 */
export function forceStopServer(id: string): void {
  const proc = procs.get(id) ?? palworldHandles.get(id)?.proc ?? steamGameHandles.get(id)?.proc
  if (!proc) {
    // nothing left running — clear a state stranded by an earlier failed stop
    pushLog(id, '[ELauncher] Nothing was running — marking the server stopped')
    setState(id, 'stopped')
    return
  }
  setState(id, 'stopping')
  pushLog(id, '[ELauncher] Force stopping — killing the process tree without saving')
  killProcessTree(proc)
  // the exit handler normally clears the state; if the kill leaves no exit event
  // behind (pid already reaped, taskkill refused) don't strand it in 'stopping'
  setTimeout(() => {
    // identity check, not presence: a fresh run started in the meantime holds a
    // different proc and must not be torn down by this timer
    const stranded =
      procs.get(id) === proc || palworldHandles.get(id)?.proc === proc || steamGameHandles.get(id)?.proc === proc
    if (!stranded) return
    procs.delete(id)
    palworldHandles.delete(id)
    steamGameHandles.delete(id)
    setState(id, 'stopped', 'Force stopped — the process never reported an exit.')
  }, 5_000)
}

export function sendServerCommand(id: string, command: string): void {
  const cmd = command.trim()
  if (!cmd) return
  const record = getServer(id)
  if (isSteamGame(gameOf(record))) {
    const handle = steamGameHandles.get(id)
    if (!handle || (states.get(id) ?? 'stopped') !== 'running') throw new Error('The server is not running.')
    if (!handle.command) throw new Error(`${STEAM_GAMES[gameOf(record) as 'valheim' | 'sdtd'].label} has no admin console — manage it through Settings.`)
    pushLog(id, `> ${cmd}`)
    handle.command(cmd)
    return
  }
  if (gameOf(record) === 'palworld') {
    if ((states.get(id) ?? 'stopped') !== 'running') throw new Error('The server is not running.')
    pushLog(id, `> ${cmd}`)
    void sendPalworldCommand(serverDir(id), record.port, cmd, (line) => pushLog(id, line)).catch((e) =>
      pushLog(id, `[ELauncher] ${e instanceof Error ? e.message : String(e)}`)
    )
    return
  }
  const proc = procs.get(id)
  if (!proc) throw new Error('The server is not running.')
  pushLog(id, `> ${cmd}`)
  proc.stdin?.write(cmd + '\n')
}

// ---------- server.properties ----------

export function getServerProperties(id: string): Record<string, string> {
  const record = getServer(id)
  if (isSteamGame(gameOf(record))) return getSteamGameSettings(gameOf(record) as 'valheim' | 'sdtd', serverDir(id))
  if (gameOf(record) === 'palworld') return getPalworldSettings(serverDir(id))
  const file = join(serverDir(id), 'server.properties')
  const entries: Record<string, string> = {}
  if (!existsSync(file)) return entries
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    entries[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return entries
}

/** Merge-write properties, preserving comments and unknown keys (mirrors gameOptions.setGameOptions). */
export function setServerProperties(id: string, updates: Record<string, string>): Record<string, string> {
  const palworldRecord = getServer(id)
  if (isSteamGame(gameOf(palworldRecord))) {
    return setSteamGameSettings(gameOf(palworldRecord) as 'valheim' | 'sdtd', serverDir(id), updates)
  }
  if (gameOf(palworldRecord) === 'palworld') {
    const entries = setPalworldSettings(serverDir(id), updates)
    // keep the record's port in sync so UPnP mappings point at the right place
    const portValue = Number(entries['PublicPort'])
    if (Number.isInteger(portValue) && portValue > 0 && palworldRecord.port !== portValue) {
      const servers = loadServers()
      const record = servers.find((s) => s.id === id)
      if (record) {
        record.port = portValue
        saveServers(servers)
      }
    }
    return entries
  }
  const file = join(serverDir(id), 'server.properties')
  const pending = new Map(Object.entries(updates))
  const lines: string[] = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const idx = line.indexOf('=')
      const key = !line.startsWith('#') && idx > 0 ? line.slice(0, idx) : null
      if (key && pending.has(key)) {
        lines.push(`${key}=${pending.get(key)}`)
        pending.delete(key)
      } else if (line.trim().length > 0) {
        lines.push(line)
      }
    }
  }
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8')

  // keep the record's port in sync so tunnels point at the right place
  const portValue = Number(getServerProperties(id)['server-port'])
  if (Number.isInteger(portValue) && portValue > 0) {
    const servers = loadServers()
    const record = servers.find((s) => s.id === id)
    if (record && record.port !== portValue) {
      record.port = portValue
      saveServers(servers)
    }
  }
  return getServerProperties(id)
}

export function updateServerSettings(id: string, name: string, memoryMax: number, syncGameName = true): LocalServer[] {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (record) {
    const newName = name.trim()
    const oldName = record.name
    record.name = newName || record.name
    if (memoryMax >= 1024) record.memoryMax = memoryMax
    saveServers(servers)

    // keep player-facing names in step — but only when asked, and only while they
    // still match the old launcher name, so a customized motd/ServerName survives
    if (syncGameName && newName && newName !== oldName) {
      try {
        if (gameOf(record) === 'palworld') {
          const entries = getPalworldSettings(serverDir(id))
          if (!entries['ServerName'] || entries['ServerName'] === oldName) {
            setPalworldSettings(serverDir(id), { ServerName: newName })
          }
        } else {
          const props = getServerProperties(id)
          if (props['motd'] === oldName) setServerProperties(id, { motd: newName })
        }
      } catch {
        // cosmetic sync only — the rename itself already succeeded
      }
    }
  }
  return listLocalServers()
}

/** Live Palworld player rows for the moderation tab (empty when not running). */
export async function getPalworldPlayerDetails(id: string): Promise<PalworldPlayerDetail[]> {
  const record = getServer(id)
  if (gameOf(record) !== 'palworld') throw new Error('Not a Palworld server.')
  if ((states.get(id) ?? 'stopped') !== 'running') return []
  return getPalworldPlayers(serverDir(id), record.port)
}

/** Kick/ban/unban/broadcast on a running Palworld server, with a console line for the audit trail. */
export async function palworldModerate(
  id: string,
  action: PalworldModerationAction,
  target: string,
  message?: string
): Promise<void> {
  const record = getServer(id)
  if (gameOf(record) !== 'palworld') throw new Error('Not a Palworld server.')
  if ((states.get(id) ?? 'stopped') !== 'running') throw new Error('The server is not running.')
  await moderatePalworld(serverDir(id), record.port, action, target, message)
  pushLog(
    id,
    action === 'announce' ? `[ELauncher] Broadcast: ${target}` : `[ELauncher] ${action} ${target}${message ? ` — ${message}` : ''}`
  )
}

/** Toggle a palworld server's community-browser listing (applies on next start). */
export function setCommunityServer(id: string, enabled: boolean): LocalServer[] {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (record && gameOf(record) === 'palworld') {
    record.communityServer = enabled
    saveServers(servers)
  }
  return listLocalServers()
}

// ---------- server content: mods (modded kinds) or plugins (paper) ----------

interface ServerModRecord {
  projectId: string
  title: string
  versionNumber: string
  iconUrl?: string
}

/** Where installable content lives for a server, and which Modrinth loaders match it. */
function contentTargets(server: LocalServer): { dir: string; loaders: string[]; noun: string } | null {
  if (server.kind === 'paper') {
    // Paper runs the whole Bukkit plugin family
    return { dir: 'plugins', loaders: ['paper', 'spigot', 'bukkit', 'purpur'], noun: 'plugin' }
  }
  if (LOADER_KINDS.has(server.kind)) {
    return { dir: 'mods', loaders: [server.kind], noun: 'mod' }
  }
  return null
}

function serverModsMetaFile(id: string): string {
  return join(serverDir(id), 'elauncher-server-mods.json')
}

function readServerModsMeta(id: string): Record<string, ServerModRecord> {
  return readJson<Record<string, ServerModRecord>>(serverModsMetaFile(id), {})
}

export function listServerMods(id: string): ServerMod[] {
  const server = getServer(id)
  const targets = contentTargets(server)
  if (!targets) return []
  const dir = join(serverDir(id), targets.dir)
  if (!existsSync(dir)) return []
  const meta = readServerModsMeta(id)
  const mods: ServerMod[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jar')) continue
    const record = meta[file]
    mods.push({
      fileName: file,
      sizeBytes: statSync(join(dir, file)).size,
      projectId: record?.projectId,
      title: record?.title,
      versionNumber: record?.versionNumber,
      iconUrl: record?.iconUrl
    })
  }
  return mods.sort((a, b) => (a.title ?? a.fileName).localeCompare(b.title ?? b.fileName))
}

export function removeServerMod(id: string, fileName: string): ServerMod[] {
  const server = getServer(id)
  const targets = contentTargets(server)
  if (targets) rmSync(join(serverDir(id), targets.dir, fileName), { force: true })
  const meta = readServerModsMeta(id)
  if (meta[fileName]) {
    delete meta[fileName]
    writeJson(serverModsMetaFile(id), meta)
  }
  return listServerMods(id)
}

interface ModrinthVersionLite {
  id: string
  version_number: string
  files: { url: string; filename: string; primary: boolean }[]
  dependencies: { project_id?: string; dependency_type: string }[]
}

/**
 * Install a Modrinth mod (modded servers) or plugin (Paper) plus its required
 * dependencies. Client-only mods are refused up front instead of crashing the
 * server; plugins fall back to a loaders-only match because they usually
 * support many game versions without listing every one.
 */
export async function installServerMod(id: string, projectId: string, depth = 0): Promise<void> {
  if (depth > 5) return
  const server = getServer(id)
  const targets = contentTargets(server)
  if (!targets) {
    throw new Error('Vanilla servers have no mod loader. Use a Paper server for plugins, or Fabric/NeoForge/Forge for mods.')
  }
  const meta = readServerModsMeta(id)
  if (Object.values(meta).some((m) => m.projectId === projectId)) return

  const project = (await modrinthFetch(`/project/${projectId}`)) as {
    id: string
    title: string
    icon_url?: string
    server_side: string
  }
  if (project.server_side === 'unsupported') {
    if (depth > 0) return // optional-platform dependency of something else; skip quietly
    throw new Error(
      `${project.title} is a client-only mod — it can't run on a server. Players add it to their own instances instead.`
    )
  }
  const strict = new URLSearchParams({
    game_versions: JSON.stringify([server.minecraftVersion]),
    loaders: JSON.stringify(targets.loaders)
  })
  let versions = (await modrinthFetch(`/project/${projectId}/version?${strict}`)) as ModrinthVersionLite[]
  if (versions.length === 0 && targets.noun === 'plugin') {
    const loose = new URLSearchParams({ loaders: JSON.stringify(targets.loaders) })
    versions = (await modrinthFetch(`/project/${projectId}/version?${loose}`)) as ModrinthVersionLite[]
  }
  if (versions.length === 0) {
    if (depth > 0) return
    throw new Error(`No ${server.kind}-compatible ${targets.noun} build of ${project.title} for ${server.minecraftVersion}.`)
  }
  const version = versions[0]
  const file = version.files.find((f) => f.primary) ?? version.files[0]

  const dir = join(serverDir(id), targets.dir)
  mkdirSync(dir, { recursive: true })
  await downloadToFile(file.url, join(dir, file.filename))

  const fresh = readServerModsMeta(id)
  fresh[file.filename] = {
    projectId: project.id,
    title: project.title,
    versionNumber: version.version_number,
    iconUrl: project.icon_url
  }
  writeJson(serverModsMetaFile(id), fresh)

  for (const dep of version.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id)) {
    try {
      await installServerMod(id, dep.project_id!, depth + 1)
    } catch (e) {
      console.warn(`Server ${targets.noun} dependency ${dep.project_id} failed:`, e)
    }
  }
}

// ---------- export the matching client modpack ----------

const KIND_TO_DEP: Record<string, string> = {
  fabric: 'fabric-loader',
  forge: 'forge',
  neoforge: 'neoforge'
}

/**
 * Build a .mrpack that players install to join this server: every server mod
 * identifiable on Modrinth becomes a download entry, unknown jars are embedded,
 * and configs travel as overrides — the same strategy as instance exports.
 */
export async function exportServerPack(id: string): Promise<{ ok: boolean; error?: string }> {
  const server = getServer(id)
  const dir = serverDir(id)
  const modsDir = join(dir, 'mods')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export client modpack',
    defaultPath: `${server.name.replace(/[<>:"/\\|?*]/g, '_')}.mrpack`,
    filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }]
  })
  if (canceled || !filePath) return { ok: false, error: 'cancelled' }

  const zip = new AdmZip()
  const jars = existsSync(modsDir) ? readdirSync(modsDir).filter((f) => f.endsWith('.jar')) : []
  const hashed = jars.map((fileName) => {
    const buffer = readFileSync(join(modsDir, fileName))
    return {
      fileName,
      size: buffer.length,
      sha1: createHash('sha1').update(buffer).digest('hex'),
      sha512: createHash('sha512').update(buffer).digest('hex')
    }
  })
  const identified = await lookupModrinthByHash(hashed.map((h) => h.sha1))

  const files: MrpackFile[] = []
  for (const jar of hashed) {
    const match = identified.get(jar.sha1)
    if (match) {
      files.push({
        path: `mods/${jar.fileName}`,
        hashes: { sha1: jar.sha1, sha512: jar.sha512 },
        downloads: [match.url],
        fileSize: jar.size,
        env: { client: 'required', server: 'required' }
      })
    } else {
      // private/unidentifiable jar: it travels inside the pack
      zip.addLocalFile(join(modsDir, jar.fileName), 'overrides/mods')
    }
  }
  const configDir = join(dir, 'config')
  if (existsSync(configDir)) zip.addLocalFolder(configDir, 'overrides/config')

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    name: server.name,
    files,
    dependencies: {
      minecraft: server.minecraftVersion,
      ...(KIND_TO_DEP[server.kind] && server.loaderVersion ? { [KIND_TO_DEP[server.kind]]: server.loaderVersion } : {})
    }
  }
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf-8'))
  zip.writeZip(filePath)
  return { ok: true }
}

// ---------- file manager (strictly scoped to the server folder) ----------

const TEXT_EXTENSIONS = new Set([
  'txt', 'json', 'json5', 'properties', 'toml', 'yml', 'yaml', 'cfg', 'conf', 'log', 'mcmeta', 'snbt', 'md', 'csv', 'tsv', 'bat', 'sh'
])
const MAX_EDIT_BYTES = 512 * 1024

/** Resolve a relative path inside the server folder; anything escaping it is rejected. */
function safePath(id: string, rel: string): string {
  const root = resolve(serverDir(id))
  const target = resolve(root, rel || '.')
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Path escapes the server folder')
  return target
}

export function listServerFiles(id: string, rel: string): ServerFileEntry[] {
  const dir = safePath(id, rel)
  if (!existsSync(dir)) return []
  const entries: ServerFileEntry[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    try {
      const st = statSync(join(dir, e.name))
      entries.push({
        name: e.name,
        isDir: e.isDirectory(),
        sizeBytes: e.isDirectory() ? 0 : st.size,
        modifiedAt: st.mtimeMs
      })
    } catch {
      // file vanished mid-scan (server writing); skip
    }
  }
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

export function readServerFile(id: string, rel: string): { content: string } {
  const file = safePath(id, rel)
  const st = statSync(file)
  if (st.size > MAX_EDIT_BYTES) {
    throw new Error(`This file is too large to edit here (${(st.size / 1024).toFixed(0)} KB). Use Open folder instead.`)
  }
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const buf = readFileSync(file)
  if (!TEXT_EXTENSIONS.has(ext) && buf.includes(0)) {
    throw new Error('This is a binary file — use Open folder to manage it.')
  }
  return { content: buf.toString('utf-8') }
}

export function writeServerFile(id: string, rel: string, content: string): void {
  writeFileSync(safePath(id, rel), content, 'utf-8')
}

export function deleteServerPath(id: string, rel: string): void {
  const target = safePath(id, rel)
  if (target === resolve(serverDir(id))) throw new Error('Cannot delete the server folder itself.')
  rmSync(target, { recursive: true, force: true })
}

// ---------- player lists (whitelist / ops / bans) ----------

export type PlayerFileKind = 'whitelist' | 'ops' | 'banned-players'

function playerFile(id: string, kind: PlayerFileKind): string {
  return join(serverDir(id), `${kind}.json`)
}

export function readPlayerList(id: string, kind: PlayerFileKind): PlayerListEntry[] {
  const raw = readJson<{ name?: string; uuid?: string }[]>(playerFile(id, kind), [])
  return raw.filter((e) => e.name).map((e) => ({ name: e.name!, uuid: e.uuid }))
}

function dashedUuid(uuid: string): string {
  return uuid.includes('-') ? uuid : uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}

/** Add a player to the whitelist: a live server does it itself; a stopped one gets the json edited. */
export async function whitelistAdd(id: string, name: string): Promise<PlayerListEntry[]> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a player name.')
  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    sendServerCommand(id, `whitelist add ${trimmed}`)
    return readPlayerList(id, 'whitelist')
  }
  const player = await searchSkin(trimmed) // resolves the exact name + uuid
  const list = readJson<{ name: string; uuid: string }[]>(playerFile(id, 'whitelist'), [])
  if (!list.some((e) => e.name.toLowerCase() === player.username.toLowerCase())) {
    list.push({ uuid: dashedUuid(player.uuid), name: player.username })
    writeJson(playerFile(id, 'whitelist'), list)
  }
  return readPlayerList(id, 'whitelist')
}

export function whitelistRemove(id: string, name: string): PlayerListEntry[] {
  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    sendServerCommand(id, `whitelist remove ${name}`)
  }
  const list = readJson<{ name: string; uuid?: string }[]>(playerFile(id, 'whitelist'), [])
  writeJson(
    playerFile(id, 'whitelist'),
    list.filter((e) => (e.name ?? '').toLowerCase() !== name.toLowerCase())
  )
  return readPlayerList(id, 'whitelist')
}

/** Console verbs per list. A running server owns its own files, so we go through it. */
const ROSTER_COMMANDS: Record<PlayerFileKind, { add: string; remove: string }> = {
  whitelist: { add: 'whitelist add', remove: 'whitelist remove' },
  ops: { add: 'op', remove: 'deop' },
  'banned-players': { add: 'ban', remove: 'pardon' }
}

/** All three Minecraft player lists in one read, for the panel's Players tab. */
export function readServerRoster(id: string): Record<PlayerFileKind, PlayerListEntry[]> {
  return {
    whitelist: readPlayerList(id, 'whitelist'),
    ops: readPlayerList(id, 'ops'),
    'banned-players': readPlayerList(id, 'banned-players')
  }
}

/**
 * Add or remove a player on any of the three lists.
 *
 * Running servers are told over the console — they hold these files open and
 * would overwrite a direct edit on shutdown. Stopped servers get the json
 * edited directly, which is the case the panel could never handle before.
 */
export async function editServerRoster(
  id: string,
  list: PlayerFileKind,
  op: 'add' | 'remove',
  name: string
): Promise<Record<PlayerFileKind, PlayerListEntry[]>> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a player name.')
  const server = loadServers().find((s) => s.id === id)
  if (server && gameOf(server) !== 'minecraft') {
    throw new Error('Whitelist, ops and bans are Minecraft-only.')
  }

  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    sendServerCommand(id, `${ROSTER_COMMANDS[list][op]} ${trimmed}`)
    // the server rewrites the file itself; give it a beat before reading back
    await sleep(400)
    return readServerRoster(id)
  }

  const file = playerFile(id, list)
  const entries = readJson<Record<string, unknown>[]>(file, [])
  const matches = (e: Record<string, unknown>): boolean =>
    String(e.name ?? '').toLowerCase() === trimmed.toLowerCase()

  if (op === 'remove') {
    writeJson(file, entries.filter((e) => !matches(e)))
    return readServerRoster(id)
  }

  if (entries.some(matches)) return readServerRoster(id)
  // Mojang is the only source of truth for the uuid these files key on
  const player = await searchSkin(trimmed)
  const base = { uuid: dashedUuid(player.uuid), name: player.username }
  if (list === 'ops') entries.push({ ...base, level: 4, bypassesPlayerLimit: false })
  else if (list === 'banned-players') {
    entries.push({ ...base, created: new Date().toISOString(), source: 'ELauncher', expires: 'forever', reason: 'Banned by an operator.' })
  } else entries.push(base)
  writeJson(file, entries)
  return readServerRoster(id)
}

// ---------- backups ----------

/** Recursive byte count, best-effort — an unreadable entry contributes zero rather than throwing. */
function dirSize(path: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      try {
        if (entry.isDirectory()) total += dirSize(child)
        else total += statSync(child).size
      } catch {
        /* vanished mid-walk */
      }
    }
  } catch {
    return 0
  }
  return total
}

export type ServerBackup = { stamp: string; createdAt: string; sizeBytes: number }

/** Newest first — the order a restore list wants. */
export function listServerBackups(id: string): ServerBackup[] {
  const root = join(serverDir(id), 'backups')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(root, e.name)
      const manifest = readJson<Partial<BackupManifest>>(join(dir, BACKUP_MANIFEST), {})
      return {
        stamp: e.name,
        // pre-manifest backups fall back to the folder's own mtime
        createdAt: manifest.createdAt ?? statSync(dir).mtime.toISOString(),
        sizeBytes: dirSize(dir)
      }
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp))
}

/**
 * Put a backup back. Requires the server to be stopped — copying over a live
 * world hands the running process a half-replaced directory, and the shutdown
 * save would then overwrite whatever we just restored.
 */
export async function restoreServerBackup(id: string, stamp: string): Promise<{ ok: true }> {
  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    throw new Error('Stop the server before restoring a backup.')
  }
  const dir = serverDir(id)
  const from = join(dir, 'backups', stamp)
  // reject traversal: the stamp is user input and lands straight in a path
  if (!existsSync(from) || dirname(from) !== join(dir, 'backups')) throw new Error('That backup no longer exists.')

  const manifest = readJson<Partial<BackupManifest>>(join(from, BACKUP_MANIFEST), {})
  const server = loadServers().find((s) => s.id === id)
  // older backups predate the manifest — fall back to where this game keeps saves today
  const sources = manifest.sources ?? (server ? backupSources(server) : [])
  if (sources.length === 0) throw new Error('This backup is missing its manifest and the save location could not be inferred.')

  for (const rel of sources) {
    const src = join(from, basename(rel))
    if (!existsSync(src)) continue
    const dest = join(dir, rel)
    rmSync(dest, { recursive: true, force: true })
    await cp(src, dest, { recursive: true })
  }
  pushLog(id, `[ELauncher] Restored world from backups/${stamp}`)
  return { ok: true }
}

// graceful shutdown: ask every server to save + stop, give it a few seconds, then quit
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || procs.size === 0) return
  quitting = true
  event.preventDefault()
  for (const [id, proc] of procs) {
    try {
      // steam games matter here too: valheim/7dtd ignore stdin `stop`, so
      // without their handle they used to be killed without ever saving
      const handle = palworldHandles.get(id) ?? steamGameHandles.get(id)
      if (handle) handle.stop() // REST save + shutdown, or SIGINT / telnet shutdown
      else proc.stdin?.write('stop\n') // minecraft saves the world on `stop`
    } catch {
      // already dead
    }
  }
  setTimeout(() => {
    for (const proc of procs.values()) {
      try {
        killProcessTree(proc)
      } catch {
        // gone
      }
    }
    app.quit()
  }, 4_000)
})
