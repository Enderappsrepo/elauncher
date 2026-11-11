// Finds Fallout: New Vegas installs. Read-only: the registry is only ever queried, never written.
import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { win32 as path } from 'path'
import type { GameCandidate, GameSource, Mo2Setup } from '../shared/types'
import { parseVdf, vdfGet, vdfString } from './vdf'

/** Everything detection touches, so tests can run against fixtures. */
export interface DetectIO {
  /** Values of one key (name -> data), or null when the key or the requested value is missing. */
  regQuery(key: string, value?: string): Promise<Record<string, string> | null>
  /** Names (last segment only) of a key's direct subkeys. */
  regSubkeys(key: string): Promise<string[]>
  exists(p: string): boolean
  readText(p: string): string | null
  readDir(p: string): string[]
  env: Record<string, string | undefined>
  /** Drive roots such as "C:\". */
  drives(): string[]
  /** Real path with links resolved and on-disk casing; the path itself when absent. */
  realpath?(p: string): string
}

const WOW = 'HKLM\\SOFTWARE\\WOW6432Node'
const STEAM_APPS: ReadonlyArray<readonly [string, GameSource]> = [['22380', 'steam'], ['22490', 'steam-pcr']]
const GOG_IDS = ['1454587428', '1312824873']
const EPIC_APP = '5daeb974a22a435988892319b3a4f476'
const LABEL: Record<GameSource, string> = {
  steam: 'Steam', 'steam-pcr': 'Steam (PCR edition)', gog: 'GOG', epic: 'Epic Games', xbox: 'Xbox / Game Pass',
  'bethesda-registry': 'Installed game', mo2: 'Mod Organizer 2', manual: 'Chosen folder'
}
const RANK: Record<GameSource, number> = { steam: 0, gog: 0, 'steam-pcr': 1, mo2: 2, 'bethesda-registry': 3, manual: 3, epic: 4, xbox: 5 }
export const DETECT_WARNINGS = {
  pcr: 'This is the Steam "Fallout: New Vegas PCR" edition (app 22490). NV:MP groups normally play the regular Steam or GOG edition; upload from the copy your group actually plays.',
  epic: 'This is the Epic Games Store edition. xNVSE and NV:MP need the Epic Games patcher on it, and NV:MP officially supports the Steam and GOG editions.',
  xbox: 'This is the Xbox / Game Pass edition, which xNVSE and NV:MP do not support. Use the Steam or GOG edition.',
  noLauncher: 'NV:MP is not installed in this folder (no nvmp_launcher.exe). Upload from the copy you play NV:MP with, so the server gets the same files.',
  steamState: 'Steam reports this game as not fully installed or waiting for an update. Let Steam finish before uploading.',
  mo2Managed: 'Mod Organizer 2 runs this game, and mods installed through it are not in this folder. If you play NV:MP through Mod Organizer 2, choose its entry instead.'
}

interface Found { root: string; source: GameSource; warnings?: string[]; mo2?: Mo2Setup; instance?: string }
type JsonObject = Record<string, unknown>

function valueOf(values: Record<string, string> | null, name: string): string | undefined {
  if (!values) return undefined
  const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : values[key]
}

/** An absolute Windows path without a trailing separator, or null. */
function clean(p: string | undefined | null): string | null {
  const v = p?.trim().replace(/^"(.*)"$/, '$1')
  if (!v || !path.isAbsolute(v)) return null
  const n = path.normalize(v)
  return /^[a-z]:\\$/i.test(n) ? n : n.replace(/\\+$/, '')
}

function unique(paths: Array<string | undefined | null | false>): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const p of paths) {
    const c = p ? clean(p) : null
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c) }
  }
  return out
}

function parseJson(text: string | null): JsonObject | null {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
  } catch { return null }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/** The folder itself, or language subfolders (Epic: <dir>\<Lang>, Xbox: <dir>\Content\<Lang>) holding FalloutNV.exe. */
function gameRootsUnder(io: DetectIO, folder: string): string[] {
  const dir = clean(folder)
  if (!dir) return []
  if (io.exists(path.join(dir, 'FalloutNV.exe'))) return [dir]
  const out: string[] = []
  for (const parent of [dir, path.join(dir, 'Content')]) {
    for (const name of io.readDir(parent)) {
      const sub = path.join(parent, name)
      if (io.exists(path.join(sub, 'FalloutNV.exe'))) out.push(sub)
    }
  }
  return out
}

function toCandidate(found: Found, io: DetectIO): GameCandidate | null {
  const given = clean(found.root)
  if (!given || !io.exists(path.join(given, 'FalloutNV.exe'))) return null
  const root = clean(io.realpath?.(given)) ?? given
  const dataName = io.readDir(root).find((n) => n.toLowerCase() === 'data')
  if (!dataName || !io.exists(path.join(root, dataName, 'FalloutNV.esm'))) return null
  const hasNvmpLauncher = io.exists(path.join(root, 'nvmp_launcher.exe'))
  const warnings = [...(found.warnings ?? [])]
  let supported = true
  if (found.source === 'xbox' || io.exists(path.join(root, 'appxmanifest.xml')) || io.exists(path.join(path.dirname(root), 'appxmanifest.xml'))) {
    supported = false
    warnings.push(DETECT_WARNINGS.xbox)
  } else if (found.source === 'epic' || io.exists(path.join(root, 'EOSSDK-Win32-Shipping.dll'))) {
    // An Epic copy with NV:MP installed is assumed to be patched; one without it is not usable as-is.
    supported = hasNvmpLauncher
    warnings.push(DETECT_WARNINGS.epic)
  }
  if (found.source === 'steam-pcr') warnings.push(DETECT_WARNINGS.pcr)
  if (!hasNvmpLauncher) warnings.push(DETECT_WARNINGS.noLauncher)
  const label = found.mo2
    ? `${LABEL.mo2} - ${found.instance ?? path.basename(found.mo2.instanceDir)}, profile "${found.mo2.profile}" - ${root}`
    : `${LABEL[found.source]} - ${root}`
  return {
    id: `${found.source}:${root.toLowerCase()}${found.mo2 ? `|${found.mo2.profileDir.toLowerCase()}` : ''}`,
    root, data: path.join(root, dataName), source: found.source, label, hasNvmpLauncher, supported, warnings,
    ...(found.mo2 ? { mo2: found.mo2 } : {})
  }
}

function steamLibraries(io: DetectIO, steamRoot: string): string[] {
  const out: string[] = []
  for (const file of [path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), path.join(steamRoot, 'config', 'libraryfolders.vdf')]) {
    const text = io.readText(file)
    const folders = text === null ? undefined : vdfGet(parseVdf(text), 'libraryfolders')
    if (!folders || typeof folders === 'string') continue
    for (const [key, value] of Object.entries(folders)) {
      // Current layout: "1" { "path" "D:\\SteamLibrary" ... }; legacy layout: "1" "D:\\SteamLibrary".
      const library = /^\d+$/.test(key) ? (typeof value === 'string' ? value : vdfString(value, 'path')) : undefined
      if (library) out.push(library)
    }
  }
  return out
}

async function findSteam(io: DetectIO): Promise<Found[]> {
  const [user, wow, native] = await Promise.all([
    io.regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    io.regQuery(`${WOW}\\Valve\\Steam`, 'InstallPath'),
    io.regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath')
  ])
  const programFiles = io.env['ProgramFiles(x86)']
  const roots = unique([valueOf(user, 'SteamPath'), valueOf(wow, 'InstallPath'), valueOf(native, 'InstallPath'), programFiles && path.join(programFiles, 'Steam')])
  const found: Found[] = []
  for (const library of unique([...roots, ...roots.flatMap((root) => steamLibraries(io, root))])) {
    for (const [appId, source] of STEAM_APPS) {
      const text = io.readText(path.join(library, 'steamapps', `appmanifest_${appId}.acf`))
      if (text === null) continue
      const state = vdfGet(parseVdf(text), 'AppState')
      const installdir = vdfString(state, 'installdir')
      if (!installdir) continue
      const flags = Number(vdfString(state, 'StateFlags') ?? 4)
      found.push({ root: path.join(library, 'steamapps', 'common', installdir), source, warnings: flags & 4 ? [] : [DETECT_WARNINGS.steamState] })
    }
  }
  return found
}

async function findGog(io: DetectIO): Promise<Found[]> {
  const base = `${WOW}\\GOG.com\\Games`
  const ids = [...new Set([...GOG_IDS, ...await io.regSubkeys(base)])]
  const rows = await mapLimit(ids, 8, (id) => io.regQuery(`${base}\\${id}`))
  return rows.flatMap((row, i): Found[] => {
    if (!row || !(GOG_IDS.includes(ids[i]) || /new vegas/i.test(valueOf(row, 'gameName') ?? ''))) return []
    const root = valueOf(row, 'path') || valueOf(row, 'workingDir')
    return root ? [{ root, source: 'gog' }] : []
  })
}

async function findBethesda(io: DetectIO): Promise<Found[]> {
  const rows = await Promise.all([`${WOW}\\Bethesda Softworks\\FalloutNV`, 'HKLM\\SOFTWARE\\Bethesda Softworks\\FalloutNV'].map((key) => io.regQuery(key, 'Installed Path')))
  return unique(rows.map((row) => valueOf(row, 'Installed Path'))).map((root) => ({ root, source: 'bethesda-registry' }))
}

function isEpicFnv(item: unknown): item is JsonObject {
  if (!item || typeof item !== 'object') return false
  const { AppName, DisplayName } = item as JsonObject
  return String(AppName ?? '').toLowerCase() === EPIC_APP || /new vegas/i.test(String(DisplayName ?? ''))
}

async function findEpic(io: DetectIO): Promise<Found[]> {
  const row = await io.regQuery(`${WOW}\\Epic Games\\EpicGamesLauncher`, 'AppDataPath')
  const programData = io.env.ProgramData ?? io.env.PROGRAMDATA ?? io.env.ALLUSERSPROFILE
  const locations: unknown[] = []
  for (const dir of unique([valueOf(row, 'AppDataPath'), programData && path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data')])) {
    const manifests = path.join(dir, 'Manifests')
    for (const name of io.readDir(manifests)) {
      const item = /\.item$/i.test(name) ? parseJson(io.readText(path.join(manifests, name))) : null
      if (isEpicFnv(item)) locations.push(item.InstallLocation)
    }
  }
  if (programData) {
    const list = parseJson(io.readText(path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')))?.InstallationList
    for (const entry of Array.isArray(list) ? list as unknown[] : []) if (isEpicFnv(entry)) locations.push(entry.InstallLocation)
  }
  return unique(locations.filter((l): l is string => typeof l === 'string')).flatMap((l) => gameRootsUnder(io, l)).map((root) => ({ root, source: 'epic' }))
}

/** .GamingRoot: "RGBX", a uint32 count, then NUL-terminated UTF-16LE folder names relative to the drive. */
export function parseGamingRoot(text: string | null): string[] {
  if (!text?.startsWith('RGBX')) return []
  const body = text.slice(8), names: string[] = []
  let name = ''
  for (let i = 0; i + 1 < body.length; i += 2) {
    const code = body.charCodeAt(i) | (body.charCodeAt(i + 1) << 8)
    if (code) name += String.fromCharCode(code)
    else if (name) { names.push(name); name = '' }
  }
  return names
}

function findXbox(io: DetectIO): Found[] {
  const found: Found[] = []
  for (const drive of io.drives()) {
    for (const folder of parseGamingRoot(io.readText(path.join(drive, '.GamingRoot')))) {
      const library = path.join(drive, folder)
      for (const game of io.readDir(library).filter((n) => /fallout|vegas/i.test(n))) {
        const content = path.join(library, game, 'Content')
        found.push(...gameRootsUnder(io, content).map((root): Found => ({ root, source: 'xbox' })))
      }
    }
  }
  return found
}

/** A QSettings value: quotes, backslash escapes and @ByteArray(...) (whose \xNN escapes are UTF-8 bytes). */
export function qtValue(raw: string): string {
  let body = raw.trim()
  const bytes = /^"?@ByteArray\((.*)\)"?$/s.exec(body)
  if (bytes) body = bytes[1]
  const chars = [...body], parts: Buffer[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === '"') continue
    if (c !== '\\' || i + 1 >= chars.length) { parts.push(Buffer.from(c)); continue }
    const e = chars[++i]
    const hex = e === 'x' ? /^[0-9a-fA-F]{1,4}/.exec(chars.slice(i + 1, i + 5).join(''))?.[0] : undefined
    if (hex) {
      i += hex.length
      const code = parseInt(hex, 16)
      parts.push(bytes && code < 256 ? Buffer.from([code]) : Buffer.from(String.fromCharCode(code)))
      continue
    }
    parts.push(Buffer.from(({ n: '\n', r: '\r', t: '\t', '0': '\0' } as Record<string, string>)[e] ?? e))
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { '': {} }
  let section = out['']
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)
    if (header) { section = out[header[1].toLowerCase()] ??= {}; continue }
    const eq = line.indexOf('=')
    if (eq > 0 && !/^\s*[;#]/.test(line)) section[line.slice(0, eq).trim().toLowerCase()] = qtValue(line.slice(eq + 1))
  }
  return out
}

function mo2Instance(io: DetectIO, instanceDir: string): Found | null {
  const ini = parseIni(io.readText(path.join(instanceDir, 'ModOrganizer.ini')) ?? '')
  const general = ini.general ?? {}, settings = ini.settings ?? {}
  if (!/new vegas|^ttw$|tale of two wastelands/i.test(general.gamename ?? '') || !general.gamepath) return null
  const within = (p: string, base: string): string => path.resolve(base, path.normalize(p))
  const baseDir = settings.base_directory ? within(settings.base_directory, instanceDir) : instanceDir
  const dirOf = (key: string, fallback: string): string => within((settings[key] || `%BASE_DIR%/${fallback}`).replace(/%BASE_DIR%/gi, baseDir), baseDir)
  const profilesDir = dirOf('profiles_directory', 'profiles')
  const selected = general.selected_profile || 'Default'
  const profile = io.exists(path.join(profilesDir, selected, 'modlist.txt'))
    ? selected
    : io.readDir(profilesDir).find((name) => io.exists(path.join(profilesDir, name, 'modlist.txt')))
  if (!profile) return null
  return {
    root: general.gamepath,
    source: 'mo2',
    instance: path.basename(instanceDir),
    warnings: profile === selected ? [] : [`Mod Organizer 2's selected profile "${selected}" was not found, so "${profile}" is used.`],
    mo2: { instanceDir, profile, profileDir: path.join(profilesDir, profile), modsDir: dirOf('mod_directory', 'mods'), overwriteDir: dirOf('overwrite_directory', 'overwrite') }
  }
}

function findMo2(io: DetectIO): Found[] {
  const local = io.env.LOCALAPPDATA
  if (!local) return []
  const base = path.join(local, 'ModOrganizer')
  const dirs: string[] = io.readDir(base).map((name) => path.join(base, name))
  // Portable instances register themselves as download handlers; their ModOrganizer.ini sits next to the exe.
  for (const handlers of ['nxmhandler.ini', 'downloadhandler.ini']) {
    for (const match of io.readText(path.join(base, handlers))?.matchAll(/^\s*(?:\d+\\)?executable\s*=(.*)$/gim) ?? []) {
      const exe = clean(qtValue(match[1]))
      if (exe) dirs.push(path.dirname(exe))
    }
  }
  return unique(dirs)
    .filter((dir) => io.exists(path.join(dir, 'ModOrganizer.ini')))
    .map((dir) => mo2Instance(io, dir))
    .filter((found): found is Found => !!found)
}

function collect(found: Found[], io: DetectIO): GameCandidate[] {
  const seen = new Set<string>(), out: GameCandidate[] = []
  for (const f of found) {
    const candidate = toCandidate(f, io)
    if (!candidate) continue
    // One entry per real folder; each MO2 profile stays separate because its files differ from the plain folder.
    const key = candidate.mo2 ? `mo2|${candidate.mo2.profileDir.toLowerCase()}` : candidate.root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  // A player who set MO2 up on an install plays through it, so its profiles rank with that install, just above it.
  const rootOf = (c: GameCandidate): string => c.root.toLowerCase()
  const plain = new Map(out.filter((c) => !c.mo2).map((c) => [rootOf(c), c]))
  const group = new Map<string, number>()
  out.forEach((c, i) => {
    if (!group.has(rootOf(c))) group.set(rootOf(c), i)
    const managed = c.mo2 && plain.get(rootOf(c))
    if (managed && !managed.warnings.includes(DETECT_WARNINGS.mo2Managed)) managed.warnings.push(DETECT_WARNINGS.mo2Managed)
  })
  const rank = (c: GameCandidate): number => RANK[c.mo2 ? plain.get(rootOf(c))?.source ?? c.source : c.source]
  // launcher first, then supported, then by source; one install's MO2 profiles, then the install itself
  const sortKey = new Map(out.map((c, i) => [c, [Number(!c.hasNvmpLauncher), Number(!c.supported), rank(c), group.get(rootOf(c))!, Number(!c.mo2), i]]))
  return out.sort((a, b) => {
    const x = sortKey.get(a)!, y = sortKey.get(b)!
    return x.reduce((d, v, i) => d || v - y[i], 0)
  })
}

export async function findFalloutNV(io: DetectIO = realIO): Promise<GameCandidate[]> {
  const settle = async (finder: () => Found[] | Promise<Found[]>): Promise<Found[]> => {
    try { return await finder() } catch { return [] }
  }
  // Discovery order decides which source names a folder found twice (Steam beats the Bethesda key).
  const groups = await Promise.all([
    settle(() => findSteam(io)), settle(() => findGog(io)), settle(() => findEpic(io)),
    settle(() => findXbox(io)), settle(() => findBethesda(io)), settle(() => findMo2(io))
  ])
  return collect(groups.flat(), io)
}

/** A folder the player picked: the game folder, its Data folder, an Epic/Xbox language parent, or an MO2 instance. */
export async function candidateFromFolder(folder: string, io: DetectIO = realIO): Promise<GameCandidate | null> {
  const dir = clean(folder)
  if (!dir) return null
  if (io.exists(path.join(dir, 'ModOrganizer.ini'))) {
    const found = mo2Instance(io, dir)
    return found ? toCandidate(found, io) : null
  }
  const roots = [dir, ...(path.basename(dir).toLowerCase() === 'data' ? [path.dirname(dir)] : []), ...gameRootsUnder(io, dir)]
  for (const root of roots) {
    const candidate = toCandidate({ root, source: 'manual' }, io)
    if (candidate) return candidate
  }
  return null
}

/** reg.exe query output: "    Name    REG_TYPE    Data" lines of the queried key. */
export function parseRegValues(output: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/.exec(line)
    if (!m || /^\(.*\)$/.test(m[1])) continue // the localised "(Default)" value
    const [, name, type, data = ''] = m
    values[name] = type === 'REG_DWORD' || type === 'REG_QWORD' ? String(Number(data))
      : type === 'REG_EXPAND_SZ' ? data.replace(/%([^%]+)%/g, (all, v: string) => process.env[v] ?? all)
      : data
  }
  return values
}

const HIVES: Record<string, string> = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT', HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG' }

/** Subkey lines of `reg query <key>`. A key without values of its own prints no header line, only its subkeys. */
export function parseRegSubkeys(output: string, key: string): string[] {
  const [hive, ...rest] = key.replace(/\\+$/, '').split('\\')
  const prefix = `${[HIVES[hive.toUpperCase()] ?? hive, ...rest].join('\\').toLowerCase()}\\`
  return output.split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter((name) => name && !name.includes('\\'))
}

function runReg(args: string[]): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((done) => {
    execFile(exe, args, { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => done(error ? null : stdout))
  })
}

export const realIO: DetectIO = {
  async regQuery(key, value) {
    const out = await runReg(value === undefined ? ['query', key] : ['query', key, '/v', value])
    return out === null ? null : parseRegValues(out)
  },
  async regSubkeys(key) {
    const out = await runReg(['query', key])
    return out === null ? [] : parseRegSubkeys(out, key)
  },
  exists: (p) => existsSync(p),
  readText(p) { try { return readFileSync(p, 'utf8') } catch { return null } },
  readDir(p) { try { return readdirSync(p) } catch { return [] } },
  env: process.env,
  drives: () => process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d)) : [],
  realpath(p) { try { return realpathSync.native(p) } catch { return p } }
}
