import { spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync
} from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { killProcessTree } from './proctree'

export const BEAMMP_SETTINGS_FILE = 'elauncher-beammp.json'
export const BEAMMP_INSTALL_FILE = 'elauncher-beammp-install.json'
const RELEASE_API = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest'
const MAX_BINARY_BYTES = 150 * 1024 * 1024
const USER_AGENT = 'ELauncher (BeamMP dedicated-server host)'

export interface BeammpAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}
export interface BeammpRelease {
  tag_name: string
  prerelease: boolean
  draft: boolean
  assets: BeammpAsset[]
}
export interface BeammpPlatform {
  platform: string
  arch: string
  /** Contents of /etc/os-release, needed only for Linux. */
  osRelease?: string
}

/** Match an official native build exactly; never fall back to another distro's binary. */
export function beammpAssetName(host: BeammpPlatform): string {
  if (host.platform === 'win32' && host.arch === 'x64') return 'BeamMP-Server.exe'
  if (host.platform !== 'linux' || !['x64', 'arm64'].includes(host.arch)) {
    throw new Error('BeamMP hosting supports Windows x64 and official Ubuntu/Debian x64 or arm64 builds. This host is unsupported.')
  }
  const fields: Record<string, string> = {}
  for (const line of (host.osRelease ?? '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*$/)
    if (match) fields[match[1]] = match[2] ?? match[3] ?? match[4]
  }
  const distro = fields.ID
  const version = fields.VERSION_ID
  if (!((distro === 'ubuntu' && ['22.04', '24.04'].includes(version)) ||
    (distro === 'debian' && ['12', '13'].includes(version)))) {
    throw new Error('BeamMP requires Ubuntu 22.04/24.04 or Debian 12/13 on this host. Install the native liblua5.3-0 package as well.')
  }
  return `BeamMP-Server.${distro}.${version}.${host.arch === 'x64' ? 'x86_64' : 'arm64'}`
}

export function selectBeammpAsset(release: BeammpRelease, host: BeammpPlatform): BeammpAsset {
  const name = beammpAssetName(host)
  if (release.prerelease || release.draft || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('BeamMP did not return a stable official release.')
  }
  const matches = release.assets.filter((asset) => asset.name === name)
  if (matches.length !== 1) throw new Error(`The latest stable BeamMP release has no unambiguous ${name} build.`)
  const asset = matches[0]
  const url = new URL(asset.browser_download_url)
  const expected = `/BeamMP/BeamMP-Server/releases/download/${release.tag_name}/${name}`
  if (url.origin !== 'https://github.com' || decodeURIComponent(url.pathname) !== expected || url.search || url.hash || url.username || url.password) {
    throw new Error('BeamMP returned a download outside its official release.')
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BINARY_BYTES) {
    throw new Error('The BeamMP server download has an invalid size.')
  }
  if (asset.digest && !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) throw new Error('BeamMP returned an unsupported checksum.')
  return asset
}

function hostPlatform(): BeammpPlatform {
  // Unsupported operating systems are rejected before performing any network I/O.
  return { platform: process.platform, arch: process.arch,
    ...(process.platform === 'linux' ? { osRelease: readFileSync('/etc/os-release', 'utf8') } : {}) }
}

const inside = (root: string, file: string): boolean => {
  const path = relative(resolve(root), resolve(file))
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
function regularFile(file: string): boolean {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('BeamMP managed files must be regular files.')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function privateSecretPath(dir: string, secretFile: string): void {
  if (!isAbsolute(secretFile) || inside(dir, secretFile)) throw new Error('BeamMP credentials must be stored outside the server files directory.')
  mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 })
  if (inside(realpathSync(dir), realpathSync(dirname(secretFile)))) {
    throw new Error('BeamMP credentials cannot be stored through a link inside the server files directory.')
  }
  regularFile(secretFile)
}
function atomicWrite(file: string, text: string, mode = 0o600): void {
  regularFile(file)
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.beammp-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temp, 'wx', mode)
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, file)
    chmodSync(file, mode)
  } finally { rmSync(temp, { force: true }) }
}

export function beammpDefaults(name = 'BeamMP Server', port = 30814): Record<string, string> {
  return {
    Name: name, Description: 'BeamNG.drive multiplayer server hosted with ELauncher',
    Map: '/levels/gridmap_v2/info.json', MaxPlayers: '8', MaxCars: '2',
    Private: 'true', Debug: 'false', Port: String(port), ResourceFolder: 'Resources',
    AllowGuests: 'true', LogChat: 'true', InformationPacket: 'true', Tags: 'Freeroam'
  }
}
const INT_RANGES: Record<string, [number, number]> = { Port: [1, 65535], MaxPlayers: [1, 128], MaxCars: [1, 20] }
const KEYS = new Set(Object.keys(beammpDefaults()))

/** Validate the whole merged document before changing either settings or credentials. */
export function validateBeammpSettings(settings: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (!KEYS.has(key) || typeof value !== 'string') throw new Error(`Unsupported BeamMP setting: ${key}`)
    if (INT_RANGES[key]) {
      const [min, max] = INT_RANGES[key]
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${key} must be a whole number from ${min} to ${max}.`)
      result[key] = String(Number(value))
    } else if (['Private', 'Debug', 'AllowGuests', 'LogChat', 'InformationPacket'].includes(key)) {
      if (!/^(true|false)$/i.test(value)) throw new Error(`${key} must be true or false.`)
      result[key] = value.toLowerCase()
    } else if (key === 'Map') {
      if (!/^\/levels\/[a-zA-Z0-9_-]+\/info\.json$/.test(value)) throw new Error('Map must be /levels/<map_name>/info.json (for example /levels/gridmap_v2/info.json).')
      result[key] = value
    } else if (key === 'ResourceFolder') {
      if (value !== 'Resources') throw new Error('BeamMP resources must remain in the server Resources folder.')
      result[key] = value
    } else {
      if ((key === 'Name' && !value.trim()) || value.length > (key === 'Name' || key === 'Tags' ? 128 : 4096) || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(`${key} is empty, too long, or contains control characters.`)
      }
      result[key] = value
    }
  }
  return result
}
function readSettings(dir: string): Record<string, string> {
  const file = join(dir, BEAMMP_SETTINGS_FILE)
  if (!regularFile(file)) return beammpDefaults()
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('The BeamMP settings file is invalid.')
  return validateBeammpSettings({ ...beammpDefaults(), ...value as Record<string, string> })
}
function readKey(dir: string, secretFile: string): string {
  privateSecretPath(dir, secretFile)
  return regularFile(secretFile) ? readFileSync(secretFile, 'utf8').trim() : ''
}
export function getBeammpSettings(dir: string, secretFile: string): Record<string, string> {
  return { ...readSettings(dir), AuthKeyConfigured: readKey(dir, secretFile) ? 'true' : 'false' }
}
export function setBeammpSettings(dir: string, secretFile: string, updates: Record<string, string>): Record<string, string> {
  privateSecretPath(dir, secretFile)
  const { AuthKey, ClearAuthKey, ...publicUpdates } = updates
  const settings = validateBeammpSettings({ ...readSettings(dir), ...publicUpdates })
  if (ClearAuthKey !== undefined && ClearAuthKey !== 'true' && ClearAuthKey !== 'false') throw new Error('ClearAuthKey must be true or false.')
  if (AuthKey !== undefined && (typeof AuthKey !== 'string' || (AuthKey !== '' && !validAuthKey(AuthKey)))) {
    throw new Error('Enter the BeamMP AuthKey issued at keymaster.beammp.com (a UUID).')
  }
  if (ClearAuthKey === 'true' && AuthKey) throw new Error('ClearAuthKey and a new AuthKey cannot be set together.')
  if (ClearAuthKey === 'true') rmSync(secretFile, { force: true })
  else if (AuthKey) atomicWrite(secretFile, AuthKey)
  atomicWrite(join(dir, BEAMMP_SETTINGS_FILE), JSON.stringify(settings, null, 2) + '\n')
  return getBeammpSettings(dir, secretFile)
}
const validAuthKey = (key: string): boolean => /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(key)
export function updateBeammpName(dir: string, name: string): void {
  const settings = validateBeammpSettings({ ...readSettings(dir), Name: name })
  atomicWrite(join(dir, BEAMMP_SETTINGS_FILE), JSON.stringify(settings, null, 2) + '\n')
}

export async function installBeammp(dir: string, name: string, port: number, onLog: (line: string) => void): Promise<string> {
  const host = hostPlatform()
  beammpAssetName(host)
  const response = await fetch(RELEASE_API, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Cannot fetch the latest official BeamMP release (HTTP ${response.status}).`)
  const release = await response.json() as BeammpRelease
  const asset = selectBeammpAsset(release, host)
  onLog(`[ELauncher] Downloading official BeamMP ${release.tag_name}: ${asset.name}`)
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, host.platform === 'win32' ? 'BeamMP-Server.exe' : 'BeamMP-Server')
  regularFile(exe)
  const temp = join(dir, `.beammp-download-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5 * 60_000) })
    if (!download.ok || !download.body) throw new Error(`The BeamMP binary download failed (HTTP ${download.status}).`)
    fd = openSync(temp, 'wx', 0o700)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of download.body) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > asset.size || size > MAX_BINARY_BYTES) throw new Error('The BeamMP download exceeded its declared size.')
      hash.update(bytes)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    }
    if (size !== asset.size) throw new Error('The BeamMP binary download was incomplete.')
    const digest = hash.digest('hex')
    if (asset.digest && digest !== asset.digest.slice(7).toLowerCase()) throw new Error('BeamMP binary checksum did not match the official release.')
    fsyncSync(fd); closeSync(fd); fd = undefined
    chmodSync(temp, 0o755)
    renameSync(temp, exe)
    atomicWrite(join(dir, BEAMMP_INSTALL_FILE), JSON.stringify({ version: release.tag_name, asset: asset.name, sha256: digest }, null, 2) + '\n')
    if (!regularFile(join(dir, BEAMMP_SETTINGS_FILE))) {
      atomicWrite(join(dir, BEAMMP_SETTINGS_FILE), JSON.stringify(validateBeammpSettings(beammpDefaults(name, port)), null, 2) + '\n')
    }
    for (const sub of ['Client', 'Server']) {
      const resourceRoot = join(dir, 'Resources')
      if (existsSync(resourceRoot) && (!lstatSync(resourceRoot).isDirectory() || lstatSync(resourceRoot).isSymbolicLink())) {
        throw new Error('BeamMP Resources must be a regular directory inside the server folder.')
      }
      const path = join(dir, 'Resources', sub)
      if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
        throw new Error('BeamMP resource directories cannot be symbolic links.')
      }
      mkdirSync(path, { recursive: true })
      if (!inside(realpathSync(dir), realpathSync(path))) throw new Error('BeamMP resources cannot point outside the server directory.')
    }
    if (!asset.digest) onLog('[ELauncher] GitHub provided no release checksum; the official download was recorded with a local SHA-256 digest.')
    if (host.platform === 'linux') onLog('[ELauncher] BeamMP requires the host package liblua5.3-0. No BeamNG.drive installation is needed on the host.')
    return release.tag_name
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
  }
}

/** No AuthKey ever enters argv or a downloadable ServerConfig.toml. */
export function beammpEnvironment(settings: Record<string, string>, authKey: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const valid = validateBeammpSettings(settings)
  const env: NodeJS.ProcessEnv = {}
  // Host-level BeamMP overrides must never leak into another customer's server.
  for (const [key, value] of Object.entries(inherited)) if (!key.toUpperCase().startsWith('BEAMMP_')) env[key] = value
  Object.assign(env, {
    BEAMMP_PROVIDER_DISABLE_CONFIG: 'true', BEAMMP_AUTH_KEY: authKey,
    BEAMMP_NAME: valid.Name, BEAMMP_DESCRIPTION: valid.Description, BEAMMP_MAP: valid.Map,
    BEAMMP_MAX_PLAYERS: valid.MaxPlayers, BEAMMP_MAX_CARS: valid.MaxCars,
    BEAMMP_PRIVATE: valid.Private, BEAMMP_DEBUG: valid.Debug, BEAMMP_PORT: valid.Port,
    BEAMMP_RESOURCE_FOLDER: valid.ResourceFolder, BEAMMP_LOG_CHAT: valid.LogChat,
    BEAMMP_IP: '0.0.0.0', BEAMMP_TAGS: valid.Tags,
    BEAMMP_ALLOW_GUESTS: valid.AllowGuests, BEAMMP_INFORMATION_PACKET: valid.InformationPacket
  })
  return env
}

export function redactBeammpLog(line: string, authKey: string): string {
  const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  return (authKey ? clean.split(authKey).join('[REDACTED]') : clean)
    .replace(/((?:BEAMMP_AUTH_KEY|AuthKey)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
}
export interface BeammpHandle {
  proc: ChildProcess
  stop: () => void
  command: (command: string) => void
}
export interface BeammpRunCallbacks {
  onLog: (line: string) => void
  onReady: () => void
  onPlayers?: (names: string[]) => void
  onExit: (code: number | null) => void
}

export function startBeammp(dir: string, port: number, secretFile: string, cpuList: string | null, cb: BeammpRunCallbacks): BeammpHandle {
  const host = hostPlatform()
  beammpAssetName(host)
  const key = readKey(dir, secretFile)
  if (!key) throw new Error('Add a BeamMP AuthKey in Settings before starting this server. Get a separate key for each server at keymaster.beammp.com.')
  if (!validAuthKey(key)) throw new Error('The stored BeamMP AuthKey is invalid. Replace it in Settings.')
  const settings = validateBeammpSettings({ ...readSettings(dir), Port: String(port) })
  const binary = join(dir, host.platform === 'win32' ? 'BeamMP-Server.exe' : 'BeamMP-Server')
  if (!regularFile(binary)) throw new Error('BeamMP server files are missing. Reinstall the server first.')
  let executable = binary
  let args: string[] = []
  if (host.platform === 'linux' && cpuList) {
    if (!/^\d+(?:,\d+)*$/.test(cpuList)) throw new Error('The BeamMP CPU allocation is invalid.')
    executable = 'taskset'; args = ['-c', cpuList, binary]
  }
  const proc = spawn(executable, args, { cwd: dir, windowsHide: true, detached: host.platform !== 'win32', shell: false, env: beammpEnvironment(settings, key) })
  let exited = false
  let stopping = false
  let ready = false
  const players = new Set<string>()
  let stopTimer: NodeJS.Timeout | undefined
  const timeout = setTimeout(() => {
    if (!ready && !exited) { cb.onLog('[ELauncher] BeamMP did not become ready within 2 minutes; stopping it. Check the AuthKey, ports and Linux dependencies.'); killProcessTree(proc) }
  }, 120_000)
  timeout.unref()
  const onLine = (line: string): void => {
    const clean = redactBeammpLog(line, key).trim()
    if (!clean) return
    cb.onLog(clean)
    if (!exited && !stopping && !ready && /ALL SYSTEMS STARTED SUCCESSFULLY/i.test(clean)) {
      ready = true; clearTimeout(timeout); cb.onReady(); cb.onPlayers?.([])
    }
    if (!exited && !stopping && !ready && /STARTUP NOT SUCCESSFUL/i.test(clean)) {
      stopping = true
      clearTimeout(timeout)
      cb.onLog('[ELauncher] BeamMP reported an unsuccessful startup; stopping the server.')
      killProcessTree(proc)
    }
    // These are the completed connection / termination messages, not the earlier
    // authentication or ID-assignment messages that may never become a player.
    const body = clean.replace(/^.*\[(?:INFO|DEBUG|WARN|ERROR|FATAL)\]\s*/i, '')
    const connected = body.match(/^(.+?)\s*:\s*Connected\s*$/)
    const disconnected = body.match(/^(.+?)\s+Connection Terminated\s*$/)
    if (connected && ready && !exited) {
      players.add(connected[1].trim()); cb.onPlayers?.([...players])
    } else if (disconnected && players.delete(disconnected[1].trim())) {
      cb.onPlayers?.([...players])
    }
  }
  const readers: Array<{ pending: string }> = []
  for (const stream of [proc.stdout, proc.stderr]) {
    const reader = { pending: '' }; readers.push(reader)
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      reader.pending += chunk
      const lines = reader.pending.split(/[\r\n]+/)
      reader.pending = lines.pop() ?? ''
      for (const line of lines) onLine(line)
      // A broken server/plugin must not grow the host's log buffer forever.
      if (reader.pending.length > 64 * 1024) { onLine(reader.pending.slice(0, 64 * 1024)); reader.pending = '' }
    })
  }
  const finish = (code: number | null): void => {
    if (exited) return
    exited = true; clearTimeout(timeout); if (stopTimer) clearTimeout(stopTimer)
    for (const reader of readers) if (reader.pending) onLine(reader.pending)
    cb.onExit(code)
  }
  proc.on('exit', finish)
  proc.on('error', (error) => { cb.onLog(redactBeammpLog(`[ELauncher] Failed to start BeamMP: ${error.message}`, key)); finish(null) })
  proc.stdin?.on('error', () => { /* Server exit can race an administrator's command. */ })
  const command = (text: string): void => {
    if (!text.trim() || text.length > 4096 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('Enter one BeamMP console command without control characters.')
    if (exited || !proc.stdin?.writable) throw new Error('The BeamMP console is unavailable.')
    proc.stdin.write(text + '\n')
  }
  const stop = (): void => {
    if (exited || stopping) return
    stopping = true
    if (proc.stdin?.writable) proc.stdin.write('exit\n')
    stopTimer = setTimeout(() => { if (!exited) killProcessTree(proc) }, 25_000)
    stopTimer.unref()
  }
  return { proc, stop, command }
}
