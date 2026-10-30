import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { createHash } from 'crypto'
import { cp } from 'fs/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import AdmZip from 'adm-zip'
import { downloadToFile } from './mods'
import { ensureProton, protonEnv, protonPrefixDir, readProton } from './proton'
import { ensureSteamGameUser, prepareServerDirForGameUser, type GameUserContext } from './gameuser'
import { killProcessTree } from './proctree'
import type { SteamGameCreateSettings, SteamGameHandle, SteamGameRunCallbacks } from './steamgames'
import { initialiseNvmpUpload, requireNvmpUploadReady } from './nvmpUpload'

// Official distribution inspected 2026-10-30. Pin clients and servers together.
export const NVMP_VERSION = '9.43'
export const NVMP_URL = `https://github.com/NVMP/ClientDistribution/releases/download/${NVMP_VERSION}/build_release_client.zip`
export const NVMP_SHA256 = '7c082584bca9b1e2548c23223da912906b7fa2eee955fb6c2454cc02ccc385aa'
export const NVMP_EXE = 'nvmp_storyserver.exe'
export const NVMP_CONFIG = 'server.cfg'
const SERVER_FILES = [NVMP_EXE, 'libcrypto-3.dll', 'libssl-3.dll', 'nvmp_storyserver_README.txt']
const BOOL_KEYS = ['EnableConsole', 'EnableSaving', 'EnableVATS', 'StrictNVSE', 'EnablePartySystem', 'UseClientsideHitReg', 'AllowNPCGhosts', 'EnableWildEncounters']
const DEFAULTS: Record<string, string> = {
  EnableConsole: 'false', EnableSaving: 'true', EnableVATS: 'true', StrictNVSE: 'true',
  EnablePartySystem: 'true', UseClientsideHitReg: 'false', AllowNPCGhosts: 'false', EnableWildEncounters: 'false'
}

/** Explicit load order keeps Windows file timestamps from choosing the mods. */
export function readNvmpPlugins(root: string): string[] {
  const data = join(root, 'Data')
  if (!existsSync(data) || !lstatSync(data).isDirectory() || lstatSync(data).isSymbolicLink()) {
    throw new Error('NV:MP requires a real Data directory, not a symbolic link.')
  }
  const text = readFileSync(join(root, 'plugins_override.txt'), 'utf8').replace(/^\uFEFF/, '')
  const names = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  const seen = new Set<string>()
  if (names[0]?.toLowerCase() !== 'falloutnv.esm') throw new Error('NV:MP load order must start with FalloutNV.esm.')
  for (const name of names) {
    if (!/^[^/\\:\x00-\x1f]+\.(?:esm|esp)$/i.test(name) || seen.has(name.toLowerCase())) {
      throw new Error(`Invalid or duplicate NV:MP plugin: ${name}`)
    }
    seen.add(name.toLowerCase())
    const path = join(root, 'Data', name)
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`NV:MP Data is missing ${name}. Match the filename case and the clients' load order.`)
    }
  }
  return names
}

/** Checked before claiming orders, and again before downloading anything. */
export function nvmpNodeProblem(): string | null {
  if (process.platform !== 'linux' || process.arch !== 'x64') return 'NV:MP hosting currently requires an x64 Linux node with Proton.'
  return null
}
export function nvmpHostProblem(): string | null {
  const problem = nvmpNodeProblem()
  if (problem) return problem
  const root = process.env.ELAUNCHER_NVMP_ROOT
  if (!root || !isAbsolute(root)) return 'Set ELAUNCHER_NVMP_ROOT to an absolute directory containing your Fallout: New Vegas Data folder and plugins_override.txt.'
  try { readNvmpPlugins(root) } catch (error) { return `NV:MP host data is not ready: ${String(error)}` }
  return null
}

/** Only the boolean options verified in the 9.43 server are exposed. */
export function getNvmpSettings(dir: string): Record<string, string> {
  const settings = { ...DEFAULTS }
  const file = join(dir, NVMP_CONFIG)
  if (!existsSync(file)) return settings
  let section = ''
  for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const group = line.trim().match(/^\[([^\]]+)\]$/)
    if (group) { section = group[1]; continue }
    const entry = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/)
    if (section === 'Server' && entry && BOOL_KEYS.includes(entry[1])) settings[entry[1]] = entry[2]
  }
  return settings
}

export function setNvmpSettings(dir: string, updates: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(updates)) {
    if (!BOOL_KEYS.includes(key) || !/^(?:true|false)$/.test(value)) throw new Error(`Invalid NV:MP setting: ${key}`)
  }
  writeNvmpConfig(dir, { Server: updates })
  return getNvmpSettings(dir)
}

/** Edit only known entries; keep the operator's other sections and comments. */
function writeNvmpConfig(dir: string, updates: Record<string, Record<string, string>>): void {
  const file = join(dir, NVMP_CONFIG)
  const text = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : ''
  const pending = Object.fromEntries(Object.entries(updates).map(([group, values]) => [group, { ...values }]))
  const output: string[] = []
  let section = ''
  const flush = (): void => {
    for (const [key, value] of Object.entries(pending[section] ?? {})) output.push(`${key}=${value}`)
    delete pending[section]
  }
  for (const line of text.split(/\r?\n/)) {
    const group = line.trim().match(/^\[([^\]]+)\]$/)
    if (group) { flush(); section = group[1] }
    const entry = line.match(/^\s*([A-Za-z]+)\s*=/)
    const value = entry && updates[section]?.[entry[1]]
    if (entry && value !== undefined) {
      output.push(`${entry[1]}=${value}`)
      if (pending[section]) delete pending[section][entry[1]]
    } else output.push(line)
  }
  flush()
  for (const [group, values] of Object.entries(pending)) {
    output.push(`[${group}]`, ...Object.entries(values).map(([key, value]) => `${key}=${value}`))
  }
  const tmp = file + '.tmp'
  writeFileSync(tmp, output.join('\n') + '\n', 'utf8')
  renameSync(tmp, file)
}

export function extractNvmpServer(archive: string, dir: string): void {
  const raw = readFileSync(archive)
  if (createHash('sha256').update(raw).digest('hex') !== NVMP_SHA256) throw new Error('NV:MP download checksum mismatch; nothing was extracted.')
  const zip = new AdmZip(raw)
  // Extract only the server and its libraries, never the client launcher.
  const contents = SERVER_FILES.map((name) => {
    const entry = zip.getEntry(name)
    if (!entry || entry.isDirectory) throw new Error(`NV:MP distribution is missing ${name}.`)
    const data = zip.readFile(entry)
    if (!data?.length) throw new Error(`NV:MP distribution contains an empty ${name}.`)
    return [name, data] as const
  })
  for (const [name, data] of contents) {
    writeFileSync(join(dir, name), data)
  }
}

export async function installNvmp(dir: string, settings: SteamGameCreateSettings, progress: (phase: string, amount: number) => void): Promise<void> {
  const problem = settings.nvmpCustomerFiles ? nvmpNodeProblem() : nvmpHostProblem()
  if (problem) throw new Error(problem)
  if (settings.serverPassword) throw new Error('The public NV:MP co-op server has no join-password setting.')
  if (settings.maxPlayers !== undefined && settings.maxPlayers !== 10) throw new Error('NV:MP co-op has a fixed 10-player cap; use a 10-slot plan.')
  const source = settings.nvmpCustomerFiles ? null : realpathSync(process.env.ELAUNCHER_NVMP_ROOT!)
  if (source) {
    const nested = relative(source, resolve(dir))
    if (!nested || (!nested.startsWith('..') && !isAbsolute(nested))) throw new Error('NV:MP server destination must be outside the source template.')
  }
  const proton = await ensureProton(progress)
  progress(`Using ${proton.version}; preparing the server`, -1)
  mkdirSync(dir, { recursive: true })
  if (source) {
    await cp(join(source, 'Data'), join(dir, 'Data'), { recursive: true, errorOnExist: true, force: false,
      filter: (path) => {
        if (lstatSync(path).isSymbolicLink()) throw new Error('NV:MP templates must contain real files, not symbolic links.')
        return true
      } })
    writeFileSync(join(dir, 'plugins_override.txt'), readNvmpPlugins(source).join('\r\n') + '\r\n')
    if (existsSync(join(source, NVMP_CONFIG))) writeFileSync(join(dir, NVMP_CONFIG), readFileSync(join(source, NVMP_CONFIG)))
  } else initialiseNvmpUpload(dir)
  const archive = join(dir, '.nvmp-download.zip')
  try {
    progress(`Downloading NV:MP ${NVMP_VERSION}`, -1)
    await downloadToFile(NVMP_URL, archive, (bytes, total) => progress(`Downloading NV:MP ${NVMP_VERSION}`, total > 0 ? bytes / total : -1))
    extractNvmpServer(archive, dir)
  } finally { rmSync(archive, { force: true }) }
  writeNvmpConfig(dir, { Server: getNvmpSettings(dir), Network: { Hostname: '*', Port: String(settings.port) } })
  writeFileSync(join(dir, 'elauncher-nvmp.json'), JSON.stringify({ version: NVMP_VERSION, sha256: NVMP_SHA256, maxPlayers: 10 }, null, 2))
}

const users = new Map<string, { user: GameUserContext | null; port: number }>()

export async function prepareNvmpStart(dir: string, port: number, log: (line: string) => void): Promise<void> {
  requireNvmpUploadReady(dir)
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('NV:MP hosting requires an x64 Linux node.')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid NV:MP port.')
  readNvmpPlugins(dir)
  if (!existsSync(join(dir, NVMP_EXE))) throw new Error('NV:MP server binary is missing; reinstall the server.')
  if (!readProton()) throw new Error('NV:MP needs Proton; reinstall the server to fetch it.')
  // Config edits create root-owned files on a root host; write before handing ownership over.
  writeNvmpConfig(dir, { Network: { Hostname: '*', Port: String(port) } })
  mkdirSync(protonPrefixDir(dir), { recursive: true })
  mkdirSync(join(dir, 'steam-compat'), { recursive: true })
  const user = await ensureSteamGameUser()
  if (user) await prepareServerDirForGameUser(user, dir, log)
  users.set(dir, { user, port })
}

/** Protocol messages observed in the official 9.43 executable, not timed guesses. */
export function nvmpLogEvent(line: string): { ready?: boolean; joined?: { id: string; name: string }; left?: string } {
  if (/Listening on .+:\d+ \[max peers = \d+\]/.test(line)) return { ready: true }
  const joined = line.match(/Player (.+?) \[(\d+)\]\[[^\]]*\] connected/)
  if (joined) return { joined: { id: joined[2], name: joined[1] } }
  const left = line.match(/Player (\d+) disconnected/)
  return left ? { left: left[1] } : {}
}

export function startNvmp(dir: string, port: number, cpuList: string | null, cb: SteamGameRunCallbacks): SteamGameHandle {
  const prepared = users.get(dir)
  if (!prepared || prepared.port !== port) throw new Error('NV:MP runtime was not prepared for this port.')
  users.delete(dir)
  const proton = readProton()
  if (!proton) throw new Error('NV:MP Proton runtime is missing.')
  // Do not give third-party server plugins the host's cloud account secrets.
  let env: NodeJS.ProcessEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(env, protonEnv(protonPrefixDir(dir)), { STEAM_COMPAT_CLIENT_INSTALL_PATH: join(dir, 'steam-compat') })
  let exe = proton.script
  let args = ['run', join(dir, NVMP_EXE)]
  const user = prepared.user
  if (user) { env = user.env(env); [exe, args] = user.wrap(exe, args) }
  if (cpuList) { args = ['-c', cpuList, exe, ...args]; exe = 'taskset' }
  cb.onLog(`[ELauncher] NV:MP ${NVMP_VERSION}, 10-player co-op via ${proton.version}. Clients must match the server's mods and load order.`)
  const proc = spawn(exe, args, { cwd: dir, detached: true, windowsHide: true, env })
  let finished = false, ready = false, stopping = false, timedOut = false
  const players = new Map<string, string>()
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (code: number | null): void => {
    if (finished) return
    finished = true
    clearTimeout(killTimer)
    clearTimeout(startTimer)
    cb.onExit(timedOut ? 1 : code)
  }
  const startTimer = setTimeout(() => {
    if (!ready && !finished && !stopping) { timedOut = true; cb.onLog('[ELauncher] NV:MP did not reach its listening state within five minutes. Check the data files and Proton logs.'); killProcessTree(proc) }
  }, 300_000)
  const reader = (): ((chunk: Buffer) => void) => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    return (chunk) => {
      if (finished) return
      buffer += decoder.write(chunk)
      const lines = buffer.split(/[\r\n]+/)
      buffer = lines.pop()!.slice(-65536)
      for (const line of lines) {
        if (!line) continue
        cb.onLog(line)
        if (stopping || timedOut) continue
        const event = nvmpLogEvent(line)
        if (event.ready && !ready) { ready = true; clearTimeout(startTimer); cb.onReady() }
        if (event.joined) { players.set(event.joined.id, event.joined.name); cb.onPlayers([...players.values()]) }
        if (event.left) { players.delete(event.left); cb.onPlayers([...players.values()]) }
      }
    }
  }
  proc.stdout?.on('data', reader())
  proc.stderr?.on('data', reader())
  proc.on('exit', finish)
  proc.on('error', (error) => { cb.onLog(`[ELauncher] Could not start NV:MP: ${error.message}`); finish(1) })
  return { proc, stop: () => {
    if (finished || stopping) return
    stopping = true
    clearTimeout(startTimer)
    cb.onLog('[ELauncher] Stopping NV:MP. Player saves are stored on the clients; there is no server save command.')
    try { if (proc.pid) process.kill(-proc.pid, 'SIGINT') } catch { proc.kill('SIGINT') }
    killTimer = setTimeout(() => { if (!finished) killProcessTree(proc) }, 25_000)
  } }
}
