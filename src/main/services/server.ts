import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { cp, readdir, readFile } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { cpus, tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { app, dialog, shell } from 'electron'
import AdmZip from 'adm-zip'
import { fetchJavaRuntimeManifest, installJavaRuntimeTask } from '@xmcl/installer'
import type {
  CreateServerOptions,
  ExtraPort,
  LocalServer,
  LocalServerState,
  ModSource,
  PalworldModerationAction,
  PalworldPlayerDetail,
  PlanLimits,
  PlayerListEntry,
  PortStatus,
  ServerAutomation,
  ServerFileEntry,
  ServerGame,
  ServerLogEvent,
  ServerMod,
  ServerPortsView,
  ServerSource,
  ServerStateEvent,
  ServerTaskEvent,
  ServerTimeline,
  TimelineEventKind
} from '@shared/types'
import { archivedServersFile, instanceDir, javaDir, serverArchivesDir, serverDir, serversFile } from '../paths'
import { readJson, writeJson } from '../store'
import { killProcessTree } from './proctree'
import { startSleeper, type SleeperHandle } from './sleeper'
import { addEvent, addSample, flushTimelines, forgetTimeline, readTimeline } from './timeline'
import { downloadAgent, withRetries } from '../net'
import { CF_LOADER_TYPES, curseforgeFetch, downloadToFile, listInstalledMods, modrinthFetch, readModsMeta, type CfAccess } from './mods'
import {
  cfDownloadUrl,
  curseforgeFilesBulk,
  downloadPackToTemp,
  downloadWithRetries,
  forgeCdnUrl,
  lookupModrinthByHash,
  parseCfLoader,
  parseDependencies,
  parseIndex,
  requireCurseforgeKey,
  resolveCurseforgePackDownloads,
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
  valheimWorldExists,
  type SteamGameHandle,
  type SteamGameId
} from './steamgames'
import { STEAM_GAME_INFO } from '@shared/games'
import { closePort, getMapping, isDirectHost } from './upnp'
import {
  MAX_EXTRA_PORTS,
  blockedPortReason,
  closeRules,
  companionPorts,
  mainPortProtocol,
  noteFailure,
  openRules,
  portCautions,
  portKey,
  portPresets,
  statusOf,
  validateRules
} from './ports'
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

/**
 * Relay hook: the cloud panel needs console output as it happens, not on the
 * next heartbeat. services/remote.ts registers itself here.
 *
 * A callback rather than an import because remote.ts already imports this
 * module — going the other way would make a cycle. It receives only the server
 * id; the relay reads the tail through getServerLogs so the buffer stays the
 * single source of truth for what the console contains.
 */
type LogBatchSink = (serverId: string) => void
let logBatchSink: LogBatchSink | null = null

export function onLogBatch(sink: LogBatchSink | null): void {
  logBatchSink = sink
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
        // the desktop window and the cloud panel learn on the same beat
        logBatchSink?.(serverId)
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
  /** CurseForge server pack zip; takes the place of cfZip when the author published one */
  cfServerZip?: AdmZip
  /** instance whose mods/configs get mirrored onto the server */
  instanceId?: string
  /** temp downloads to delete afterwards (cloud/Modrinth/CurseForge fetches) */
  tempZipPaths?: string[]
}

/** CF packs use manifest.json instead of the mrpack index; map it onto a plan. */
function planFromCfZip(zip: AdmZip, cfAccess?: CfAccess): CreationPlan {
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('Not a CurseForge modpack: manifest.json is missing.')
  // every file in a CF manifest resolves through the API, so no key = no pack.
  // Checked here so it fails at the picker, not after the binary is installed.
  // The provisioner supplies proxy access instead of a local key, so skip then.
  if (!cfAccess || cfAccess.mode === 'key') requireCurseforgeKey()
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

/** Non-directory entry names, normalised to forward slashes. */
function zipFileNames(zip: AdmZip): string[] {
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, '/'))
}

/**
 * Plenty of authors wrap a server pack in one folder ("BigPack-1.2.3/"). Returns
 * the prefix to strip, recognised by that folder being the one that holds mods/
 * or config/ — so a zip whose own root is mods/ is left alone.
 */
function serverPackRoot(zip: AdmZip): string {
  const names = zipFileNames(zip)
  const tops = new Set(names.map((n) => n.split('/')[0]))
  if (tops.size !== 1) return ''
  const only = [...tops][0]
  const children = new Set(names.map((n) => n.slice(only.length + 1).split('/')[0]))
  return children.has('mods') || children.has('config') ? `${only}/` : ''
}

/** NeoForge versions are <mc-minor>.<mc-patch>.<build> — 21.1.65 is Minecraft 1.21.1. */
function neoforgeMcVersion(version: string): string {
  const [minor, patch] = version.split('.')
  if (!minor || patch === undefined) throw new Error(`Unrecognised NeoForge version "${version}".`)
  return patch === '0' ? `1.${minor}` : `1.${minor}.${patch}`
}

/**
 * A server pack the user downloaded themselves ("Server Pack" on a CurseForge
 * pack's Files page) carries no manifest, so the loader and versions have to be
 * read off the installer the author bundled — or off the libraries tree, for
 * packs that ship an already-installed server.
 */
function planFromCfServerPackZip(zip: AdmZip): CreationPlan {
  const root = serverPackRoot(zip)
  const names = zipFileNames(zip).map((n) => n.slice(root.length))
  const match = (re: RegExp): RegExpMatchArray | null => {
    for (const name of names) {
      const m = name.match(re)
      if (m) return m
    }
    return null
  }
  const packName = root ? root.slice(0, -1) : undefined

  const forge =
    match(/(?:^|\/)forge-(\d[\d.]*)-([\d.]+(?:-[\w.]+)?)-installer\.jar$/i) ??
    match(/^libraries\/net\/minecraftforge\/forge\/(\d[\d.]*)-([^/]+)\//)
  if (forge) return { kind: 'forge', minecraftVersion: forge[1], loaderVersion: forge[2], packName, cfServerZip: zip }

  const neo =
    match(/(?:^|\/)neoforge-([\d.]+(?:-[\w.]+)?)-installer\.jar$/i) ?? match(/^libraries\/net\/neoforged\/neoforge\/([^/]+)\//)
  if (neo) {
    return { kind: 'neoforge', minecraftVersion: neoforgeMcVersion(neo[1]), loaderVersion: neo[1], packName, cfServerZip: zip }
  }

  const fabric = match(/fabric-server-mc\.([\d.]+[\w.]*)-loader\.([\w.]+)-launcher/)
  if (fabric) return { kind: 'fabric', minecraftVersion: fabric[1], loaderVersion: fabric[2], packName, cfServerZip: zip }

  throw new Error(
    "That looks like a CurseForge server pack, but it doesn't say which loader it needs — no installer and no libraries folder. Host the pack from Browse instead: the launcher resolves the same server pack and reads the version from the pack itself."
  )
}

/**
 * A pack file the user picked themselves, in any of the three shapes: Modrinth
 * exports .mrpack (modrinth.index.json), CurseForge exports .zip
 * (manifest.json), and a CurseForge server pack is a bare .zip of the server
 * itself. Sniff rather than trust the extension — two of the three are plain
 * .zip and plenty of people rename an .mrpack to .zip to get it past a
 * chat/upload filter.
 */
function planFromPackZip(zip: AdmZip): CreationPlan {
  if (zip.getEntry('modrinth.index.json')) return planFromZip(zip)
  if (zip.getEntry('manifest.json')) return planFromCfZip(zip)
  // a CurseForge server pack has no index of any kind — it's the installed server itself
  const root = serverPackRoot(zip)
  if (zipFileNames(zip).some((n) => n.slice(root.length).startsWith('mods/'))) return planFromCfServerPackZip(zip)
  throw new Error(
    'That file is not a modpack export — it has neither modrinth.index.json (Modrinth) nor manifest.json (CurseForge). In the CurseForge app, open the pack and use Export to get an installable zip, or download its Server Pack from the Files page.'
  )
}

/** Resolves the source into a concrete plan. Returns null when the user cancels a file dialog. */
async function planFromSource(source: ServerSource, cfAccess?: CfAccess): Promise<CreationPlan | null> {
  switch (source.type) {
    case 'fresh':
      return { kind: source.kind, minecraftVersion: source.minecraftVersion }
    case 'mrpack': {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a modpack to host',
        filters: [{ name: 'Modpack export (Modrinth or CurseForge)', extensions: ['mrpack', 'zip'] }],
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      return planFromPackZip(new AdmZip(picked.filePaths[0]))
    }
    case 'cloudPack': {
      emitTask('Downloading modpack from the cloud', -1)
      const tmp = await downloadCloudPackToTemp(source.packId, (phase, progress) => emitTask(phase, progress))
      const plan = planFromZip(new AdmZip(tmp))
      plan.tempZipPaths = [tmp]
      return plan
    }
    case 'modrinthPack': {
      emitTask('Resolving modpack on Modrinth', -1)
      const url = await resolveModrinthModpackUrl(source.projectId)
      const tmp = await downloadPackToTemp(url, (phase, progress) => emitTask(phase, progress))
      const plan = planFromZip(new AdmZip(tmp))
      plan.tempZipPaths = [tmp]
      return plan
    }
    case 'curseforgePack': {
      emitTask('Resolving modpack on CurseForge', -1)
      const { clientUrl, serverUrl } = await resolveCurseforgePackDownloads(source.projectId, cfAccess)
      const fetchZip = async (url: string, phase: string, prefix: string): Promise<string> => {
        const tmp = join(tmpdir(), `elauncher-${prefix}-${randomUUID()}.zip`)
        emitTask(phase, -1)
        await downloadToFile(url, tmp, (received, total) => {
          if (total > 0) emitTask(phase, received / total)
        })
        return tmp
      }
      // the client pack is fetched either way: its manifest is the only place the
      // pack's loader version is written down, and a server pack doesn't carry one
      const tmp = await fetchZip(clientUrl, 'Downloading modpack file', 'cfsrv')
      const plan = planFromCfZip(new AdmZip(tmp), cfAccess)
      plan.tempZipPaths = [tmp]
      if (serverUrl) {
        const srv = await fetchZip(serverUrl, 'Downloading server pack', 'cfsrvpack')
        plan.tempZipPaths.push(srv)
        plan.cfServerZip = new AdmZip(srv)
        plan.cfZip = undefined
      }
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
 * Lay a CurseForge server pack onto the server: the zip the app's "Server Pack"
 * button hands out, already stripped of client-only mods and carrying the
 * server's own configs. It's a plain zip — mods/, config/, usually the author's
 * installer and start scripts — so it just gets extracted, minus the pieces the
 * launcher owns: the loader is already installed, `server.jar`'s presence
 * decides how the server is launched, and the run command is built from the
 * server's own memory setting rather than the author's script.
 */
function applyCfServerPackToServer(dir: string, zip: AdmZip): void {
  emitTask('Applying server pack', -1)
  const root = serverPackRoot(zip)
  const skipDirs = ['resourcepacks/', 'shaderpacks/', 'libraries/']
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name.startsWith(root)) continue
    const rel = name.slice(root.length)
    if (!rel || skipDirs.some((d) => rel.startsWith(d))) continue
    // root-level jars are the loader installer / server jar; scripts are launch wrappers
    if (!rel.includes('/') && /\.(jar|bat|sh|ps1|command)$/i.test(rel)) continue
    const dest = resolve(dir, rel)
    if (!dest.startsWith(resolve(dir))) continue
    mkdirSync(dirname(dest), { recursive: true })
    zip.extractEntryTo(entry, dirname(dest), false, true)
  }
}

/**
 * Install a CurseForge pack's files onto the server: every manifest file is
 * resolved through the CF API (with the forgecdn fallback) into mods/, then the
 * overrides folder is applied minus client-only directories. This is the
 * fallback for packs whose author never published a server pack — CF manifests
 * carry no client/server flags, so a client-only mod may need removing via
 * Files if the console complains on first start.
 */
async function applyCfPackToServer(dir: string, zip: AdmZip, cfAccess?: CfAccess): Promise<void> {
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('Not a CurseForge modpack: manifest.json is missing.')
  const manifest = JSON.parse(entry.getData().toString('utf-8')) as CfManifest

  emitTask('Resolving pack files on CurseForge', -1)
  const files = await curseforgeFilesBulk(
    manifest.files.map((f) => f.fileID),
    cfAccess
  )
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
        await downloadWithRetries(cfDownloadUrl(file), join(modsDir, file.fileName))
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

/**
 * `cfAccess` is an internal-only argument (never crosses IPC): the paid-hosting
 * provisioner passes proxy access so a CurseForge modpack order installs through
 * cf-proxy with the shared key. Desktop callers omit it and use the personal
 * key from Settings.
 */
export async function createServer(opts: CreateServerOptions, cfAccess?: CfAccess): Promise<LocalServer | null> {
  if (opts.source.type === 'palworld') return createPalworldServer(opts, opts.source)
  if (opts.source.type === 'steamgame') return createSteamGameServer(opts, opts.source)
  if (!opts.acceptEula) {
    throw new Error('You must accept the Minecraft EULA to run a server.')
  }
  const servers = loadServers()
  try {
    const plan = await planFromSource(opts.source, cfAccess)
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
    const fromPack = Boolean(plan.zip || plan.cfZip || plan.cfServerZip || plan.instanceId)
    const server: LocalServer = {
      id: randomUUID(),
      name,
      kind: plan.kind,
      minecraftVersion: plan.minecraftVersion,
      loaderVersion: plan.loaderVersion,
      packName: fromPack ? plan.packName : undefined,
      port: nextFreePort(servers),
      memoryMax: opts.memoryMax && opts.memoryMax >= 1024 ? opts.memoryMax : fromPack ? 4096 : 2048,
      javaComponent: meta.javaComponent,
      eulaAccepted: true,
      orderId: opts.orderId,
      createdAt: Date.now()
    }

    const dir = serverDir(server.id)
    mkdirSync(dir, { recursive: true })
    try {
      await ensureServerBinary(dir, plan, meta.url, server.javaComponent)
      if (plan.zip) await applyPackToServer(dir, plan.zip)
      if (plan.cfServerZip) applyCfServerPackToServer(dir, plan.cfServerZip)
      else if (plan.cfZip) await applyCfPackToServer(dir, plan.cfZip, cfAccess)
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
      for (const tmp of plan.tempZipPaths ?? []) rmSync(tmp, { force: true })
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

/**
 * Delete just the loader/runtime binaries from a server directory, leaving the
 * world, the mods, the config and every properties/allowlist/op file in place.
 *
 * Everything listed here is regenerated by ensureServerBinary or by the server's
 * own first launch, so a swap can replace the loader under a live world without
 * touching anything a player made. This is the difference between a swap and a
 * rebuild: a rebuild wipes the whole directory, this wipes only the machinery.
 */
function removeLoaderArtifacts(dir: string): void {
  const throwaway = [
    'server.jar', // vanilla / paper / fabric launcher jar
    'libraries', // forge/neoforge install output; also the paper/vanilla unpack cache
    'versions', // paper/vanilla extracted server
    'cache', // paper's mojang-mappings cache
    'run.sh',
    'run.bat',
    'run.cmd',
    'user_jvm_args.txt', // forge/neoforge run scripts
    'fabric-server-launch.jar',
    'fabric-server-launcher.properties'
  ]
  for (const name of throwaway) rmSync(join(dir, name), { recursive: true, force: true })
  // a forge/neoforge install can leave its installer jar and log at the root
  for (const entry of readdirSync(dir)) {
    if (/installer.*\.jar$/i.test(entry) || /\.jar\.log$/i.test(entry)) rmSync(join(dir, entry), { force: true })
  }
}

/**
 * Swap a Minecraft server's loader and/or version WITHOUT resetting player data.
 *
 * Unlike rebuildServer, this keeps the world, the mods, the config and the
 * server.properties/allowlist/op files exactly where they are — it only replaces
 * the loader binaries (server.jar, or the Forge/NeoForge libraries and @args file)
 * with the ones the new loader/version needs. It is the safe path for the common
 * case: bumping a modpack's NeoForge build (e.g. 21.1.72 -> 21.1.235) on the same
 * Minecraft version, where the existing mods and configs stay valid.
 *
 * `loaderVersion` pins the exact loader build; omit it to take the newest that has
 * a working installer. Changing the loader KIND or the Minecraft version keeps the
 * mods too, by design — the panel warns that they may then need updating — because
 * "don't touch my world" is the whole reason this exists.
 *
 * The change bites immediately: the binary on disk is the one the next start runs.
 */
export async function swapServerLoader(
  id: string,
  kind: LocalServer['kind'],
  minecraftVersion: string,
  loaderVersion?: string
): Promise<LocalServer> {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) throw new Error('Server not found')
  if (gameOf(record) !== 'minecraft') throw new Error('Only Minecraft servers have a loader to change.')
  if (!minecraftVersion) throw new Error('Pick a Minecraft version to switch to.')

  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    stopServer(id)
    if (!(await waitForState(id, 'stopped', 60_000))) throw new Error('The server would not stop — try again.')
    await sleep(1_000)
  }

  emitTask(`Switching to ${kind} ${minecraftVersion}`, -1)
  const plan = await planFromSource({ type: 'fresh', kind, minecraftVersion })
  if (!plan) throw new Error('Could not resolve the new server type.')
  if (LOADER_KINDS.has(plan.kind)) {
    const loader = plan.kind as 'fabric' | 'neoforge' | 'forge'
    if (loaderVersion) {
      // the panel offers only builds the host itself listed for this version, so a
      // pinned one is trusted; a bad hand-crafted value surfaces at the download
      plan.loaderVersion = loaderVersion
    } else {
      const versions = await getLoaderVersions(loader, plan.minecraftVersion)
      if (versions.length === 0) throw new Error(`${loader} is not available for Minecraft ${plan.minecraftVersion}.`)
      plan.loaderVersion = await pickInstallableLoaderVersion(loader, plan.minecraftVersion, versions)
    }
  }
  const meta = await mojangServerMeta(plan.minecraftVersion)

  const dir = serverDir(id)
  mkdirSync(dir, { recursive: true }) // it already exists; this only guards a hand-deleted dir
  removeLoaderArtifacts(dir) // wipe ONLY the old binaries — the world, mods and configs stay
  await ensureServerBinary(dir, plan, meta.url, meta.javaComponent)
  if (!existsSync(join(dir, 'eula.txt'))) writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf-8')

  record.kind = kind
  record.minecraftVersion = minecraftVersion
  record.loaderVersion = plan.loaderVersion
  record.javaComponent = meta.javaComponent
  saveServers(servers)
  emitTask(`Switched to ${kind} ${minecraftVersion}`, 1, true)
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
    orderId: opts.orderId,
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

/** Create any registry Steam game server: SteamCMD download + seeded config. */
async function createSteamGameServer(
  opts: CreateServerOptions,
  source: Extract<ServerSource, { type: 'steamgame' }>
): Promise<LocalServer> {
  const spec = STEAM_GAMES[source.game]
  const info = STEAM_GAME_INFO[source.game]
  if (!opts.acceptEula) {
    throw new Error(`You must accept the ${info.label} dedicated server terms to run a server.`)
  }
  const servers = loadServers()
  const name = opts.name.trim() || `My ${info.label} Server`
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
    orderId: opts.orderId,
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
  // drop any buffered timeline first, or the next flush would recreate a file
  // inside the folder we just deleted
  forgetTimeline(serverDir(id))
  await clearSleeper(id)
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
  closeGamePorts(record)
  void closeRules(record.extraPorts ?? [])
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
  if (record) {
    closeGamePorts(record)
    void closeRules(record.extraPorts ?? [])
  }
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
  if (game === 'zomboid') return 'save' // over RCON
  if (game === 'tmodloader') return 'save' // terraria's console, over stdin
  if (game === 'ark' || game === 'arksa') return 'SaveWorld' // over RCON
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
  // a memory-driven restart is the one worth telling apart on the timeline —
  // it is the visible end of a leak the samples were already drawing
  recordEvent(id, /memory/i.test(reason) ? 'oom' : 'restart', reason)
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
  // zomboid's cachedir holds the saves and the .ini both; tModLoader keeps worlds of its own
  else if (gameOf(server) === 'zomboid') rel.push('data')
  else if (gameOf(server) === 'tmodloader') rel.push('Worlds')
  // both ARKs keep worlds, tribes and player profiles under one folder
  else if (gameOf(server) === 'ark' || gameOf(server) === 'arksa') rel.push(join('ShooterGame', 'Saved', 'SavedArks'))
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
  if (auto.sleepWhenEmptyMin && auto.sleepWhenEmptyMin > 0) {
    const idleMs = auto.sleepWhenEmptyMin * 60_000
    // the clock starts now, not at boot: a server that has just come up has had
    // no chance to be joined yet, and sleeping it instantly would fight anyone
    // who is still loading in
    emptySince.set(id, Date.now())
    timers.push(
      setInterval(() => {
        if ((states.get(id) ?? 'stopped') !== 'running') return
        if ((players.get(id)?.size ?? 0) > 0) {
          emptySince.set(id, Date.now())
          return
        }
        const since = emptySince.get(id) ?? Date.now()
        if (Date.now() - since >= idleMs) void sleepServer(id)
      }, 30_000)
    )
  }
  automationTimers.set(id, timers)
}

function stopAutomation(id: string): void {
  for (const timer of automationTimers.get(id) ?? []) clearTimeout(timer)
  automationTimers.delete(id)
}

// ---------- sleep when empty ----------
// An idle server costs its whole memory footprint for nobody. Sleeping stops it
// and leaves a listener on the port that starts it again when someone connects,
// so a box can carry far more servers than it could ever run at once.

/**
 * Note an event on a server's timeline, if it keeps one. Silent no-op otherwise,
 * so callers never have to check the setting themselves.
 */
function recordEvent(id: string, kind: TimelineEventKind, detail: string): void {
  const server = loadServers().find((s) => s.id === id)
  if (!server?.automation?.timeline) return
  addEvent(serverDir(id), kind, detail)
}

/** Everything the panel needs to draw one server's history. */
export function getTimeline(id: string): ServerTimeline {
  return readTimeline(serverDir(id))
}

const sleepers = new Map<string, SleeperHandle>()
/** when each running server last had someone on it — reset on every join */
const emptySince = new Map<string, number>()

export function isSleeping(id: string): boolean {
  return sleepers.has(id)
}

/**
 * Put a server to sleep: stop it, then hold its port.
 *
 * The listener binds only after the game has genuinely exited — bind too early
 * and it loses the race for the port, leaving a server that is neither running
 * nor reachable.
 */
async function sleepServer(id: string): Promise<void> {
  const server = loadServers().find((s) => s.id === id)
  if (!server || sleepers.has(id)) return
  if ((states.get(id) ?? 'stopped') !== 'running') return

  pushLog(id, '[ELauncher] Empty — sleeping to free its memory. It starts again when someone connects.')
  recordEvent(id, 'sleep', 'Slept while empty')
  stopServer(id)
  const stopped = await waitForState(id, 'stopped', 180_000)
  if (!stopped) {
    pushLog(id, "[ELauncher] Sleep cancelled — the server didn't stop in time, so its port is still in use.")
    return
  }
  // a start that arrived while we were stopping wins; never sleep on top of it
  if ((states.get(id) ?? 'stopped') !== 'stopped') return

  const game = gameOf(server)
  const handle = startSleeper({
    port: server.port,
    game: game === 'minecraft' ? 'minecraft' : 'other',
    protocol: mainProtocol(server),
    motd: `${server.name} is asleep · join to wake it (about a minute)`,
    onLog: (line) => pushLog(id, line),
    onWake: () => void wakeServer(id, 'a player connected')
  })
  sleepers.set(id, handle)
  setState(id, 'sleeping')
}

/** Take a server out of sleep and start it for real. */
export async function wakeServer(id: string, why = 'woken'): Promise<void> {
  const handle = sleepers.get(id)
  if (!handle) return
  sleepers.delete(id)
  await handle.stop() // must fully release the port before the game rebinds it
  setState(id, 'stopped')
  pushLog(id, `[ELauncher] Waking up — ${why}`)
  recordEvent(id, 'wake', why)
  try {
    await startServer(id)
  } catch (e) {
    pushLog(id, `[ELauncher] Could not wake: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Drop the listener without starting anything — a deliberate stop while asleep. */
export async function clearSleeper(id: string): Promise<void> {
  const handle = sleepers.get(id)
  if (!handle) return
  sleepers.delete(id)
  await handle.stop()
  emptySince.delete(id)
}

/** Crash follow-up shared by both games' exit paths. */
function handleCrashRestart(id: string): void {
  const server = loadServers().find((s) => s.id === id)
  // recorded before the restartOnCrash check: the crash happened either way, and
  // a timeline that only shows crashes you chose to recover from is a lie
  recordEvent(id, 'crash', 'Server exited unexpectedly')
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

// ---------- extra ports: the ones mods need beyond the game's own ----------

/** Which protocol a game's own port speaks. */
function mainProtocol(server: LocalServer): 'UDP' | 'TCP' {
  return mainPortProtocol(gameOf(server))
}

/**
 * The game's whole port block: its own port plus the per-game neighbors
 * (Valheim's query port, ARK's raw socket and query, Zomboid's second channel).
 * Share, hosting and the firewall treat this list as one unit — a game whose
 * neighbors stay shut is online in the panel and missing from every server
 * browser, which reads as "broken" rather than "misconfigured".
 */
function gamePortRules(server: LocalServer): ExtraPort[] {
  return [
    { port: server.port, protocol: mainProtocol(server), label: 'Game port' },
    ...companionPorts(gameOf(server), server.port)
  ]
}

/** Release the whole block — main mapping and companions — on stop/archive/delete. */
function closeGamePorts(server: LocalServer): void {
  void closePort(server.port, mainProtocol(server))
  const companions = companionPorts(gameOf(server), server.port)
  if (companions.length) void closeRules(companions)
}

/** Firewall pass for the whole block, run at every start (no-op off Linux). */
function ensureGamePortsFirewall(server: LocalServer): void {
  for (const rule of gamePortRules(server)) {
    void ensureFirewallPort(server.id, rule.port, rule.protocol.toLowerCase() as 'tcp' | 'udp')
  }
}

/**
 * Every port already claimed on this machine, minus `exceptId`'s own mod ports
 * (it's re-submitting those). Game ports always count, including its own — a mod
 * port that shadows the game port would fight it for the same mapping.
 */
function takenPorts(exceptId: string): Map<string, string> {
  const taken = new Map<string, string>()
  for (const other of loadServers()) {
    const own = other.id === exceptId
    // the whole block, not just the main port — a mod port that shadows a
    // query/companion port would fight it for the same mapping just the same
    for (const rule of gamePortRules(other)) {
      taken.set(
        portKey(rule.port, rule.protocol),
        own ? "it is part of this server's own game ports" : `"${other.name}" uses it on this machine`
      )
    }
    if (own) continue
    for (const rule of other.extraPorts ?? []) {
      taken.set(portKey(rule.port, rule.protocol), `"${other.name}" uses it for ${rule.label}`)
    }
  }
  return taken
}

/** The game port plus every mod port, with live exposure state, for the panel. */
export function getServerPorts(id: string): ServerPortsView {
  const server = getServer(id)
  const game = gameOf(server)
  // same precedence publicAddress uses; the per-port mapping backstops it, since
  // a mod port can be open while the game port isn't and we still know its IP
  const host = getAssignedHost(id) ?? getSettings().publicHost
  const live = (port: number, protocol: 'UDP' | 'TCP'): Partial<PortStatus> => {
    const status = statusOf(port, protocol)
    const at = host ?? getMapping(port, protocol)?.externalIp
    return { ...status, address: status.open && at ? `${at}:${port}` : undefined }
  }
  return {
    ports: [
      ...gamePortRules(server).map((rule) => ({ ...rule, main: true, ...live(rule.port, rule.protocol) }) as PortStatus),
      ...(server.extraPorts ?? []).map((rule) => ({ ...rule, ...live(rule.port, rule.protocol) }) as PortStatus)
    ],
    presets: portPresets(game, server.port),
    cautions: portCautions(game, server.port),
    direct: isDirectHost(),
    maxExtra: MAX_EXTRA_PORTS
  }
}

/**
 * Replace a server's mod ports. Releases what's gone and opens what's new right
 * away when the server is up — whoever just typed the port wants to know now
 * whether the router took it, not at the next restart. While it's stopped the
 * rules are stored and opened when it starts.
 */
export async function setServerPorts(id: string, raw: unknown): Promise<ServerPortsView> {
  const servers = loadServers()
  const record = servers.find((s) => s.id === id)
  if (!record) throw new Error('Server not found')
  const rules = validateRules(raw, takenPorts(id))
  const previous = record.extraPorts ?? []
  record.extraPorts = rules
  saveServers(servers)
  const kept = new Set(rules.map((r) => portKey(r.port, r.protocol)))
  await closeRules(previous.filter((r) => !kept.has(portKey(r.port, r.protocol))))
  if ((states.get(id) ?? 'stopped') !== 'stopped') await openExtraPorts(record)
  return getServerPorts(id)
}

/**
 * Move a Minecraft server to a different game port.
 *
 * The record's port is the source of truth — the firewall opens it on every start
 * and the join address is built from it — so this checks the new port is free,
 * writes it into server.properties, and lets the change bite on the next start,
 * the same way every other setting in this panel does. Nothing is re-mapped live:
 * a running server can't rebind its port without restarting anyway, and
 * ensureGamePortsFirewall opens whatever the record now holds at the next start.
 *
 * Minecraft only for now. It is the one game whose port is a single value with no
 * query/RCON neighbors, so there is nothing to move alongside it; the other games
 * re-pin a whole port block from the record at launch, and opening that up needs
 * its own validation of the neighbors — a separate change.
 */
export function setServerMainPort(id: string, newPort: number): ServerPortsView {
  const record = getServer(id)
  if (gameOf(record) !== 'minecraft') {
    throw new Error('Changing the port from here is only available for Minecraft servers right now.')
  }
  if (!Number.isInteger(newPort) || newPort < 1024 || newPort > 65535) {
    throw new Error('Enter a port between 1024 and 65535 — anything lower belongs to system services.')
  }
  // the port it already has is not a conflict with itself
  if (newPort === record.port) return getServerPorts(id)
  const blocked = blockedPortReason(newPort)
  if (blocked) {
    throw new Error(`Port ${newPort} is ${blocked}, not a game port — pick one between 1024 and 65535 that nothing else uses.`)
  }
  // every port already claimed on this machine, plus this server's own mod ports —
  // takenPorts omits those (it is built for re-submitting them), but the game port
  // must not land on one and start fighting it for the same mapping
  const taken = takenPorts(id)
  for (const rule of record.extraPorts ?? []) {
    taken.set(portKey(rule.port, rule.protocol), `this server uses it for ${rule.label}`)
  }
  const owner = taken.get(portKey(newPort, mainProtocol(record)))
  if (owner) throw new Error(`Port ${newPort} is already taken — ${owner}. Pick a different port.`)
  // writes server.properties and re-syncs record.port from what it wrote, so the
  // file and the record can never drift apart
  setServerProperties(id, { 'server-port': String(newPort) })
  return getServerPorts(id)
}

/**
 * Map a server's mod ports and say how it went in its console. Mappings are
 * released at every stop, so this runs on each start rather than only when the
 * rules change.
 */
async function openExtraPorts(server: LocalServer): Promise<void> {
  const rules = server.extraPorts ?? []
  if (rules.length === 0) return
  await openRules(rules, server.name)
  // the firewall is checked after the mapping so its verdict wins: on a
  // public-IP host the mapping always "succeeds" and ufw is the real gate
  await Promise.all(
    rules.map(async (rule) => {
      const refused = await ensureFirewallPort(server.id, rule.port, rule.protocol.toLowerCase() as 'tcp' | 'udp')
      if (refused) noteFailure(rule.port, rule.protocol, `The firewall would not open this port — ${refused}`)
    })
  )
  for (const rule of rules) {
    const status = statusOf(rule.port, rule.protocol)
    pushLog(
      server.id,
      status.open
        ? `[ELauncher] Opened ${rule.protocol} port ${rule.port} for ${rule.label}${status.warning ? ` — ${status.warning}` : ''}`
        : `[ELauncher] Could not open ${rule.protocol} port ${rule.port} for ${rule.label}${status.error ? ` — ${status.error}` : ''}`
    )
  }
}

/** Release a server's mod ports, re-read in case they changed while it ran. */
function closeExtraPorts(id: string): void {
  const rules = loadServers().find((s) => s.id === id)?.extraPorts ?? []
  if (rules.length) void closeRules(rules)
}

// ---------- live process stats: memory/cpu sampling + memory guard ----------

const cpuSecondsPrev = new Map<number, { seconds: number; at: number }>()
let sampling = false

/** Resident memory and cumulative CPU time for one server, however many processes it is. */
interface ProcSample {
  memoryBytes: number
  cpuSeconds: number
}

/** One PowerShell call samples every running server's working set + CPU time. */
async function readWindowsSamples(pids: number[]): Promise<Map<number, ProcSample>> {
  const samples = new Map<number, ProcSample>()
  const json = await new Promise<string>((resolvePs, rejectPs) => {
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
    ps.on('error', rejectPs)
    ps.on('exit', () => resolvePs(out.trim()))
  })
  if (!json) return samples
  const parsed = JSON.parse(json) as
    | { Id: number; WorkingSet64: number; CpuSeconds: number }
    | { Id: number; WorkingSet64: number; CpuSeconds: number }[]
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    samples.set(row.Id, { memoryBytes: row.WorkingSet64, cpuSeconds: row.CpuSeconds })
  }
  return samples
}

/**
 * Bytes per memory page, because /proc/<pid>/stat counts RSS in pages. Assuming
 * 4 KiB is right on x86-64 but wrong on the 16 KiB and 64 KiB ARM64 kernels some
 * hosts ship, where it would overstate memory by 4-16x. Derive it instead: our
 * own status reports RSS in kB and statm reports the same figure in pages.
 */
let pageBytes = 0
function linuxPageBytes(): number {
  if (pageBytes > 0) return pageBytes
  pageBytes = 4096
  try {
    const pages = Number(readFileSync('/proc/self/statm', 'utf8').split(' ')[1])
    const kB = Number(/^VmRSS:\s+(\d+) kB/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1])
    if (pages > 0 && kB > 0) pageBytes = Math.round((kB * 1024) / pages)
  } catch {
    // unreadable /proc — 4 KiB is right on every x86-64 kernel
  }
  return pageBytes
}

/**
 * Linux reads /proc directly — no subprocess — and totals each server's whole
 * process tree rather than just the pid we spawned. That part matters: PalServer.sh
 * and the Steam wrappers stay alive as the parent of the real server, so the pid we
 * hold is a shell sitting on a few MB while the game beside it holds gigabytes.
 * Summing double-counts pages shared between parent and child, which for a wrapper
 * and its game is a rounding error.
 */
async function readLinuxSamples(rootPids: number[]): Promise<Map<number, ProcSample>> {
  const samples = new Map<number, ProcSample>()
  const stats = new Map<number, { ppid: number; pages: number; ticks: number }>()
  const children = new Map<number, number[]>()

  await Promise.all(
    (await readdir('/proc')).map(async (name) => {
      const pid = Number(name)
      if (!Number.isInteger(pid) || pid <= 0) return
      let raw: string
      try {
        raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      } catch {
        return // exited between the listing and the read — normal, skip it
      }
      // comm (field 2) is the raw executable name and may hold spaces and
      // brackets, so the numeric fields only line up after the *last* ')'
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(fields[1])
      const ticks = Number(fields[11]) + Number(fields[12]) // utime + stime, in clock ticks
      const pages = Number(fields[21]) // rss
      if (!Number.isFinite(ppid) || !Number.isFinite(ticks) || !Number.isFinite(pages)) return
      stats.set(pid, { ppid, pages, ticks })
      const siblings = children.get(ppid)
      if (siblings) siblings.push(pid)
      else children.set(ppid, [pid])
    })
  )

  for (const root of rootPids) {
    if (!stats.has(root)) continue
    let pages = 0
    let ticks = 0
    const seen = new Set<number>()
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      if (seen.has(pid)) continue // a recycled pid can't send us round in circles
      seen.add(pid)
      const entry = stats.get(pid)
      if (!entry) continue
      pages += entry.pages
      ticks += entry.ticks
      for (const child of children.get(pid) ?? []) stack.push(child)
    }
    // USER_HZ is 100 on every Linux kernel Node runs on
    samples.set(root, { memoryBytes: pages * linuxPageBytes(), cpuSeconds: ticks / 100 })
  }
  return samples
}

/** Sample every running server's memory and CPU, then apply the memory guard. */
async function sampleProcessStats(): Promise<void> {
  const linux = process.platform === 'linux'
  if (sampling || (process.platform !== 'win32' && !linux)) return
  const entries = [...procs.entries()].filter(([, proc]) => proc.pid !== undefined)
  if (entries.length === 0) {
    resourceStats.clear()
    return
  }
  sampling = true
  try {
    const pids = entries.map(([, proc]) => proc.pid as number)
    const samples = linux ? await readLinuxSamples(pids) : await readWindowsSamples(pids)
    // a read that came back with nothing is a failed read, not an idle box —
    // leave the last good numbers up rather than blanking the dashboard
    if (samples.size === 0) return
    const cores = cpus().length || 1
    const now = Date.now()

    for (const [id, proc] of entries) {
      const pid = proc.pid as number
      const sample = samples.get(pid)
      if (!sample) {
        resourceStats.delete(id)
        continue
      }
      const prev = cpuSecondsPrev.get(pid)
      let cpuPercent: number | null = null
      if (prev && now > prev.at) {
        cpuPercent = Math.round(
          Math.max(0, Math.min(100, (((sample.cpuSeconds - prev.seconds) * 1000) / (now - prev.at) / cores) * 100))
        )
      }
      cpuSecondsPrev.set(pid, { seconds: sample.cpuSeconds, at: now })
      const memoryMB = Math.round(sample.memoryBytes / 1048576)
      resourceStats.set(id, { memoryMB, cpuPercent })
      // push fresh stats to the UI (and the phone, via the next heartbeat)
      setState(id, states.get(id) ?? 'running')

      // memory guard: warned restart when the process crosses the configured limit
      const record = loadServers().find((s) => s.id === id)
      // the timeline rides the sampler that already runs, so it costs one array
      // push rather than a second polling loop
      if (record?.automation?.timeline) {
        addSample(serverDir(id), {
          t: now,
          players: players.get(id)?.size ?? 0,
          memMb: memoryMB,
          cpu: cpuPercent
        })
      }
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
// Samples buffer in memory and land on disk here. A minute's worth is a fine
// thing to lose to a hard kill; a write per sample per server is not.
setInterval(() => flushTimelines(), 60_000)
process.on('exit', () => flushTimelines())

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
 * can connect without manual firewall edits.
 *
 * Resolves to null when the port is clear, or to a reason when the rule was
 * refused. A missing ufw is still "clear" — nothing is filtering, so the port is
 * already reachable. A ufw that answers and says no is not: on a public-IP box
 * there is no router mapping in the picture, so this rule is the only thing
 * standing between the port and the internet, and a silent failure there reads
 * as "open" while nobody can connect.
 */
function ensureFirewallPort(id: string, port: number, protocol: 'tcp' | 'udp'): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const proc = spawn('ufw', ['allow', `${port}/${protocol}`])
      let stderr = ''
      proc.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      // ufw not installed — nothing to open, ports are already exposed
      proc.on('error', () => resolve(null))
      proc.on('exit', (code) => {
        if (code === 0) {
          pushLog(id, `[ELauncher] Opened ${protocol.toUpperCase()} port ${port} in the firewall`)
          return resolve(null)
        }
        // the usual causes are running unprivileged or ufw being inactive
        resolve(stderr.trim().split('\n')[0] || `ufw refused the rule (exit code ${code})`)
      })
    } catch {
      resolve(null)
    }
  })
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
  if (game === 'zomboid') return 'MaxPlayers'
  if (game === 'tmodloader') return 'maxplayers'
  // ASE reads this from the ini; ASA ignores it there and takes the cap from
  // -WinLiveMaxPlayers, which startSteamGame builds from this same key
  if (game === 'ark' || game === 'arksa') return 'MaxPlayers'
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
  // pressing Start on a sleeping server is a wake, not an error — drop the
  // listener first so the game can take its port back
  if (sleepers.has(id)) await clearSleeper(id)
  const current = states.get(id) ?? 'stopped'
  if (current !== 'stopped') throw new Error('This server is already running.')
  const server = getServer(id)
  recordEvent(id, 'start', 'Started')
  enforcePlanLimits(server)
  // mod ports are released at every stop, so re-assert them as it comes back up
  void openExtraPorts(server)
  // companion ports follow the game port: when this server is already exposed —
  // a mapping surviving from an earlier share, or a host whose IP is its own —
  // they open with the start rather than waiting for the next share/reconcile
  const companions = companionPorts(gameOf(server), server.port)
  if (companions.length && (isDirectHost() || getMapping(server.port, mainProtocol(server)))) {
    void openRules(companions, server.name)
  }
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
    ensureGamePortsFirewall(server)

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
      closeExtraPorts(id)
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

/** Start a registry Steam game with the shared lifecycle plumbing. */
async function runSteamGameServer(server: LocalServer): Promise<void> {
  const id = server.id
  const game = gameOf(server) as SteamGameId
  const spec = STEAM_GAMES[game]
  const info = STEAM_GAME_INFO[game]
  const dir = serverDir(id)
  logs.set(id, [])
  players.set(id, new Set())
  setState(id, 'starting')
  pushLog(id, `[ELauncher] Starting ${info.label} server on ${spec.protocol} port ${server.port} — first boot can take a few minutes`)
  try {
    const handle = startSteamGame(game, dir, server.port, planCoreList(server), {
      onLog: (line) => pushLog(id, line),
      onReady: () => {
        setState(id, 'running')
        startAutomation(id)
        notifyPhones(server.name, `${info.label} server is online`, `${id}:state`)
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
        closeGamePorts(server)
        closeExtraPorts(id)
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
    ensureGamePortsFirewall(server)
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
        closeGamePorts(server)
        closeExtraPorts(id)
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
    ensureGamePortsFirewall(server)
  } catch (e) {
    setState(id, 'stopped', e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** Graceful stop via the server's own `stop` command, with a kill fallback. */
export function stopServer(id: string): void {
  // stopping a sleeping server means "stay down", so the listener goes too —
  // otherwise the next player to connect would start it right back up
  if (sleepers.has(id)) {
    void clearSleeper(id).then(() => setState(id, 'stopped'))
    return
  }
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
    if (!handle.command) throw new Error(`${STEAM_GAME_INFO[gameOf(record) as SteamGameId].label} has no admin console — manage it through Settings.`)
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

/**
 * Valheim only: has this server's world already been generated? Valheim applies
 * world modifiers while creating a world and never afterwards, so the panel
 * needs this to say whether those fields will do anything.
 */
export function valheimWorldReady(id: string): boolean {
  const record = getServer(id)
  if (gameOf(record) !== 'valheim') return false
  const dir = serverDir(id)
  return valheimWorldExists(dir, getSteamGameSettings('valheim', dir).world)
}

/**
 * Delete a Valheim server's world so the next start generates a fresh one with
 * the chosen modifiers. Valheim bakes modifiers in while creating a world and
 * ignores them from then on, so short of the in-game console this is the only
 * way to change them.
 *
 * The old world is backed up first and a failed backup aborts the whole thing:
 * once the .db is gone there is no other copy of it.
 */
export async function regenerateValheimWorld(
  id: string,
  updates: Record<string, string>
): Promise<{ stamp: string | null; world: string }> {
  const record = getServer(id)
  if (gameOf(record) !== 'valheim') throw new Error('Only Valheim servers generate their world this way.')
  const dir = serverDir(id)

  if ((states.get(id) ?? 'stopped') !== 'stopped') {
    stopServer(id)
    if (!(await waitForState(id, 'stopped', 60_000))) throw new Error('The server would not stop — try again.')
    await sleep(1_000)
  }

  // persist the picks before the old world goes, so the new one is built with them
  const settings = setSteamGameSettings('valheim', dir, updates)
  const world = (settings.world || 'Dedicated').trim()

  let stamp: string | null = null
  if (valheimWorldExists(dir, world)) {
    stamp = (await makeServerBackup(id)).stamp
    pushLog(id, `[ELauncher] Backed up the old world to backups/${stamp}`)
  }

  // walk the folder rather than building paths out of the world name, so a
  // name with path characters in it can't reach outside the save directory
  let removed = 0
  for (const sub of ['worlds_local', 'worlds']) {
    const folder = join(dir, 'save', sub)
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder)) {
      // <world>.db and .fwl, plus the .old copies valheim keeps beside them
      if (entry === world || entry.startsWith(`${world}.`)) {
        rmSync(join(folder, entry), { recursive: true, force: true })
        removed += 1
      }
    }
  }
  pushLog(id, `[ELauncher] Removed ${removed} world file${removed === 1 ? '' : 's'} — "${world}" is generated fresh on the next start`)
  return { stamp, world }
}

export function getServerProperties(id: string): Record<string, string> {
  const record = getServer(id)
  if (isSteamGame(gameOf(record))) return getSteamGameSettings(gameOf(record) as SteamGameId, serverDir(id))
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
    return setSteamGameSettings(gameOf(palworldRecord) as SteamGameId, serverDir(id), updates)
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
  /** which platform it came from; absent on records written before CurseForge support */
  source?: ModSource
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
      iconUrl: record?.iconUrl,
      // pre-CurseForge records are all Modrinth
      source: record ? (record.source ?? 'modrinth') : undefined
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

interface CfFileLite {
  id: number
  fileName: string
  displayName: string
  downloadUrl: string | null
  dependencies: { modId: number; relationType: number }[]
}

type ContentTargets = NonNullable<ReturnType<typeof contentTargets>>

/** One server-side download resolved from either platform. */
interface ResolvedServerMod {
  /** the platform's canonical id, which can differ from the id/slug asked for */
  projectId: string
  fileName: string
  url: string
  title: string
  versionNumber: string
  iconUrl?: string
  /** required dependency project ids, on the same platform */
  dependencies: string[]
}

/**
 * Modrinth resolution. Client-only mods are refused up front instead of
 * crashing the server; plugins fall back to a loaders-only match because they
 * usually support many game versions without listing every one. Returns null
 * when a *dependency* doesn't apply here — that's a skip, not a failure.
 */
async function resolveModrinthServerMod(
  server: LocalServer,
  targets: ContentTargets,
  projectId: string,
  depth: number
): Promise<ResolvedServerMod | null> {
  const project = (await modrinthFetch(`/project/${projectId}`)) as {
    id: string
    title: string
    icon_url?: string
    server_side: string
  }
  if (project.server_side === 'unsupported') {
    if (depth > 0) return null // optional-platform dependency of something else; skip quietly
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
    if (depth > 0) return null
    throw new Error(`No ${server.kind}-compatible ${targets.noun} build of ${project.title} for ${server.minecraftVersion}.`)
  }
  const version = versions[0]
  const file = version.files.find((f) => f.primary) ?? version.files[0]
  return {
    projectId: project.id,
    fileName: file.filename,
    url: file.url,
    title: project.title,
    versionNumber: version.version_number,
    iconUrl: project.icon_url,
    dependencies: version.dependencies
      .filter((d) => d.dependency_type === 'required' && d.project_id)
      .map((d) => d.project_id!)
  }
}

/**
 * CurseForge resolution. CF carries no client/server flag, so unlike Modrinth
 * there's no way to refuse a client-only mod here — one that sneaks in shows up
 * as a crash on the next start and gets removed via Files. Files whose author
 * disabled third-party downloads come back with a null downloadUrl; the CDN
 * path is derivable from the file id, which is what the pack installer uses.
 */
async function resolveCfServerMod(
  server: LocalServer,
  targets: ContentTargets,
  projectId: string,
  depth: number
): Promise<ResolvedServerMod | null> {
  const params = new URLSearchParams({ gameVersion: server.minecraftVersion, pageSize: '1' })
  // bukkit plugins aren't loader-tagged; only the modded kinds take the filter
  if (targets.noun === 'mod' && server.kind !== 'vanilla' && server.kind !== 'paper') {
    params.set('modLoaderType', String(CF_LOADER_TYPES[server.kind]))
  }
  const files = (await curseforgeFetch(`/mods/${projectId}/files?${params}`)) as { data: CfFileLite[] }
  const file = files.data[0]
  if (!file) {
    if (depth > 0) return null
    throw new Error(`No ${server.kind}-compatible ${targets.noun} build for ${server.minecraftVersion} on CurseForge.`)
  }
  const mod = (await curseforgeFetch(`/mods/${projectId}`)) as {
    data: { id: number; name: string; logo?: { thumbnailUrl?: string } }
  }
  return {
    projectId: String(mod.data.id),
    fileName: file.fileName,
    url: file.downloadUrl ?? forgeCdnUrl(file.id, file.fileName),
    title: mod.data.name,
    versionNumber: file.displayName,
    iconUrl: mod.data.logo?.thumbnailUrl,
    dependencies: file.dependencies.filter((d) => d.relationType === 3).map((d) => String(d.modId))
  }
}

/**
 * Install a mod (modded servers) or plugin (Paper) from either platform, plus
 * its required dependencies. A dependency that fails is logged and skipped
 * rather than failing the whole install — half the time it's an optional
 * platform shim the server doesn't need.
 */
export async function installServerMod(
  id: string,
  projectId: string,
  source: ModSource = 'modrinth',
  depth = 0
): Promise<void> {
  if (depth > 5) return
  const server = getServer(id)
  const targets = contentTargets(server)
  if (!targets) {
    throw new Error('Vanilla servers have no mod loader. Use a Paper server for plugins, or Fabric/NeoForge/Forge for mods.')
  }
  const meta = readServerModsMeta(id)
  // ids are only unique per platform, so the same number can mean two things
  if (Object.values(meta).some((m) => m.projectId === projectId && (m.source ?? 'modrinth') === source)) return

  const resolved =
    source === 'curseforge'
      ? await resolveCfServerMod(server, targets, projectId, depth)
      : await resolveModrinthServerMod(server, targets, projectId, depth)
  if (!resolved) return

  const dir = join(serverDir(id), targets.dir)
  mkdirSync(dir, { recursive: true })
  await downloadToFile(resolved.url, join(dir, resolved.fileName))

  const fresh = readServerModsMeta(id)
  fresh[resolved.fileName] = {
    projectId: resolved.projectId,
    title: resolved.title,
    versionNumber: resolved.versionNumber,
    iconUrl: resolved.iconUrl,
    source
  }
  writeJson(serverModsMetaFile(id), fresh)

  for (const dep of resolved.dependencies) {
    try {
      await installServerMod(id, dep, source, depth + 1)
    } catch (e) {
      console.warn(`Server ${targets.noun} dependency ${dep} failed:`, e)
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
/**
 * Ceiling on one upload or download. Bytes travel base64'd through the relay's
 * jsonb column, so this is a patience promise as much as a storage one: the
 * panel moves roughly a megabyte per round trip.
 */
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024
/** Biggest slice one round trip may carry, before base64's 4/3 inflation. */
const MAX_CHUNK_BYTES = 512 * 1024
/** Abandoned uploads (tab closed mid-transfer) are swept once they go cold. */
const UPLOAD_TEMP_TTL_MS = 6 * 60 * 60_000

const fileExt = (path: string): string => (path.includes('.') ? path.split('.').pop()!.toLowerCase() : '')

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
        modifiedAt: st.mtimeMs,
        isText: !e.isDirectory() && TEXT_EXTENSIONS.has(fileExt(e.name)) && st.size <= MAX_EDIT_BYTES
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
    throw new Error(`This file is too large to edit here (${(st.size / 1024).toFixed(0)} KB). Download it instead.`)
  }
  const buf = readFileSync(file)
  if (!TEXT_EXTENSIONS.has(fileExt(file)) && buf.includes(0)) {
    throw new Error('This is a binary file — download it to open it.')
  }
  return { content: buf.toString('utf-8') }
}

export function writeServerFile(id: string, rel: string, content: string): void {
  // the editor refuses to open anything bigger, so it can't legitimately save one either
  if (Buffer.byteLength(content, 'utf-8') > MAX_EDIT_BYTES) throw new Error('That file is too large to save here.')
  writeFileSync(safePath(id, rel), content, 'utf-8')
}

export function deleteServerPath(id: string, rel: string): void {
  const target = safePath(id, rel)
  if (target === resolve(serverDir(id))) throw new Error('Cannot delete the server folder itself.')
  rmSync(target, { recursive: true, force: true })
}

/**
 * Delete many paths in one round trip. One bad entry doesn't strand the rest —
 * the caller gets a per-path tally so the panel can say exactly what survived.
 */
export function deleteServerPaths(id: string, rels: string[]): { deleted: number; failed: { path: string; error: string }[] } {
  const failed: { path: string; error: string }[] = []
  let deleted = 0
  for (const rel of rels) {
    try {
      deleteServerPath(id, rel)
      deleted++
    } catch (e) {
      failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { deleted, failed }
}

export function createServerFolder(id: string, rel: string): void {
  const dir = safePath(id, rel)
  if (dir === resolve(serverDir(id))) throw new Error('Give the folder a name.')
  if (existsSync(dir)) throw new Error('Something with that name is already here.')
  mkdirSync(dir, { recursive: true })
}

/** Rename or move one entry. Same call either way — only the destination differs. */
export function moveServerPath(id: string, from: string, to: string): void {
  const src = safePath(id, from)
  const dest = safePath(id, to)
  const root = resolve(serverDir(id))
  if (src === root) throw new Error('Cannot move the server folder itself.')
  if (dest === root) throw new Error('Give it a name.')
  if (src === dest) return
  if (!existsSync(src)) throw new Error('That file is no longer here.')
  // Windows and macOS match paths case-insensitively, so a pure case change
  // ("Mods" -> "mods") looks like a collision with itself. It isn't.
  if (dest.toLowerCase() !== src.toLowerCase() && existsSync(dest)) {
    throw new Error('Something with that name is already here.')
  }
  if (dest.startsWith(src + sep)) throw new Error('Cannot move a folder inside itself.')
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(src, dest)
}

const uploadTempPath = (uploadId: string): string => join(tmpdir(), `elauncher-upload-${uploadId}`)

/** Drop temp files from uploads that were abandoned rather than committed. */
function sweepStaleUploads(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('elauncher-upload-')) continue
      const path = join(tmpdir(), name)
      try {
        if (Date.now() - statSync(path).mtimeMs > UPLOAD_TEMP_TTL_MS) rmSync(path, { force: true })
      } catch {
        // in use or already gone — leave it
      }
    }
  } catch {
    // sweeping is housekeeping; never let it fail an upload
  }
}

/**
 * One slice of an upload. Slices land at their own offset in a temp file, so
 * they may arrive in any order and the panel can keep several in flight; the
 * separate `final` commit is what moves the finished file into place.
 */
export function uploadServerFileChunk(
  id: string,
  rel: string,
  chunk: { uploadId: string; offset: number; totalBytes: number; data?: string; final?: boolean }
): { received: number; done: boolean } {
  const dest = safePath(id, rel)
  if (dest === resolve(serverDir(id))) throw new Error('Give the file a name.')
  const uploadId = String(chunk.uploadId ?? '').replace(/[^a-zA-Z0-9-]/g, '')
  if (!uploadId) throw new Error('Upload is missing its id.')
  const total = Number(chunk.totalBytes)
  if (!Number.isFinite(total) || total < 0) throw new Error('Upload is missing its size.')
  if (total > MAX_TRANSFER_BYTES) {
    throw new Error(`Uploads here are capped at ${MAX_TRANSFER_BYTES / 1048576} MB — copy anything larger in from the launcher.`)
  }

  const temp = uploadTempPath(uploadId)
  const buf = chunk.data ? Buffer.from(String(chunk.data), 'base64') : Buffer.alloc(0)
  if (buf.length > 0) {
    if (buf.length > MAX_CHUNK_BYTES) throw new Error('Upload slice is too large.')
    const offset = Number(chunk.offset)
    if (!Number.isFinite(offset) || offset < 0 || offset + buf.length > total) {
      throw new Error('Upload slice is out of range.')
    }
    if (offset === 0) sweepStaleUploads()
    const fd = openSync(temp, existsSync(temp) ? 'r+' : 'w')
    try {
      writeSync(fd, buf, 0, buf.length, offset)
    } finally {
      closeSync(fd)
    }
  }
  if (!chunk.final) return { received: buf.length, done: false }

  // an empty file sends no slices at all, so there is nothing to move — just make it
  if (total === 0 && !existsSync(temp)) {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, '')
    return { received: 0, done: true }
  }
  if (!existsSync(temp)) throw new Error('Upload arrived empty — try again.')
  if (statSync(temp).size !== total) {
    rmSync(temp, { force: true })
    throw new Error('Upload arrived incomplete — try again.')
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(temp, dest)
  } catch {
    // the temp folder and the server folder can sit on different drives, where rename fails
    copyFileSync(temp, dest)
    rmSync(temp, { force: true })
  }
  return { received: buf.length, done: true }
}

/** One slice of a download, base64'd. Drives real binary downloads in the panel. */
export function readServerFileChunk(
  id: string,
  rel: string,
  offset: number,
  length: number
): { data: string; size: number; eof: boolean } {
  const file = safePath(id, rel)
  const st = statSync(file)
  if (st.isDirectory()) throw new Error('That is a folder, not a file.')
  if (st.size > MAX_TRANSFER_BYTES) {
    throw new Error(`Downloads here are capped at ${MAX_TRANSFER_BYTES / 1048576} MB — copy anything larger out from the launcher.`)
  }
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), st.size)
  const want = Math.floor(Number(length)) || MAX_CHUNK_BYTES
  const buf = Buffer.alloc(Math.min(Math.max(0, Math.min(want, MAX_CHUNK_BYTES)), st.size - start))
  if (buf.length > 0) {
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
  }
  return { data: buf.toString('base64'), size: st.size, eof: start + buf.length >= st.size }
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
