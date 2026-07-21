import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { Socket } from 'net'
import { randomBytes } from 'crypto'
import AdmZip from 'adm-zip'
import type { SteamServerGame } from '@shared/types'
import { installSteamApp } from './steamcmd'
import { downloadToFile } from './mods'
import { killProcessTree } from './proctree'

/**
 * Generic Steam dedicated-server provider. Palworld came first and has its own
 * module (REST API, ini tuple format); every further Steam game rides this spec
 * table instead — adding one is a new entry plus, at most, a settings seed.
 * Currently Valheim, 7 Days to Die, Project Zomboid and tModLoader; all have
 * native Windows + Linux builds, and all but tModLoader install over SteamCMD
 * anonymously.
 */

const IS_WIN = process.platform === 'win32'

export interface SteamGameSpec {
  label: string
  appId: number
  basePort: number
  /** ports each server claims (game port + query/telnet neighbors) */
  portStep: number
  protocol: 'UDP' | 'TCP'
  /** rough steady-state RAM, used for capacity hints */
  memoryHintMb: number
  /** whether the console accepts commands (7dtd telnet) or is read-only (valheim) */
  hasConsole: boolean
}

/** Record, not a partial: a new SteamServerGame will not compile without an entry. */
export const STEAM_GAMES: Record<SteamServerGame, SteamGameSpec> = {
  valheim: { label: 'Valheim', appId: 896660, basePort: 2456, portStep: 3, protocol: 'UDP', memoryHintMb: 4096, hasConsole: false },
  sdtd: { label: '7 Days to Die', appId: 294420, basePort: 26900, portStep: 4, protocol: 'UDP', memoryHintMb: 8192, hasConsole: true },
  // port+1 is zomboid's second UDP channel, port+2 its RCON — bound to localhost,
  // so the step reserves it rather than exposing it
  zomboid: { label: 'Project Zomboid', appId: 380870, basePort: 16261, portStep: 3, protocol: 'UDP', memoryHintMb: 4096, hasConsole: true },
  // appId is informational here — tModLoader's depots aren't anonymously
  // licensed, so its server comes from GitHub (see installTModLoader)
  tmodloader: { label: 'tModLoader', appId: 1281930, basePort: 7777, portStep: 1, protocol: 'TCP', memoryHintMb: 3072, hasConsole: true }
}

export type SteamGameId = SteamServerGame

/** Asked of raw strings off the wire, so it reads the table rather than a copy of it. */
export function isSteamGame(game: string | undefined): game is SteamGameId {
  return game !== undefined && Object.prototype.hasOwnProperty.call(STEAM_GAMES, game)
}

// ---------- settings ----------
// Each game keeps its settings wherever it already expects them:
//   valheim    launch args only, in a sidecar json we own
//   sdtd       the game's serverconfig.xml <property name value/> lines
//   zomboid    its own <servername>.ini, flat key=value
//   tmodloader serverconfig.txt, also flat key=value

const VALHEIM_FILE = 'elauncher-valheim.json'
const SDTD_CONFIG = 'serverconfig.xml'
const TML_CONFIG = 'serverconfig.txt'
/** Zomboid's own name for the config set; also the .ini's filename. */
const PZ_SERVER_NAME = 'servertest'
/** Launcher-owned zomboid bits that aren't game settings (the admin password). */
const PZ_SIDECAR = 'elauncher-zomboid.json'

/**
 * Zomboid keeps its data under a "cache dir" that defaults to the user's home.
 * Pointing it inside the server folder is what puts the .ini, the saves and the
 * logs where the files tab and the backup job already look — the same reason
 * valheim gets an explicit -savedir.
 */
const pzDataDir = (dir: string): string => join(dir, 'data')
const pzIniPath = (dir: string): string => join(pzDataDir(dir), 'Server', `${PZ_SERVER_NAME}.ini`)

/**
 * Read a flat `key=value` config, preserving nothing but the values — callers
 * that write go through writeFlatConfig, which edits lines in place instead.
 * Splits on the first `=` only, since values legitimately contain them.
 */
function readFlatConfig(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return out
}

/**
 * Merge-write a flat config: existing keys are edited where they sit and new
 * ones appended. Zomboid's .ini is ~150 documented lines that it rewrites
 * itself, so rebuilding the file from a map would throw away its comments and
 * every key we don't model.
 */
function writeFlatConfig(file: string, updates: Record<string, string>): void {
  const pending = new Map(Object.entries(updates))
  const lines = existsSync(file) ? readFileSync(file, 'utf-8').split(/\r?\n/) : []
  const merged = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return line
    const key = trimmed.slice(0, idx).trim()
    if (!pending.has(key)) return line
    const value = pending.get(key)!
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) merged.push(`${key}=${value}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, merged.join('\n').replace(/\n*$/, '\n'), 'utf-8')
}

function valheimDefaults(name: string): Record<string, string> {
  return { name, world: 'Dedicated', password: 'play' + randomBytes(3).toString('hex'), public: 'true' }
}

/**
 * Everything else Valheim accepts on the command line. Each one defaults to
 * unset — blank, or false for a flag — and `valheimExtraArgs` emits nothing for
 * an unset value, so a server that never touches this screen keeps exactly the
 * command line it had before these existed.
 *
 * The Modifier and Key entries are world modifiers, which Valheim only applies
 * while generating a world. Editing them on a server whose world already exists
 * does nothing; `valheimWorldExists` is what lets the panel say so.
 */
function valheimOptionDefaults(): Record<string, string> {
  return {
    Crossplay: 'false',
    SaveIntervalSeconds: '',
    BackupCount: '',
    BackupShortSeconds: '',
    BackupLongSeconds: '',
    ModifierCombat: '',
    ModifierDeathPenalty: '',
    ModifierResources: '',
    ModifierRaids: '',
    ModifierPortals: '',
    KeyNoBuildCost: 'false',
    KeyPlayerEvents: 'false',
    KeyPassiveMobs: 'false',
    KeyNoMap: 'false'
  }
}

/** ELauncher's key -> the name Valheim's `-modifier` expects. */
const VALHEIM_MODIFIERS: Record<string, string> = {
  ModifierCombat: 'combat',
  ModifierDeathPenalty: 'deathpenalty',
  ModifierResources: 'resources',
  ModifierRaids: 'raids',
  ModifierPortals: 'portals'
}

/** ELauncher's key -> the name Valheim's `-setkey` expects. */
const VALHEIM_SETKEYS: Record<string, string> = {
  KeyNoBuildCost: 'nobuildcost',
  KeyPlayerEvents: 'playerevents',
  KeyPassiveMobs: 'passivemobs',
  KeyNoMap: 'nomap'
}

/**
 * The optional half of the launch line — only what the user actually set.
 * Exported so the arg line can be asserted directly: a wrong flag here does not
 * fail loudly, it stops a live server from booting.
 */
export function valheimExtraArgs(settings: Record<string, string>): string[] {
  const args: string[] = []
  const on = (value?: string): boolean => /^true$/i.test(value ?? '')
  const num = (flag: string, value?: string): void => {
    const n = Number(value)
    // blank means "leave it to the game" rather than "zero"
    if ((value ?? '') !== '' && Number.isFinite(n) && n >= 0) args.push(flag, String(Math.round(n)))
  }
  if (on(settings.Crossplay)) args.push('-crossplay')
  num('-saveinterval', settings.SaveIntervalSeconds)
  num('-backups', settings.BackupCount)
  num('-backupshort', settings.BackupShortSeconds)
  num('-backuplong', settings.BackupLongSeconds)
  for (const [key, name] of Object.entries(VALHEIM_MODIFIERS)) {
    const value = (settings[key] ?? '').trim()
    if (value) args.push('-modifier', name, value)
  }
  for (const [key, name] of Object.entries(VALHEIM_SETKEYS)) {
    if (on(settings[key])) args.push('-setkey', name)
  }
  return args
}

/**
 * Has this world already been generated? Valheim writes `<savedir>/worlds_local/
 * <world>.fwl`; older builds used `worlds/`, so both are checked. World
 * modifiers are creation-time only, so this is the difference between the
 * modifier fields meaning something and being decoration.
 */
export function valheimWorldExists(dir: string, world: string): boolean {
  const name = (world || 'Dedicated').trim()
  return ['worlds_local', 'worlds'].some((sub) => existsSync(join(dir, 'save', sub, `${name}.fwl`)))
}

export function getSteamGameSettings(game: SteamGameId, dir: string): Record<string, string> {
  if (game === 'valheim') {
    const file = join(dir, VALHEIM_FILE)
    if (!existsSync(file)) return { ...valheimOptionDefaults(), ...valheimDefaults('Valheim Server') }
    try {
      // options merge *under* the saved file, so a server made before they
      // existed gains the fields unset without any saved value being touched
      return { ...valheimOptionDefaults(), ...(JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>) }
    } catch {
      return { ...valheimOptionDefaults(), ...valheimDefaults('Valheim Server') }
    }
  }
  if (game === 'zomboid') return readFlatConfig(pzIniPath(dir))
  if (game === 'tmodloader') return readFlatConfig(join(dir, TML_CONFIG))
  const file = join(dir, SDTD_CONFIG)
  if (!existsSync(file)) return {}
  const props: Record<string, string> = {}
  for (const m of readFileSync(file, 'utf-8').matchAll(/<property\s+name="([^"]+)"\s+value="([^"]*)"/g)) {
    props[m[1]] = m[2]
  }
  return props
}

export function setSteamGameSettings(game: SteamGameId, dir: string, updates: Record<string, string>): Record<string, string> {
  if (game === 'valheim') {
    const merged = { ...getSteamGameSettings('valheim', dir), ...updates }
    // valheim hard rules: password ≥5 chars and not contained in the server name
    if ((merged.password ?? '').length > 0 && merged.password.length < 5) {
      throw new Error('Valheim requires a join password of at least 5 characters.')
    }
    if (merged.password && merged.name?.toLowerCase().includes(merged.password.toLowerCase())) {
      throw new Error("Valheim refuses passwords contained in the server name — pick a different one.")
    }
    writeFileSync(join(dir, VALHEIM_FILE), JSON.stringify(merged, null, 2), 'utf-8')
    return merged
  }
  if (game === 'zomboid') {
    writeFlatConfig(pzIniPath(dir), updates)
    return getSteamGameSettings('zomboid', dir)
  }
  if (game === 'tmodloader') {
    writeFlatConfig(join(dir, TML_CONFIG), updates)
    return getSteamGameSettings('tmodloader', dir)
  }
  const file = join(dir, SDTD_CONFIG)
  let xml = existsSync(file) ? readFileSync(file, 'utf-8') : '<?xml version="1.0"?>\n<ServerSettings>\n</ServerSettings>\n'
  for (const [key, value] of Object.entries(updates)) {
    const line = `<property name="${key}" value="${String(value).replace(/"/g, '&quot;')}"/>`
    const re = new RegExp(`<property\\s+name="${key}"\\s+value="[^"]*"\\s*/>`)
    xml = re.test(xml) ? xml.replace(re, line) : xml.replace(/<\/ServerSettings>/, `  ${line}\n</ServerSettings>`)
  }
  writeFileSync(file, xml, 'utf-8')
  return getSteamGameSettings('sdtd', dir)
}

/**
 * The binary or launch script for each game. Zomboid and tModLoader ship
 * wrapper scripts that set up their own runtimes — the raw jar/dll underneath
 * will not start on its own, so these are the real entry points.
 */
function serverExe(game: SteamGameId, dir: string): string {
  const names: Record<SteamGameId, [win: string, unix: string]> = {
    valheim: ['valheim_server.exe', 'valheim_server.x86_64'],
    sdtd: ['7DaysToDieServer.exe', '7DaysToDieServer.x86_64'],
    zomboid: ['StartServer64.bat', 'start-server.sh'],
    tmodloader: ['start-tModLoaderServer.bat', 'start-tModLoaderServer.sh']
  }
  return join(dir, names[game][IS_WIN ? 0 : 1])
}

// ---------- source rcon (zomboid) ----------
// Zomboid has no telnet channel like 7dtd; its admin channel is Source RCON, a
// length-prefixed binary protocol. Worth the ~50 lines: it gives the player
// list and a clean shutdown that saves, neither of which its log reliably does.

const RCON_AUTH = 3
const RCON_EXEC = 2

function rconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf-8')
  const buf = Buffer.alloc(payload.length + 14)
  buf.writeInt32LE(payload.length + 10, 0) // length excludes itself
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeInt16LE(0, payload.length + 12) // body terminator + packet terminator
  return buf
}

interface RconChannel {
  send: (command: string, onReply?: (body: string) => void) => void
  close: () => void
}

/**
 * Connect, authenticate, and hand back a command channel. `onReady` fires only
 * after the password is accepted, which doubles as a readiness signal — the
 * port does not answer until the world is loaded.
 */
function rconConnect(
  port: number,
  password: string,
  handlers: { onReady: () => void; onClose: () => void }
): RconChannel {
  const sock = new Socket()
  const waiting = new Map<number, (body: string) => void>()
  let nextId = 2
  let authed = false
  let buf = Buffer.alloc(0)

  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    // frames can split or coalesce across reads, so drain whole packets only
    while (buf.length >= 12) {
      const size = buf.readInt32LE(0)
      if (buf.length < size + 4) break
      const id = buf.readInt32LE(4)
      const body = buf.subarray(12, Math.max(12, size + 2)).toString('utf-8').replace(/\0+$/, '')
      buf = buf.subarray(size + 4)
      if (!authed) {
        // id -1 is a rejected password; anything else means we're in
        if (id === -1) {
          sock.destroy()
          return
        }
        authed = true
        handlers.onReady()
        continue
      }
      const reply = waiting.get(id)
      if (reply) {
        waiting.delete(id)
        reply(body)
      }
    }
  })
  sock.on('error', () => sock.destroy())
  sock.on('close', () => handlers.onClose())
  sock.connect(port, '127.0.0.1', () => sock.write(rconPacket(1, RCON_AUTH, password)))

  return {
    send: (command, onReply) => {
      if (!authed || sock.destroyed) return
      const id = nextId++
      if (onReply) waiting.set(id, onReply)
      sock.write(rconPacket(id, RCON_EXEC, command))
    },
    close: () => sock.destroy()
  }
}

// ---------- install ----------

export interface SteamGameCreateSettings {
  serverName: string
  serverPassword?: string
  maxPlayers?: number
  port: number
}

/**
 * tModLoader is the one game here SteamCMD cannot fetch: its depots need a
 * Terraria licence, so an anonymous `app_update 1281930` installs nothing while
 * still reporting success. Its dedicated server ships as a single zip on the
 * team's own GitHub releases — the same source tModLoader's bundled
 * DedicatedServerUtils script uses — which carries the launch scripts and
 * serverconfig.txt the rest of this module already expects.
 *
 * Deliberately unpinned: players connect with whatever tModLoader Steam gave
 * them, and a server on an older build refuses them outright.
 */
const TML_RELEASE_URL = 'https://github.com/tModLoader/tModLoader/releases/latest/download/tModLoader.zip'

async function installTModLoader(dir: string, onProgress: (phase: string, progress: number) => void): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'tModLoader-download.zip')
  onProgress('Downloading tModLoader server', -1)
  await downloadToFile(TML_RELEASE_URL, archive, (received, total) => {
    if (total > 0) onProgress('Downloading tModLoader server', received / total)
  })
  onProgress('Extracting tModLoader server', -1)
  try {
    new AdmZip(archive).extractAllTo(dir, true)
  } finally {
    rmSync(archive, { force: true })
  }
}

export async function installSteamGame(
  game: SteamGameId,
  dir: string,
  settings: SteamGameCreateSettings,
  onProgress: (phase: string, progress: number) => void
): Promise<void> {
  if (game === 'tmodloader') await installTModLoader(dir, onProgress)
  else await installSteamApp(STEAM_GAMES[game].appId, dir, onProgress)
  onProgress('Writing server configuration', -1)
  if (game === 'valheim') {
    if (!existsSync(join(dir, IS_WIN ? 'valheim_server.exe' : 'valheim_server.x86_64'))) {
      throw new Error('Valheim server files did not install correctly — retry the install.')
    }
    setSteamGameSettings('valheim', dir, {
      ...valheimDefaults(settings.serverName),
      name: settings.serverName,
      ...(settings.serverPassword && settings.serverPassword.length >= 5 ? { password: settings.serverPassword } : {})
    })
  } else if (game === 'zomboid') {
    if (!existsSync(serverExe(game, dir))) {
      throw new Error('Project Zomboid server files did not install correctly — retry the install.')
    }
    // Zomboid asks for an admin password on the console at first boot and blocks
    // there forever if nobody answers, which on a headless host is a hang. The
    // password is generated once and passed on every launch instead.
    writeFileSync(join(dir, PZ_SIDECAR), JSON.stringify({ adminPassword: randomBytes(9).toString('base64url') }, null, 2), 'utf-8')
    setSteamGameSettings('zomboid', dir, {
      PublicName: settings.serverName,
      Password: settings.serverPassword ?? '',
      MaxPlayers: String(settings.maxPlayers ?? 8),
      DefaultPort: String(settings.port),
      UDPPort: String(settings.port + 1),
      RCONPort: String(settings.port + 2),
      RCONPassword: randomBytes(9).toString('base64url'),
      Public: 'false',
      PauseEmpty: 'true'
    })
  } else if (game === 'tmodloader') {
    if (!existsSync(serverExe(game, dir))) {
      throw new Error('tModLoader server files did not install correctly — retry the install.')
    }
    // world= names a file that does not exist yet; with autocreate set, the
    // server generates it on first boot instead of prompting for a world
    const worldName = (settings.serverName || 'World').replace(/[^\w -]/g, '').trim() || 'World'
    setSteamGameSettings('tmodloader', dir, {
      world: join(dir, 'Worlds', `${worldName}.wld`),
      worldpath: join(dir, 'Worlds'),
      worldname: worldName,
      autocreate: '3',
      difficulty: '0',
      maxplayers: String(settings.maxPlayers ?? 8),
      port: String(settings.port),
      password: settings.serverPassword ?? '',
      motd: `Welcome to ${settings.serverName}`,
      secure: '1'
    })
  } else {
    if (!existsSync(join(dir, IS_WIN ? '7DaysToDieServer.exe' : '7DaysToDieServer.x86_64'))) {
      throw new Error('7 Days to Die server files did not install correctly — retry the install.')
    }
    setSteamGameSettings('sdtd', dir, {
      ServerName: settings.serverName,
      ServerPassword: settings.serverPassword ?? '',
      ServerMaxPlayerCount: String(settings.maxPlayers ?? 8),
      ServerPort: String(settings.port),
      TelnetEnabled: 'true',
      TelnetPort: String(settings.port + 3),
      TelnetPassword: randomBytes(9).toString('base64url'),
      UserDataFolder: join(dir, 'UserData'),
      EACEnabled: 'true'
    })
  }
}

// ---------- run ----------

export interface SteamGameHandle {
  proc: ChildProcess
  stop: () => void
  /** games with an admin channel: 7dtd telnet, zomboid RCON, tModLoader stdin */
  command?: (cmd: string) => void
}

export interface SteamGameRunCallbacks {
  onLog: (line: string) => void
  onReady: () => void
  onPlayers: (names: string[]) => void
  onExit: (code: number | null) => void
}

export function startSteamGame(
  game: SteamGameId,
  dir: string,
  port: number,
  cpuList: string | null,
  cb: SteamGameRunCallbacks
): SteamGameHandle {
  const settings = getSteamGameSettings(game, dir)
  let exe: string
  let args: string[]
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (game === 'zomboid') {
    exe = serverExe(game, dir)
    let adminPassword = ''
    try {
      adminPassword = (JSON.parse(readFileSync(join(dir, PZ_SIDECAR), 'utf-8')) as { adminPassword?: string }).adminPassword ?? ''
    } catch {
      // sidecar lost: zomboid keeps the admin account it already made, and the
      // console prompt only appears when there isn't one, so this stays headless
    }
    args = [
      `-cachedir=${pzDataDir(dir)}`,
      '-servername', PZ_SERVER_NAME,
      ...(adminPassword ? ['-adminpassword', adminPassword] : [])
    ]
  } else if (game === 'tmodloader') {
    exe = serverExe(game, dir)
    // -config carries every setting; without it the server prompts for a world
    args = ['-config', join(dir, TML_CONFIG), '-tmlsavedirectory', join(dir, 'tmodloader'), '-nosteam']
  } else if (game === 'valheim') {
    exe = join(dir, IS_WIN ? 'valheim_server.exe' : 'valheim_server.x86_64')
    args = [
      '-nographics', '-batchmode',
      '-name', settings.name || 'Valheim Server',
      '-port', String(port),
      '-world', settings.world || 'Dedicated',
      ...(settings.password ? ['-password', settings.password] : []),
      '-public', /^true$/i.test(settings.public ?? 'true') ? '1' : '0',
      '-savedir', join(dir, 'save'), // keep worlds inside the server folder (files tab, backups)
      ...valheimExtraArgs(settings)
    ]
    env.SteamAppId = '892970'
    if (!IS_WIN) env.LD_LIBRARY_PATH = `${join(dir, 'linux64')}:${env.LD_LIBRARY_PATH ?? ''}`
  } else {
    // keep the record's port authoritative even if the xml was hand-edited
    setSteamGameSettings('sdtd', dir, { ServerPort: String(port), TelnetEnabled: 'true', TelnetPort: String(port + 3) })
    exe = join(dir, IS_WIN ? '7DaysToDieServer.exe' : '7DaysToDieServer.x86_64')
    args = ['-quit', '-batchmode', '-nographics', '-dedicated', `-configfile=${SDTD_CONFIG}`, '-logfile', IS_WIN ? '-' : '/dev/stdout']
  }

  // steamcmd doesn't reliably keep the +x bit on the wrapper scripts these two ship
  if (!IS_WIN && (game === 'zomboid' || game === 'tmodloader')) {
    try {
      chmodSync(exe, 0o755)
    } catch {
      // already executable, or not ours to change — the spawn error will say
    }
  }

  let [spawnExe, spawnArgs] = [exe, args]
  if (!IS_WIN && cpuList) {
    cb.onLog(`[ELauncher] CPU pinned to ${cpuList.split(',').length} cores (plan limit)`)
    ;[spawnExe, spawnArgs] = ['taskset', ['-c', cpuList, exe, ...args]]
  }
  const proc = spawn(spawnExe, spawnArgs, { cwd: dir, windowsHide: true, detached: !IS_WIN, env })

  let exited = false
  let ready = false
  const names: string[] = []
  let connections = 0
  const timers: NodeJS.Timeout[] = []

  const markReady = (): void => {
    if (ready) return
    ready = true
    cb.onLog(`[ELauncher] ${STEAM_GAMES[game].label} server is up`)
    cb.onReady()
  }

  const onLine = (line: string): void => {
    cb.onLog(line)
    if (game === 'valheim') {
      if (!ready && /Game server connected/i.test(line)) markReady()
      if (/Got connection SteamID/i.test(line)) connections++
      if (/Closing socket/i.test(line) && connections > 0) connections--
      const zdoid = line.match(/Got character ZDOID from ([^\s:]+)/)
      if (zdoid && !names.includes(zdoid[1])) names.push(zdoid[1])
      while (names.length > connections) names.shift() // best effort — valheim never logs who left
      cb.onPlayers([...names])
    } else if (game === 'zomboid') {
      // the authoritative readiness signal is RCON accepting the password
      // below; this only catches it sooner when the banner does appear
      if (!ready && /SERVER STARTED/i.test(line)) markReady()
    } else if (game === 'tmodloader') {
      if (!ready && /Server started/i.test(line)) markReady()
      // terraria announces both sides of a session on the console
      const joined = line.match(/^(.+?) has joined\.?$/)
      if (joined && !names.includes(joined[1])) {
        names.push(joined[1])
        cb.onPlayers([...names])
      }
      const left = line.match(/^(.+?) has left\.?$/)
      if (left && names.includes(left[1])) {
        names.splice(names.indexOf(left[1]), 1)
        cb.onPlayers([...names])
      }
    } else if (!ready && /(GameServer\.Init successful|StartGame done)/i.test(line)) {
      markReady()
    }
  }
  let buf = ''
  const onChunk = (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    let idx: number
    while ((idx = buf.search(/[\r\n]/)) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) onLine(line)
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  // ---- 7dtd telnet admin channel (localhost only) ----
  let telnet: Socket | null = null
  const telnetSend = (cmd: string): void => {
    if (telnet && !telnet.destroyed) telnet.write(cmd + '\n')
  }
  if (game === 'sdtd') {
    const connectTelnet = (): void => {
      if (exited) return
      const sock = new Socket()
      sock.connect(port + 3, '127.0.0.1', () => {
        telnet = sock
        const pass = getSteamGameSettings('sdtd', dir).TelnetPassword
        if (pass) sock.write(pass + '\n')
      })
      sock.on('data', (d) => {
        // player list answers: "1. id=171, PlayerName, pos=…"
        const listed = [...d.toString().matchAll(/^\d+\. id=\d+, ([^,]+),/gm)].map((m) => m[1])
        if (listed.length || /Total of 0 in the game/.test(d.toString())) cb.onPlayers(listed)
      })
      sock.on('error', () => sock.destroy())
      sock.on('close', () => {
        telnet = null
        if (!exited) timers.push(setTimeout(connectTelnet, 10_000))
      })
    }
    timers.push(setTimeout(connectTelnet, 20_000))
    timers.push(setInterval(() => telnetSend('lp'), 15_000))
  }

  // ---- zomboid rcon admin channel (localhost only) ----
  let rcon: RconChannel | null = null
  const rconSend = (cmd: string, onReply?: (body: string) => void): void => rcon?.send(cmd, onReply)
  if (game === 'zomboid') {
    const rconPort = Number(settings.RCONPort) || port + 2
    const rconPassword = settings.RCONPassword ?? ''
    // "Players connected (2):" then one "-name" per line
    const readPlayers = (body: string): void => {
      cb.onPlayers(
        body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('-'))
          .map((l) => l.slice(1).trim())
          .filter(Boolean)
      )
    }
    const connectRcon = (): void => {
      if (exited || !rconPassword) return
      rcon = rconConnect(rconPort, rconPassword, {
        onReady: () => {
          // the port refuses the password until the world is loaded, so getting
          // in is the most reliable "this server is actually up" we have
          markReady()
          rconSend('players', readPlayers)
        },
        onClose: () => {
          rcon = null
          if (!exited) timers.push(setTimeout(connectRcon, 10_000))
        }
      })
    }
    timers.push(setTimeout(connectRcon, 20_000))
    // pushed once, not per connection, so reconnects don't stack pollers
    timers.push(setInterval(() => rconSend('players', readPlayers), 15_000))
  }

  proc.on('exit', (code) => {
    exited = true
    telnet?.destroy()
    rcon?.close()
    for (const t of timers) clearTimeout(t as NodeJS.Timeout)
    cb.onExit(code)
  })
  proc.on('error', (err) => {
    exited = true
    for (const t of timers) clearTimeout(t as NodeJS.Timeout)
    cb.onLog(`[ELauncher] Failed to start: ${err}`)
    cb.onExit(null)
  })

  const stop = (): void => {
    if (game === 'sdtd' && telnet) {
      telnetSend('shutdown') // saves and exits cleanly
    } else if (game === 'zomboid' && rcon) {
      rconSend('quit') // saves every player and the world, then exits
    } else if (game === 'tmodloader' && proc.stdin?.writable) {
      proc.stdin.write('exit\n') // terraria's console: save and shut down
    } else if (!IS_WIN && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGINT') // valheim saves the world on SIGINT
      } catch {
        proc.kill('SIGINT')
      }
    }
    setTimeout(() => {
      if (!exited) killProcessTree(proc)
    }, 25_000)
  }

  const command =
    game === 'sdtd' ? telnetSend
    : game === 'zomboid' ? (cmd: string) => rconSend(cmd, (body) => body.split(/\r?\n/).forEach((l) => l && cb.onLog(l)))
    : game === 'tmodloader' ? (cmd: string) => { if (proc.stdin?.writable) proc.stdin.write(cmd + '\n') }
    : undefined

  return { proc, stop, ...(command ? { command } : {}) }
}
