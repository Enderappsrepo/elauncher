// Disk-backed stand-ins for the browser File objects web/src/panel/nvmpTransfer.ts reads. fs.openAsBlob
// reports Blob.size modulo 2^32 for files of 4 GiB or more (Node 22 and Electron's Node 24), so these read
// exactly the requested range with fs.readSync instead, and hold no handle between reads.
import { closeSync, fstatSync, openSync, readSync, type Stats } from 'fs'
import { NVMP_CHUNK_BYTES } from '@shared/nvmpUpload'
import type { DataEntry } from '../shared/types'

/** nvmpTransfer.ts reads 512 KiB chunks and two 64 KiB fingerprint samples; nothing ever needs more at once. */
export const MAX_SLICE_BYTES = Math.max(NVMP_CHUNK_BYTES, 64 * 1024)

export const CHANGED_FILE_CODE = 'NVMP_FILE_CHANGED'
export const CHANGED_FILE_PREFIX = 'changed: '

/**
 * A Data file no longer matches the scan (size or modified time differ, or it was removed), found when
 * it was read. message is exactly `changed: Data/<rel>`; path is `Data/<rel>`.
 *
 * For the upload controller: thrown by slice() while selectNvmpFiles fingerprints (before nvmpBegin:
 * scan again) or while transferNvmpFiles reads a chunk (after nvmpBegin: the host's manifest no longer
 * matches, so a resume cannot work; discard and upload again). Match it with isChangedFileError(), which
 * also recognises the message after the class was lost (e.g. re-thrown as `new Error(message)`).
 * Any other read failure (a file another program holds locked, EBUSY/EPERM; a disk error) is the fs
 * error as thrown, with its `code`; a resume may work once the file is free.
 */
export class ChangedFileError extends Error {
  readonly code = CHANGED_FILE_CODE
  constructor(readonly path: string) {
    super(`${CHANGED_FILE_PREFIX}${path}`)
    this.name = 'ChangedFileError'
  }
}

export function isChangedFileError(error: unknown): boolean {
  if (error instanceof ChangedFileError) return true
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return code === CHANGED_FILE_CODE || (typeof message === 'string' && message.startsWith(CHANGED_FILE_PREFIX))
}

/** The `Data/...` path a ChangedFileError names, or null. */
export function changedFilePath(error: unknown): string | null {
  if (!isChangedFileError(error)) return null
  if (error instanceof ChangedFileError) return error.path
  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message.slice(CHANGED_FILE_PREFIX.length) : null
}

/** A slice bound as Blob.slice reads it (negative counts from the end, clamped to the file); anything but an integer is refused. */
function position(value: number | undefined, fallback: number, size: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RangeError(`Invalid slice position: ${String(value)}`)
  return value < 0 ? Math.max(size + value, 0) : Math.min(value, size)
}

/** One scanned Data file. Each read checks that the file still matches the scan, before and after reading. */
export class DiskFile {
  readonly name: string
  readonly lastModified: number
  readonly webkitRelativePath: string
  readonly type = ''

  constructor(private readonly entry: DataEntry, readonly size: number) {
    this.name = entry.rel.slice(entry.rel.lastIndexOf('/') + 1)
    this.lastModified = entry.modified
    this.webkitRelativePath = `Data/${entry.rel}`
  }

  private check(stats: Stats): void {
    if (stats.size !== this.size || Math.floor(stats.mtimeMs) !== this.entry.modified) throw new ChangedFileError(this.webkitRelativePath)
  }

  /** The opened handle must be the very file the scan saw (dev:ino), not another one now behind the same path. */
  private same(fd: number): void {
    if (this.entry.fileId === undefined) return
    const st = fstatSync(fd, { bigint: true })
    if (`${st.dev}:${st.ino}` !== this.entry.fileId) throw new ChangedFileError(this.webkitRelativePath)
  }

  /** Synchronous like Blob.slice; returns a real Blob holding exactly bytes [start, end). */
  slice(start?: number, end?: number, contentType?: string): Blob {
    const from = position(start, 0, this.size), to = position(end, this.size, this.size)
    const length = Math.max(to - from, 0)
    if (length > MAX_SLICE_BYTES) throw new RangeError(`A read of ${length} bytes is larger than the ${MAX_SLICE_BYTES}-byte limit: ${this.webkitRelativePath}`)
    let fd: number
    try {
      fd = openSync(this.entry.abs, 'r')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new ChangedFileError(this.webkitRelativePath)
      throw error // locked by another program (EBUSY/EPERM), a disk error...: not a change
    }
    try {
      this.same(fd)
      this.check(fstatSync(fd))
      const bytes = new Uint8Array(length)
      let read = 0
      while (read < length) {
        const n = readSync(fd, bytes, read, length - read, from + read)
        if (n === 0) throw new ChangedFileError(this.webkitRelativePath) // shorter than its size: changed
        read += n
      }
      this.check(fstatSync(fd)) // written to while we read
      return new Blob([bytes], { type: contentType ?? '' })
    } finally {
      closeSync(fd)
    }
  }

  /** Whole-file reads go through slice(), so they are refused above MAX_SLICE_BYTES rather than buffered. */
  arrayBuffer(): Promise<ArrayBuffer> {
    try { return this.slice().arrayBuffer() } catch (error) { return Promise.reject(error) }
  }

  text(): Promise<string> {
    try { return this.slice().text() } catch (error) { return Promise.reject(error) }
  }
}

/** The File shape selectNvmpFiles and transferNvmpFiles use: name, size, lastModified, webkitRelativePath, slice(). */
export function diskFile(entry: DataEntry, size = entry.size): File {
  return new DiskFile(entry, size) as unknown as File
}
