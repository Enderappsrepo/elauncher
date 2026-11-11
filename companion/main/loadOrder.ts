// The load order sent with nvmpFinish. The Linux host checks every name case-sensitively against Data,
// so each plugin is written in the exact case of the file being uploaded.
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'fs'
import { join } from 'path'
import type { DataEntry, DataSetScan, GameCandidate, LoadOrderResult } from '../shared/types'

const BASE = 'FalloutNV.esm'
const NAME = /^[^/\\:\x00-\x1f]+\.(?:esm|esp)$/i
const MAX_TEXT = 64 * 1024
const DLC = ['DeadMoney.esm', 'HonestHearts.esm', 'OldWorldBlues.esm', 'LonesomeRoad.esm', 'GunRunnersArsenal.esm', 'ClassicPack.esm', 'MercenaryPack.esm', 'TribalPack.esm', 'CaravanPack.esm']
// windows-1252 bytes 0x80-0x9F; the five unassigned ones stay C1 controls, as in the WHATWG decoder.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
]
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b)
  return out
}

function strictUtf8(bytes: Uint8Array): string | null {
  try { return utf8.decode(bytes) } catch { return null }
}

/** Each line's possible readings, preferred first. plugins.txt is ANSI (windows-1252), but a BOM or valid UTF-8 is honoured too. */
function readLines(input: Uint8Array, ansi: boolean): string[][] {
  let bytes = input
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bytes = bytes.subarray(3); ansi = false }
  const lines: string[][] = []
  for (let start = 0, i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue
    const line = bytes.subarray(start, i), unicode = strictUtf8(line)
    start = i + 1
    lines.push([...new Set(ansi ? [decodeWindows1252(line), ...(unicode === null ? [] : [unicode])] : [unicode ?? decodeWindows1252(line)])])
  }
  return lines
}

function readBytes(file: string): Buffer | null {
  try { return readFileSync(file) } catch { return null }
}

/** Plugins directly in Data, by lower-cased name. */
function pluginIndex(scan: DataSetScan): Map<string, DataEntry> {
  const index = new Map<string, DataEntry>()
  for (const entry of scan.entries) if (!entry.rel.includes('/') && /\.(?:esm|esp)$/i.test(entry.rel)) index.set(entry.rel.toLowerCase(), entry)
  return index
}

/** The TES4 header's master flag (uint32 at byte 8, bit 0x1) decides, not the extension; unreadable files fall back to it. */
function isMaster(entry: DataEntry): boolean {
  const header = Buffer.alloc(12)
  let read = 0
  try {
    const fd = openSync(entry.abs, 'r')
    try { read = readSync(fd, header, 0, 12, 0) } finally { closeSync(fd) }
  } catch { /* fall back to the extension */ }
  if (read === 12 && header.toString('latin1', 0, 4) === 'TES4') return (header.readUInt32LE(8) & 1) !== 0
  return /\.esm$/i.test(entry.rel)
}

/** The game's own order (libloadorder, timestamp games): masters first, then oldest first; equal times by name, reversed. */
function engineOrder(names: string[], index: Map<string, DataEntry>): string[] {
  const info = new Map(names.map((name) => {
    const entry = index.get(name.toLowerCase())
    return [name, { master: entry ? isMaster(entry) : true, time: entry?.modified ?? 0 }] as const
  }))
  const rest = names.filter((n) => n.toLowerCase() !== 'falloutnv.esm').sort((a, b) => {
    const x = info.get(a)!, y = info.get(b)!
    return Number(y.master) - Number(x.master) || x.time - y.time || (a < b ? 1 : a > b ? -1 : 0)
  })
  const base = names.find((n) => n.toLowerCase() === 'falloutnv.esm')
  return base ? [base, ...rest] : rest
}

/** Plugins a Data\<name>.nam switches on whether or not a plugin list names them. */
function namPlugins(scan: DataSetScan, index: Map<string, DataEntry>): string[] {
  const out: string[] = []
  for (const entry of scan.entries) {
    if (entry.rel.includes('/') || !/\.nam$/i.test(entry.rel)) continue
    const stem = entry.rel.slice(0, -4).toLowerCase()
    for (const ext of ['.esm', '.esp']) {
      const hit = index.get(stem + ext)
      if (hit && !out.includes(hit.rel)) out.push(hit.rel)
    }
  }
  return out
}

/** Map listed names to scanned files (exact case), collecting every reason a line cannot be used. */
function resolveNames(lines: string[][], index: Map<string, DataEntry>, where: string, skipping = false): { plugins: string[]; problems: string[] } {
  const plugins: string[] = [], problems: string[] = [], seen = new Set<string>()
  const left = skipping ? ' It was left out.' : ''
  for (const readings of lines) {
    const options = readings.map((r) => r.trim().replace(/^\*+\s*/, ''))
    const shown = options[0]
    if (!shown || shown.startsWith('#')) continue
    const hit = options.map((o) => index.get(o.toLowerCase())).find((e) => e !== undefined)
    if (!hit) {
      problems.push(NAME.test(shown)
        ? `${where} lists ${shown}, which is not in the Data folder being uploaded.${left}`
        : `${where} has "${shown}", which is not a plugin file name (an .esm or .esp directly in Data).${left}`)
    } else if (seen.has(hit.rel.toLowerCase())) {
      problems.push(`${where} lists ${hit.rel} more than once.${skipping ? ' Only the first entry is used.' : ''}`)
    } else {
      seen.add(hit.rel.toLowerCase())
      plugins.push(hit.rel)
    }
  }
  return { plugins, problems }
}

/** Put extra plugins where the game's own order would place them relative to the listed ones. */
function insertByEngine(plugins: string[], extra: string[], index: Map<string, DataEntry>): string[] {
  const out = [...plugins], engine = engineOrder([...plugins, ...extra], index)
  for (const name of engine.filter((n) => extra.includes(n))) {
    let after = 0
    for (let i = engine.indexOf(name) - 1; i >= 0; i--) {
      const j = out.indexOf(engine[i])
      if (j >= 0) { after = j; break }
    }
    out.splice(after + 1, 0, name)
  }
  return out
}

function orderWarning(plugins: string[], engine: string[], where: string): string | null {
  const i = plugins.findIndex((name, n) => name !== engine[n])
  if (i < 0) return null
  return `${where} puts ${plugins[i]} at position ${i + 1}, but the file dates (the order Fallout: New Vegas itself loads) put ${engine[i]} there. ` +
    'The server gets the order shown here; make sure it is the order your group plays with.'
}

function result(plugins: string[], source: LoadOrderResult['source'], warnings: string[], index: Map<string, DataEntry>, where: string): LoadOrderResult {
  const engine = engineOrder(plugins, index), mismatch = orderWarning(plugins, engine, where)
  if (mismatch) warnings.push(mismatch)
  return { plugins, text: `${plugins.join('\r\n')}\r\n`, source, warnings, ...(mismatch ? { timestampOrder: engine } : {}) }
}

const isEpic = (game: GameCandidate): boolean => game.source === 'epic' || existsSync(join(game.root, 'EOSSDK-Win32-Shipping.dll'))

/** The order the player's game actually uses: the MO2 profile's lists, else %LOCALAPPDATA%\FalloutNV\plugins.txt. */
export async function readLoadOrder(game: GameCandidate, scan: DataSetScan, env: Record<string, string | undefined> = process.env): Promise<LoadOrderResult> {
  const index = pluginIndex(scan), warnings: string[] = []
  const base = index.get(BASE.toLowerCase())?.rel ?? BASE
  if (!index.has(BASE.toLowerCase())) warnings.push('Data/FalloutNV.esm is missing, so the load order cannot be checked.')
  const local = env.LOCALAPPDATA
  const file = game.mo2 ? join(game.mo2.profileDir, 'plugins.txt') : local ? join(local, isEpic(game) ? 'FalloutNV_Epic' : 'FalloutNV', 'plugins.txt') : null
  const where = game.mo2 ? `Mod Organizer 2 profile "${game.mo2.profile}"` : 'plugins.txt'
  const bytes = file ? readBytes(file) : null

  if (!bytes) {
    const present = [...[BASE, ...DLC].map((n) => index.get(n.toLowerCase())?.rel), ...namPlugins(scan, index)]
    const plugins = engineOrder([...new Set([base, ...present.filter((n): n is string => !!n)])], index)
    warnings.push(`No plugins.txt was found${file ? ` at ${file}` : ''}, so only FalloutNV.esm and the official DLC are listed, in file-date order. ` +
      'Add your other active plugins in load order before finishing setup.')
    return { plugins, text: `${plugins.join('\r\n')}\r\n`, source: 'timestamps', warnings }
  }

  const listed = resolveNames(readLines(bytes, true), index, where, true)
  warnings.push(...listed.problems)
  if (!listed.plugins.length) warnings.push(`${where} lists no plugins (${file}). Check the load order below before finishing setup.`)
  if (listed.plugins.includes(base) && listed.plugins[0] !== base) warnings.push('FalloutNV.esm was moved to the top of the load order, where the game always loads it.')
  let plugins = [base, ...listed.plugins.filter((n) => n !== base)]
  const implied = namPlugins(scan, index).filter((n) => !plugins.includes(n))
  if (implied.length) {
    plugins = insertByEngine(plugins, implied, index)
    warnings.push(...implied.map((n) => `${n} was added: its .nam file in Data makes the game load it even though ${where} does not list it.`))
  }

  if (game.mo2) {
    const order = readBytes(join(game.mo2.profileDir, 'loadorder.txt'))
    if (order) {
      const active = new Set(plugins.map((n) => n.toLowerCase()))
      const saved = resolveNames(readLines(order, false), index, 'loadorder.txt').plugins.filter((n) => active.has(n.toLowerCase()))
      const savedSet = new Set(saved)
      if (plugins.filter((n) => savedSet.has(n)).join('\n') !== saved.join('\n')) {
        warnings.push('Mod Organizer 2\'s loadorder.txt and plugins.txt disagree. Open Mod Organizer 2 once so it saves both, then scan again.')
      }
    }
  }
  const out = result(plugins, game.mo2 ? 'mo2-profile' : 'plugins.txt', warnings, index, where)
  if (Buffer.byteLength(out.text) > MAX_TEXT) out.warnings.push('The load order is larger than 64 KB, which the server refuses.')
  return out
}

/** The player's edited list, checked like the host checks plugins_override.txt and rewritten in on-disk case. */
export function normaliseLoadOrder(text: string, scan: DataSetScan): LoadOrderResult {
  const index = pluginIndex(scan)
  const { plugins, problems } = resolveNames(text.replace(/^﻿/, '').split(/\r?\n/).map((line) => [line]), index, 'The load order')
  if (problems.length) throw new Error(problems.length > 10 ? [...problems.slice(0, 10), `...and ${problems.length - 10} more.`].join('\n') : problems.join('\n'))
  if (plugins[0]?.toLowerCase() !== 'falloutnv.esm') throw new Error('The load order must start with FalloutNV.esm.')
  const warnings = namPlugins(scan, index).filter((n) => !plugins.includes(n))
    .map((n) => `${n} is not listed, but its .nam file makes the game load it anyway. Add it so the server matches.`)
  const out = result(plugins, 'plugins.txt', warnings, index, 'This list')
  if (Buffer.byteLength(out.text) > MAX_TEXT) throw new Error('The load order is larger than 64 KB.')
  return out
}
