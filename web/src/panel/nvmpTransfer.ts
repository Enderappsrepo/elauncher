import { NVMP_CHUNK_BYTES, nvmpAssetPath, validateNvmpManifest, type NvmpSetupStatus, type NvmpUploadFile } from '@shared/nvmpUpload'
import type { TabProps } from './tabs/types'

export interface NvmpSelection { files: Map<string, File>; manifest: NvmpUploadFile[]; skipped: string[] }
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
async function digest(bytes: ArrayBuffer): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', bytes)) }
export async function selectNvmpFiles(files: File[]): Promise<NvmpSelection> {
  const selected = new Map<string, File>(), manifest: NvmpUploadFile[] = [], skipped: string[] = []
  for (const file of files) {
    let path: string
    try { path = nvmpAssetPath(file.webkitRelativePath || `Data/${file.name}`) }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Executable plugins need host assistance:')) { skipped.push(file.webkitRelativePath || file.name); continue }
      throw error
    }
    // A bounded sample + size/mtime identifies reselected files without loading GB-sized BSAs.
    const sample = await digest(await new Blob([file.slice(0, 65536), file.slice(Math.max(65536, file.size - 65536)), String(file.size)]).arrayBuffer())
    manifest.push({ path, size: file.size, modified: file.lastModified, sample })
    selected.set(path, file)
  }
  return { files: selected, manifest: validateNvmpManifest(manifest), skipped }
}
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer); let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
export async function transferNvmpFiles(ask: TabProps['ask'], selected: NvmpSelection, status: NvmpSetupStatus, signal: AbortSignal, progress: (bytes: number, path: string) => void): Promise<void> {
  if (!status.session || !status.files) throw new Error('The host did not return an upload session. Refresh and retry.')
  const session = status.session
  const jobs = function* (): Generator<{ index: number; offset: number; file: File; path: string }> {
    for (let index = 0; index < status.files!.length; index++) {
      const remote = status.files![index], file = selected.files.get(remote.path)
      if (!file || file.size !== remote.size) throw new Error(`Select the same folder to resume: ${remote.path}`)
      const bits = Uint8Array.from(atob(remote.bitmap), (c) => c.charCodeAt(0))
      for (let offset = 0; offset < file.size; offset += NVMP_CHUNK_BYTES) {
        const n = offset / NVMP_CHUNK_BYTES
        if (!(bits[n >> 3] & (1 << (n & 7)))) yield { index, offset, file, path: remote.path }
      }
    }
  }()
  let bytes = status.receivedBytes, failure: unknown
  progress(bytes, '')
  const worker = async (): Promise<void> => {
    while (!signal.aborted && !failure) {
      const next = jobs.next(); if (next.done) return
      const { file, path, offset, index } = next.value
      const buffer = await file.slice(offset, offset + NVMP_CHUNK_BYTES).arrayBuffer()
      const data = base64(buffer), checksum = await digest(buffer)
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted || failure) return
        try {
          await ask('nvmpChunk', { session, index, offset, data, checksum })
          bytes += buffer.byteLength; progress(bytes, path); break
        } catch (error) {
          if (attempt === 2) { failure = error; return }
        }
      }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: 4 }, worker))
  if (failure) throw failure
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) throw rejected.reason
}
