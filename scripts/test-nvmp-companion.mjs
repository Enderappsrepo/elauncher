// NV:MP companion: game detection, Data scanning and load order, then a real upload through the browser
// transfer code and the host handlers. Offline: registry/launcher fixtures and temp folders only.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { test, after } from 'node:test'
import { transformSync } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
const root = fs.mkdtempSync(join(tmpdir(), 'elauncher-nvmp-companion-'))
after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes('elauncher-nvmp-companion-')); fs.rmSync(root, { recursive: true, force: true }) })
let count = 0
const temp = () => { const p = join(root, String(++count)); fs.mkdirSync(p); return p }
function load(file, imports = {}) {
  const code = transformSync(fs.readFileSync(join(repo, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const module = { exports: {} }
  const req = (id) => { if (id in imports) return imports[id]; if (id.startsWith('.') || id.startsWith('@')) throw new Error(`Unmocked import: ${id}`); return require(id) }
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, module, module.exports)
  return module.exports
}
const policy = load('src/shared/nvmpUpload.ts')
const api = load('src/main/services/nvmpUpload.ts', { '@shared/nvmpUpload': policy, fs: { ...fs, statfsSync: () => ({ bavail: 1024 ** 3, bsize: 4096 }) } })
const nvmp = load('src/main/services/nvmp.ts', { './nvmpUpload': api, './mods': {}, './proton': {}, './gameuser': {}, './proctree': {} })
const browser = load('web/src/panel/nvmpTransfer.ts', { '@shared/nvmpUpload': policy })
const vdf = load('companion/main/vdf.ts')
const detect = load('companion/main/detect.ts', { './vdf': vdf })
const fileReader = load('companion/main/fileReader.ts', { '@shared/nvmpUpload': policy })
const dataSet = load('companion/main/dataSet.ts', { '@shared/nvmpUpload': policy, './fileReader': fileReader })
const loadOrder = load('companion/main/loadOrder.ts')
const CHUNK = policy.NVMP_CHUNK_BYTES, DAY = 86_400, T0 = 1_600_000_000

/** A plugin with a TES4 header; flag bit 0x1 marks a master whatever the extension. */
function plugin(master, size = 64, seed = 1) {
  const b = Buffer.alloc(Math.max(size, 24))
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7) & 255
  b.write('TES4', 0, 'latin1'); b.writeUInt32LE(b.length - 24, 4); b.writeUInt32LE(master ? 1 : 0, 8)
  return b
}
function put(path, content, day) {
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, content)
  if (day !== undefined) fs.utimesSync(path, T0 + day * DAY, T0 + day * DAY)
  return path
}
const cp1252 = (text) => Buffer.from(text, 'latin1') // the fixtures only use characters below U+0100

// Registry, launcher files and drives as plain data; lookups are case-insensitive like Windows.
function fakeIO({ files = {}, registry = {}, env = {}, drives = [] }) {
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const fileMap = new Map(Object.entries(files).map(([p, v]) => [norm(p), v]))
  const dirs = new Map()
  for (const p of Object.keys(files)) {
    const parts = p.replace(/\//g, '\\').split('\\')
    for (let i = 1; i < parts.length; i++) {
      const d = norm(parts.slice(0, i).join('\\'))
      if (!dirs.has(d)) dirs.set(d, new Map())
      dirs.get(d).set(parts[i].toLowerCase(), parts[i])
    }
  }
  const keys = Object.keys(registry)
  const row = (key) => { const k = keys.find((x) => x.toLowerCase() === key.toLowerCase()); return k === undefined ? null : registry[k] }
  return {
    async regQuery(key, value) {
      const values = row(key)
      if (!values || value === undefined) return values && { ...values }
      const name = Object.keys(values).find((n) => n.toLowerCase() === value.toLowerCase())
      return name === undefined ? null : { [name]: values[name] }
    },
    async regSubkeys(key) {
      const prefix = `${key.toLowerCase()}\\`
      return keys.filter((k) => k.toLowerCase().startsWith(prefix) && !k.slice(prefix.length).includes('\\')).map((k) => k.slice(prefix.length))
    },
    exists: (p) => fileMap.has(norm(p)) || dirs.has(norm(p)),
    readText: (p) => { const v = fileMap.get(norm(p)); return v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : v },
    readDir: (p) => [...(dirs.get(norm(p))?.values() ?? [])],
    env,
    drives: () => drives
  }
}
const install = (dir, extra = []) => Object.fromEntries([['FalloutNV.exe', 'MZ'], ['Data\\FalloutNV.esm', 'TES4'], ...extra.map((n) => [n, 'x'])].map(([n, v]) => [`${dir}\\${n}`, v]))

const STEAM = 'D:\\SteamLibrary\\steamapps\\common\\Fallout New Vegas'
const LOCAL = 'C:\\Users\\p\\AppData\\Local'
const EPIC_ROOT = 'C:\\Program Files\\Epic Games\\FalloutNV'
const XBOX = 'G:\\XboxGames\\Fallout- New Vegas\\Content'
const machine = () => fakeIO({
  env: { LOCALAPPDATA: LOCAL, ProgramData: 'C:\\ProgramData', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
  drives: ['C:\\', 'G:\\'],
  registry: {
    'HKCU\\Software\\Valve\\Steam': { SteamPath: 'c:/program files (x86)/steam' },
    'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428': { gameName: 'Fallout: New Vegas Ultimate Edition', path: 'E:\\GOG Games\\Fallout New Vegas' },
    'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658930': { gameName: 'Some Other Game', path: 'E:\\GOG Games\\Other' },
    'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\2000000001': { gameName: 'Fallout: New Vegas', path: 'F:\\Games\\FNV GOG copy' },
    'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\FalloutNV': { 'Installed Path': `${STEAM}\\` },
    'HKLM\\SOFTWARE\\Bethesda Softworks\\FalloutNV': { 'Installed Path': 'C:\\Old\\Fallout New Vegas\\' },
    'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher': { AppDataPath: 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\' }
  },
  files: {
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf': String.raw`"libraryfolders"
{
	"0" { "path" "c:\\program files (x86)\\steam" "apps" { "22490" "1" } }
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"apps" { "22380" "10335862594" }
	}
}`,
    'C:\\Program Files (x86)\\Steam\\steamapps\\appmanifest_22490.acf': '"AppState"\n{\n\t"appid" "22490"\n\t"StateFlags" "2"\n\t"installdir" "Fallout New Vegas PCR"\n}\n',
    ...install('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Fallout New Vegas PCR'),
    'D:\\SteamLibrary\\steamapps\\appmanifest_22380.acf': '"AppState"\n{\n\t"appid"\t\t"22380"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Fallout New Vegas"\n}\n',
    ...install(STEAM, ['nvmp_launcher.exe']),
    ...install('E:\\GOG Games\\Fallout New Vegas'),
    ...install('F:\\Games\\FNV GOG copy'),
    'E:\\GOG Games\\Other\\Other.exe': 'MZ',
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\ABC123.item': `\uFEFF${JSON.stringify({ AppName: '5daeb974a22a435988892319b3a4f476', DisplayName: 'Fallout: New Vegas', InstallLocation: EPIC_ROOT })}`,
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\Other.item': JSON.stringify({ AppName: 'other', DisplayName: 'Other', InstallLocation: 'C:\\Other' }),
    ...install(`${EPIC_ROOT}\\Fallout New Vegas English`, ['EOSSDK-Win32-Shipping.dll']),
    'G:\\.GamingRoot': Buffer.concat([Buffer.from('RGBX'), Buffer.from([1, 0, 0, 0]), Buffer.from('XboxGames\0', 'utf16le')]),
    [`${XBOX}\\appxmanifest.xml`]: '<Package/>',
    ...install(`${XBOX}\\Fallout New Vegas English`),
    [`${LOCAL}\\ModOrganizer\\New Vegas\\ModOrganizer.ini`]: String.raw`[General]
gameName=New Vegas
gamePath=@ByteArray(D:\\SteamLibrary\\steamapps\\common\\Fallout New Vegas)
selected_profile=@ByteArray(Viva)

[Settings]
mod_directory=E:/Modding/mods
`,
    [`${LOCAL}\\ModOrganizer\\New Vegas\\profiles\\Viva\\modlist.txt`]: '+A\r\n',
    [`${LOCAL}\\ModOrganizer\\Fallout 4\\ModOrganizer.ini`]: '[General]\ngameName=Fallout 4\ngamePath=@ByteArray(D:\\\\Fallout 4)\n',
    [`${LOCAL}\\ModOrganizer\\nxmhandler.ini`]: String.raw`[handlers]
1\games=falloutnv
1\executable=H:\\Portable MO2\\ModOrganizer.exe
1\arguments=
size=1
`,
    'H:\\Portable MO2\\ModOrganizer.ini': String.raw`[General]
gameName=New Vegas
gamePath=@ByteArray(E:\\GOG Games\\Fallout New Vegas)
`,
    'H:\\Portable MO2\\profiles\\Default\\modlist.txt': ''
  }
})

test('VDF parsing handles both libraryfolders layouts, comments, escapes and conditionals', () => {
  const legacy = vdf.parseVdf(String.raw`"LibraryFolders" // Steam before mid-2021
{
	"TimeNextStatsReport"		"1612345678"
	"1"		"E:\\Games\\Steam \"Library\""
	"key"	"value"	[$WIN32]
	"2"		"F:\\Steam"
}`)
  assert.equal(vdf.vdfString(legacy, 'libraryfolders', '1'), 'E:\\Games\\Steam "Library"')
  assert.equal(vdf.vdfString(legacy, 'libraryfolders', '2'), 'F:\\Steam')
  assert.equal(vdf.vdfString(legacy, 'LIBRARYFOLDERS', 'key'), 'value')
  const acf = vdf.parseVdf('"AppState"\n{\n\t"appid"\t\t"22380"\n\t"installdir"\t\t"Fallout New Vegas"\n\t"UserConfig"\n\t{\n\t\t"language"\t\t"english"\n\t}\n}\n')
  assert.equal(vdf.vdfString(acf, 'AppState', 'installdir'), 'Fallout New Vegas')
  assert.equal(vdf.vdfString(acf, 'appstate', 'userconfig', 'language'), 'english')
})

test('reg.exe output, QSettings values and .GamingRoot parse like the real files', () => {
  const out = [
    '', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428',
    '    (Default)    REG_SZ    ignored', '    gameName    REG_SZ    Fallout: New Vegas Ultimate Edition',
    '    path    REG_SZ    E:\\GOG Games\\Fallout New Vegas', '    launchParam    REG_SZ    ',
    '    Installed Path    REG_SZ    D:\\Games\\FNV\\', '    StateFlags    REG_DWORD    0x4', '    Where    REG_EXPAND_SZ    %SystemRoot%\\x',
    '', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428\\Sub', ''
  ].join('\r\n')
  assert.deepEqual(detect.parseRegValues(out), {
    gameName: 'Fallout: New Vegas Ultimate Edition', path: 'E:\\GOG Games\\Fallout New Vegas', launchParam: '',
    'Installed Path': 'D:\\Games\\FNV\\', StateFlags: '4', Where: `${process.env.SystemRoot ?? '%SystemRoot%'}\\x`
  })
  assert.deepEqual(detect.parseRegSubkeys(out, 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428'), ['Sub'])
  // A key with no values of its own (GOG.com\Games) prints only its subkeys, without a header line.
  const bare = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1491728574\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428\r\n'
  assert.deepEqual(detect.parseRegSubkeys(bare, 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games'), ['1491728574', '1454587428'])
  assert.deepEqual(detect.parseRegSubkeys(bare, 'hklm\\software\\wow6432node\\gog.com\\games\\'), ['1491728574', '1454587428'])
  assert.equal(detect.qtValue(String.raw`@ByteArray(D:\\Games\\Caf\xc3\xa9 NV)`), 'D:\\Games\\Café NV')
  assert.equal(detect.qtValue(String.raw`"@ByteArray(C:\\Mods, Games\\NV)"`), 'C:\\Mods, Games\\NV')
  assert.equal(detect.qtValue('Viva New Vegas'), 'Viva New Vegas')
  const gaming = Buffer.concat([Buffer.from('RGBX'), Buffer.from([2, 0, 0, 0]), Buffer.from('XboxGames\0Games\0', 'utf16le')])
  assert.deepEqual(detect.parseGamingRoot(gaming.toString('utf8')), ['XboxGames', 'Games'])
  assert.deepEqual(detect.parseGamingRoot('not a gaming root'), [])
})

test('detection finds Steam, PCR, GOG, Epic, Xbox and MO2 installs, validates, dedupes and ranks them', async () => {
  const found = await detect.findFalloutNV(machine())
  // An MO2 profile ranks just above the plain install it runs: a player who set MO2 up plays through it.
  assert.deepEqual(found.map((c) => c.source), ['mo2', 'steam', 'mo2', 'gog', 'gog', 'steam-pcr', 'epic', 'xbox'])
  assert.equal(new Set(found.map((c) => c.id)).size, found.length)
  const [mo2, steam, portable, gog] = found
  assert.deepEqual({ root: steam.root, data: steam.data, hasNvmpLauncher: steam.hasNvmpLauncher, supported: steam.supported, warnings: steam.warnings },
    { root: STEAM, data: `${STEAM}\\Data`, hasNvmpLauncher: true, supported: true, warnings: [detect.DETECT_WARNINGS.mo2Managed] })
  assert.equal(steam.label, `Steam - ${STEAM}`)
  assert.equal(found.filter((c) => c.root.toLowerCase() === STEAM.toLowerCase() && !c.mo2).length, 1, 'the Bethesda key points at the Steam copy')
  assert.ok(!found.some((c) => c.root.startsWith('C:\\Old')), 'stale registry paths are dropped')
  assert.deepEqual(mo2.mo2, {
    instanceDir: `${LOCAL}\\ModOrganizer\\New Vegas`, profile: 'Viva', profileDir: `${LOCAL}\\ModOrganizer\\New Vegas\\profiles\\Viva`,
    modsDir: 'E:\\Modding\\mods', overwriteDir: `${LOCAL}\\ModOrganizer\\New Vegas\\overwrite`
  })
  assert.equal(mo2.root, STEAM)
  assert.deepEqual([mo2.hasNvmpLauncher, mo2.supported, mo2.warnings], [true, true, []])
  assert.match(mo2.label, /Mod Organizer 2 - New Vegas, profile "Viva"/)
  assert.equal(gog.root, 'E:\\GOG Games\\Fallout New Vegas')
  assert.equal(found[4].root, 'F:\\Games\\FNV GOG copy')
  assert.ok(gog.warnings.includes(detect.DETECT_WARNINGS.noLauncher) && gog.warnings.includes(detect.DETECT_WARNINGS.mo2Managed))
  assert.ok(!found[4].warnings.includes(detect.DETECT_WARNINGS.mo2Managed), 'only an install an MO2 instance runs gets the MO2 note')
  const pcr = found[5]
  assert.match(pcr.root, /Fallout New Vegas PCR$/)
  assert.ok(pcr.supported && pcr.warnings.includes(detect.DETECT_WARNINGS.pcr) && pcr.warnings.includes(detect.DETECT_WARNINGS.steamState))
  assert.equal(portable.mo2.instanceDir, 'H:\\Portable MO2')
  assert.equal(portable.mo2.profile, 'Default')
  assert.equal(portable.root, gog.root, 'the portable MO2 runs the GOG copy, so it ranks just above it')
  const [epic, xbox] = found.slice(6)
  assert.equal(epic.root, `${EPIC_ROOT}\\Fallout New Vegas English`)
  assert.equal(epic.supported, false); assert.ok(epic.warnings.includes(detect.DETECT_WARNINGS.epic))
  assert.equal(xbox.root, `${XBOX}\\Fallout New Vegas English`)
  assert.equal(xbox.supported, false); assert.ok(xbox.warnings.includes(detect.DETECT_WARNINGS.xbox))
})

test('a chosen folder may be the game, its Data folder, an Epic language parent or an MO2 instance', async () => {
  const io = machine()
  const fromData = await detect.candidateFromFolder(`${STEAM}\\Data\\`, io)
  assert.deepEqual([fromData.source, fromData.root, fromData.hasNvmpLauncher], ['manual', STEAM, true])
  const epic = await detect.candidateFromFolder(EPIC_ROOT, io)
  assert.deepEqual([epic.root, epic.supported], [`${EPIC_ROOT}\\Fallout New Vegas English`, false])
  const portable = await detect.candidateFromFolder('H:\\Portable MO2', io)
  assert.deepEqual([portable.source, portable.mo2.profile], ['mo2', 'Default'])
  assert.equal(await detect.candidateFromFolder('C:\\Nowhere', io), null)
  assert.equal(await detect.candidateFromFolder('relative\\path', io), null)
})

/** A plain install on disk with masters, an ESM-flagged .esp, .nam DLC, an accented plugin and links. */
function plainGame({ baseName = 'FalloutNV.esm', baseSize = 64 } = {}) {
  const dir = temp(), game = join(dir, 'Fallout New Vegas'), data = join(game, 'Data')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(game, 'nvmp_launcher.exe'), 'MZ')
  put(join(data, baseName), plugin(true, baseSize, 1), 0)
  put(join(data, 'DeadMoney.esm'), plugin(true, 80, 2), 1); put(join(data, 'DeadMoney.nam'), 'nam', 1)
  put(join(data, 'HonestHearts.esm'), plugin(true, 80, 3), 2); put(join(data, 'HonestHearts.nam'), 'nam', 2)
  put(join(data, 'Mod.esp'), plugin(false, 70, 4), 4)
  put(join(data, 'Café.esp'), plugin(false, 70, 5), 5)
  put(join(data, 'Masterlike.esp'), plugin(true, 70, 6), 6)
  put(join(data, 'Textures', 'Armor', 'a.dds'), 'texture', 3)
  put(join(data, 'empty.txt'), '', 3)
  put(join(data, 'NVSE', 'Plugins', 'nvse_plugin.dll'), 'MZ', 3)
  fs.mkdirSync(join(data, 'Meshes'))
  fs.linkSync(put(join(dir, 'staging', 'linked.nif'), 'hardlinked mesh', 3), join(data, 'Meshes', 'linked.nif'))
  put(join(dir, 'shared-sounds', 'voice.wav'), 'voice', 3)
  fs.symlinkSync(join(dir, 'shared-sounds'), join(data, 'Sound'), 'junction')
  fs.symlinkSync(data, join(data, 'Loop'), 'junction')
  let fileLinks = true
  try { fs.symlinkSync(put(join(dir, 'staging', 'song.mp3'), 'music', 3), join(data, 'song.mp3'), 'file') } catch { fileLinks = false } // needs Developer Mode on Windows
  const local = join(dir, 'Local')
  return { dir, game, data, local, fileLinks }
}

test('plugins.txt is read as windows-1252 with comments, stars, duplicates, missing names and .nam DLC handled', async () => {
  const g = plainGame()
  put(join(g.local, 'FalloutNV', 'plugins.txt'), cp1252('# This file is used by Fallout: New Vegas to keep track of your downloaded content.\r\n' +
    'falloutnv.esm\r\nDeadMoney.esm\r\n*MASTERLIKE.ESP\r\nmod.esp\r\nCaf\u00e9.esp\r\nMissing.esp\r\nnot a plugin.txt\r\nMod.esp\r\n'))
  const game = await detect.candidateFromFolder(g.game, detect.realIO)
  const scan = await dataSet.scanDataSet(game)
  const order = await loadOrder.readLoadOrder(game, scan, { LOCALAPPDATA: g.local })
  assert.equal(order.source, 'plugins.txt')
  assert.deepEqual(order.plugins, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Masterlike.esp', 'Mod.esp', 'Café.esp'])
  assert.equal(order.text, 'FalloutNV.esm\r\nDeadMoney.esm\r\nHonestHearts.esm\r\nMasterlike.esp\r\nMod.esp\r\nCafé.esp\r\n')
  assert.equal(order.timestampOrder, undefined)
  assert.equal(order.warnings.length, 4)
  for (const pattern of [/Missing\.esp, which is not in the Data folder/, /"not a plugin\.txt", which is not a plugin file name/, /Mod\.esp more than once/, /HonestHearts\.esm was added: its \.nam file/]) {
    assert.ok(order.warnings.some((w) => pattern.test(w)), pattern.source)
  }
})

test('a BOM, UTF-8 names and an order that disagrees with file dates produce the engine order as a warning', async () => {
  const g = plainGame()
  put(join(g.local, 'FalloutNV', 'plugins.txt'), Buffer.from('\uFEFFFalloutNV.esm\r\nCafé.esp\r\nMod.esp\r\n', 'utf8'))
  const game = await detect.candidateFromFolder(g.game, detect.realIO)
  const scan = await dataSet.scanDataSet(game)
  const order = await loadOrder.readLoadOrder(game, scan, { LOCALAPPDATA: g.local })
  assert.deepEqual(order.plugins, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Café.esp', 'Mod.esp'])
  assert.deepEqual(order.timestampOrder, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Mod.esp', 'Café.esp'])
  assert.ok(order.warnings.some((w) => /puts Café\.esp at position 4, but the file dates .* put Mod\.esp there/.test(w)))
})

test('Epic reads FalloutNV_Epic; no plugins.txt falls back to the base game and DLC by file date', async () => {
  const g = plainGame()
  put(join(g.game, 'EOSSDK-Win32-Shipping.dll'), 'MZ')
  put(join(g.local, 'FalloutNV', 'plugins.txt'), 'FalloutNV.esm\r\nCafé.esp\r\n')
  put(join(g.local, 'FalloutNV_Epic', 'plugins.txt'), 'FalloutNV.esm\r\nMod.esp\r\n')
  const epic = await detect.candidateFromFolder(g.game, detect.realIO)
  assert.equal(epic.supported, true, 'an Epic copy with NV:MP installed is treated as patched')
  const scan = await dataSet.scanDataSet(epic)
  assert.deepEqual((await loadOrder.readLoadOrder(epic, scan, { LOCALAPPDATA: g.local })).plugins, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Mod.esp'])
  const none = await loadOrder.readLoadOrder(epic, scan, { LOCALAPPDATA: join(g.dir, 'empty') })
  assert.equal(none.source, 'timestamps')
  assert.deepEqual(none.plugins, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm'])
  assert.match(none.warnings[0], /No plugins\.txt was found/)
})

test('an edited load order is checked like the host does and rewritten in on-disk case', async () => {
  const g = plainGame()
  const scan = await dataSet.scanDataSet(await detect.candidateFromFolder(g.game, detect.realIO))
  const edited = loadOrder.normaliseLoadOrder('\uFEFF  falloutnv.esm\r\n# my notes\r\n\r\ndeadmoney.esm\nhonesthearts.ESM\n*mod.esp\nCAFÉ.ESP\n', scan)
  assert.deepEqual(edited.plugins, ['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Mod.esp', 'Café.esp'])
  assert.equal(edited.text, 'FalloutNV.esm\r\nDeadMoney.esm\r\nHonestHearts.esm\r\nMod.esp\r\nCafé.esp\r\n')
  assert.deepEqual(edited.warnings, [])
  const short = loadOrder.normaliseLoadOrder('FalloutNV.esm\r\nCafé.esp\r\nMod.esp', scan)
  assert.deepEqual(short.timestampOrder, ['FalloutNV.esm', 'Mod.esp', 'Café.esp'])
  assert.equal(short.warnings.filter((w) => /\.nam file/.test(w)).length, 2)
  for (const [text, error] of [['', /start with FalloutNV\.esm/], ['Mod.esp\nFalloutNV.esm', /start with FalloutNV\.esm/], ['FalloutNV.esm\nMissing.esp', /Missing\.esp, which is not in the Data folder/],
    ['FalloutNV.esm\nTextures/a.esp', /not a plugin file name/], ['FalloutNV.esm\nmod.esp\nMOD.ESP', /more than once/], ['FalloutNV.esm\nempty.txt', /not a plugin file name/]]) {
    assert.throws(() => loadOrder.normaliseLoadOrder(text, scan), error)
  }
})

test('Mod Organizer 2: the merged Data follows modlist priority, overwrite wins and MO2-hidden files stay out', async () => {
  const dir = temp(), game = join(dir, 'Stock Game'), data = join(game, 'Data'), local = join(dir, 'Local')
  const instance = join(local, 'ModOrganizer', 'NV Test'), mods = join(instance, 'mods'), profile = join(instance, 'profiles', 'Default')
  put(join(game, 'FalloutNV.exe'), 'MZ')
  put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  put(join(data, 'shared.txt'), 'base'); put(join(data, 'both.txt'), 'base'); put(join(data, 'readme.txt'), 'base readme')
  put(join(data, 'Textures', 'base.dds'), 'base')
  put(join(mods, 'High', 'shared.txt'), 'high'); put(join(mods, 'High', 'both.txt'), 'high')
  put(join(mods, 'High', 'textures', 'high.dds'), 'high'); put(join(mods, 'High', 'Meshes', 'x.nif'), 'high')
  put(join(mods, 'High', 'meta.ini'), '[General]'); put(join(mods, 'High', 'fomod', 'ModuleConfig.xml'), '<config/>')
  put(join(mods, 'High', 'hidden.dds.mohidden'), 'hidden'); put(join(mods, 'High', 'Root', 'd3d9.dll'), 'MZ')
  put(join(mods, 'High', 'HighPlugin.esp'), plugin(false, 64, 2), 3)
  put(join(mods, 'Low', 'shared.txt'), 'low'); put(join(mods, 'Low', 'TEXTURES', 'low.dds'), 'low'); put(join(mods, 'Low', 'meshes', 'y.nif'), 'low')
  put(join(mods, 'Low', 'readme.txt'), 'low readme'); put(join(mods, 'Low', 'LowPlugin.esp'), plugin(false, 64, 3), 2)
  put(join(mods, 'Off', 'off.esp'), plugin(false, 64, 4), 1)
  put(join(mods, 'Group_separator', 'x.txt'), 'separator')
  put(join(instance, 'overwrite', 'both.txt'), 'over'); put(join(instance, 'overwrite', 'NVSE', 'Plugins', 'plugin.dll'), 'MZ')
  put(join(instance, 'ModOrganizer.ini'), `[General]\r\ngameName=New Vegas\r\ngamePath=@ByteArray(${game.replace(/\\/g, '\\\\')})\r\nselected_profile=@ByteArray(Default)\r\n`)
  put(join(profile, 'modlist.txt'), '# This file was automatically generated by Mod Organizer.\r\n+High\r\n-Off\r\n*DLC: Dead Money\r\n+Group_separator\r\n+Low\r\n+Missing Mod\r\n')
  put(join(profile, 'plugins.txt'), '# This file was automatically generated by Mod Organizer.\r\nFalloutNV.esm\r\nLowPlugin.esp\r\nHighPlugin.esp\r\n')
  put(join(profile, 'loadorder.txt'), '# This file was automatically generated by Mod Organizer.\r\nFalloutNV.esm\r\nLowPlugin.esp\r\noff.esp\r\nHighPlugin.esp\r\n')

  const io = { ...detect.realIO, env: { LOCALAPPDATA: local }, regQuery: async () => null, regSubkeys: async () => [], drives: () => [] }
  const found = await detect.findFalloutNV(io)
  assert.deepEqual(found.map((c) => [c.source, c.mo2?.profile]), [['mo2', 'Default']])
  const [candidate] = found
  assert.equal(candidate.root.toLowerCase(), fs.realpathSync.native(game).toLowerCase())
  const scan = await dataSet.scanDataSet(candidate)
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.skippedExecutables, ['Data/NVSE/Plugins/plugin.dll'])
  const files = Object.fromEntries(scan.entries.map((e) => [e.rel, fs.readFileSync(e.abs, 'utf8')]))
  assert.deepEqual(Object.keys(files).sort(), ['FalloutNV.esm', 'HighPlugin.esp', 'LowPlugin.esp', 'Textures/base.dds', 'Textures/high.dds', 'Textures/low.dds', 'both.txt', 'meshes/x.nif', 'meshes/y.nif', 'shared.txt'])
  assert.deepEqual([files['shared.txt'], files['both.txt'], files['meshes/x.nif']], ['high', 'over', 'high'])
  assert.equal(scan.totalBytes, scan.entries.reduce((n, e) => n + e.size, 0))
  const order = await loadOrder.readLoadOrder(candidate, scan, { LOCALAPPDATA: join(dir, 'unused') })
  assert.deepEqual([order.source, order.plugins, order.warnings], ['mo2-profile', ['FalloutNV.esm', 'LowPlugin.esp', 'HighPlugin.esp'], []])
  put(join(profile, 'loadorder.txt'), 'FalloutNV.esm\r\nHighPlugin.esp\r\nLowPlugin.esp\r\n')
  assert.ok((await loadOrder.readLoadOrder(candidate, scan)).warnings.some((w) => /loadorder\.txt and plugins\.txt disagree/.test(w)))
})

test('scan pre-checks report what the host would refuse before anything is uploaded', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), mods = join(dir, 'mods'), profile = join(dir, 'profiles', 'Default')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), '')
  put(join(data, 'Deep', 'x'.repeat(120), `${'y'.repeat(120)}.dds`), 'long')
  put(join(data, 'textures', 'a.dds'), 'dir'); put(join(mods, 'A', 'Textures'), 'a file named like the folder')
  put(join(profile, 'modlist.txt'), '+A\r\n')
  const scan = await dataSet.scanDataSet({
    id: 'mo2:x', root: game, data, source: 'mo2', label: 'x', hasNvmpLauncher: false, supported: true, warnings: [],
    mo2: { instanceDir: dir, profile: 'Default', profileDir: profile, modsDir: mods, overwriteDir: join(dir, 'overwrite') }
  })
  assert.ok(scan.problems.some((p) => /longer than 240 characters: Data\/Deep\//.test(p)))
  assert.ok(scan.problems.some((p) => /A file and a folder share the name Data\/textures: Data\/textures\/a\.dds/.test(p)))
  assert.ok(scan.problems.some((p) => /FalloutNV\.esm is missing or empty/.test(p)))
  assert.equal(scan.entries.some((e) => e.rel.startsWith('Deep/')), false)
  await assert.rejects(browser.selectNvmpFiles(await dataSet.toUploadFiles(scan.entries)), /collision|FalloutNV/, 'the panel code agrees with the pre-check')
})

test('a scanned install uploads through the browser transfer to the real host, resumes, and finishes with its load order', async () => {
  const g = plainGame({ baseName: 'falloutnv.esm', baseSize: 2 * CHUNK + 123 })
  put(join(g.local, 'FalloutNV', 'plugins.txt'), cp1252('FalloutNV.esm\r\nDeadMoney.esm\r\nHonestHearts.esm\r\nMasterlike.esp\r\nMod.esp\r\n*Caf\u00e9.esp\r\n'))
  const game = await detect.candidateFromFolder(g.data, detect.realIO)
  assert.deepEqual([game.source, game.hasNvmpLauncher, game.supported, game.warnings], ['manual', true, true, []])
  const scan = await dataSet.scanDataSet(game)
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.skippedExecutables, ['Data/NVSE/Plugins/nvse_plugin.dll'])
  const rels = scan.entries.map((e) => e.rel)
  assert.ok(rels.includes('FalloutNV.esm') && !rels.includes('falloutnv.esm'), 'the base master is uploaded under the name the host requires')
  assert.ok(rels.includes('Meshes/linked.nif') && rels.includes('Sound/voice.wav'), 'hard links and folder junctions are followed')
  assert.equal(rels.some((r) => r.startsWith('Loop/')), false, 'a junction back into Data is not followed')
  if (g.fileLinks) assert.ok(rels.includes('song.mp3'))
  // Links to folders outside Data are still followed, but listed so the player can confirm them (a hard link has no other side).
  assert.deepEqual(scan.outsideLinks, [
    { rel: 'Sound', target: fs.realpathSync.native(join(g.dir, 'shared-sounds')) },
    ...(g.fileLinks ? [{ rel: 'song.mp3', target: fs.realpathSync.native(join(g.dir, 'staging', 'song.mp3')) }] : [])
  ])
  const order = await loadOrder.readLoadOrder(game, scan, { LOCALAPPDATA: g.local })
  assert.deepEqual([order.plugins, order.warnings], [['FalloutNV.esm', 'DeadMoney.esm', 'HonestHearts.esm', 'Masterlike.esp', 'Mod.esp', 'Café.esp'], []])

  const host = temp(); api.initialiseNvmpUpload(host)
  const ask = async (action, p = {}) => {
    if (action === 'nvmpStatus') return api.nvmpSetupStatus(host, !!p.detail)
    if (action === 'nvmpBegin') return api.beginNvmpUpload(host, p.files)
    if (action === 'nvmpChunk') return api.uploadNvmpChunk(host, p.session, p.index, p.offset, p.data, p.checksum)
    if (action === 'nvmpFinish') return api.finishNvmpUpload(host, p.session, p.loadOrder, nvmp.readNvmpPlugins)
    throw new Error(`Unexpected ${action}`)
  }
  const select = async () => browser.selectNvmpFiles(await dataSet.toUploadFiles((await dataSet.scanDataSet(game)).entries))
  const first = await select()
  assert.deepEqual(first.skipped, [], 'executables were already set aside by the scan (scan.skippedExecutables)')
  assert.equal(first.manifest.length, scan.entries.length)
  // The disk-backed files fingerprint exactly like browser Files holding the same bytes, so panel and companion manifests match.
  const inMemory = scan.entries.map((e) => {
    const file = new File([fs.readFileSync(e.abs)], e.rel.slice(e.rel.lastIndexOf('/') + 1), { lastModified: e.modified })
    return Object.defineProperty(file, 'webkitRelativePath', { value: `Data/${e.rel}` })
  })
  assert.equal(JSON.stringify((await browser.selectNvmpFiles(inMemory)).manifest), JSON.stringify(first.manifest))
  const begun = await ask('nvmpBegin', { files: first.manifest })
  const chunks = begun.files.reduce((n, f) => n + Math.ceil(f.size / CHUNK), 0), base = begun.files.find((f) => f.path === 'Data/FalloutNV.esm')
  assert.ok(Math.ceil(base.size / CHUNK) === 3 && chunks > 3)

  const acknowledged = new Set(), stop = new AbortController()
  await browser.transferNvmpFiles(async (action, p) => {
    const reply = await ask(action, p); acknowledged.add(`${p.index}:${p.offset}`)
    if (acknowledged.size >= 2) stop.abort()
    return reply
  }, first, begun, stop.signal, () => {})
  const paused = await ask('nvmpStatus')
  assert.equal(paused.phase, 'uploading')
  assert.ok(paused.receivedBytes > 0 && paused.receivedBytes < paused.totalBytes)

  // Resuming = a fresh scan whose manifest is byte-identical, so the host hands back its chunk bitmaps.
  const second = await select()
  assert.equal(JSON.stringify(second.manifest), JSON.stringify(first.manifest))
  const resumed = await ask('nvmpBegin', { files: second.manifest })
  assert.equal(resumed.session, begun.session)
  assert.equal(resumed.receivedBytes, paused.receivedBytes)
  const resent = []
  await browser.transferNvmpFiles(async (action, p) => { resent.push(`${p.index}:${p.offset}`); return ask(action, p) }, second, resumed, new AbortController().signal, () => {})
  assert.equal(resent.filter((k) => acknowledged.has(k)).length, 0, 'acknowledged chunks are not sent again')
  assert.equal(resent.length + acknowledged.size, chunks)

  const done = await ask('nvmpFinish', { session: resumed.session, loadOrder: order.text })
  assert.equal(done.phase, 'ready')
  const byRel = new Map(scan.entries.map((e) => [e.rel, e]))
  for (const file of first.manifest) assert.deepEqual(fs.readFileSync(join(host, file.path)), fs.readFileSync(byRel.get(file.path.slice(5)).abs), file.path)
  assert.equal(fs.existsSync(join(host, 'Data/NVSE')), false)
  assert.equal(fs.readFileSync(join(host, 'plugins_override.txt'), 'utf8'), order.text)
  assert.deepEqual(nvmp.readNvmpPlugins(host), order.plugins)
  const uploaded = new Set(first.manifest.map((f) => f.path))
  for (const name of order.plugins) assert.ok(uploaded.has(`Data/${name}`), `${name} matches an uploaded path exactly, as the Linux host requires`)

  fs.appendFileSync(join(g.data, 'Mod.esp'), 'changed')
  await assert.rejects(dataSet.toUploadFiles(scan.entries), /Mod\.esp changed after the scan/)
})

test('links to folders outside Data are followed but listed with their real target, nested ones too', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), home = join(dir, 'FakeHome')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  put(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY'); put(join(home, 'Documents', 'taxes.pdf'), '%PDF')
  put(join(dir, 'Elsewhere', 'deep.dds'), 'deep')
  fs.symlinkSync(join(dir, 'Elsewhere'), join(home, 'Documents', 'More'), 'junction')
  fs.mkdirSync(join(data, 'Textures')); fs.symlinkSync(home, join(data, 'Textures', 'extra'), 'junction')
  put(join(dir, 'Tools', 'helper.dll'), 'MZ'); fs.symlinkSync(join(dir, 'Tools'), join(data, 'Tools'), 'junction') // supplies nothing uploadable
  put(join(data, 'Meshes', 'm.nif'), 'mesh'); fs.symlinkSync(join(data, 'Meshes'), join(data, 'MeshAlias'), 'junction') // stays inside Data
  const scan = await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.entries.map((e) => e.rel).sort(), ['FalloutNV.esm', 'MeshAlias/m.nif', 'Meshes/m.nif', 'Textures/extra/.ssh/id_ed25519',
    'Textures/extra/Documents/More/deep.dds', 'Textures/extra/Documents/taxes.pdf'])
  assert.deepEqual(scan.skippedExecutables, ['Data/Tools/helper.dll'])
  assert.deepEqual(scan.outsideLinks, [
    { rel: 'Textures/extra', target: fs.realpathSync.native(home) },
    { rel: 'Textures/extra/Documents/More', target: fs.realpathSync.native(join(dir, 'Elsewhere')) }
  ])
})

test('a link whose target cannot be read is listed as outside the game, never taken to be inside it', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), lost = join(data, 'Textures', 'lost')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  put(join(data, 'Meshes', 'm.nif'), 'mesh')
  fs.mkdirSync(join(data, 'Textures')); fs.symlinkSync(join(data, 'Meshes'), lost, 'junction') // points inside Data, but nobody can tell
  // a junction to a volume without a drive letter: both realpath and readlink fail for this one path
  const same = (p) => resolve(String(p)).toLowerCase() === resolve(lost).toLowerCase()
  const unreadable = () => Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' })
  const fsp = await import('node:fs/promises')
  const blind = load('companion/main/dataSet.ts', {
    '@shared/nvmpUpload': policy, './fileReader': fileReader,
    'fs/promises': { ...fsp, realpath: async (p, o) => { if (same(p)) throw unreadable(); return fsp.realpath(p, o) },
      readlink: async (p, o) => { if (same(p)) throw unreadable(); return fsp.readlink(p, o) } }
  })
  const scan = await blind.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.entries.map((e) => e.rel).sort(), ['FalloutNV.esm', 'Meshes/m.nif', 'Textures/lost/m.nif'])
  assert.deepEqual(scan.outsideLinks, [{ rel: 'Textures/lost', target: `${lost} (where this link points cannot be read)` }])
  // the same folder seen normally stays inside Data
  assert.deepEqual((await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))).outsideLinks, [])
})

test('a link retargeted after the scan to a file of the same size and date is caught: the upload reads only the files it scanned', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), link = join(data, 'Textures', 'extra')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  put(join(dir, 'Shared', 'pack.dds'), 'textures', 3)
  put(join(dir, 'Private', 'pack.dds'), 'personal', 3) // same name, size and date, other bytes
  fs.mkdirSync(join(data, 'Textures')); fs.symlinkSync(join(dir, 'Shared'), link, 'junction')
  const scan = await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  const entry = scan.entries.find((e) => e.rel === 'Textures/extra/pack.dds')
  assert.match(entry.fileId ?? '', /^\d+:\d+$/, 'every scanned file carries its id on disk')
  const files = await dataSet.toUploadFiles(scan.entries), file = files.find((f) => f.webkitRelativePath === 'Data/Textures/extra/pack.dds')
  assert.equal(await file.slice(0, 8).text(), 'textures')

  fs.unlinkSync(link); fs.symlinkSync(join(dir, 'Private'), link, 'junction')
  const now = fs.statSync(join(link, 'pack.dds'))
  assert.deepEqual([now.size, Math.floor(now.mtimeMs)], [entry.size, entry.modified], 'size and date alone cannot tell the two apart')
  // an open upload: the next read refuses the other file
  assert.throws(() => file.slice(0, 8), (error) => fileReader.isChangedFileError(error) && error.message === 'changed: Data/Textures/extra/pack.dds')
  // a fresh start from the old scan: refused before anything is read
  await assert.rejects(dataSet.toUploadFiles(scan.entries), /Textures\/extra\/pack\.dds changed after the scan/)
  // a file replaced in place (deleted and written again with the same size and date) is another file too
  const esm = join(data, 'FalloutNV.esm'), before = scan.entries.find((e) => e.rel === 'FalloutNV.esm')
  fs.unlinkSync(link); fs.symlinkSync(join(dir, 'Shared'), link, 'junction')
  const bytes = fs.readFileSync(esm); fs.rmSync(esm); put(esm, bytes, 0)
  assert.deepEqual([fs.statSync(esm).size, Math.floor(fs.statSync(esm).mtimeMs)], [before.size, before.modified])
  await assert.rejects(dataSet.toUploadFiles(scan.entries), /FalloutNV\.esm changed after the scan/)
})

test('Mod Organizer 2: links between the profile\'s own layers are not listed; links supplying files from elsewhere are', async () => {
  const dir = temp(), game = join(dir, 'Game'), data = join(game, 'Data'), instance = join(dir, 'MO2'), mods = join(instance, 'mods')
  const profile = join(instance, 'profiles', 'Default'), overwrite = join(instance, 'overwrite')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  put(join(dir, 'Other drive', 'Stored', 'stored.dds'), 'stored')
  fs.mkdirSync(mods, { recursive: true }); fs.symlinkSync(join(dir, 'Other drive', 'Stored'), join(mods, 'Stored'), 'junction') // a mod kept on another drive
  put(join(mods, 'A', 'a.esp'), plugin(false, 64, 2), 1)
  fs.symlinkSync(join(mods, 'Stored'), join(mods, 'A', 'FromStored'), 'junction') // into another enabled mod
  put(join(overwrite, 'ow.txt'), 'ow'); fs.symlinkSync(overwrite, join(mods, 'A', 'FromOverwrite'), 'junction')
  put(join(mods, 'Off', 'off.dds'), 'off'); fs.symlinkSync(join(mods, 'Off'), join(mods, 'A', 'FromOff'), 'junction') // a disabled mod
  put(join(dir, 'Home', 'notes.txt'), 'notes'); fs.symlinkSync(join(dir, 'Home'), join(mods, 'A', 'Home'), 'junction')
  put(join(dir, 'Old', 'over.nif'), 'old'); fs.mkdirSync(join(mods, 'A', 'Meshes')); fs.symlinkSync(join(dir, 'Old'), join(mods, 'A', 'Meshes', 'Old'), 'junction')
  put(join(mods, 'B', 'Meshes', 'Old', 'over.nif'), 'new') // B outranks A, so A's outside copy is never uploaded
  put(join(profile, 'modlist.txt'), '+B\r\n+A\r\n+Stored\r\n-Off\r\n')
  const scan = await dataSet.scanDataSet({
    id: 'mo2:links', root: game, data, source: 'mo2', label: 'x', hasNvmpLauncher: true, supported: true, warnings: [],
    mo2: { instanceDir: instance, profile: 'Default', profileDir: profile, modsDir: mods, overwriteDir: overwrite }
  })
  assert.deepEqual(scan.problems, [])
  const files = Object.fromEntries(scan.entries.map((e) => [e.rel, fs.readFileSync(e.abs, 'utf8')]))
  assert.deepEqual(Object.keys(files).sort(), ['FalloutNV.esm', 'FromOff/off.dds', 'FromOverwrite/ow.txt', 'FromStored/stored.dds', 'Home/notes.txt',
    'Meshes/Old/over.nif', 'a.esp', 'ow.txt', 'stored.dds'])
  assert.equal(files['Meshes/Old/over.nif'], 'new')
  assert.deepEqual(scan.outsideLinks, [
    { rel: 'FromOff', target: fs.realpathSync.native(join(mods, 'Off')) },
    { rel: 'Home', target: fs.realpathSync.native(join(dir, 'Home')) }
  ])
})

/** 1,000 empty files, plus junctions that show the same folder under more names (cheap way past 10,000 entries). */
function manyFiles(folder, aliases) {
  fs.mkdirSync(folder, { recursive: true })
  for (let i = 0; i < 1000; i++) fs.writeFileSync(join(folder, `f${i}.dds`), '')
  for (const alias of aliases) { fs.mkdirSync(dirname(alias), { recursive: true }); fs.symlinkSync(folder, alias, 'junction') }
}

test('the 10,000-file limit says what counts, what to remove and where most files are', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  manyFiles(join(data, 'Textures', 'pack'), [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => join(data, 'Textures', `pack${n}`)))
  put(join(data, 'fomod', 'ModuleConfig.xml'), '<config/>'); put(join(data, 'readme - Mod.txt'), 'read me')
  put(join(data, 'FNVEdit Backups', 'Mod.esp.backup.2020_01_01'), 'backup')
  const plain = await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  assert.equal(plain.entries.length, 10_004)
  const limit = plain.problems.find((p) => /an upload can hold at most/.test(p))
  assert.match(limit, /^Data has 10,004 files; an upload can hold at most 10,000\. Every file in the Data folder counts/)
  assert.match(limit, /fomod installer folders, readme files and xEdit backups \(3 here\)\. Remove those and any mods your group does not play with/)
  assert.match(limit, /Most files are in Data\/Textures \(10,000\), files directly in Data \(2\)/)

  // MO2: only enabled mods count, and the message names the mods that bring the most files.
  const stock = join(dir, 'Stock Game'), instance = join(dir, 'MO2'), mods = join(instance, 'mods'), profile = join(instance, 'profiles', 'Server')
  put(join(stock, 'FalloutNV.exe'), 'MZ'); put(join(stock, 'Data', 'FalloutNV.esm'), plugin(true, 64), 0)
  const pack = join(mods, 'Huge Textures', 'Textures', 'pack')
  manyFiles(pack, [2, 3, 4, 5, 6, 7].map((n) => join(mods, 'Huge Textures', 'Textures', `p${n}`)))
  for (const name of ['a', 'b', 'c']) { fs.mkdirSync(join(mods, 'Big Meshes', 'Meshes'), { recursive: true }); fs.symlinkSync(pack, join(mods, 'Big Meshes', 'Meshes', name), 'junction') }
  manyFiles(join(mods, 'Unused', 'Textures'), [])
  put(join(profile, 'modlist.txt'), '+Big Meshes\r\n-Unused\r\n+Huge Textures\r\n')
  const mo2 = await dataSet.scanDataSet({
    id: 'mo2:many', root: stock, data: join(stock, 'Data'), source: 'mo2', label: 'x', hasNvmpLauncher: true, supported: true, warnings: [],
    mo2: { instanceDir: instance, profile: 'Server', profileDir: profile, modsDir: mods, overwriteDir: join(instance, 'overwrite') }
  })
  assert.equal(mo2.entries.length, 10_001)
  assert.deepEqual(mo2.outsideLinks, [], 'junctions between enabled mods stay inside what the profile uploads')
  assert.deepEqual(mo2.problems, ['Data has 10,001 files; an upload can hold at most 10,000. Mods disabled in Mod Organizer 2 profile "Server" do not count: ' +
    'disable the mods your group does not play with (a profile just for this server works well), then check again. ' +
    'Most files come from "Huge Textures" (7,000), "Big Meshes" (3,000), the game\'s own Data folder (1).'])
})

/** An empty file that grows sparsely (NTFS needs the flag first, or a 4 GiB test file would take 4 GiB of disk). */
function sparse(path, size) {
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, '')
  try {
    if (process.platform === 'win32') execFileSync('fsutil', ['sparse', 'setflag', path], { stdio: 'pipe', windowsHide: true })
    fs.truncateSync(path, size)
    return true
  } catch { return false }
}

test('files of 4 GiB or more keep their real size, fingerprint and chunk offsets, through to the host', async (t) => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), huge = join(data, 'Movies', 'Huge.bik')
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  // fs.openAsBlob reported this file as 524,345 bytes (size mod 2^32), so every upload of it failed.
  const at4G = 2 ** 32, size = at4G + CHUNK + 12_345, tailAt = at4G - 1000
  if (!sparse(huge, size)) { t.skip('this filesystem cannot hold a sparse file past 4 GiB'); return }
  const head = randomBytes(70_000), tail = randomBytes(size - tailAt)
  const fd = fs.openSync(huge, 'r+')
  try { fs.writeSync(fd, head, 0, head.length, 0); fs.writeSync(fd, tail, 0, tail.length, tailAt) } finally { fs.closeSync(fd) }
  fs.utimesSync(huge, T0 + DAY, T0 + DAY)

  const scan = await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  assert.deepEqual(scan.problems, [])
  assert.equal(scan.entries.find((e) => e.rel === 'Movies/Huge.bik').size, size)
  const files = await dataSet.toUploadFiles(scan.entries)
  const file = files.find((f) => f.webkitRelativePath === 'Data/Movies/Huge.bik')
  assert.deepEqual([file.name, file.size, file.lastModified], ['Huge.bik', size, (T0 + DAY) * 1000])
  const read = async (from, to) => Buffer.from(await file.slice(from, to).arrayBuffer())
  assert.deepEqual(await read(at4G - 8, at4G + 8), tail.subarray(at4G - tailAt - 8, at4G - tailAt + 8), 'bytes across the 4 GiB mark')
  assert.deepEqual(await read(at4G + CHUNK, at4G + 2 * CHUNK), tail.subarray(at4G - tailAt + CHUNK), 'the short last chunk')
  const selection = await browser.selectNvmpFiles(files)
  // Same sample layout as the panel: first 64 KiB, last 64 KiB, then the size as text.
  const sample = createHash('sha256').update(head.subarray(0, 65536)).update(tail.subarray(tail.length - 65536)).update(String(size)).digest('hex')
  assert.deepEqual(selection.manifest.find((f) => f.path === 'Data/Movies/Huge.bik'), { path: 'Data/Movies/Huge.bik', size, modified: (T0 + DAY) * 1000, sample })

  // The real host accepts the manifest and stores the two chunks past 4 GiB at their offsets (the rest marked as already there).
  const host = temp(); api.initialiseNvmpUpload(host)
  const begun = api.beginNvmpUpload(host, selection.manifest)
  const index = begun.files.findIndex((f) => f.path === 'Data/Movies/Huge.bik'), missing = [at4G / CHUNK, at4G / CHUNK + 1]
  const staged = join(host, api.NVMP_UPLOAD_DIR, begun.session, 'staged', 'Data', 'Movies', 'Huge.bik')
  assert.ok(sparse(staged, 0))
  const status = {
    ...begun,
    files: begun.files.map((f, i) => {
      const bits = Buffer.alloc(Math.ceil(Math.ceil(f.size / CHUNK) / 8), 0xff)
      if (i === index) for (const n of missing) bits[n >> 3] &= ~(1 << (n & 7))
      return { ...f, bitmap: bits.toString('base64') }
    })
  }
  const sent = []
  await browser.transferNvmpFiles(async (action, p) => {
    sent.push(p.offset)
    return api.uploadNvmpChunk(host, p.session, p.index, p.offset, p.data, p.checksum)
  }, selection, status, new AbortController().signal, () => {})
  assert.deepEqual(sent.sort((a, b) => a - b), [at4G, at4G + CHUNK])
  const landed = Buffer.alloc(CHUNK + 12_345), sfd = fs.openSync(staged, 'r')
  try { fs.readSync(sfd, landed, 0, landed.length, at4G) } finally { fs.closeSync(sfd) }
  assert.deepEqual(landed, tail.subarray(at4G - tailAt))
  assert.equal(api.nvmpSetupStatus(host).receivedBytes, CHUNK + 12_345)
})

test('a Data file that changes after the scan fails its next read with an identifiable error, and the transfer stops', async () => {
  const dir = temp(), game = join(dir, 'FNV'), data = join(game, 'Data'), content = randomBytes(8 * CHUNK + 10)
  put(join(game, 'FalloutNV.exe'), 'MZ'); put(join(data, 'FalloutNV.esm'), plugin(true, 64), 0)
  const bsa = put(join(data, 'Big.bsa'), content, 1)
  for (const name of ['a', 'b', 'c']) put(join(data, `${name}.ini`), 'abcdef', 1)
  const scan = await dataSet.scanDataSet(await detect.candidateFromFolder(game, detect.realIO))
  const list = await dataSet.toUploadFiles(scan.entries), files = new Map(list.map((f) => [f.webkitRelativePath, f]))
  const big = files.get('Data/Big.bsa')
  // Blob.slice semantics, but never more than one chunk in memory
  assert.deepEqual(Buffer.from(await big.slice(-4).arrayBuffer()), content.subarray(-4))
  assert.equal(big.slice(5, 2).size, 0); assert.equal(big.slice(big.size + 9).size, 0)
  assert.throws(() => big.slice(0, CHUNK + 1), RangeError)
  assert.throws(() => big.slice(Number.NaN), RangeError)
  assert.equal(await files.get('Data/a.ini').text(), 'abcdef')
  const selection = await browser.selectNvmpFiles(list)

  // Changed after the first piece arrives: the four pieces already read still land, nothing after them is sent.
  const host = temp(); api.initialiseNvmpUpload(host)
  const begun = api.beginNvmpUpload(host, selection.manifest)
  let sent = 0
  const failed = await browser.transferNvmpFiles(async (action, p) => {
    if (++sent === 1) fs.utimesSync(bsa, T0 + 5 * DAY, T0 + 5 * DAY)
    return api.uploadNvmpChunk(host, p.session, p.index, p.offset, p.data, p.checksum)
  }, selection, begun, new AbortController().signal, () => {}).then(() => null, (error) => error)
  assert.ok(failed instanceof fileReader.ChangedFileError, String(failed))
  assert.deepEqual([failed.message, failed.path, failed.code], ['changed: Data/Big.bsa', 'Data/Big.bsa', fileReader.CHANGED_FILE_CODE])
  assert.ok(sent <= 4, `${sent} pieces were sent`)
  assert.ok(api.nvmpSetupStatus(host).receivedBytes < begun.totalBytes)

  // Same size but a new date, a new size, and a removed file are all changes.
  fs.utimesSync(join(data, 'a.ini'), T0 + 9 * DAY, T0 + 9 * DAY)
  fs.appendFileSync(join(data, 'b.ini'), '!')
  fs.rmSync(join(data, 'c.ini'))
  for (const name of ['a', 'b', 'c']) {
    assert.throws(() => files.get(`Data/${name}.ini`).slice(0, 3), (error) => fileReader.isChangedFileError(error) && error.message === `changed: Data/${name}.ini`)
  }
  assert.ok(fileReader.isChangedFileError(new Error('changed: Data/x.esp')), 'still recognised once only the message is left')
  assert.equal(fileReader.changedFilePath(new Error('changed: Data/x.esp')), 'Data/x.esp')
  assert.ok(!fileReader.isChangedFileError(new Error("EBUSY: resource busy or locked, open 'x'")))
})

test('a file another program holds locked is not reported as changed, and reads again once released', { skip: process.platform !== 'win32' && 'Windows file sharing' }, async (t) => {
  const file = put(join(temp(), 'Data', 'Locked.esp'), 'locked bytes', 1), st = fs.statSync(file)
  const disk = fileReader.diskFile({ abs: file, rel: 'Locked.esp', size: st.size, modified: Math.floor(st.mtimeMs) })
  const script = `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $f.Close()`
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  const exited = new Promise((resolve) => ps.once('close', resolve))
  const locked = await new Promise((resolve) => { ps.stdout.once('data', () => resolve(true)); ps.once('error', () => resolve(false)); exited.then(() => resolve(false)) })
  if (!locked) { t.skip('PowerShell could not lock the file'); return }
  try {
    assert.throws(() => disk.slice(0, 6), (error) => !fileReader.isChangedFileError(error) && error.code === 'EBUSY')
  } finally {
    ps.stdin.end('\n'); await exited
  }
  assert.equal(await disk.slice(0, 6).text(), 'locked')
})

test('a file written to while a piece is being read fails that read as changed: it is checked again after reading', () => {
  const file = put(join(temp(), 'Data', 'Busy.esp'), randomBytes(3000), 1), st = fs.statSync(file)
  let writeDuringRead = false
  // the same module, with a readSync during which another program touches the file
  const reader = load('companion/main/fileReader.ts', {
    '@shared/nvmpUpload': policy,
    fs: { ...fs, readSync: (...args) => { const n = fs.readSync(...args); if (writeDuringRead) fs.utimesSync(file, T0 + 7 * DAY, T0 + 7 * DAY); return n } }
  })
  const disk = reader.diskFile({ abs: file, rel: 'Busy.esp', size: st.size, modified: Math.floor(st.mtimeMs) })
  assert.equal(disk.slice(0, 10).size, 10, 'an undisturbed read passes the checks before and after')
  writeDuringRead = true
  assert.throws(() => disk.slice(10, 20), (error) => reader.isChangedFileError(error) && error.message === 'changed: Data/Busy.esp')
})
