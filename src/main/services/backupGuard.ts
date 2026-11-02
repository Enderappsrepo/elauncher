import { existsSync, readdirSync, rmSync } from 'fs'
import { lstat, readdir, statfs } from 'fs/promises'
import { join } from 'path'

const GB = 1024 ** 3
const MAX_RESERVE = 25 * GB

export const BACKUP_MANIFEST = '.elauncher-backup.json'

export type BackupOnDisk = { name: string; bytes: number; complete: boolean }

/** Free space a backup must leave behind: game servers, logins and logs all need room to write. */
export function diskReserve(totalBytes: number): number {
  return Math.min(MAX_RESERVE, Math.floor(totalBytes * 0.1))
}

/**
 * Which old backups to remove so a new one fits: unfinished ones, then the oldest.
 * Empty and fits:false when removing them all still wouldn't help, so restore points
 * are never spent for nothing. The newest complete backup is always kept.
 */
export function planBackupRoom(
  available: number,
  need: number,
  reserve: number,
  backups: BackupOnDisk[]
): { fits: boolean; remove: string[] } {
  if (available - need >= reserve) return { fits: true, remove: [] }
  const oldestFirst = [...backups].sort((a, b) => a.name.localeCompare(b.name))
  const kept =
    [...oldestFirst].reverse().find((b) => b.complete)?.name ?? oldestFirst[oldestFirst.length - 1]?.name
  const order = [...oldestFirst.filter((b) => !b.complete), ...oldestFirst.filter((b) => b.complete)]
  let room = available
  const remove: string[] = []
  for (const backup of order) {
    if (backup.name === kept) continue
    remove.push(backup.name)
    room += backup.bytes
    if (room - need >= reserve) return { fits: true, remove }
  }
  return { fits: false, remove: [] }
}

/** Bytes a file or folder takes on disk. */
export async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path)
  const own = info.blocks ? info.blocks * 512 : info.size
  if (!info.isDirectory()) return own
  let total = own
  for (const entry of await readdir(path)) total += await treeBytes(join(path, entry))
  return total
}

// Backups of different servers run at once, and none of them has written much when the next one looks.
let promised = 0

async function diskSpace(path: string): Promise<{ available: number; total: number }> {
  const disk = await statfs(path)
  return { available: Number(disk.bavail) * Number(disk.bsize), total: Number(disk.blocks) * Number(disk.bsize) }
}

async function listBackups(destRoot: string): Promise<BackupOnDisk[]> {
  if (!existsSync(destRoot)) return []
  const out: BackupOnDisk[] = []
  for (const entry of readdirSync(destRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(destRoot, entry.name)
    out.push({ name: entry.name, bytes: await treeBytes(path), complete: existsSync(join(path, BACKUP_MANIFEST)) })
  }
  return out
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/**
 * Run a backup only if the disk can take it. Old backups of this server go first when
 * space is short; if that isn't enough the backup is refused before anything is copied.
 * A copy that fails anyway takes its half-written folder with it.
 */
export async function withBackupRoom(
  serverRoot: string,
  destRoot: string,
  stamp: string,
  sources: string[],
  log: (line: string) => void,
  copy: () => Promise<void>
): Promise<void> {
  let need = 0
  for (const source of sources) need += await treeBytes(source)

  let disk: { available: number; total: number } | null = await diskSpace(serverRoot).catch(() => null)
  if (disk) {
    let reserve = diskReserve(disk.total)
    if (disk.available - promised - need < reserve) {
      const backups = await listBackups(destRoot)
      disk = await diskSpace(serverRoot)
      reserve = diskReserve(disk.total)
      const plan = planBackupRoom(disk.available - promised, need, reserve, backups)
      if (!plan.fits) {
        throw new Error(
          `Not enough disk space: this backup needs ${gb(need)}, ${gb(disk.available)} is free, and ${gb(reserve)} must stay free.`
        )
      }
      for (const name of plan.remove) {
        rmSync(join(destRoot, name), { recursive: true, force: true })
        log(`[ELauncher] Low disk space: removed the old backup ${name}`)
      }
    }
  }

  const folder = join(destRoot, stamp)
  const fresh = !existsSync(folder)
  promised += need
  try {
    await copy()
  } catch (e) {
    if (fresh) rmSync(folder, { recursive: true, force: true })
    throw e
  } finally {
    promised -= need
  }
}
