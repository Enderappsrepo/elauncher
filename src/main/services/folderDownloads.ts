import { constants, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { lstat, mkdtemp, open, readdir, realpath, writeFile } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import AdmZip from 'adm-zip'

const MAX_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_CHUNK = 512 * 1024
const TTL_MS = 6 * 60 * 60_000
const PREFIX = 'elauncher-folder-download-'

interface Download {
  serverId: string
  requesterId: string
  directory: string
  file: string
  size: number
  touched: number
}

export interface FolderDownload {
  downloadId: string
  name: string
  size: number
}

/** Temporary archives live outside server folders, and never expose a host path. */
export class FolderDownloads {
  private downloads = new Map<string, Download>()
  private preparing = 0
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(private tempRoot = tmpdir()) {}

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [id, download] of this.downloads) {
      if (download.touched < cutoff) this.remove(id, download)
    }
    // A host restart loses the in-memory tokens. Sweep its abandoned ZIPs too.
    for (const entry of readdirSync(this.tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue
      const directory = join(this.tempRoot, entry.name)
      if ([...this.downloads.values()].some((d) => d.directory === directory)) continue
      try {
        if (statSync(directory).mtimeMs < cutoff) rmSync(directory, { recursive: true, force: true })
      } catch { /* A different launcher process may already have cleaned it. */ }
    }
  }

  private remove(id: string, download: Download): void {
    rmSync(download.directory, { recursive: true, force: true })
    this.downloads.delete(id)
  }

  private get(serverId: string, requesterId: string, id: string): Download {
    const download = this.downloads.get(id)
    if (!download || download.serverId !== serverId || download.requesterId !== requesterId) {
      throw new Error('That ZIP download is unavailable. Download the folder again.')
    }
    if (Date.now() - download.touched > TTL_MS) {
      this.remove(id, download)
      throw new Error('That ZIP download expired. Download the folder again.')
    }
    download.touched = Date.now()
    return download
  }

  async prepare(serverId: string, requesterId: string, root: string, requested: string, excludedRoots: readonly string[] = []): Promise<FolderDownload> {
    mkdirSync(this.tempRoot, { recursive: true })
    this.sweep()
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        try { this.sweep() } catch { /* Retry cleanup on the next pass. */ }
      }, 60_000)
      this.sweepTimer.unref()
    }
    if (this.downloads.size + this.preparing >= 4) {
      throw new Error('Too many ZIP downloads are active. Finish a download and try again.')
    }
    this.preparing++
    let directory: string | undefined
    try {
      const clean = requested.replace(/\\/g, '/')
      if (clean.includes('\0') || isAbsolute(clean) || /^[a-z]:/i.test(clean)) {
        throw new Error('Path escapes the server folder.')
      }
      const rootPath = resolve(root)
      const target = resolve(rootPath, clean || '.')
      const inside = (base: string, path: string): boolean => path === base || path.startsWith(base + sep)
      if (!inside(rootPath, target)) throw new Error('Path escapes the server folder.')
      const excluded = new Set(excludedRoots.map((name) => name.toLowerCase()))
      if (excluded.has(relative(rootPath, target).split(sep)[0].toLowerCase())) throw new Error('This folder is managed by Game setup.')
      const realRoot = await realpath(rootPath)
      // Reject links in the selected path as well as in its descendants.
      let ancestor = rootPath
      for (const part of relative(rootPath, target).split(sep).filter(Boolean)) {
        ancestor = join(ancestor, part)
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('ZIP downloads cannot include symbolic links.')
      }
      if (!inside(realRoot, await realpath(target))) throw new Error('Path escapes the server folder.')
      if (!(await lstat(target)).isDirectory()) throw new Error('Choose a folder to download as a ZIP.')

      const folderName = basename(target)
      const validName = (name: string): boolean => !/[\\/:\0]/.test(name) && name !== '.' && name !== '..'
      if (!validName(folderName)) throw new Error('That folder name cannot be stored safely in a ZIP.')
      const entries: { path: string; name: string; size: number; directory: boolean; modified: Date }[] = []
      let bytes = 0
      const walk = async (path: string, name: string): Promise<void> => {
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('ZIP downloads cannot include symbolic links.')
        if (!inside(realRoot, await realpath(path))) throw new Error('Path escapes the server folder.')
        if (!info.isDirectory() && !info.isFile()) throw new Error('ZIP downloads only support files and folders.')
        if (entries.length >= MAX_ENTRIES) throw new Error(`This folder contains too many entries (limit ${MAX_ENTRIES}).`)
        bytes += info.isFile() ? info.size : 0
        if (bytes > MAX_BYTES) throw new Error('Folder ZIP downloads are capped at 100 MB of source files. Choose a smaller folder or use SFTP.')
        entries.push({ path, name, size: info.size, directory: info.isDirectory(), modified: info.mtime })
        if (info.isDirectory()) {
          for (const child of await readdir(path)) {
            if (path === rootPath && excluded.has(child.toLowerCase())) continue
            if (!validName(child)) throw new Error('A filename in this folder cannot be stored safely in a ZIP.')
            await walk(join(path, child), `${name}/${child}`)
          }
        }
      }
      await walk(target, folderName)
      const zip = new AdmZip()
      for (const entry of entries) {
        let data = Buffer.alloc(0)
        if (!entry.directory) {
          // Read only the size we bounded during the scan, even if a running
          // server grows this file while the archive is being prepared.
          if (!inside(realRoot, await realpath(entry.path))) throw new Error('Path escapes the server folder.')
          const handle = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const before = await handle.stat()
            if (!before.isFile() || before.size !== entry.size) throw new Error('A file changed while zipping. Stop the server and try again.')
            data = Buffer.alloc(entry.size)
            let offset = 0
            while (offset < data.length) {
              const read = await handle.read(data, offset, data.length - offset, offset)
              if (!read.bytesRead) throw new Error('A file changed while zipping. Stop the server and try again.')
              offset += read.bytesRead
            }
            const after = await handle.stat()
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
              throw new Error('A file changed while zipping. Stop the server and try again.')
            }
          } finally {
            await handle.close()
          }
        }
        const added = zip.addFile(entry.name + (entry.directory ? '/' : ''), data)
        added.header.time = entry.modified
      }
      const buffer = await zip.toBufferPromise()
      if (buffer.length > MAX_BYTES) throw new Error('That ZIP exceeds the 100 MB download limit. Choose a smaller folder or use SFTP.')
      directory = await mkdtemp(join(this.tempRoot, PREFIX))
      const file = join(directory, 'download.zip')
      await writeFile(file, buffer, { mode: 0o600 })
      const downloadId = randomUUID()
      this.downloads.set(downloadId, { serverId, requesterId, directory, file, size: buffer.length, touched: Date.now() })
      return { downloadId, name: `${folderName}.zip`, size: buffer.length }
    } catch (error) {
      if (directory) rmSync(directory, { recursive: true, force: true })
      throw error
    } finally {
      this.preparing--
    }
  }

  async read(serverId: string, requesterId: string, id: string, offset: number, length: number): Promise<{ data: string; size: number; eof: boolean }> {
    const download = this.get(serverId, requesterId, id)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > download.size ||
        !Number.isSafeInteger(length) || length <= 0 || length > MAX_CHUNK) {
      throw new Error('ZIP download slice is out of range.')
    }
    const handle = await open(download.file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(length, download.size - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead !== buffer.length) throw new Error('The ZIP download is incomplete. Download the folder again.')
      return { data: buffer.toString('base64'), size: download.size, eof: offset + bytesRead === download.size }
    } finally {
      await handle.close()
    }
  }

  release(serverId: string, requesterId: string, id: string): { ok: true } {
    if (this.downloads.has(id)) this.remove(id, this.get(serverId, requesterId, id))
    return { ok: true }
  }
}
