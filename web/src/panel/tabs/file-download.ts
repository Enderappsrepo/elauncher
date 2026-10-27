import type { RequestAction } from '../relay'

/** Capture this function when the download starts: a later server switch must
 * never send the remaining chunks or cleanup to a different host. */
export type DownloadRequest = <T = unknown>(
  action: RequestAction,
  params?: Record<string, unknown>
) => Promise<T>

const CHUNK = 256 * 1024
const MAX_BYTES = 100 * 1024 * 1024

export interface PreparedFolderDownload {
  downloadId: string
  name: string
  size: number
}

interface DownloadChunk {
  data: string
  size: number
  eof: boolean
}

export type DownloadProgress = (received: number, total: number) => void

/** Empty chunks and early EOF are failures, not successful partial backups. */
async function readChunks(
  read: (offset: number) => Promise<DownloadChunk>,
  progress?: DownloadProgress,
  expectedSize?: number,
  type = ''
): Promise<Blob> {
  const parts: BlobPart[] = []
  let offset = 0
  let total = expectedSize
  for (;;) {
    const result = await read(offset)
    if (
      !result ||
      typeof result.data !== 'string' ||
      typeof result.eof !== 'boolean' ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      result.size > MAX_BYTES
    ) {
      throw new Error('The host sent an invalid download response. Please try again.')
    }
    total ??= result.size
    if (result.size !== total) {
      throw new Error('The download size changed while transferring. Please try again.')
    }
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
    } catch {
      throw new Error('The host sent damaged download data. Please try again.')
    }
    if (bytes.length > CHUNK || offset + bytes.length > total) {
      throw new Error('The host sent more download data than expected. Please try again.')
    }
    offset += bytes.length
    if (
      (result.eof && offset !== total) ||
      (!result.eof && (bytes.length === 0 || offset === total))
    ) {
      throw new Error('The download ended before all bytes arrived. Please try again.')
    }
    parts.push(bytes)
    progress?.(offset, total)
    if (result.eof) return new Blob(parts, { type })
  }
}

export function fetchFileBlob(
  ask: DownloadRequest,
  path: string,
  progress?: DownloadProgress
): Promise<Blob> {
  return readChunks(
    (offset) => ask<DownloadChunk>('downloadChunk', { path, offset, length: CHUNK }),
    progress
  )
}

export async function fetchFolderBlob(
  ask: DownloadRequest,
  path: string,
  onPrepared?: (archive: PreparedFolderDownload) => void,
  progress?: DownloadProgress
): Promise<{ blob: Blob; name: string }> {
  let downloadId: string | undefined
  try {
    const archive = await ask<PreparedFolderDownload>('prepareFolderDownload', { path })
    if (typeof archive?.downloadId === 'string' && archive.downloadId) {
      downloadId = archive.downloadId
    }
    if (
      !downloadId ||
      typeof archive.name !== 'string' ||
      !archive.name ||
      /[\\/]/.test(archive.name) ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0 ||
      archive.size > MAX_BYTES
    ) {
      throw new Error('The host could not prepare a valid ZIP download. Please try again.')
    }
    onPrepared?.(archive)
    const blob = await readChunks(
      (offset) => ask<DownloadChunk>('downloadArchiveChunk', { downloadId, offset, length: CHUNK }),
      progress,
      archive.size,
      'application/zip'
    )
    return { blob, name: archive.name }
  } finally {
    if (downloadId) {
      try {
        await ask('releaseArchive', { downloadId })
      } catch (error) {
        // The host also expires unused archives. Losing the cleanup response
        // must not discard an otherwise complete, validated backup.
        console.warn('Could not release a temporary ZIP; the host will expire it.', error)
      }
    }
  }
}
