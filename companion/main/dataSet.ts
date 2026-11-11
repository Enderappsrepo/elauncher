// What the companion uploads: the game's Data folder, or the merged Data an MO2 profile shows the game.
import type { Dirent, Stats } from 'fs'
import { readFile, readdir, readlink, realpath, stat } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { NVMP_MAX_FILE_BYTES, NVMP_MAX_FILES, NVMP_MAX_TOTAL_BYTES, nvmpAssetPath } from '@shared/nvmpUpload'
import type { DataEntry, DataSetScan, GameCandidate, Mo2Setup } from '../shared/types'
import { diskFile } from './fileReader'

interface Layer { dir: string; kind: 'data' | 'mod' | 'overwrite'; name: string }
type OutsideLink = NonNullable<DataSetScan['outsideLinks']>[number]
/** A file as one layer has it, with the links to outside folders it was reached through. */
interface Found extends DataEntry { layer: Layer; via: OutsideLink[] }

const LISTED = 25
const byRel = (a: { rel: string }, b: { rel: string }): number => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const count = (n: number): string => n.toLocaleString('en-US')
/** Windows paths compare without case (the chain of followed folders and the layer roots). */
const fold = (p: string): string => p.toLowerCase()
const within = (real: string, roots: string[]): boolean => roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))

/** MO2 hides these from the game (directoryrefresher cleanStructure, *.mohidden); Root Builder's Root/ goes to the game folder. */
function hiddenByMo2(layer: Layer, rel: string, name: string, isDir: boolean): boolean {
  if (/\.mohidden$/i.test(name)) return true
  if (rel.includes('/')) return false
  const lower = name.toLowerCase()
  return isDir ? lower === 'fomod' || (layer.kind !== 'data' && lower === 'root') : lower === 'meta.ini' || lower === 'readme.txt'
}

/**
 * Where a file or folder link really points; some virtual drives cannot resolve a final path, so fall back to the
 * link text. A link that cannot be read at all (a junction to a volume without a drive letter) is never taken to be
 * inside the game: resolved false makes it an outside link the player has to approve.
 */
async function linkTarget(abs: string): Promise<{ target: string; resolved: boolean }> {
  try { return { target: await realpath(abs), resolved: true } } catch { /* fall through */ }
  try { return { target: resolve(dirname(abs), await readlink(abs)), resolved: true } } catch {
    return { target: `${abs} (where this link points cannot be read)`, resolved: false }
  }
}

/** The file's identity on disk, so a link retargeted after the scan cannot swap in another file. */
async function fileId(abs: string): Promise<string | undefined> {
  try {
    const st = await stat(abs, { bigint: true })
    return st.ino === 0n ? undefined : `${st.dev}:${st.ino}`
  } catch { return undefined }
}

/**
 * Files under one folder, following file and folder links (Vortex deploys them) but never a link back into
 * its own parent. A link whose real target is outside every layer root (Data, the enabled MO2 mods and
 * overwrite) is still followed; its files carry it in `via` so the player can be shown where they come from.
 */
async function walk(layer: Layer, roots: string[], mo2: boolean, problems: string[]): Promise<Found[]> {
  const out: Found[] = []
  const visit = async (dir: string, rel: string, chain: string[], via: OutsideLink[]): Promise<void> => {
    let items: Dirent[]
    try { items = await readdir(dir, { withFileTypes: true }) } catch (error) {
      const missingLayer = rel === '' && layer.kind !== 'data' && (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!missingLayer) problems.push(`Could not read ${dir}: ${errorText(error)}`)
      return
    }
    await Promise.all(items.map(async (item) => {
      const abs = join(dir, item.name), r = rel ? `${rel}/${item.name}` : item.name
      let st: Stats
      try { st = await stat(abs) } catch { return } // a broken link: the game cannot read it either
      if (mo2 && hiddenByMo2(layer, r, item.name, st.isDirectory())) return
      if (!st.isDirectory() && !st.isFile()) return
      let real = fold(join(chain[chain.length - 1], item.name)), next = via
      if (item.isSymbolicLink()) {
        const { target, resolved } = await linkTarget(abs)
        real = fold(target)
        if (!resolved || !within(real, roots)) next = [...via, { rel: r, target }]
      }
      if (st.isDirectory()) {
        if (!chain.includes(real)) await visit(abs, r, [...chain, real], next)
      } else {
        out.push({ abs, rel: r, size: st.size, modified: Math.floor(st.mtimeMs), fileId: await fileId(abs), layer, via: next })
      }
    }))
  }
  await visit(layer.dir, '', [fold(await realpath(layer.dir).catch(() => layer.dir))], [])
  return out
}

async function mo2Layers(data: string, mo2: Mo2Setup, problems: string[]): Promise<Layer[]> {
  let text = ''
  try { text = await readFile(join(mo2.profileDir, 'modlist.txt'), 'utf8') } catch {
    problems.push(`Mod Organizer 2 profile "${mo2.profile}" has no readable modlist.txt in ${mo2.profileDir}.`)
  }
  // modlist.txt lists the highest priority first ('+' enabled, '-' disabled, '*' DLC already in Data).
  const enabled = text.replace(/^﻿/, '').split(/\r?\n/)
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1).trim())
    .filter((name) => name && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !/_separator$/i.test(name))
  return [
    { dir: data, kind: 'data', name: 'Data' },
    ...enabled.reverse().map((name): Layer => ({ dir: join(mo2.modsDir, name), kind: 'mod', name })),
    { dir: mo2.overwriteDir, kind: 'overwrite', name: 'overwrite' }
  ]
}

/** One casing per folder (the first seen), so the Linux host never gets both Textures/ and textures/. */
function canonical(rel: string, dirs: Map<string, string>): string {
  const parts = rel.split('/')
  let cased = ''
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(0, i + 1).join('/').toLowerCase()
    let known = dirs.get(key)
    if (known === undefined) { known = cased ? `${cased}/${parts[i]}` : parts[i]; dirs.set(key, known) }
    cased = known
  }
  return cased ? `${cased}/${parts[parts.length - 1]}` : parts[0]
}

/** Installer, readme and xEdit leftovers in a plain Data folder: the game never loads them, but they count. */
const LEFTOVER = /(^|\/)(fomod|[^/]*edit (backups|cache))\/|(^|\/)readme[^/]*$|\.bak$/i

/** The 10,000-file limit, with what to do about it and where most of the files come from. */
function tooManyFiles(game: GameCandidate, used: Found[]): string {
  const groups = new Map<string, number>()
  for (const f of used) {
    const at = f.rel.indexOf('/')
    const group = game.mo2
      ? f.layer.kind === 'mod' ? `"${f.layer.name}"` : f.layer.kind === 'overwrite' ? 'overwrite' : "the game's own Data folder"
      : at < 0 ? 'files directly in Data' : `Data/${f.rel.slice(0, at)}`
    groups.set(group, (groups.get(group) ?? 0) + 1)
  }
  const top = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} (${count(n)})`).join(', ')
  const head = `Data has ${count(used.length)} files; an upload can hold at most ${count(NVMP_MAX_FILES)}.`
  if (game.mo2) {
    return `${head} Mods disabled in Mod Organizer 2 profile "${game.mo2.profile}" do not count: disable the mods your group does not play with ` +
      `(a profile just for this server works well), then check again. Most files come from ${top}.`
  }
  const leftovers = used.filter((f) => LEFTOVER.test(f.rel)).length
  return `${head} Every file in the Data folder counts, including leftovers the game never loads such as fomod installer folders, ` +
    `readme files and xEdit backups${leftovers ? ` (${count(leftovers)} here)` : ''}. Remove those and any mods your group does not play with, ` +
    `then check again. Most files are in ${top}.`
}

export async function scanDataSet(game: GameCandidate): Promise<DataSetScan> {
  const problems: string[] = []
  const layers: Layer[] = game.mo2 ? await mo2Layers(game.data, game.mo2, problems) : [{ dir: game.data, kind: 'data', name: 'Data' }]
  // A link into any layer stays within what the player (or MO2) chose to upload; anything else is reported.
  const roots = await Promise.all(layers.map(async (l) => fold(await realpath(l.dir).catch(() => l.dir))))
  // Later layers win the bytes; the first file seen keeps its name casing, as in MO2's virtual Data.
  const merged = new Map<string, Found>(), dirs = new Map<string, string>()
  for (const layer of layers) {
    for (const file of (await walk(layer, roots, !!game.mo2, problems)).sort(byRel)) {
      const key = file.rel.toLowerCase()
      merged.set(key, { ...file, rel: merged.get(key)?.rel ?? canonical(file.rel, dirs) })
    }
  }
  const base = merged.get('falloutnv.esm')
  if (base) base.rel = 'FalloutNV.esm' // the host requires this exact name; Windows does not care

  const entries: DataEntry[] = [], used: Found[] = [], skippedExecutables: string[] = [], listed: string[] = []
  for (const entry of [...merged.values()].sort(byRel)) {
    const path = `Data/${entry.rel}`
    try { nvmpAssetPath(path) } catch (error) {
      const message = errorText(error)
      if (message.startsWith('Executable plugins need host assistance:')) skippedExecutables.push(path)
      else listed.push(path.length > 240 ? `The path is longer than 240 characters: ${path}` : message)
      continue
    }
    if (entry.size > NVMP_MAX_FILE_BYTES) listed.push(`Larger than the 16 GB per-file limit: ${path}`)
    entries.push({ abs: entry.abs, rel: entry.rel, size: entry.size, modified: entry.modified, fileId: entry.fileId })
    used.push(entry)
  }
  const lower = new Set(entries.map((e) => e.rel.toLowerCase()))
  for (const entry of entries) {
    const parts = entry.rel.toLowerCase().split('/')
    for (let i = 1; i < parts.length; i++) {
      if (lower.has(parts.slice(0, i).join('/'))) { listed.push(`A file and a folder share the name Data/${parts.slice(0, i).join('/')}: Data/${entry.rel}`); break }
    }
  }
  problems.push(...listed.slice(0, LISTED))
  if (listed.length > LISTED) problems.push(`...and ${listed.length - LISTED} more files with the same kinds of problems.`)

  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
  if (entries.length > NVMP_MAX_FILES) problems.push(tooManyFiles(game, used))
  if (totalBytes > NVMP_MAX_TOTAL_BYTES) problems.push('These files exceed the 64 GB per-server setup limit.')
  if (!entries.some((e) => e.rel === 'FalloutNV.esm' && e.size > 0)) problems.push('Data/FalloutNV.esm is missing or empty. Choose your installed game folder.')
  // Only links that still supply an uploaded file (not overridden by a later layer, hidden or skipped) are listed.
  const outsideLinks = [...new Set(used.flatMap((f) => f.via))].sort(byRel).map(({ rel, target }) => ({ rel, target }))
  return { entries, totalBytes, skippedExecutables, problems, outsideLinks }
}

/**
 * Lazy, disk-backed Files in the shape web/src/panel/nvmpTransfer.ts selectNvmpFiles reads from a folder
 * pick. Every later read re-checks the file against the scan (fileReader.ts ChangedFileError).
 */
export async function toUploadFiles(entries: DataEntry[]): Promise<File[]> {
  const files: File[] = []
  for (let i = 0; i < entries.length; i += 64) {
    files.push(...await Promise.all(entries.slice(i, i + 64).map(async (entry) => {
      let st: Stats
      try { st = await stat(entry.abs) } catch (error) {
        throw new Error(`Could not open Data/${entry.rel}: ${errorText(error)}. Scan the game folder again.`)
      }
      // Size and mtime are the upload's identity; a change after the scan would break resuming. The file id catches
      // a link retargeted (or a folder swapped for a junction) to another file with the same size and date.
      if (!st.isFile() || st.size !== entry.size || Math.floor(st.mtimeMs) !== entry.modified
        || (entry.fileId !== undefined && (await fileId(entry.abs)) !== entry.fileId)) {
        throw new Error(`Data/${entry.rel} changed after the scan. Scan the game folder again.`)
      }
      return diskFile(entry, st.size)
    })))
  }
  return files
}
