/** Shared browser/host limits. The folder is streamed; no whole-game buffer or ZIP. */
export const NVMP_CHUNK_BYTES = 512 * 1024
export const NVMP_MAX_FILE_BYTES = 16 * 1024 ** 3
export const NVMP_MAX_TOTAL_BYTES = 64 * 1024 ** 3
export const NVMP_MAX_FILES = 10_000
export interface NvmpUploadFile { path: string; size: number; modified: number; sample: string }
export interface NvmpUploadProgress extends NvmpUploadFile { bitmap: string }
export interface NvmpSetupStatus {
  phase: 'waiting' | 'uploading' | 'committing' | 'ready'
  session?: string
  totalBytes: number
  receivedBytes: number
  totalFiles: number
  completedFiles: number
  loadOrder: string
  files?: NvmpUploadProgress[]
}

export function nvmpAssetPath(value: string): string {
  const parts = value.split('/')
  if (parts[0]?.toLowerCase() !== 'data' || parts.length < 2 || value.length > 240) throw new Error('Select the Fallout: New Vegas Data folder.')
  parts[0] = 'Data'
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) {
      throw new Error(`Unsupported file path: ${value}`)
    }
  }
  if (/\.(dll|exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|scr|msi|lnk|url|desktop|sh|bash|so|dylib|py|pyd|asi|jar)$/i.test(parts.at(-1)!)) {
    throw new Error(`Executable plugins need host assistance: ${value}`)
  }
  return parts.join('/')
}

export function validateNvmpManifest(input: unknown): NvmpUploadFile[] {
  if (!Array.isArray(input) || !input.length || input.length > NVMP_MAX_FILES) throw new Error(`Choose between 1 and ${NVMP_MAX_FILES} Data files.`)
  const seen = new Set<string>(); let total = 0
  const files = input.map((item) => {
    if (!item || typeof item.path !== 'string') throw new Error('Invalid upload file.')
    const path = nvmpAssetPath(item.path)
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate filename: ${path}`)
    seen.add(path.toLowerCase())
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > NVMP_MAX_FILE_BYTES || !Number.isSafeInteger(item.modified) || item.modified < 0 || !/^[a-f0-9]{64}$/.test(item.sample)) throw new Error(`Invalid size or fingerprint: ${path}`)
    total += item.size
    return { path, size: item.size, modified: item.modified, sample: item.sample }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (total > NVMP_MAX_TOTAL_BYTES) throw new Error('This upload exceeds the 64 GB per-server setup limit.')
  if (!files.some((f) => f.path === 'Data/FalloutNV.esm' && f.size > 0)) throw new Error('Data/FalloutNV.esm is missing or empty. Select your installed game’s Data folder.')
  // A path cannot be both a file and a directory, including case-only variants.
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/')
    for (let i = 2; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new Error(`File/folder collision: ${file.path}`)
  }
  return files
}
