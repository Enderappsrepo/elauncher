import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Socket } from 'net'
import { randomBytes } from 'crypto'
import { installSteamApp } from './steamcmd'
import { killProcessTree } from './proctree'

/**
 * Generic SteamCMD dedicated-server provider. Palworld came first and has its
 * own module (REST API, ini tuple format); every further Steam game rides this
 * spec table instead — adding one is a new entry plus, at most, a settings
 * seed. Currently: Valheim and 7 Days to Die, both with native Windows + Linux
 * builds and anonymous SteamCMD downloads.
 */

const IS_WIN = process.platform === 'win32'

export type SteamGameId = 'valheim' | 'sdtd'

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

export const STEAM_GAMES: Record<SteamGameId, SteamGameSpec> = {
  valheim: { label: 'Valheim', appId: 896660, basePort: 2456, portStep: 3, protocol: 'UDP', memoryHintMb: 4096, hasConsole: false },
  sdtd: { label: '7 Days to Die', appId: 294420, basePort: 26900, portStep: 4, protocol: 'UDP', memoryHintMb: 8192, hasConsole: true }
}

export function isSteamGame(game: string | undefined): game is SteamGameId {
  return game === 'valheim' || game === 'sdtd'
}

// ---------- settings ----------
// valheim: launch args only — persisted in a sidecar json we own.
// sdtd: the game's own serverconfig.xml <property name value/> lines.

const VALHEIM_FILE = 'elauncher-valheim.json'
const SDTD_CONFIG = 'serverconfig.xml'

function valheimDefaults(name: string): Record<string, string> {
  return { name, world: 'Dedicated', password: 'play' + randomBytes(3).toString('hex'), public: 'true' }
}

export function getSteamGameSettings(game: SteamGameId, dir: string): Record<string, string> {
  if (game === 'valheim') {
    const file = join(dir, VALHEIM_FILE)
    if (!existsSync(file)) return valheimDefaults('Valheim Server')
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
    } catch {
      return valheimDefaults('Valheim Server')
    }
  }
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

// ---------- install ----------

export interface SteamGameCreateSettings {
  serverName: string
  serverPassword?: string
  maxPlayers?: number
  port: number
}

export async function installSteamGame(
  game: SteamGameId,
  dir: string,
  settings: SteamGameCreateSettings,
  onProgress: (phase: string, progress: number) => void
): Promise<void> {
  await installSteamApp(STEAM_GAMES[game].appId, dir, onProgress)
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
  /** sdtd only: run a console command over the local telnet admin port */
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
  if (game === 'valheim') {
    exe = join(dir, IS_WIN ? 'valheim_server.exe' : 'valheim_server.x86_64')
    args = [
      '-nographics', '-batchmode',
      '-name', settings.name || 'Valheim Server',
      '-port', String(port),
      '-world', settings.world || 'Dedicated',
      ...(settings.password ? ['-password', settings.password] : []),
      '-public', /^true$/i.test(settings.public ?? 'true') ? '1' : '0',
      '-savedir', join(dir, 'save') // keep worlds inside the server folder (files tab, backups)
    ]
    env.SteamAppId = '892970'
    if (!IS_WIN) env.LD_LIBRARY_PATH = `${join(dir, 'linux64')}:${env.LD_LIBRARY_PATH ?? ''}`
  } else {
    // keep the record's port authoritative even if the xml was hand-edited
    setSteamGameSettings('sdtd', dir, { ServerPort: String(port), TelnetEnabled: 'true', TelnetPort: String(port + 3) })
    exe = join(dir, IS_WIN ? '7DaysToDieServer.exe' : '7DaysToDieServer.x86_64')
    args = ['-quit', '-batchmode', '-nographics', '-dedicated', `-configfile=${SDTD_CONFIG}`, '-logfile', IS_WIN ? '-' : '/dev/stdout']
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

  const onLine = (line: string): void => {
    cb.onLog(line)
    if (game === 'valheim') {
      if (!ready && /Game server connected/i.test(line)) {
        ready = true
        cb.onLog('[ELauncher] Valheim server is up')
        cb.onReady()
      }
      if (/Got connection SteamID/i.test(line)) connections++
      if (/Closing socket/i.test(line) && connections > 0) connections--
      const zdoid = line.match(/Got character ZDOID from ([^\s:]+)/)
      if (zdoid && !names.includes(zdoid[1])) names.push(zdoid[1])
      while (names.length > connections) names.shift() // best effort — valheim never logs who left
      cb.onPlayers([...names])
    } else if (!ready && /(GameServer\.Init successful|StartGame done)/i.test(line)) {
      ready = true
      cb.onLog('[ELauncher] 7 Days to Die server is up')
      cb.onReady()
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

  proc.on('exit', (code) => {
    exited = true
    telnet?.destroy()
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

  return { proc, stop, ...(game === 'sdtd' ? { command: telnetSend } : {}) }
}
