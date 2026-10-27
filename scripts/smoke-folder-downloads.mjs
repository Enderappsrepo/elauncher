// Real archive/transfer regressions, without Electron, a cloud account, or a server.
// Usage: node scripts/smoke-folder-downloads.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, truncateSync, utimesSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, '..')
const cacheRoot = join(ROOT, 'node_modules', '.cache')
mkdirSync(cacheRoot, { recursive: true })
// Compiling beneath node_modules allows the real backend to resolve adm-zip.
const compiled = mkdtempSync(join(cacheRoot, 'folder-download-test-'))
const fixtures = mkdtempSync(join(tmpdir(), 'elauncher-folder-test-'))
const tempRoot = join(fixtures, 'archives')
const root = join(fixtures, 'servers', 'mine')
const victim = join(fixtures, 'servers', 'mine-evil')
const SERVER = 'server-one'
const USER = 'customer-one'
const LIMIT = 100 * 1024 * 1024
const CHUNK = 256 * 1024
const tests = []
const test = (name, run) => tests.push({ name, run })
let passed = 0

/** Decode the ZIP directory independently of adm-zip, then verify file bytes. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'ZIP has an end-of-directory record')
  const count = buffer.readUInt16LE(end + 10)
  let position = buffer.readUInt32LE(end + 16)
  const entries = new Map()
  for (let n = 0; n < count; n++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50)
    const method = buffer.readUInt16LE(position + 10)
    const compressedSize = buffer.readUInt32LE(position + 20)
    const size = buffer.readUInt32LE(position + 24)
    const nameLength = buffer.readUInt16LE(position + 28)
    const extraLength = buffer.readUInt16LE(position + 30)
    const commentLength = buffer.readUInt16LE(position + 32)
    const local = buffer.readUInt32LE(position + 42)
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8')
    assert.equal(buffer.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const compressed = buffer.subarray(start, start + compressedSize)
    assert.ok(method === 0 || method === 8, 'ZIP uses a standard compression method')
    const bytes = method === 0 ? compressed : inflateRawSync(compressed)
    assert.equal(bytes.length, size)
    assert.ok(!entries.has(name), 'ZIP entry names are unique')
    entries.set(name, bytes)
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

try {
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    join(ROOT, 'src/main/services/folderDownloads.ts'), '--ignoreConfig',
    '--outDir', compiled, '--module', 'commonjs', '--target', 'es2022',
    '--types', 'node', '--esModuleInterop', '--strict', '--skipLibCheck'
  ], { cwd: ROOT, stdio: 'inherit' })
  // Erase relay types without importing Supabase/browser configuration. Compile
  // the lazily loaded compatibility helper as well as its real entry point.
  const helperPath = join(ROOT, 'web/src/panel/tabs/file-download.ts')
  const compatibilityPath = join(ROOT, 'web/src/panel/tabs/browser-folder-zip.ts')
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'), helperPath, compatibilityPath, '--ignoreConfig',
    '--outDir', compiled, '--module', 'commonjs', '--target', 'es2022',
    '--noCheck', '--noResolve'
  ], { cwd: ROOT, stdio: 'inherit' })
  const { FolderDownloads } = require(join(compiled, 'folderDownloads.js'))
  const { fetchFileBlob, fetchFolderBlob } = require(join(compiled, 'file-download.js'))
  const downloads = new FolderDownloads(tempRoot)
  const binary = randomBytes(CHUNK * 3 + 137)
  mkdirSync(join(root, 'save', 'nested', 'empty'), { recursive: true })
  mkdirSync(victim, { recursive: true })
  writeFileSync(join(victim, 'secret.txt'), 'another customer save')
  writeFileSync(join(root, 'save', 'nested', 'world.bin'), binary)
  writeFileSync(join(root, 'save', 'café.txt'), 'world backup\n')
  writeFileSync(join(root, 'save', 'empty.dat'), '')
  const archives = () => readdirSync(tempRoot).filter((name) => name.startsWith('elauncher-folder-download-'))
  const prepare = (path = 'save') => downloads.prepare(SERVER, USER, root, path)
  const release = (archive) => downloads.release(SERVER, USER, archive.downloadId)
  const route = async (action, params = {}) => {
    if (action === 'prepareFolderDownload') return prepare(params.path)
    if (action === 'downloadArchiveChunk') {
      return downloads.read(SERVER, USER, params.downloadId, params.offset, params.length)
    }
    if (action === 'releaseArchive') return downloads.release(SERVER, USER, params.downloadId)
    throw new Error(`Unexpected action: ${action}`)
  }

  test('folder download round-trips nested binary files, Unicode names and empty directories', async () => {
    const progress = []
    let metadata
    const result = await fetchFolderBlob(route, 'save', (value) => { metadata = value }, (done, total) => progress.push([done, total]))
    assert.equal(result.name, 'save.zip')
    assert.equal(result.blob.type, 'application/zip')
    assert.match(metadata.downloadId, /^[\da-f-]{36}$/i)
    assert.deepEqual(Object.keys(metadata).sort(), ['downloadId', 'name', 'size'])
    assert.ok(progress.length >= 4, 'archive spans multiple relay chunks')
    assert.deepEqual(progress.at(-1), [result.blob.size, result.blob.size])
    const entries = unzip(Buffer.from(await result.blob.arrayBuffer()))
    assert.deepEqual([...entries.keys()].sort(), [
      'save/', 'save/café.txt', 'save/empty.dat', 'save/nested/', 'save/nested/empty/', 'save/nested/world.bin'
    ])
    assert.deepEqual(entries.get('save/nested/world.bin'), binary)
    assert.equal(entries.get('save/café.txt').toString(), 'world backup\n')
    assert.equal(entries.get('save/empty.dat').length, 0)
    assert.deepEqual(archives(), [], 'successful browser download releases its temporary ZIP')
    assert.deepEqual(readFileSync(join(root, 'save', 'nested', 'world.bin')), binary, 'source save remains intact')
  })

  test('archive tokens cannot be read or released by a different server or customer', async () => {
    const archive = await prepare()
    for (const [server, user] of [['other-server', USER], [SERVER, 'other-customer']]) {
      await assert.rejects(downloads.read(server, user, archive.downloadId, 0, CHUNK), /unavailable/i)
      assert.throws(() => downloads.release(server, user, archive.downloadId), /unavailable/i)
    }
    assert.ok((await downloads.read(SERVER, USER, archive.downloadId, 0, CHUNK)).data.length > 0)
    release(archive)
    assert.deepEqual(release(archive), { ok: true }, 'cleanup may safely be retried')
    await assert.rejects(downloads.read(SERVER, USER, archive.downloadId, 0, CHUNK), /unavailable/i)
  })

  test('invalid archive chunk ranges fail and exact EOF is reported correctly', async () => {
    const archive = await prepare()
    try {
      for (const [offset, length] of [
        [-1, 1], [0.5, 1], [NaN, 1], [Infinity, 1], [archive.size + 1, 1],
        [0, 0], [0, -1], [0, 0.5], [0, NaN], [0, Infinity], [0, 512 * 1024 + 1]
      ]) await assert.rejects(downloads.read(SERVER, USER, archive.downloadId, offset, length), /out of range/i)
      const last = await downloads.read(SERVER, USER, archive.downloadId, archive.size - 1, CHUNK)
      assert.equal(Buffer.from(last.data, 'base64').length, 1)
      assert.equal(last.eof, true)
      assert.deepEqual(await downloads.read(SERVER, USER, archive.downloadId, archive.size, 1), { data: '', size: archive.size, eof: true })
    } finally { release(archive) }
  })

  test('traversal, absolute paths, null bytes and non-folder selections are refused', async () => {
    for (const path of [
      '../mine-evil', '../mine-evil/secret.txt', 'save/../../mine-evil', '..\\mine-evil',
      victim, '/etc', 'C:/Windows', 'save\0hidden', 'save/café.txt'
    ]) await assert.rejects(prepare(path), /escapes|folder|null|invalid/i)
    assert.deepEqual(archives(), [])
  })

  test('selected and nested directory links cannot leak another customer save', async () => {
    mkdirSync(join(root, 'linked-save'), { recursive: true })
    // Windows junctions do not require the elevated privilege needed for symlinks.
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(victim, join(root, 'outside-link'), type)
    symlinkSync(victim, join(root, 'linked-save', 'escape'), type)
    for (const path of ['outside-link', 'outside-link/secret.txt', 'linked-save']) {
      await assert.rejects(prepare(path), /symbolic|escapes/i)
    }
    assert.deepEqual(archives(), [])
  })

  test('oversized source is refused without archiving or consuming an active slot', async () => {
    mkdirSync(join(root, 'oversized'))
    const sparse = join(root, 'oversized', 'large.dat')
    writeFileSync(sparse, '')
    truncateSync(sparse, LIMIT + 1)
    await assert.rejects(prepare('oversized'), /100 MB.*source/i)
    assert.deepEqual(archives(), [])
    const archive = await prepare()
    release(archive)
  })

  test('active ZIP limit bounds concurrent work and releasing a ZIP frees capacity', async () => {
    const active = await Promise.all(Array.from({ length: 4 }, () => prepare()))
    try {
      await assert.rejects(prepare(), /too many.*active/i)
      release(active.pop())
      const replacement = await prepare()
      release(replacement)
    } finally { active.forEach(release) }
    assert.deepEqual(archives(), [])
  })

  test('expired tokens and abandoned archives are removed without touching unrelated files', async () => {
    const archive = await prepare()
    const originalNow = Date.now
    try {
      const future = originalNow() + 6 * 60 * 60_000 + 1000
      Date.now = () => future
      await assert.rejects(downloads.read(SERVER, USER, archive.downloadId, 0, 1), /expired/i)
    } finally { Date.now = originalNow }
    assert.deepEqual(archives(), [])
    const orphan = join(tempRoot, 'elauncher-folder-download-abandoned')
    const unrelated = join(tempRoot, 'unrelated-directory')
    mkdirSync(orphan)
    mkdirSync(unrelated)
    writeFileSync(join(orphan, 'download.zip'), 'partial')
    const old = new Date(Date.now() - 7 * 60 * 60_000)
    utimesSync(orphan, old, old)
    utimesSync(unrelated, old, old)
    const fresh = await prepare()
    release(fresh)
    assert.equal(existsSync(orphan), false)
    assert.equal(existsSync(unrelated), true)
  })

  test('a truncated temporary ZIP fails instead of returning a successful partial chunk', async () => {
    const archive = await prepare()
    const file = join(tempRoot, archives()[0], 'download.zip')
    truncateSync(file, 2)
    try {
      await assert.rejects(downloads.read(SERVER, USER, archive.downloadId, 0, CHUNK), /incomplete/i)
    } finally { release(archive) }
    assert.deepEqual(archives(), [])
  })

  test('folder helper releases its ZIP after transport errors, early EOF and invalid metadata', async () => {
    for (const failure of ['transport', 'early-eof', 'metadata', 'callback']) {
      let released = 0
      const ask = async (action, params) => {
        const response = await route(action, params)
        if (action === 'releaseArchive') released++
        if (action === 'prepareFolderDownload' && failure === 'metadata') return { ...response, name: '../unsafe.zip' }
        if (action === 'downloadArchiveChunk' && failure === 'transport') throw new Error('transport failed')
        if (action === 'downloadArchiveChunk' && failure === 'early-eof') return { ...response, data: 'AA==', eof: true }
        return response
      }
      await assert.rejects(fetchFolderBlob(ask, 'save', () => {
        if (failure === 'callback') throw new Error('progress callback failed')
      }))
      assert.equal(released, 1, `${failure} releases exactly once`)
      assert.deepEqual(archives(), [])
    }
  })

  test('a lost cleanup reply does not discard a complete validated folder download', async () => {
    const originalWarn = console.warn
    let warned = false
    try {
      console.warn = () => { warned = true }
      const result = await fetchFolderBlob(async (action, params) => {
        const response = await route(action, params)
        if (action === 'releaseArchive') throw new Error('cleanup reply lost')
        return response
      }, 'save')
      const entries = unzip(Buffer.from(await result.blob.arrayBuffer()))
      assert.deepEqual(entries.get('save/nested/world.bin'), binary)
      assert.equal(warned, true)
      assert.deepEqual(archives(), [])
    } finally { console.warn = originalWarn }
  })

  test('ordinary binary and empty file downloads still round-trip through the helper', async () => {
    for (const contents of [binary, Buffer.alloc(0)]) {
      const blob = await fetchFileBlob(async (action, params) => {
        assert.equal(action, 'downloadChunk')
        assert.equal(params.path, 'world.bin')
        const end = Math.min(params.offset + params.length, contents.length)
        return { data: contents.subarray(params.offset, end).toString('base64'), size: contents.length, eof: end === contents.length }
      }, 'world.bin')
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), contents)
    }
  })

  test('file helper rejects corrupt, incomplete and inconsistent relay responses', async () => {
    const badResponses = [
      [{ data: '', size: 10, eof: false }],
      [{ data: 'AA==', size: 10, eof: true }],
      [{ data: 'AA==', size: 1, eof: false }],
      [{ data: 'AA==', size: 1, eof: false }, { data: '', size: 2, eof: true }],
      [{ data: 'AA==', size: 10, eof: false }, { data: 'AA==', size: 11, eof: false }],
      [{ data: '!!!!', size: 1, eof: true }],
      [{ data: Buffer.alloc(CHUNK + 1).toString('base64'), size: CHUNK + 1, eof: true }],
      [{ data: 'AAA=', size: 1, eof: true }],
      [{ data: '', size: LIMIT + 1, eof: true }],
      [{ data: '', size: -1, eof: true }],
      [{ data: '', size: 0.5, eof: true }],
      [{ data: '', size: 0, eof: 'true' }],
      [null]
    ]
    for (const responses of badResponses) {
      let index = 0
      await assert.rejects(fetchFileBlob(async () => {
        assert.ok(index < responses.length, 'malformed download must stop instead of polling forever')
        return responses[index++]
      }, 'world.bin'))
    }
  })

  // An older deployed host knows only the original listing/chunk APIs. These
  // fixtures deliberately use the wire shape, rather than browser ZIP internals.
  const entry = (name, isDir = false, sizeBytes = 0) => ({ name, isDir, sizeBytes, modifiedAt: 1234 })
  const oldListings = new Map([
    ['save', [entry('nested', true), entry('café.txt', false, 13), entry('empty.dat')]],
    ['save/nested', [entry('empty', true), entry('world.bin', false, binary.length)]],
    ['save/nested/empty', []]
  ])
  const oldFiles = new Map([
    ['save/café.txt', Buffer.from('world backup\n')],
    ['save/empty.dat', Buffer.alloc(0)],
    ['save/nested/world.bin', binary]
  ])
  function oldHost(listings = oldListings, files = oldFiles) {
    const calls = []
    const ask = async (action, params = {}) => {
      calls.push({ action, params })
      if (action === 'prepareFolderDownload') throw new Error('unknown request: prepareFolderDownload')
      if (action === 'files') return listings.get(params.path)
      if (action === 'downloadChunk') {
        assert.ok(files.has(params.path), `requested an expected file: ${params.path}`)
        const contents = files.get(params.path)
        const end = Math.min(params.offset + params.length, contents.length)
        return { data: contents.subarray(params.offset, end).toString('base64'), size: contents.length, eof: end === contents.length }
      }
      throw new Error(`Older hosts do not support ${action}`)
    }
    return { ask, calls }
  }

  test('older hosts produce a complete browser ZIP with nested binary files and empty folders', async () => {
    const host = oldHost()
    const progress = []
    const result = await fetchFolderBlob(host.ask, 'save', undefined, (done, total) => progress.push([done, total]))
    assert.equal(result.name, 'save.zip')
    assert.equal(result.blob.type, 'application/zip')
    const entries = unzip(Buffer.from(await result.blob.arrayBuffer()))
    assert.deepEqual([...entries.keys()].sort(), [
      'save/', 'save/café.txt', 'save/empty.dat', 'save/nested/', 'save/nested/empty/', 'save/nested/world.bin'
    ])
    assert.deepEqual(entries.get('save/nested/world.bin'), binary)
    assert.equal(entries.get('save/café.txt').toString(), 'world backup\n')
    assert.equal(entries.get('save/empty.dat').length, 0)
    assert.ok(progress.length >= 4, 'compatibility download spans multiple relay chunks')
    assert.ok(host.calls.some(({ action }) => action === 'files'))
    assert.equal(host.calls.filter(({ action }) => action === 'prepareFolderDownload').length, 1)
    assert.equal(host.calls.some(({ action }) => action === 'releaseArchive'), false, 'old host has no temporary archive to release')
  })

  test('denied, offline, timeout and unrelated host errors never activate ZIP fallback', async () => {
    for (const message of [
      'access was revoked', 'Only the host owner or an admin can do that.',
      'No answer from the machine hosting this server — is the launcher running?',
      'Request timed out', 'Disk is full', 'unknown request: files',
      'unknown request: prepareFolderDownload.', 'proxy error: unknown request: prepareFolderDownload'
    ]) {
      const calls = []
      await assert.rejects(fetchFolderBlob(async (action) => {
        calls.push(action)
        throw new Error(message)
      }, 'save'), (error) => error.message === message)
      assert.deepEqual(calls, ['prepareFolderDownload'], message)
    }
  })

  test('browser ZIP refuses missing listings, invalid entries, unsafe names and duplicates', async () => {
    const badListings = [
      undefined, null, {}, 'missing', [null], [{}],
      [entry('')], [entry('.')], [entry('..')], [entry('../loot')],
      [entry('nested/loot')], [entry('nested\\loot')], [entry('/absolute')],
      [entry('C:escape')], [entry('bad\0name')],
      [entry('same'), entry('same')],
      [{ ...entry('save.dat'), isDir: 'false' }],
      [{ ...entry('save.dat'), sizeBytes: -1 }],
      [{ ...entry('save.dat'), sizeBytes: 0.5 }],
      [{ ...entry('save.dat'), sizeBytes: NaN }],
      [{ ...entry('save.dat'), isSymlink: true }],
      [{ ...entry('save.dat'), isSymbolicLink: true }]
    ]
    for (const listing of badListings) {
      const host = oldHost(new Map([['save', listing]]))
      let result
      await assert.rejects(async () => { result = await fetchFolderBlob(host.ask, 'save') })
      assert.equal(result, undefined, 'invalid listing must never yield a partial ZIP')
      assert.equal(host.calls.some(({ action }) => action === 'downloadChunk'), false, 'unsafe listing is refused before file reads')
    }
    const missingNested = oldHost(new Map([['save', [entry('nested', true)]]]))
    await assert.rejects(fetchFolderBlob(missingNested.ask, 'save'))
    assert.equal(missingNested.calls.some(({ action }) => action === 'downloadChunk'), false)
  })

  test('browser ZIP refuses a selected path outside the server folder before listing it', async () => {
    for (const path of ['../victim', 'save/../../victim', '..\\victim', '/root', 'C:/Windows', 'save\0hidden']) {
      const host = oldHost()
      await assert.rejects(fetchFolderBlob(host.ask, path))
      assert.equal(host.calls.some(({ action }) => action === 'files'), false)
    }
  })

  test('browser ZIP enforces entry and source-size bounds across nested folders', async () => {
    for (const listings of [
      new Map([
        ['save', [entry('left', true), entry('right', true)]],
        ['save/left', Array.from({ length: 10_000 }, (_, index) => entry(`file-${index}`))],
        ['save/right', Array.from({ length: 10_000 }, (_, index) => entry(`file-${index}`))]
      ]),
      new Map([
        ['save', [entry('left', true), entry('right', true)]],
        ['save/left', [entry('part.dat', false, 60 * 1024 * 1024)]],
        ['save/right', [entry('part.dat', false, 60 * 1024 * 1024)]]
      ])
    ]) {
      const host = oldHost(listings)
      await assert.rejects(fetchFolderBlob(host.ask, 'save'), /limit|20.?000|100|large|many|cap/i)
      assert.equal(host.calls.some(({ action }) => action === 'downloadChunk'), false, 'aggregate bounds apply before reading file contents')
    }
  })

  test('browser ZIP rejects changed or interrupted source files without returning partial backups', async () => {
    for (const failure of ['changed-size', 'early-eof', 'read-error', 'listing-error']) {
      const host = oldHost()
      let result
      await assert.rejects(async () => {
        result = await fetchFolderBlob(async (action, params) => {
          if (action === 'files' && failure === 'listing-error') throw new Error('listing failed')
          const response = await host.ask(action, params)
          if (action === 'downloadChunk' && failure === 'read-error') throw new Error('file vanished')
          if (action === 'downloadChunk' && failure === 'early-eof') return { ...response, data: '', eof: true }
          if (action === 'downloadChunk' && failure === 'changed-size') {
            return { data: 'AA==', size: 1, eof: true }
          }
          return response
        }, 'save')
      })
      assert.equal(result, undefined, `${failure} cannot yield a partial ZIP`)
      assert.equal(host.calls.some(({ action }) => action === 'releaseArchive'), false)
    }
  })

  test('browser ZIP preserves filenames which coincide with JavaScript object properties', async () => {
    const files = new Map([['save/__proto__', Buffer.from('prototype name')], ['save/constructor', Buffer.from('constructor name')]])
    const listings = new Map([['save', [...files].map(([path, bytes]) => entry(path.slice(5), false, bytes.length))]])
    const result = await fetchFolderBlob(oldHost(listings, files).ask, 'save')
    const entries = unzip(Buffer.from(await result.blob.arrayBuffer()))
    assert.equal(entries.get('save/__proto__').toString(), 'prototype name')
    assert.equal(entries.get('save/constructor').toString(), 'constructor name')
  })

  for (const { name, run } of tests) {
    await run()
    passed++
    console.log(`PASS ${name}`)
  }
  console.log(`\n${passed} folder/download regression tests passed.`)
} catch (error) {
  console.error(`FAIL after ${passed} tests`, error)
  process.exitCode = 1
} finally {
  // Both paths were created by mkdtemp above, beneath explicitly named roots.
  assert.ok(compiled.startsWith(cacheRoot + (process.platform === 'win32' ? '\\' : '/')))
  assert.ok(fixtures.startsWith(join(tmpdir(), 'elauncher-folder-test-')))
  rmSync(compiled, { recursive: true, force: true })
  rmSync(fixtures, { recursive: true, force: true })
}
