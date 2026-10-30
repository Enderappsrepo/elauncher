import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statfsSync, writeFileSync, writeSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { NVMP_CHUNK_BYTES, validateNvmpManifest, type NvmpSetupStatus, type NvmpUploadFile } from '@shared/nvmpUpload'

export const NVMP_UPLOAD_DIR = '.nvmp-upload'
interface State { phase: NvmpSetupStatus['phase']; session?: string; previousReady?: boolean; loadOrder: string; files: NvmpUploadFile[] }
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** Never follow a customer-created link into another instance or outside this one. */
function inside(root: string, rel: string): string {
  const base = resolve(root), target = resolve(base, rel)
  if (target !== base && !target.startsWith(base + sep)) throw new Error('Path escapes the NV:MP instance.')
  for (let p = target; ; p = dirname(p)) {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error('Linked paths are not accepted for game uploads.')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (p === base) break
  }
  return target
}
const uploadRoot = (dir: string): string => inside(dir, NVMP_UPLOAD_DIR)
function readState(dir: string): State {
  const file = inside(uploadRoot(dir), 'state.json')
  if (!existsSync(file)) return { phase: 'ready', files: [], loadOrder: '' } // pre-upload/template instances
  return JSON.parse(readFileSync(file, 'utf8')) as State
}
function writeState(dir: string, state: State): void {
  const root = uploadRoot(dir); mkdirSync(root, { recursive: true })
  const file = inside(root, 'state.json'), tmp = inside(root, 'state.tmp')
  writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, file)
}
function sessionRoot(dir: string, state: State): string {
  if (!state.session || !/^[a-f0-9-]{36}$/.test(state.session)) throw new Error('No active game-file upload.')
  return inside(uploadRoot(dir), state.session)
}
function checkSession(dir: string, session: string): State {
  const state = readState(dir)
  if (state.phase !== 'uploading' || state.session !== session) throw new Error('This upload is no longer active. Refresh setup.')
  return state
}
function bitmap(root: string, i: number, size: number): Buffer {
  const path = inside(root, `${i}.bits`), length = Math.ceil(Math.ceil(size / NVMP_CHUNK_BYTES) / 8)
  if (!existsSync(path)) return Buffer.alloc(length)
  const b = readFileSync(path)
  if (b.length !== length) throw new Error('Upload progress is damaged. Discard the upload and select the folder again.')
  return b
}
function received(bits: Buffer, size: number): number {
  let bytes = 0
  for (let n = 0; n * NVMP_CHUNK_BYTES < size; n++) if (bits[n >> 3] & (1 << (n & 7))) bytes += Math.min(NVMP_CHUNK_BYTES, size - n * NVMP_CHUNK_BYTES)
  return bytes
}
export function initialiseNvmpUpload(dir: string): void {
  writeState(dir, { phase: 'waiting', files: [], loadOrder: 'FalloutNV.esm\n' })
}
export function nvmpUploadPending(dir: string): boolean { return readState(dir).phase !== 'ready' }
export function requireNvmpUploadReady(dir: string): void {
  if (nvmpUploadPending(dir)) throw new Error('Waiting for your game files. Finish Game setup in the web hosting panel before starting NV:MP.')
}
export function nvmpSetupStatus(dir: string, detail = false): NvmpSetupStatus {
  const state = readState(dir)
  const result: NvmpSetupStatus = { phase: state.phase, session: state.session, totalBytes: 0, receivedBytes: 0, totalFiles: state.files.length, completedFiles: 0, loadOrder: state.loadOrder }
  if (detail) result.files = []
  if (state.phase === 'ready') return result
  const root = state.session ? sessionRoot(dir, state) : null
  state.files.forEach((f, i) => {
    const bits = root ? bitmap(root, i, f.size) : Buffer.alloc(0), count = received(bits, f.size)
    result.totalBytes += f.size; result.receivedBytes += count
    if (count === f.size) result.completedFiles++
    if (detail) result.files!.push({ ...f, bitmap: bits.toString('base64') })
  })
  return result
}
export function beginNvmpUpload(dir: string, input: unknown): NvmpSetupStatus {
  const files = validateNvmpManifest(input), state = readState(dir)
  if (state.phase === 'committing') throw new Error('Finish or discard the interrupted setup before uploading again.')
  if (state.phase === 'uploading') {
    if (JSON.stringify(files) !== JSON.stringify(state.files)) throw new Error('This selection differs from the saved upload. Select the same folder to resume, or discard the upload first.')
    return nvmpSetupStatus(dir, true)
  }
  const total = files.reduce((sum, f) => sum + f.size, 0), disk = statfsSync(dir)
  if (total + 128 * 1024 ** 2 > disk.bavail * disk.bsize) throw new Error('The host does not have enough free disk space for this upload. Contact the host.')
  const next: State = { phase: 'uploading', session: randomUUID(), files, previousReady: state.phase === 'ready', loadOrder: state.loadOrder || 'FalloutNV.esm\n' }
  const root = sessionRoot(dir, next); mkdirSync(inside(root, 'staged/Data'), { recursive: true })
  writeState(dir, next)
  return nvmpSetupStatus(dir, true)
}
export function uploadNvmpChunk(dir: string, session: string, index: number, offset: number, data: string, checksum: string): { received: number } {
  const state = checkSession(dir, session)
  if (!Number.isSafeInteger(index) || index < 0 || index >= state.files.length) throw new Error('Unknown upload file.')
  const f = state.files[index]
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % NVMP_CHUNK_BYTES !== 0 || offset >= f.size) throw new Error('Invalid upload offset.')
  if (typeof data !== 'string' || data.length > Math.ceil(NVMP_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Invalid upload chunk.')
  const b = Buffer.from(data, 'base64')
  if (b.length !== Math.min(NVMP_CHUNK_BYTES, f.size - offset) || sha(b) !== checksum) throw new Error('Upload checksum or length mismatch. Retry this chunk.')
  const root = sessionRoot(dir, state), dest = inside(root, `staged/${f.path}`)
  mkdirSync(dirname(dest), { recursive: true })
  const bits = bitmap(root, index, f.size), n = offset / NVMP_CHUNK_BYTES
  const fd = openSync(dest, existsSync(dest) ? 'r+' : 'w')
  try {
    if (bits[n >> 3] & (1 << (n & 7))) {
      const old = Buffer.alloc(b.length); readSync(fd, old, 0, old.length, offset)
      if (!old.equals(b)) throw new Error('A retried chunk contains different data. Discard this upload and select the changed folder again.')
    } else {
      let written = 0
      while (written < b.length) {
        const n = writeSync(fd, b, written, b.length - written, offset + written)
        if (!n) throw new Error('The host could not write the complete upload chunk.')
        written += n
      }
      fsyncSync(fd)
      bits[n >> 3] |= 1 << (n & 7)
      const pending = inside(root, `${index}.bits.tmp`)
      writeFileSync(pending, bits); renameSync(pending, inside(root, `${index}.bits`))
    }
  } finally { closeSync(fd) }
  return { received: received(bits, f.size) }
}

/** Recover a process exit between the two renames; retained originals always win. */
function rollback(dir: string, state: State): void {
  const root = sessionRoot(dir, state)
  for (const name of ['Data', 'plugins_override.txt']) {
    const previous = inside(root, `previous/${name}`), current = inside(dir, name), staged = inside(root, `staged/${name}`)
    if (existsSync(previous)) {
      if (existsSync(current) && !existsSync(staged)) { mkdirSync(dirname(staged), { recursive: true }); renameSync(current, staged) }
      renameSync(previous, current)
    } else if (!state.previousReady && existsSync(current) && !existsSync(staged)) {
      mkdirSync(dirname(staged), { recursive: true }); renameSync(current, staged)
    }
  }
  state.phase = 'uploading'; writeState(dir, state)
}
export function finishNvmpUpload(dir: string, session: string, loadOrder: string, validate: (root: string) => unknown): NvmpSetupStatus {
  let state = readState(dir)
  if (state.phase === 'ready' && state.session === session) return nvmpSetupStatus(dir)
  if (state.phase === 'committing' && state.session === session) rollback(dir, state)
  state = checkSession(dir, session)
  if (typeof loadOrder !== 'string' || Buffer.byteLength(loadOrder) > 64 * 1024) throw new Error('The load order is too large.')
  const root = sessionRoot(dir, state), staged = inside(root, 'staged')
  for (let i = 0; i < state.files.length; i++) {
    const f = state.files[i]
    if (received(bitmap(root, i, f.size), f.size) !== f.size) throw new Error(`Upload incomplete: ${f.path}`)
    const file = inside(staged, f.path)
    if (f.size === 0 && !existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '') }
    if (!existsSync(file) || lstatSync(file).size !== f.size) throw new Error(`Upload file is missing or incomplete: ${f.path}`)
  }
  writeFileSync(inside(staged, 'plugins_override.txt'), loadOrder.replace(/^\uFEFF/, ''))
  validate(staged) // validate every plugin before moving existing customer files
  state.loadOrder = loadOrder; state.phase = 'committing'; writeState(dir, state)
  try {
    mkdirSync(inside(root, 'previous'), { recursive: true })
    for (const name of ['Data', 'plugins_override.txt']) {
      const target = inside(dir, name)
      if (existsSync(target)) renameSync(target, inside(root, `previous/${name}`))
      renameSync(inside(staged, name), target)
    }
    writeState(dir, { ...state, phase: 'ready', files: [] })
  } catch (error) { rollback(dir, state); throw error }
  // Paths are resolved and bounded inside this server's generated session directory.
  try { rmSync(root, { recursive: true, force: true }) } catch { /* completed data is already in place; cleanup may be retried on discard */ }
  return nvmpSetupStatus(dir)
}
export function discardNvmpUpload(dir: string, session: string): NvmpSetupStatus {
  const state = readState(dir)
  if (!state.session || state.session !== session || state.phase === 'ready') throw new Error('No matching unfinished upload to discard.')
  if (state.phase === 'committing') rollback(dir, state)
  const root = sessionRoot(dir, state)
  rmSync(root, { recursive: true, force: true })
  writeState(dir, { phase: state.previousReady ? 'ready' : 'waiting', files: [], loadOrder: state.previousReady && existsSync(inside(dir, 'plugins_override.txt')) ? readFileSync(inside(dir, 'plugins_override.txt'), 'utf8') : 'FalloutNV.esm\n' })
  return nvmpSetupStatus(dir)
}
