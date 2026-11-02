// Offline regression tests. The disk is a real temp folder; only statfs's numbers are made up.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { after, test } from 'node:test'
import { transformSync } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const GB = 1024 ** 3
const root = mkdtempSync(join(tmpdir(), 'elauncher-backup-guard-'))
after(() => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  rmSync(root, { recursive: true, force: true })
})

const disk = { available: 0, total: 464 * GB, fail: false, seen: [] }
function load() {
  const source = readFileSync(join(repo, 'src/main/services/backupGuard.ts'), 'utf8')
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' }).code
  const module = { exports: {} }
  const localRequire = (id) => {
    if (id !== 'fs/promises') return require(id)
    return {
      ...require('fs/promises'),
      statfs: async (path) => {
        disk.seen.push(path)
        if (disk.fail) throw new Error('statfs unavailable')
        return { bavail: disk.available / 4096, bsize: 4096, blocks: disk.total / 4096 }
      }
    }
  }
  runInThisContext(`(function (exports, module, require) {${code}\n})`)(module.exports, module, localRequire)
  return module.exports
}
const guard = load()

let serial = 0
function rig(backups = []) {
  const server = join(root, String(++serial))
  const world = join(server, 'world')
  mkdirSync(world, { recursive: true })
  writeFileSync(join(world, 'region.mca'), Buffer.alloc(8192))
  for (const [name, complete] of backups) {
    const folder = join(server, 'backups', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'region.mca'), Buffer.alloc(8192))
    if (complete) writeFileSync(join(folder, guard.BACKUP_MANIFEST), '{}')
  }
  disk.available = 200 * GB
  disk.fail = false
  return { server, world, dest: join(server, 'backups') }
}
const names = (dest) => (existsSync(dest) ? readdirSync(dest).sort() : [])
const quiet = () => {}

test('the reserve is 10% of a small disk and 25 GB of a big one', () => {
  assert.equal(guard.diskReserve(100 * GB), 10 * GB)
  assert.equal(guard.diskReserve(464 * GB), 25 * GB)
})

test('a backup that fits removes nothing', () => {
  const backups = [{ name: 'a', bytes: GB, complete: true }]
  assert.deepEqual(guard.planBackupRoom(100 * GB, 24 * GB, 25 * GB, backups), { fits: true, remove: [] })
})

test('exactly the reserve left still fits', () => {
  assert.equal(guard.planBackupRoom(49 * GB, 24 * GB, 25 * GB, []).fits, true)
  assert.equal(guard.planBackupRoom(49 * GB - 1, 24 * GB, 25 * GB, []).fits, false)
})

test('only as many of the oldest go as the new one needs', () => {
  const backups = ['c', 'a', 'b', 'd'].map((name) => ({ name, bytes: 24 * GB, complete: true }))
  assert.deepEqual(guard.planBackupRoom(30 * GB, 24 * GB, 25 * GB, backups), { fits: true, remove: ['a'] })
  assert.deepEqual(guard.planBackupRoom(10 * GB, 24 * GB, 25 * GB, backups), { fits: true, remove: ['a', 'b'] })
})

test('an unfinished backup goes first; the newest complete one survives', () => {
  const backups = [
    { name: 'a', bytes: 24 * GB, complete: true },
    { name: 'b', bytes: 24 * GB, complete: true },
    { name: 'c', bytes: 21 * GB, complete: false }
  ]
  assert.deepEqual(guard.planBackupRoom(30 * GB, 24 * GB, 25 * GB, backups), { fits: true, remove: ['c'] })
  assert.deepEqual(guard.planBackupRoom(5 * GB, 24 * GB, 25 * GB, backups), { fits: true, remove: ['c', 'a'] })
  assert.deepEqual(guard.planBackupRoom(1 * GB, 24 * GB, 25 * GB, backups), { fits: false, remove: [] })
})

test('nothing is spent when removing every backup would not help', () => {
  const backups = ['a', 'b'].map((name) => ({ name, bytes: GB, complete: true }))
  assert.deepEqual(guard.planBackupRoom(GB, 24 * GB, 25 * GB, backups), { fits: false, remove: [] })
})

test('the one backup left is never removed, complete or not', () => {
  assert.equal(guard.planBackupRoom(GB, 24 * GB, 25 * GB, [{ name: 'a', bytes: 99 * GB, complete: true }]).fits, false)
  assert.equal(guard.planBackupRoom(GB, 24 * GB, 25 * GB, [{ name: 'a', bytes: 99 * GB, complete: false }]).fits, false)
})

test('treeBytes counts every file below a folder and a single file', async () => {
  const { world, server } = rig()
  mkdirSync(join(world, 'deep', 'er'), { recursive: true })
  writeFileSync(join(world, 'deep', 'er', 'x'), Buffer.alloc(4096))
  const all = await guard.treeBytes(world)
  assert.ok(all >= 8192 + 4096, String(all))
  assert.ok((await guard.treeBytes(join(world, 'region.mca'))) >= 4096)
  assert.ok(server)
})

test('room to spare: the copy runs and old backups stay', async () => {
  const { server, world, dest } = rig([['2026-01', true], ['2026-02', true]])
  let copied = 0
  await guard.withBackupRoom(server, dest, '2026-03', [world], quiet, async () => { copied++ })
  assert.equal(copied, 1)
  assert.deepEqual(names(dest), ['2026-01', '2026-02'])
})

test('a full disk refuses before the copy starts and touches nothing', async () => {
  const { server, world, dest } = rig([['2026-01', true]])
  disk.available = 0
  let copied = 0
  await assert.rejects(
    guard.withBackupRoom(server, dest, '2026-03', [world], quiet, async () => { copied++ }),
    /Not enough disk space/
  )
  assert.equal(copied, 0)
  assert.deepEqual(names(dest), ['2026-01'])
})

test('short on space with big old backups: the oldest goes, is logged, the copy runs', async () => {
  const { server, world, dest } = rig([['2026-01', true], ['2026-02', true]])
  const big = join(dest, '2026-01', 'big')
  writeFileSync(big, Buffer.alloc(1 << 20))
  // 25 GB reserve; 512 KiB short of it, so the 1 MiB oldest backup covers the gap
  disk.available = 25 * GB + 8192 - (1 << 19)
  const lines = []
  let copied = 0
  await guard.withBackupRoom(server, dest, '2026-03', [world], (l) => lines.push(l), async () => { copied++ })
  assert.equal(copied, 1)
  assert.deepEqual(names(dest), ['2026-02'])
  assert.match(lines.join('\n'), /removed the old backup 2026-01/)
})

test('a copy that fails leaves no half-written folder and rethrows', async () => {
  const { server, world, dest } = rig([['2026-01', true]])
  await assert.rejects(
    guard.withBackupRoom(server, dest, '2026-03', [world], quiet, async () => {
      mkdirSync(join(dest, '2026-03'))
      writeFileSync(join(dest, '2026-03', 'part'), 'x')
      throw new Error('ENOSPC')
    }),
    /ENOSPC/
  )
  assert.deepEqual(names(dest), ['2026-01'])
})

test('a failed copy never removes an earlier backup from the same minute', async () => {
  const { server, world, dest } = rig([['2026-03', true]])
  await assert.rejects(
    guard.withBackupRoom(server, dest, '2026-03', [world], quiet, async () => { throw new Error('ENOSPC') }),
    /ENOSPC/
  )
  assert.deepEqual(names(dest), ['2026-03'])
})

test('two backups at once count each other: the second sees the first one\'s promise', async () => {
  const a = rig()
  const b = rig()
  const size = await guard.treeBytes(a.world)
  disk.available = 25 * GB + size // room for exactly one
  let release
  const first = guard.withBackupRoom(a.server, a.dest, 's', [a.world], quiet, () => new Promise((done) => { release = done }))
  while (!release) await new Promise((done) => setImmediate(done))
  await assert.rejects(guard.withBackupRoom(b.server, b.dest, 's', [b.world], quiet, async () => {}), /Not enough disk space/)
  release()
  await first
  let copied = 0
  await guard.withBackupRoom(b.server, b.dest, 's', [b.world], quiet, async () => { copied++ })
  assert.equal(copied, 1, 'the promise is released when the first backup ends')
})

test('a failed backup releases its promise too', async () => {
  const { server, world, dest } = rig()
  const size = await guard.treeBytes(world)
  disk.available = 25 * GB + size
  await assert.rejects(guard.withBackupRoom(server, dest, 's', [world], quiet, async () => { throw new Error('boom') }), /boom/)
  let copied = 0
  await guard.withBackupRoom(server, dest, 's', [world], quiet, async () => { copied++ })
  assert.equal(copied, 1)
})

test('a platform without statfs backs up as before', async () => {
  const { server, world, dest } = rig()
  disk.fail = true
  let copied = 0
  await guard.withBackupRoom(server, dest, 's', [world], quiet, async () => { copied++ })
  assert.equal(copied, 1)
})

test('makeServerBackup goes through the guard, before the world is paused', () => {
  const source = readFileSync(join(repo, 'src/main/services/server.ts'), 'utf8')
  const body = source.slice(source.indexOf('export async function makeServerBackup'), source.indexOf('/** Fire-and-forget wrapper'))
  const guardAt = body.indexOf('withBackupRoom(')
  assert.ok(guardAt > 0, 'guard call')
  assert.ok(guardAt < body.indexOf("'save-off'"), 'measured before save-off')
  assert.ok(body.indexOf('await cp(') > guardAt, 'copy inside the guard')
})
