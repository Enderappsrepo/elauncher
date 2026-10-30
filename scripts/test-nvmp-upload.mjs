// Uses real files and the actual browser transfer/host handlers; no network or game processes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { test, after } from 'node:test'
import { transformSync } from 'esbuild'
import { parse } from '@babel/parser'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
const root = fs.mkdtempSync(join(tmpdir(), 'elauncher-nvmp-upload-'))
after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.ok(root.includes('elauncher-nvmp-upload-')); fs.rmSync(root, { recursive: true, force: true }) })
let count = 0
const temp = () => { const p = join(root, String(++count)); fs.mkdirSync(p); return p }
const hash = (b) => createHash('sha256').update(b).digest('hex')
function load(file, imports = {}) {
  const code = transformSync(fs.readFileSync(join(repo, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const module = { exports: {} }
  const req = (id) => { if (id in imports) return imports[id]; if (id.startsWith('.') || id.startsWith('@')) throw new Error(`Unmocked import: ${id}`); return require(id) }
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, module, module.exports)
  return module.exports
}
const policy = load('src/shared/nvmpUpload.ts')
const uploadApi = (overrides = {}) => load('src/main/services/nvmpUpload.ts', { '@shared/nvmpUpload': policy, fs: { ...fs, statfsSync: () => ({ bavail: 1024 ** 3, bsize: 4096 }), ...overrides } })
const api = uploadApi()
const nvmp = load('src/main/services/nvmp.ts', { './nvmpUpload': api, './mods': {}, './proton': {}, './gameuser': {}, './proctree': {} })
const browser = load('web/src/panel/nvmpTransfer.ts', { '@shared/nvmpUpload': policy })
function fixture(files = [{ path: 'Data/FalloutNV.esm', size: 7, modified: 1, sample: hash('sample') }]) {
  const dir = temp(); api.initialiseNvmpUpload(dir)
  const status = api.beginNvmpUpload(dir, files)
  return { dir, status, files: status.files }
}
function put(f, index, offset, b) { return api.uploadNvmpChunk(f.dir, f.status.session, index, offset, b.toString('base64'), hash(b)) }
function fill(f) {
  f.files.forEach((file, i) => { for (let offset = 0; offset < file.size; offset += policy.NVMP_CHUNK_BYTES) put(f, i, offset, Buffer.alloc(Math.min(policy.NVMP_CHUNK_BYTES, file.size - offset), 65 + i)) })
}
function pick(path, bytes, modified = 1) {
  const file = new File([bytes], path.split('/').at(-1), { lastModified: modified })
  Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file
}

test('manifest confines uploads to Data and rejects traversal, executables and case collisions', () => {
  const base = { size: 1, modified: 1, sample: hash('file') }
  for (const path of ['../Data/FalloutNV.esm', 'Data/../server.cfg', 'Data/C:/x.esm', 'Data/a\\x.esm', 'server.cfg', 'Data/payload.dll', 'Data/CON.esm']) {
    assert.throws(() => policy.validateNvmpManifest([{ ...base, path }]))
  }
  assert.throws(() => policy.validateNvmpManifest([{ ...base, path: 'Data/FalloutNV.esm' }, { ...base, path: 'Data/falloutnv.ESM' }]), /Duplicate/)
  assert.throws(() => policy.validateNvmpManifest([{ ...base, path: 'Data/FalloutNV.esm' }, { ...base, path: 'Data/Textures' }, { ...base, path: 'Data/textures/a.dds' }]), /collision/)
})

test('manifest permits large retail assets, enforces size/count limits and requires the base game', () => {
  const base = { path: 'Data/FalloutNV.esm', size: 2 * 1024 ** 3, modified: 1, sample: hash('file') }
  assert.equal(policy.validateNvmpManifest([base])[0].size, 2 * 1024 ** 3)
  for (const size of [-1, 1.5, Infinity, policy.NVMP_MAX_FILE_BYTES + 1]) assert.throws(() => policy.validateNvmpManifest([{ ...base, size }]))
  assert.throws(() => policy.validateNvmpManifest([{ ...base, path: 'Data/Mod.esp' }]), /FalloutNV/)
  assert.throws(() => policy.validateNvmpManifest([base, ...Array.from({ length: 5 }, (_, i) => ({ ...base, path: `Data/${i}.bsa`, size: policy.NVMP_MAX_FILE_BYTES }))]), /64 GB/)
  assert.throws(() => policy.validateNvmpManifest(Array(10001).fill(base)), /10000/)
})

test('new customer instances wait for files and cannot start', () => {
  const dir = temp(); api.initialiseNvmpUpload(dir)
  assert.equal(api.nvmpSetupStatus(dir).phase, 'waiting')
  assert.throws(() => api.requireNvmpUploadReady(dir), /Game setup/)
  assert.equal(fs.existsSync(join(dir, 'Data')), false)
})

test('low disk space rejects setup before any file data is accepted', () => {
  const dir = temp(), low = uploadApi({ statfsSync: () => ({ bavail: 1, bsize: 4096 }) })
  low.initialiseNvmpUpload(dir)
  assert.throws(() => low.beginNvmpUpload(dir, [{ path: 'Data/FalloutNV.esm', size: 7, modified: 1, sample: hash('base') }]), /free disk space/)
  assert.equal(low.nvmpSetupStatus(dir).phase, 'waiting')
})

test('out-of-order chunks require full coverage; a sparse file is not a completed upload', () => {
  const size = policy.NVMP_CHUNK_BYTES + 7
  const f = fixture([{ path: 'Data/FalloutNV.esm', size, modified: 1, sample: hash('large') }])
  put(f, 0, policy.NVMP_CHUNK_BYTES, Buffer.alloc(7, 2))
  assert.equal(api.nvmpSetupStatus(f.dir).receivedBytes, 7)
  assert.throws(() => api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins), /incomplete/)
  put(f, 0, 0, Buffer.alloc(policy.NVMP_CHUNK_BYTES, 1))
  assert.equal(api.nvmpSetupStatus(f.dir).receivedBytes, size)
  assert.equal(api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins).phase, 'ready')
  assert.equal(fs.readFileSync(join(f.dir, 'Data/FalloutNV.esm')).at(-1), 2)
})

test('retries are idempotent and reject changed data at an acknowledged offset', () => {
  const f = fixture(); const b = Buffer.from('1234567')
  put(f, 0, 0, b); put(f, 0, 0, b)
  assert.equal(api.nvmpSetupStatus(f.dir).receivedBytes, 7)
  assert.throws(() => put(f, 0, 0, Buffer.from('7654321')), /different data/)
})

test('tampered chunk hashes, partial chunks, and invalid offsets do not advance progress', () => {
  const f = fixture()
  assert.throws(() => api.uploadNvmpChunk(f.dir, f.status.session, 0, 0, Buffer.from('1234567').toString('base64'), hash('bad')), /checksum/)
  assert.throws(() => put(f, 0, 0, Buffer.from('123')), /length/)
  assert.throws(() => put(f, 0, 1, Buffer.from('1234567')), /offset/)
  assert.throws(() => put(f, 99, 0, Buffer.from('1234567')), /Unknown/)
  assert.equal(api.nvmpSetupStatus(f.dir).receivedBytes, 0)
})

test('sessions are confined to their instance and progress survives loading the module again', () => {
  const a = fixture(), b = fixture(); put(a, 0, 0, Buffer.from('1234567'))
  assert.throws(() => api.uploadNvmpChunk(b.dir, a.status.session, 0, 0, 'MTIzNDU2Nw==', hash('1234567')), /no longer active/)
  assert.equal(api.nvmpSetupStatus(b.dir).receivedBytes, 0)
  const reloaded = uploadApi()
  assert.equal(reloaded.beginNvmpUpload(a.dir, a.files).receivedBytes, 7)
  assert.throws(() => reloaded.beginNvmpUpload(a.dir, a.files.map((f) => ({ ...f, modified: 2 }))), /differs/)
})

test('load order errors keep staged data intact and keep startup blocked', () => {
  const f = fixture(); fill(f)
  for (const order of ['', 'Missing.esp', 'FalloutNV.esm\nMissing.esp', 'FalloutNV.esm\nFalloutNV.esm', 'FalloutNV.esm\n../outside.esp']) {
    assert.throws(() => api.finishNvmpUpload(f.dir, f.status.session, order, nvmp.readNvmpPlugins))
    assert.equal(api.nvmpSetupStatus(f.dir).phase, 'uploading')
    assert.equal(api.nvmpSetupStatus(f.dir).receivedBytes, 7)
    assert.throws(() => api.requireNvmpUploadReady(f.dir))
  }
  api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  assert.doesNotThrow(() => api.requireNvmpUploadReady(f.dir))
  assert.equal(api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins).phase, 'ready')
})

test('a zero-byte supporting file is materialised only when the complete upload is finalised', () => {
  const files = [{ path: 'Data/FalloutNV.esm', size: 7, modified: 1, sample: hash('base') }, { path: 'Data/empty.txt', size: 0, modified: 1, sample: hash('empty') }]
  const f = fixture(files); fill(f); api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  assert.equal(fs.readFileSync(join(f.dir, 'Data/empty.txt')).length, 0)
})

test('discard invalidates the session and never touches another customer', () => {
  const a = fixture(), b = fixture(); fill(a); fill(b)
  assert.equal(api.discardNvmpUpload(a.dir, a.status.session).phase, 'waiting')
  assert.equal(api.nvmpSetupStatus(b.dir).receivedBytes, 7)
  assert.throws(() => put(a, 0, 0, Buffer.from('1234567')), /no longer active/)
})

test('discarding a replacement preserves the installed Data and load order', () => {
  const f = fixture(); fill(f); api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  const before = fs.readFileSync(join(f.dir, 'Data/FalloutNV.esm'))
  const next = api.beginNvmpUpload(f.dir, f.files)
  assert.throws(() => api.requireNvmpUploadReady(f.dir))
  assert.equal(api.discardNvmpUpload(f.dir, next.session).phase, 'ready')
  assert.deepEqual(fs.readFileSync(join(f.dir, 'Data/FalloutNV.esm')), before)
  assert.deepEqual(nvmp.readNvmpPlugins(f.dir), ['FalloutNV.esm'])
})

test('interrupted commit restores originals, then can finish without uploading again', () => {
  const f = fixture(); fill(f); api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  f.status = api.beginNvmpUpload(f.dir, f.files); put(f, 0, 0, Buffer.from('newdata'))
  const base = join(f.dir, '.nvmp-upload'), stateFile = join(base, 'state.json'), state = JSON.parse(fs.readFileSync(stateFile))
  const session = join(base, state.session)
  fs.mkdirSync(join(session, 'previous')); fs.renameSync(join(f.dir, 'Data'), join(session, 'previous/Data'))
  fs.renameSync(join(session, 'staged/Data'), join(f.dir, 'Data'))
  state.phase = 'committing'; fs.writeFileSync(stateFile, JSON.stringify(state))
  assert.throws(() => api.requireNvmpUploadReady(f.dir))
  api.finishNvmpUpload(f.dir, state.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  assert.equal(fs.readFileSync(join(f.dir, 'Data/FalloutNV.esm'), 'utf8'), 'newdata')
})

test('links cannot redirect uploads into another instance', () => {
  const f = fixture(), other = temp(), path = join(f.dir, '.nvmp-upload', f.status.session, 'staged/Data')
  assert.ok(resolve(path).startsWith(resolve(f.dir) + sep))
  fs.rmdirSync(path); fs.symlinkSync(other, path, 'junction')
  assert.throws(() => put(f, 0, 0, Buffer.from('1234567')), /Linked paths/)
  assert.deepEqual(fs.readdirSync(other), [])
})

test('browser transfer reaches the host intact, retries a lost acknowledgement and resumes only missing chunks', async () => {
  const data = Buffer.alloc(policy.NVMP_CHUNK_BYTES * 2 + 7, 42)
  const selection = await browser.selectNvmpFiles([pick('Data/FalloutNV.esm', data), pick('Data/Textures/a.dds', Buffer.from('texture')), pick('Data/NVSE/native.dll', 'excluded')])
  assert.deepEqual(selection.skipped, ['Data/NVSE/native.dll'])
  const f = fixture(selection.manifest); const baseIndex = f.files.findIndex((x) => x.path.endsWith('FalloutNV.esm'))
  put(f, baseIndex, 0, data.subarray(0, policy.NVMP_CHUNK_BYTES))
  const status = api.nvmpSetupStatus(f.dir, true); let lost = false; const offsets = []
  await browser.transferNvmpFiles(async (action, p) => {
    assert.equal(action, 'nvmpChunk'); offsets.push([p.index, p.offset])
    const result = api.uploadNvmpChunk(f.dir, p.session, p.index, p.offset, p.data, p.checksum)
    if (!lost) { lost = true; throw new Error('acknowledgement lost') }; return result
  }, selection, status, new AbortController().signal, () => {})
  assert.equal(offsets.some(([i, o]) => i === baseIndex && o === 0), false)
  api.finishNvmpUpload(f.dir, f.status.session, 'FalloutNV.esm\n', nvmp.readNvmpPlugins)
  assert.deepEqual(fs.readFileSync(join(f.dir, 'Data/FalloutNV.esm')), data)
  assert.equal(fs.readFileSync(join(f.dir, 'Data/Textures/a.dds'), 'utf8'), 'texture')
})

test('pausing the browser transfer leaves all unacknowledged work resumable', async () => {
  const selection = await browser.selectNvmpFiles([pick('Data/FalloutNV.esm', Buffer.alloc(6 * policy.NVMP_CHUNK_BYTES, 33))])
  const f = fixture(selection.manifest), stop = new AbortController()
  await browser.transferNvmpFiles(async (_action, p) => { const result = api.uploadNvmpChunk(f.dir, p.session, p.index, p.offset, p.data, p.checksum); stop.abort(); return result }, selection, f.status, stop.signal, () => {})
  const status = api.nvmpSetupStatus(f.dir, true)
  assert.ok(status.receivedBytes > 0 && status.receivedBytes < status.totalBytes)
  assert.equal(status.phase, 'uploading')
})

// Exercise actual service/authorization functions without booting Electron or Supabase.
function isolated(file, name, bindings) {
  const source = fs.readFileSync(join(repo, file), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const declaration = ast.program.body.map((n) => n.type === 'ExportNamedDeclaration' ? n.declaration : n).find((n) => n?.type === 'FunctionDeclaration' && n.id?.name === name)
  assert.ok(declaration, name)
  const js = transformSync(source.slice(declaration.start, declaration.end), { loader: 'ts', target: 'es2022' }).code
  return runInThisContext(`(function(${Object.keys(bindings).join(',')}){${js};return ${name}})`)(...Object.values(bindings))
}
test('panel setup changes are restricted to the renter/host/admin; viewers can inspect status', async () => {
  const calls = []
  const run = isolated('src/main/services/remote.ts', 'runPanelRequest', { runNvmpSetupRequest: (...args) => { calls.push(args); return { phase: 'waiting' } } })
  assert.deepEqual(await run('own-server', 'nvmpStatus', {}, 'viewer', false, false), { phase: 'waiting' })
  for (const action of ['nvmpBegin', 'nvmpChunk', 'nvmpFinish', 'nvmpDiscard']) await assert.rejects(run('own-server', action, {}, 'viewer', false, false), /renting customer/)
  await run('own-server', 'nvmpBegin', { files: [] }, 'renter', false, true)
  assert.equal(calls.length, 2); assert.equal(calls[1][0], 'own-server')
})

test('host refuses setup writes while running and refuses non-NVMP servers', () => {
  let game = 'nvmp', state = 'running'
  const run = isolated('src/main/services/server.ts', 'runNvmpSetupRequest', {
    getServer: () => ({ game }), gameOf: (s) => s.game, serverDir: () => root,
    states: { get: () => state }, nvmpSetupStatus: () => ({ phase: 'ready' })
  })
  assert.deepEqual(run('id', 'nvmpStatus', {}), { phase: 'ready' })
  for (const action of ['nvmpBegin', 'nvmpChunk', 'nvmpFinish', 'nvmpDiscard']) assert.throws(() => run('id', action, {}), /Stop the server/)
  game = 'minecraft'; state = 'stopped'; assert.throws(() => run('id', 'nvmpStatus', {}), /only available/)
})

test('ordinary file-manager routes cannot read upload bookkeeping or follow Wine links', () => {
  const dir = temp(), other = temp(); fs.symlinkSync(other, join(dir, 'wine-link'), 'junction')
  const safe = isolated('src/main/services/server.ts', 'safePath', { serverDir: () => dir, resolve, sep, dirname, lstatSync: fs.lstatSync, NVMP_UPLOAD_DIR: '.nvmp-upload' })
  assert.throws(() => safe('id', '.nvmp-upload/state.json'), /Game setup/)
  assert.throws(() => safe('id', 'wine-link/private.txt'), /Linked paths/)
  assert.throws(() => safe('id', '../outside'), /escapes/)
  assert.equal(safe('id', 'Data/test.esp'), join(dir, 'Data/test.esp'))
})
