import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { installSteamApp } from './steamcmd'

/**
 * Palworld dedicated server provider. Pocketpair ships the server free via
 * SteamCMD (anonymous login, app 2394010). Configuration lives in a single
 * `OptionSettings=(...)` line, and a localhost REST API (basic auth, user
 * "admin") drives players/save/shutdown — which is how we get graceful stops
 * and live player lists out of an otherwise quiet Unreal server process.
 */

export const PALWORLD_APP_ID = 2394010
/** Game traffic is UDP on this port; the REST API sits on gamePort+1 (TCP, localhost). */
export const PALWORLD_BASE_PORT = 8211
/** Allocate palworld ports two apart so every server's REST port (port+1) stays free. */
export const PALWORLD_PORT_STEP = 2

const IS_WIN = process.platform === 'win32'
// SteamCMD app 2394010 ships a Windows and a Linux build; paths and the config
// folder (WindowsServer vs LinuxServer) differ. On Linux we launch the provided
// PalServer.sh, which sets up the Steam runtime before exec'ing the binary.
const SHIPPING_EXE = IS_WIN
  ? join('Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping.exe')
  : join('Pal', 'Binaries', 'Linux', 'PalServer-Linux-Shipping')
const LAUNCH_SCRIPT = IS_WIN ? 'PalServer.exe' : 'PalServer.sh'
const CONFIG_REL = join('Pal', 'Saved', 'Config', IS_WIN ? 'WindowsServer' : 'LinuxServer', 'PalWorldSettings.ini')
const TEMPLATE_REL = 'DefaultPalWorldSettings.ini'
const SECTION_HEADER = '[/Script/Pal.PalGameWorldSettings]'

// ---------- PalWorldSettings.ini (OptionSettings tuple) ----------

/**
 * Split "a=1,b="x, y",c=(p,q),d=True" on top-level commas, honoring quotes,
 * \" escapes, and nested parens (e.g. CrossplayPlatforms=(Steam,Xbox,PS5,Mac) —
 * one mangled member makes Unreal discard the whole OptionSettings struct).
 */
function splitTuple(body: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && inQuotes && i + 1 < body.length) {
      current += ch + body[i + 1]
      i++
      continue
    }
    if (ch === '"') inQuotes = !inQuotes
    if (!inQuotes) {
      if (ch === '(') depth++
      else if (ch === ')') depth = Math.max(0, depth - 1)
    }
    if (ch === ',' && !inQuotes && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

interface ParsedSettings {
  /** key -> value with surrounding quotes stripped */
  entries: Record<string, string>
  /** keys whose values were quoted in the source (kept quoted on save) */
  quoted: Set<string>
}

function parseOptionSettings(text: string): ParsedSettings {
  const entries: Record<string, string> = {}
  const quoted = new Set<string>()
  const m = text.match(/OptionSettings=\((.*)\)/)
  if (!m) return { entries, quoted }
  for (const part of splitTuple(m[1])) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    let value = part.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      quoted.add(key)
      value = value.slice(1, -1).replace(/\\"/g, '"')
    }
    entries[key] = value
  }
  return { entries, quoted }
}

/** Values that aren't bare numbers/booleans/enum tokens must be quoted for the engine. */
function needsQuotes(value: string): boolean {
  if (value.startsWith('(') && value.endsWith(')')) return false // nested tuple/list — never quote
  return !/^-?\d+(\.\d+)?$/.test(value) && !/^(True|False|None)$/i.test(value) && !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)
}

function serializeOptionSettings(parsed: ParsedSettings): string {
  const parts = Object.entries(parsed.entries).map(([key, value]) => {
    const quote = parsed.quoted.has(key) || needsQuotes(value)
    return `${key}=${quote ? `"${value.replace(/"/g, '\\"')}"` : value}`
  })
  return `${SECTION_HEADER}\nOptionSettings=(${parts.join(',')})\n`
}

function configPath(dir: string): string {
  return join(dir, CONFIG_REL)
}

/** Heal values an earlier launcher build mangled (nested tuples split at commas). */
function repairMangledValues(parsed: ParsedSettings, dir: string): void {
  const broken = Object.keys(parsed.entries).filter((key) => {
    const value = parsed.entries[key]
    return (value.match(/\(/g) ?? []).length !== (value.match(/\)/g) ?? []).length
  })
  if (broken.length === 0) return
  const templatePath = join(dir, TEMPLATE_REL)
  const template = existsSync(templatePath) ? parseOptionSettings(readFileSync(templatePath, 'utf-8')) : null
  for (const key of broken) {
    if (template && key in template.entries) {
      parsed.entries[key] = template.entries[key]
      if (template.quoted.has(key)) parsed.quoted.add(key)
      else parsed.quoted.delete(key)
    } else {
      // no clean source — drop the key so the engine falls back to its default
      delete parsed.entries[key]
      parsed.quoted.delete(key)
    }
  }
}

/** Read settings, seeding the live config from Pocketpair's template on first touch. */
function readSettings(dir: string): ParsedSettings {
  const file = configPath(dir)
  if (existsSync(file)) {
    const parsed = parseOptionSettings(readFileSync(file, 'utf-8'))
    if (Object.keys(parsed.entries).length > 0) {
      repairMangledValues(parsed, dir)
      return parsed
    }
  }
  const template = join(dir, TEMPLATE_REL)
  if (existsSync(template)) return parseOptionSettings(readFileSync(template, 'utf-8'))
  return { entries: {}, quoted: new Set() }
}

export function getPalworldSettings(dir: string): Record<string, string> {
  return readSettings(dir).entries
}

export function setPalworldSettings(dir: string, updates: Record<string, string>): Record<string, string> {
  const parsed = readSettings(dir)
  for (const [key, value] of Object.entries(updates)) parsed.entries[key] = value
  mkdirSync(dirname(configPath(dir)), { recursive: true })
  writeFileSync(configPath(dir), serializeOptionSettings(parsed), 'utf-8')
  return parsed.entries
}

// ---------- install ----------

export interface PalworldCreateSettings {
  serverName: string
  serverPassword?: string
  maxPlayers?: number
  port: number
}

export async function installPalworld(
  dir: string,
  settings: PalworldCreateSettings,
  onProgress: (phase: string, progress: number) => void
): Promise<void> {
  await installSteamApp(PALWORLD_APP_ID, dir, onProgress)
  if (!existsSync(join(dir, SHIPPING_EXE)) && !existsSync(join(dir, LAUNCH_SCRIPT))) {
    throw new Error('Palworld server files did not install correctly — retry the install.')
  }
  onProgress('Writing server configuration', -1)
  setPalworldSettings(dir, {
    ServerName: settings.serverName,
    ServerPassword: settings.serverPassword ?? '',
    ServerPlayerMaxNum: String(settings.maxPlayers ?? 16),
    AdminPassword: randomBytes(9).toString('base64url'),
    PublicPort: String(settings.port),
    RESTAPIEnabled: 'True',
    RESTAPIPort: String(settings.port + 1),
    RCONEnabled: 'False'
  })
}

// ---------- REST API (localhost, basic auth "admin:<AdminPassword>") ----------

async function restCall(
  dir: string,
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 6000
): Promise<Response> {
  const adminPassword = readSettings(dir).entries['AdminPassword'] ?? ''
  return fetch(`http://127.0.0.1:${port + 1}/v1/api${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64'),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
}

interface PalworldPlayer {
  name: string
  accountName?: string
  playerId?: string
  userId?: string
  level?: number
  ping?: number
}

/** Live player details for the moderation UI. */
export async function getPalworldPlayers(dir: string, port: number): Promise<PalworldPlayer[]> {
  const res = await restCall(dir, port, 'GET', '/players')
  if (!res.ok) throw new Error(`Player list unavailable (HTTP ${res.status}).`)
  const data = (await res.json()) as { players?: PalworldPlayer[] }
  return (data.players ?? []).filter((p) => p.name)
}

/** Kick/ban/unban a player (by steam_xxx user id) or broadcast an announcement. */
export async function moderatePalworld(
  dir: string,
  port: number,
  action: 'kick' | 'ban' | 'unban' | 'announce',
  target: string,
  message?: string
): Promise<void> {
  const call = async (path: string, body: unknown): Promise<void> => {
    const res = await restCall(dir, port, 'POST', path, body)
    if (!res.ok) throw new Error(`The server refused (HTTP ${res.status}).`)
  }
  switch (action) {
    case 'kick':
      return call('/kick', { userid: target, message: message || 'Kicked by admin' })
    case 'ban':
      return call('/ban', { userid: target, message: message || 'Banned by admin' })
    case 'unban':
      return call('/unban', { userid: target })
    case 'announce':
      return call('/announce', { message: target })
  }
}

// ---------- run ----------

export interface PalworldHandle {
  proc: ChildProcess
  /** graceful REST shutdown with a force-kill fallback */
  stop: () => void
}

export interface PalworldRunCallbacks {
  onLog: (line: string) => void
  onReady: (version?: string) => void
  onPlayers: (names: string[]) => void
  onExit: (code: number | null) => void
}

export interface PalworldLaunchOptions {
  /** register in Palworld's official community server browser (-publiclobby) */
  publicLobby: boolean
  /** WAN address announced to the lobby — behind NAT the auto-detect can pick the wrong one */
  publicIp: string | null
}

export function startPalworld(
  dir: string,
  port: number,
  launch: PalworldLaunchOptions,
  cb: PalworldRunCallbacks
): PalworldHandle {
  // keep ports and the REST API pinned to the record, even if the ini was hand-edited;
  // community servers also announce their WAN address to the lobby
  setPalworldSettings(dir, {
    PublicPort: String(port),
    ...(launch.publicLobby && launch.publicIp ? { PublicIP: launch.publicIp } : {}),
    RESTAPIEnabled: 'True',
    RESTAPIPort: String(port + 1)
  })

  const shipping = join(dir, SHIPPING_EXE)
  const useShipping = IS_WIN && existsSync(shipping)
  // windows: run the shipping exe directly (needs the "Pal" project arg), else
  // the launch script. linux: always the launch script, which sets up libs.
  const exe = IS_WIN ? (useShipping ? shipping : join(dir, LAUNCH_SCRIPT)) : join(dir, LAUNCH_SCRIPT)
  const flags = [
    ...(launch.publicLobby ? ['-publiclobby'] : []),
    `-port=${port}`,
    '-publicport=' + port,
    '-useperfthreads',
    '-NoAsyncLoadingThread',
    '-UseMultithreadForDS'
  ]
  const args = [...(useShipping ? ['Pal'] : []), ...flags]
  if (!IS_WIN) {
    try {
      chmodSync(exe, 0o755)
    } catch {
      // already executable, or permission handled by steamcmd
    }
  }
  // linux: detached so the whole process group (PalServer.sh + the UE binary) can be killed together
  const proc = spawn(exe, args, { cwd: dir, windowsHide: true, detached: !IS_WIN })

  let exited = false
  const timers: NodeJS.Timeout[] = []

  // the server logs every REST hit — our own 10s status polling would flood the console
  const restNoise = /REST accessed endpoint \S+ OK$/
  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed && !restNoise.test(trimmed)) cb.onLog(trimmed)
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  // the UE process is quiet on stdout — readiness comes from the REST API answering
  const startedAt = Date.now()
  let authFailures = 0
  const readyTimer = setInterval(async () => {
    if (exited) return
    try {
      const res = await restCall(dir, port, 'GET', '/info', undefined, 2500)
      if (res.ok) {
        clearInterval(readyTimer)
        const info = (await res.json().catch(() => null)) as { version?: string } | null
        cb.onLog(`[ELauncher] Palworld server is up${info?.version ? ` (${info.version})` : ''}`)
        cb.onReady(info?.version)
        // the player poll doubles as a health check: a hung UE server stops
        // answering REST while the process lives — kill it so crash-restart applies
        let pollFailures = 0
        const unresponsive = (): void => {
          pollFailures = Number.MIN_SAFE_INTEGER // fire once
          cb.onLog(
            '[ELauncher] The server has not responded for 90 seconds — force-stopping it (crash auto-restart applies if enabled).'
          )
          forceKill(proc)
        }
        const playersTimer = setInterval(async () => {
          try {
            const r = await restCall(dir, port, 'GET', '/players')
            if (!r.ok) {
              if (++pollFailures === 9) unresponsive()
              return
            }
            pollFailures = 0
            const data = (await r.json()) as { players?: PalworldPlayer[] }
            cb.onPlayers((data.players ?? []).map((p) => p.name).filter(Boolean))
          } catch {
            if (++pollFailures === 9) unresponsive()
          }
        }, 10_000)
        timers.push(playersTimer)
      } else if (res.status === 401 && ++authFailures >= 3) {
        // an HTTP answer proves the server is up — auth is broken, so run degraded instead of hanging in "starting"
        clearInterval(readyTimer)
        cb.onLog(
          '[ELauncher] Server is up, but its REST API rejected the admin password — player list, console commands, and graceful stop are unavailable this run. Stop and start the server to repair the config.'
        )
        cb.onReady()
      }
    } catch {
      if (Date.now() - startedAt > 240_000) {
        clearInterval(readyTimer)
        cb.onLog('[ELauncher] The server did not respond within 4 minutes — stopping it.')
        forceKill(proc)
      }
    }
  }, 2500)
  timers.push(readyTimer)

  proc.on('exit', (code) => {
    exited = true
    for (const t of timers) clearInterval(t)
    cb.onExit(code)
  })
  proc.on('error', (err) => {
    exited = true
    for (const t of timers) clearInterval(t)
    cb.onLog(`[ELauncher] Failed to start: ${err}`)
    cb.onExit(null)
  })

  const stop = (): void => {
    void (async () => {
      try {
        await restCall(dir, port, 'POST', '/save', {})
        await restCall(dir, port, 'POST', '/shutdown', { waittime: 1, message: 'Server is stopping' })
      } catch {
        // REST not up (still booting / crashed) — fall through to the kill below
      }
      setTimeout(() => {
        if (!exited) forceKill(proc)
      }, 20_000)
    })()
  }

  return { proc, stop }
}

/** UE servers spawn child processes — kill the whole tree (Windows) / group (Linux). */
function forceKill(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    // the server was spawned detached, so it leads its own process group (-pid)
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

// ---------- console commands over REST ----------

export async function sendPalworldCommand(dir: string, port: number, command: string, log: (line: string) => void): Promise<void> {
  const [verb, ...rest] = command.split(/\s+/)
  const arg = rest.join(' ')
  const need = (what: string): string => {
    if (!arg) throw new Error(`Usage: ${verb} <${what}>`)
    return arg
  }
  switch (verb.toLowerCase()) {
    case 'save':
      await restCall(dir, port, 'POST', '/save', {})
      log('[ELauncher] World saved')
      return
    case 'say':
    case 'broadcast':
      await restCall(dir, port, 'POST', '/announce', { message: need('message') })
      return
    case 'kick':
      await restCall(dir, port, 'POST', '/kick', { userid: need('steam id'), message: 'Kicked by admin' })
      return
    case 'ban':
      await restCall(dir, port, 'POST', '/ban', { userid: need('steam id'), message: 'Banned by admin' })
      return
    case 'unban':
      await restCall(dir, port, 'POST', '/unban', { userid: need('steam id') })
      return
    case 'players': {
      const res = await restCall(dir, port, 'GET', '/players')
      const data = (await res.json()) as { players?: PalworldPlayer[] }
      const players = data.players ?? []
      log(
        players.length === 0
          ? '[ELauncher] No players online'
          : players.map((p) => `[ELauncher] ${p.name} (lvl ${p.level ?? '?'}, id ${p.userId ?? 'unknown'})`).join('\n')
      )
      return
    }
    default:
      throw new Error('Palworld commands: save, say <message>, players, kick <steam id>, ban <steam id>, unban <steam id>')
  }
}
