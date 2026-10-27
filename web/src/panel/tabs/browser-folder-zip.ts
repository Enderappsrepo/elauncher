import { AsyncZipDeflate, Zip, ZipPassThrough } from 'fflate'
import { fetchFileBlob } from './file-download'
import type { DownloadPhase, DownloadProgress, DownloadRequest, PreparedFolderDownload } from './file-download'

const MAX_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 20_000

interface Entry {
  path: string
  name: string
  size: number
  directory: boolean
}

const safeName = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0:]/.test(name)

/** Older hosts already expose scoped listings and file chunks. Assemble their
 * ZIP in the browser without asking them to write anything to the server. */
export async function fetchBrowserFolderBlob(
  ask: DownloadRequest,
  path: string,
  onPrepared?: (archive: PreparedFolderDownload) => void,
  progress?: DownloadProgress,
  onPhase?: (phase: DownloadPhase) => void
): Promise<{ blob: Blob; name: string }> {
  const pieces = path ? path.split('/') : []
  if (pieces.some((piece) => !safeName(piece))) throw new Error('That folder path cannot be downloaded safely.')
  const folder = pieces.at(-1) ?? 'server'
  const entries: Entry[] = [{ path, name: `${folder}/`, size: 0, directory: true }]
  const encoder = new TextEncoder()
  let total = 0
  let headers = 22
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const listing = await ask<unknown>('files', { path: directory })
    if (!Array.isArray(listing)) throw new Error('The host sent an invalid folder listing. Please try again.')
    const names = new Set<string>()
    for (const raw of listing) {
      const entry = raw as { name?: unknown; isDir?: unknown; sizeBytes?: unknown; isSymlink?: unknown; isSymbolicLink?: unknown } | null
      if (!entry || !safeName(entry.name) || typeof entry.isDir !== 'boolean' || names.has(entry.name)) {
        throw new Error('The host sent an unsafe or duplicate filename. The ZIP was not created.')
      }
      if (entry.isSymlink || entry.isSymbolicLink) throw new Error('ZIP downloads cannot include symbolic links.')
      if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) {
        throw new Error('The host sent an invalid file size. Please try again.')
      }
      names.add(entry.name)
      if (entries.length >= MAX_ENTRIES) throw new Error(`This folder contains too many entries (limit ${MAX_ENTRIES}).`)
      const rel = directory ? `${directory}/${entry.name}` : entry.name
      const name = `${prefix}${entry.name}${entry.isDir ? '/' : ''}`
      const length = encoder.encode(name).length
      headers += 76 + length * 2
      if (length > 65535 || headers > MAX_BYTES) throw new Error('The ZIP filenames exceed the 100 MB download limit.')
      const size = entry.isDir ? 0 : entry.sizeBytes as number
      total += size
      if (total > MAX_BYTES) throw new Error('Folder ZIP downloads are capped at 100 MB of source files. Choose a smaller folder or use SFTP.')
      entries.push({ path: rel, name, size, directory: entry.isDir })
      if (entry.isDir) await walk(rel, name)
    }
  }
  await walk(path, `${folder}/`)
  const name = `${folder}.zip`
  // This callback describes progress only; there is no host token to release.
  onPrepared?.({ downloadId: '', name, size: total })
  const parts: BlobPart[] = []
  let output = 0
  let received = 0
  let failure: Error | undefined
  let rejectCurrent: ((error: Error) => void) | undefined
  let complete: (() => void) | undefined
  let rejectFinished: ((error: Error) => void) | undefined
  const archive = new Zip((error, data, final) => {
    if (failure) return
    output += data?.length ?? 0
    if (error || output > MAX_BYTES) {
      failure = error ?? new Error('That ZIP exceeds the 100 MB download limit. Choose a smaller folder or use SFTP.')
      archive.terminate()
      rejectCurrent?.(failure)
      rejectFinished?.(failure)
      return
    }
    parts.push(data)
    if (final) complete?.()
  })
  try {
    for (const entry of entries) {
      let data = new Uint8Array(0)
      if (!entry.directory) {
        onPhase?.('live')
        const blob = await fetchFileBlob(ask, entry.path, (bytes, size) => {
          if (size !== entry.size) throw new Error('A file changed while downloading. Stop the server and try again.')
          progress?.(received + bytes, total)
        })
        if (blob.size !== entry.size) throw new Error('A file changed while downloading. Stop the server and try again.')
        data = new Uint8Array(await blob.arrayBuffer())
        received += data.length
      }
      onPhase?.('preparing')
      // One file and one compression worker at a time bounds browser memory
      // and avoids spawning a worker for every file in a large world folder.
      const file = data.length ? new AsyncZipDeflate(entry.name, { level: 1 }) : new ZipPassThrough(entry.name)
      try {
        await new Promise<void>((resolve, reject) => {
          rejectCurrent = reject
          archive.add(file)
          if (failure) return reject(failure)
          const forward = file.ondata!
          file.ondata = (error, bytes, final) => {
            forward(error, bytes, final)
            if (error || failure) reject(error ?? failure)
            else if (final) resolve()
          }
          file.push(data, true)
        })
      } finally {
        rejectCurrent = undefined
        if ('terminate' in file) file.terminate()
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      rejectFinished = reject
      complete = () => resolve(new Blob(parts, { type: 'application/zip' }))
      archive.end()
      if (failure) reject(failure)
    })
    return { blob, name }
  } catch (error) {
    archive.terminate()
    throw error
  }
}
