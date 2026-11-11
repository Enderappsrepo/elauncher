// NVMP Companion app: the upload controller, relay, server list and job store against the real host handlers.
// No network and no Electron (electron is stubbed).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { test, after } from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'package.json'))
const { build, transformSync } = require('esbuild')
const { parse } = require('@babel/parser')

const root = fs.mkdtempSync(join(tmpdir(), 'companion-b-'))
after(() => { assert.ok(root.includes('companion-b-')); fs.rmSync(root, { recursive: true, force: true }) })
let count = 0
const temp = () => { const p = join(root, String(++count)); fs.mkdirSync(p, { recursive: true }); return p }
const hash = (b) => createHash('sha256').update(b).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- bundle the companion modules (aliases as in electron.vite.companion.config.ts) ----------
const ALIAS = { '@shared/': `${repo}/src/shared/`, '@web/': `${repo}/web/src/`, '@companion/': `${repo}/companion/` }
const aliasPlugin = {
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^@(shared|web|companion)\// }, (args) => {
      const prefix = Object.keys(ALIAS).find((p) => args.path.startsWith(p))
      const base = ALIAS[prefix] + args.path.slice(prefix.length)
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
      return hit ? { path: resolve(hit) } : undefined
    })
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'module.exports = { app: { getPath: () => process.env.TEST_USERDATA, getVersion: () => "0.0.0" }, safeStorage: { isEncryptionAvailable: () => false } }',
      loader: 'js'
    }))
  }
}
const outDir = join(root, 'bundle')
await build({
  entryPoints: ['upload', 'relay', 'servers', 'jobStore'].map((n) => `${repo}/companion/main/${n}.ts`),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', outdir: outDir, logLevel: 'error',
  plugins: [aliasPlugin], external: ['@supabase/supabase-js']
})
const companion = (n) => require(join(outDir, `${n}.js`))
const { UploadController } = companion('upload')
const relay = companion('relay')
const servers = companion('servers')
const jobStore = companion('jobStore')

// cloud.ts (with the real supabase-js, pointed at a host that cannot exist) and the window's pure flow logic
const cloudDir = join(root, 'bundle-cloud')
await build({
  entryPoints: [`${repo}/companion/main/cloud.ts`, `${repo}/companion/renderer/src/flow.ts`],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', outdir: cloudDir, logLevel: 'error',
  plugins: [{
    name: 'test-cloud-config',
    setup(b) {
      b.onResolve({ filter: /^@shared\/cloudConfig$/ }, () => ({ path: 'cloudConfig', namespace: 'cloud-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'cloud-stub' }, () => ({
        contents: 'export const SUPABASE_URL = "https://companion-test.invalid"; export const SUPABASE_ANON_KEY = "test-anon-key-that-is-long-enough"; export const isCloudConfigured = () => true',
        loader: 'js'
      }))
    }
  }, aliasPlugin]
})
const cloud = require(join(cloudDir, 'main', 'cloud.js'))
const flow = require(join(cloudDir, 'renderer', 'src', 'flow.js'))
const SIGNED_OUT_MESSAGE = 'Your sign-in expired. Sign in again.'
const OFFLINE_MESSAGE = 'Cannot reach the eLauncher cloud. Check your internet connection.'
const HOST_SILENT = 'No answer from the machine hosting this server — is the launcher running?'
const offline = () => Object.assign(new Error('TypeError: fetch failed'), { status: 0 })

// ---------- the real host code ----------
function load(file, imports = {}) {
  const code = transformSync(fs.readFileSync(join(repo, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const module = { exports: {} }
  const req = (id) => { if (id in imports) return imports[id]; if (id.startsWith('.') || id.startsWith('@')) throw new Error(`Unmocked import: ${id}`); return require(id) }
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, module, module.exports)
  return module.exports
}
function isolated(file, name, bindings) {
  const source = fs.readFileSync(join(repo, file), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const declaration = ast.program.body.map((n) => n.type === 'ExportNamedDeclaration' ? n.declaration : n).find((n) => n?.type === 'FunctionDeclaration' && n.id?.name === name)
  assert.ok(declaration, name)
  const js = transformSync(source.slice(declaration.start, declaration.end), { loader: 'ts', target: 'es2022' }).code
  return runInThisContext(`(function(${Object.keys(bindings).join(',')}){${js};return ${name}})`)(...Object.values(bindings))
}
const policy = load('src/shared/nvmpUpload.ts')
const hostApi = load('src/main/services/nvmpUpload.ts', { '@shared/nvmpUpload': policy, fs: { ...fs, statfsSync: () => ({ bavail: 1024 ** 3, bsize: 4096 }) } })
const nvmp = load('src/main/services/nvmp.ts', { './nvmpUpload': hostApi, './mods': {}, './proton': {}, './gameuser': {}, './proctree': {} })

/** One hosted NV:MP server: its instance dir, run state, and the relay as the companion sees it. */
function host({ canShare = true } = {}) {
  const dir = temp(); hostApi.initialiseNvmpUpload(dir)
  const h = { dir, state: 'stopped', online: true, canShare, calls: [], hooks: {} }
  const setup = isolated('src/main/services/server.ts', 'runNvmpSetupRequest', {
    getServer: () => ({ game: 'nvmp' }), gameOf: (s) => s.game, serverDir: () => dir, states: { get: () => h.state },
    nvmpSetupStatus: hostApi.nvmpSetupStatus, nvmpUploadPending: hostApi.nvmpUploadPending, beginNvmpUpload: hostApi.beginNvmpUpload,
    uploadNvmpChunk: hostApi.uploadNvmpChunk, finishNvmpUpload: hostApi.finishNvmpUpload, discardNvmpUpload: hostApi.discardNvmpUpload,
    readNvmpPlugins: nvmp.readNvmpPlugins
  })
  const panel = isolated('src/main/services/remote.ts', 'runPanelRequest', { runNvmpSetupRequest: setup, guardCustomerLimits: () => {} })
  // JSON both ways, like a server_requests row
  h.ask = async (action, params = {}) => {
    h.calls.push(action)
    await sleep(1)
    const hook = h.hooks[action]
    if (hook) { const out = await hook(params); if (out instanceof Error) throw out }
    // remote.ts: a non-privileged request (info and nvmpStatus included) to an archived server is refused for everyone
    if (h.state === 'archived' || h.archivedOnHost) throw new Error('This server is archived \u2014 restore it first.')
    if (action === 'info') return { canShare: h.canShare }
    return JSON.parse(JSON.stringify(await panel('srv-1', action, JSON.parse(JSON.stringify(params)), 'renter', false, h.canShare)))
  }
  h.server = { serverId: 'srv-1', ownerId: 'host-owner', name: 'My NV:MP', get state() { return h.state }, get hostOnline() { return h.online } }
  h.commands = []
  return h
}

/** A Fallout: New Vegas folder with assets, a skipped NVSE dll and a plugins.txt in a fake %LOCALAPPDATA%. */
function gameFolder() {
  const game = temp(), data = join(game, 'Data')
  const put = (rel, bytes) => { fs.mkdirSync(join(data, rel, '..'), { recursive: true }); fs.writeFileSync(join(data, rel), bytes) }
  fs.writeFileSync(join(game, 'FalloutNV.exe'), 'exe')
  put('FalloutNV.esm', randomBytes(300_000))
  put('Mod.esp', randomBytes(5_000))
  put('Meshes/Big.nif', randomBytes(3 * 1024 * 1024 + 123))
  put('Textures/empty.dds', Buffer.alloc(0))
  put('NVSE/Plugins/nvse_thing.dll', randomBytes(100))
  const local = temp(); fs.mkdirSync(join(local, 'FalloutNV'))
  fs.writeFileSync(join(local, 'FalloutNV', 'plugins.txt'), '# active\r\nFalloutNV.esm\r\nmod.esp\r\n')
  process.env.LOCALAPPDATA = local
  return { game, data }
}

function controllerFor(h, jobs = memoryJobs(), { account = 'renter', retry = { delaysMs: [5, 5, 5], forMs: 300 } } = {}) {
  const events = []
  const who = { account }
  const c = new UploadController({
    server: async (id) => (id === 'srv-1' && !h.gone ? { ...h.server, state: h.state, hostOnline: h.online } : null),
    userId: async () => {
      if (!who.account) throw Object.assign(new Error(SIGNED_OUT_MESSAGE), { code: 'SIGNED_OUT' })
      return who.account
    },
    ask: async () => (action, params) => h.ask(action, params),
    command: async (server, action) => { h.commands.push(action); if (action === 'start') h.state = 'running'; else h.state = 'stopped' },
    emit: (p) => events.push(p),
    keepAwake: (on) => events.push({ keepAwake: on }),
    jobs,
    retry
  })
  c.setAccount(account) // as index.ts does once the window has found the session
  return { c, events, jobs, who }
}
/** The controller's per-account job store, in memory; load() with no account reads the default test account's. */
function memoryJobs() {
  const jobs = new Map()
  return {
    load: (userId = 'renter') => jobs.get(userId) ?? null,
    save: (j) => { assert.ok(j.userId, 'a job is always saved for an account'); jobs.set(j.userId, JSON.parse(JSON.stringify(j))) },
    clear: (userId) => { jobs.delete(userId) },
    accounts: () => [...jobs.keys()]
  }
}
const chunks = (h) => h.calls.filter((a) => a === 'nvmpChunk').length
const issueOf = async (promise) => { try { await promise } catch (e) { return { issue: e.issue, message: e.message } } assert.fail('expected a rejection') }

// ---------- tests ----------

test('full upload: scans, skips executables, uploads every byte, finishes with the canonical load order', async () => {
  const h = host(), { game, data } = gameFolder(), { c, events, jobs } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  assert.ok(found, 'candidateFromFolder found the synthetic install')
  const prepared = await c.prepare(found.id)
  assert.equal(prepared.scan.files, 4)
  assert.deepEqual(prepared.scan.skippedExecutables, ['Data/NVSE/Plugins/nvse_thing.dll'])
  assert.deepEqual(prepared.scan.problems, [])
  assert.deepEqual(prepared.loadOrder.plugins, ['FalloutNV.esm', 'Mod.esp'])
  await c.upload('srv-1', found.id)
  assert.equal(c.snapshot().state, 'ready')
  assert.equal(c.snapshot().running, false)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
  for (const rel of ['FalloutNV.esm', 'Mod.esp', 'Meshes/Big.nif', 'Textures/empty.dds']) {
    assert.equal(hash(fs.readFileSync(join(h.dir, 'Data', rel))), hash(fs.readFileSync(join(data, rel))), rel)
  }
  assert.equal(fs.existsSync(join(h.dir, 'Data', 'NVSE')), false)
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')
  assert.equal(chunks(h), 1 + 1 + 7)
  assert.equal(jobs.load(), null, 'a finished job is forgotten')
  const states = [...new Set(events.filter((e) => e.state).map((e) => e.state))]
  for (const s of ['starting', 'scanning', 'uploading', 'finishing', 'ready']) assert.ok(states.includes(s), `emitted ${s}`)
  assert.deepEqual(events.filter((e) => 'keepAwake' in e).map((e) => e.keepAwake).slice(0, 1), [true])
  assert.equal(events.filter((e) => 'keepAwake' in e).at(-1).keepAwake, false)
  const last = events.filter((e) => e.state === 'uploading').at(-1)
  assert.equal(last.totalBytes, prepared.scan.totalBytes)
})

test('pause keeps the job; a restarted companion resumes only the missing chunks', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const first = controllerFor(h, jobs)
  const found = await first.c.gameFromFolder(game)
  let acked = 0
  h.hooks.nvmpChunk = async () => { await sleep(5) }
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpChunk' && ++acked === 1) void first.c.pause()
    return out
  }
  await first.c.upload('srv-1', found.id)
  assert.equal(first.c.snapshot().state, 'paused')
  const saved = jobs.load()
  assert.equal(saved.serverId, 'srv-1'); assert.equal(saved.gameId, found.id); assert.equal(saved.serverName, 'My NV:MP')
  const status = hostApi.nvmpSetupStatus(h.dir)
  assert.equal(status.phase, 'uploading')
  assert.ok(status.receivedBytes > 0 && status.receivedBytes < status.totalBytes, 'partially uploaded')
  const before = chunks(h)
  assert.ok(before < 9)

  // a fresh controller knows nothing but the saved job, like the app after a restart
  const second = controllerFor(h, jobs)
  assert.deepEqual(second.c.pending(), { serverId: 'srv-1', serverName: 'My NV:MP', gameId: found.id, gameRoot: saved.gameRoot, startedAt: saved.startedAt })
  h.ask = realAsk; h.hooks = {}
  await second.c.upload('srv-1', found.id)
  assert.equal(second.c.snapshot().state, 'ready')
  assert.equal(chunks(h) - before, 9 - before, 'only the missing chunks were sent again')
  assert.equal(second.c.pending(), null)
})

test('changed files cannot resume: the player is told, discards, and uploads again', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  const found = await c.gameFromFolder(game)
  h.hooks.nvmpChunk = async () => { await c.pause() }
  await c.upload('srv-1', found.id)
  assert.equal(c.snapshot().state, 'paused')
  h.hooks = {}
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(join(data, 'Mod.esp'), later, later)
  const failed = await issueOf(c.upload('srv-1', found.id))
  assert.equal(failed.issue, 'selection-differs')
  assert.equal(c.snapshot().state, 'error'); assert.equal(c.snapshot().issue, 'selection-differs')
  await c.discard('srv-1')
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'waiting')
  assert.equal(jobs.load(), null)
  assert.equal(c.snapshot().state, 'idle')
  await c.upload('srv-1', found.id)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
})

test('a load order the host refuses keeps the files; fixing it finishes without re-sending', async () => {
  const h = host(), { game } = gameFolder(), { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  await c.prepare(found.id)
  let refuse = true
  h.hooks.nvmpFinish = () => refuse ? new Error("NV:MP Data is missing Mod.esp. Match the filename case and the clients' load order.") : undefined
  const failed = await issueOf(c.upload('srv-1', found.id))
  assert.equal(failed.issue, 'load-order')
  assert.match(failed.message, /do not need to be sent again/)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'uploading')
  assert.throws(() => c.setLoadOrder('Mod.esp\r\n'), /FalloutNV\.esm/)
  const fixed = c.setLoadOrder('falloutnv.esm\nMOD.ESP\n')
  assert.deepEqual(fixed.plugins, ['FalloutNV.esm', 'Mod.esp'])
  refuse = false
  const sent = chunks(h)
  await c.upload('srv-1', found.id)
  assert.equal(chunks(h), sent, 'no chunk was sent again')
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')
})

test('gates: a running server, no edit rights and an offline host are refused before any upload', async () => {
  const { game } = gameFolder()
  const running = host(); running.state = 'running'
  let { c } = controllerFor(running)
  const found = await c.gameFromFolder(game)
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'not-stopped')
  assert.ok(!running.calls.includes('nvmpBegin'))
  await c.command('srv-1', 'stop')
  assert.deepEqual(running.commands, ['stop'])

  const viewer = host({ canShare: false }); ({ c } = controllerFor(viewer)); await c.gameFromFolder(game)
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'no-access')

  const offline = host(); offline.online = false; ({ c } = controllerFor(offline)); await c.gameFromFolder(game)
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'host-offline')
  assert.deepEqual(offline.calls, [])

  const silent = host(); ({ c } = controllerFor(silent)); await c.gameFromFolder(game)
  silent.hooks.nvmpBegin = () => new Error('No answer from the machine hosting this server — is the launcher running?')
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'host-offline')
})

test('start is refused until setup is ready, then queues a start command', async () => {
  const h = host(), { game } = gameFolder(), { c } = controllerFor(h)
  await assert.rejects(c.command('srv-1', 'start'), /Finish setting up/)
  const found = await c.gameFromFolder(game)
  await c.upload('srv-1', found.id)
  await c.command('srv-1', 'start')
  assert.deepEqual(h.commands, ['start'])
  await c.command('srv-1', 'start')
  assert.deepEqual(h.commands, ['start'], 'a running server is not started twice')
})

test('an interrupted commit is finished, not re-begun', async () => {
  const h = host(), { game } = gameFolder(), { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  h.hooks.nvmpFinish = () => new Error('disk hiccup')
  await issueOf(c.upload('srv-1', found.id))
  const state = JSON.parse(fs.readFileSync(join(h.dir, '.nvmp-upload', 'state.json'), 'utf8'))
  fs.writeFileSync(join(h.dir, '.nvmp-upload', 'state.json'), JSON.stringify({ ...state, phase: 'committing' }))
  h.hooks = {}; h.calls.length = 0
  await c.upload('srv-1', found.id)
  assert.ok(!h.calls.includes('nvmpBegin'))
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
})

test('job store survives garbage and round-trips the resume record', () => {
  const file = join(temp(), 'upload-job.json')
  assert.equal(jobStore.loadJob(file), null)
  fs.writeFileSync(file, '{not json'); assert.equal(jobStore.loadJob(file), null)
  fs.writeFileSync(file, JSON.stringify({ serverId: 'x' })); assert.equal(jobStore.loadJob(file), null)
  const job = { serverId: 's', serverName: 'S', gameId: 'steam:c:\\g', gameRoot: 'C:\\g', startedAt: 5, loadOrderText: 'FalloutNV.esm\n' }
  jobStore.saveJob(job, file)
  assert.deepEqual(jobStore.loadJob(file), { ...job, mo2Profile: undefined, mo2Instance: undefined, userId: undefined, session: undefined, allowedLinks: undefined, finishedEdit: undefined })
  // the account, the host session and the consented links survive a restart
  const full = { ...job, mo2Profile: 'P', mo2Instance: 'C:\\mo2', userId: 'u-1', session: '0b6c1f3e-2f6e-4f7e-9a51-3c2d9a7b1e44', allowedLinks: ['Textures/x -> D:\\x'] }
  jobStore.saveJob(full, file)
  assert.deepEqual(jobStore.loadJob(file), { ...full, finishedEdit: undefined })
  fs.writeFileSync(file, JSON.stringify({ ...full, allowedLinks: [1], session: 7 }))
  assert.deepEqual(jobStore.loadJob(file), { ...full, allowedLinks: undefined, session: undefined, finishedEdit: undefined })
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  jobStore.clearJob(file); jobStore.clearJob(file)
  assert.equal(jobStore.loadJob(file), null)
  process.env.TEST_USERDATA = temp()
  assert.equal(jobStore.jobFile('0b6c1f3e-2f6e-4f7e-9a51-3c2d9a7b1e44'), join(process.env.TEST_USERDATA, 'upload-job-0b6c1f3e-2f6e-4f7e-9a51-3c2d9a7b1e44.json'))
  assert.match(jobStore.jobFile('../../x'), /upload-job-[0-9a-f]{32}\.json$/, 'an id that is not a plain name is hashed')
  const full2 = { ...full, finishedEdit: '' }
  jobStore.saveJob(full2, file)
  assert.deepEqual(jobStore.loadJob(file), full2, 'the edit a finish was sent with survives a restart (an empty one too)')
})

// ---------- relay and server list against a scripted Supabase client ----------

function fakeClient(tables) {
  const log = []
  const from = (table) => {
    const q = { table, filters: [], op: 'select' }
    const run = () => { log.push(q); return tables[table](q) }
    const chain = {
      select(cols) { if (q.op !== 'insert') q.op = 'select'; q.cols = cols; return chain },
      insert(row) { q.op = 'insert'; q.row = row; return chain },
      eq(k, v) { q.filters.push(['eq', k, v]); return chain },
      in(k, v) { q.filters.push(['in', k, v]); return chain },
      single() { return Promise.resolve(run()) },
      maybeSingle() { return Promise.resolve(run()) },
      then(ok, bad) { return Promise.resolve(run()).then(ok, bad) }
    }
    return chain
  }
  return { from, log }
}

test('relay: inserts the panel row shape, polls until done, surfaces host errors and offline timeouts', async () => {
  let polls = 0, response = { done: false }
  const client = fakeClient({
    server_requests: (q) => q.op === 'insert' ? { data: { id: 'req-1' }, error: null } : (++polls, { data: polls < 2 ? { done: false } : response, error: null })
  })
  response = { done: true, response: { phase: 'waiting' } }
  const ask = relay.makeAsk({ serverId: 's1', ownerId: 'host' }, 'me', client)
  assert.deepEqual(await ask('nvmpStatus', {}), { phase: 'waiting' })
  const insert = client.log.find((q) => q.op === 'insert')
  assert.deepEqual(insert.row, { server_id: 's1', owner_id: 'host', requester_id: 'me', action: 'nvmpStatus', params: {} })
  assert.ok(polls >= 2)

  polls = 0; response = { done: true, error: 'Stop the server before uploading or replacing its game files.' }
  await assert.rejects(ask('nvmpBegin', { files: [] }), /^Error: Stop the server/)

  const ownerless = relay.makeAsk({ serverId: 's1', ownerId: '' }, 'me', client)
  polls = 0; response = { done: true, response: 1 }
  await ownerless('info'); assert.equal(client.log.filter((q) => q.op === 'insert').at(-1).row.owner_id, 'me')

  const realNow = Date.now; let skew = 0
  Date.now = () => realNow() + skew
  try {
    const never = fakeClient({ server_requests: (q) => q.op === 'insert' ? { data: { id: 'r' }, error: null } : ((skew += 30_000), { data: { done: false }, error: null }) })
    await assert.rejects(relay.sendRequest(never, 's', 'o', 'me', 'info'), /No answer from the machine hosting this server/)
  } finally { Date.now = realNow }
  await assert.rejects(relay.sendRequest(client, '', 'o', 'me', 'info'), /No server selected/)
})

test('relay: commands carry the primed sender name', async () => {
  const client = fakeClient({
    profiles: () => ({ data: { username: 'Courier6' }, error: null }),
    server_commands: () => ({ error: null })
  })
  await relay.primeSenderName(client, 'me')
  await relay.queueCommand(client, 's1', 'host', 'me', 'start')
  assert.deepEqual(client.log.find((q) => q.table === 'server_commands').row, { server_id: 's1', owner_id: 'host', sender_id: 'me', sender_name: 'Courier6', action: 'start', payload: '' })
  const failing = fakeClient({ server_commands: () => ({ error: { message: 'permission denied' } }) })
  await assert.rejects(relay.queueCommand(failing, 's1', 'host', 'me', 'stop'), /permission denied/)
})

test('servers: owned + shared NV:MP rows, offline hosts, and per-host phase/edit checks', async () => {
  const fresh = new Date().toISOString(), old = new Date(Date.now() - 5 * 60_000).toISOString()
  const rows = {
    own: { server_id: 'own', owner_id: 'me', game: 'nvmp', name: 'Zeta', state: 'stopped', updated_at: fresh },
    mc: { server_id: 'mc', owner_id: 'me', game: 'minecraft', name: 'MC', state: 'running', updated_at: fresh },
    rent: { server_id: 'rent', owner_id: 'host', game: 'nvmp', name: 'Alpha', state: 'weird', updated_at: fresh },
    gone: { server_id: 'gone', owner_id: 'host', game: 'nvmp', name: 'Mid', state: 'running', updated_at: old }
  }
  const client = fakeClient({
    server_status: (q) => {
      const [kind, , value] = q.filters[0]
      if (kind === 'in') return { data: value.map((id) => rows[id]), error: null }
      if (q.filters[0][1] === 'server_id') return { data: rows[value] ?? null, error: null }
      return { data: [rows.own, rows.mc], error: null }
    },
    server_shares: () => ({ data: [{ server_id: 'rent' }, { server_id: 'gone' }, { server_id: 'own' }], error: null })
  })
  const asked = []
  const list = await servers.listServers(client, 'me', (s) => async (action) => {
    asked.push(`${s.serverId}:${action}`)
    if (s.serverId === 'own' && action === 'info') throw new Error('No answer')
    return action === 'info' ? { canShare: s.serverId === 'rent' } : { phase: s.serverId === 'rent' ? 'waiting' : 'ready' }
  })
  assert.deepEqual(list.map((s) => s.name), ['Alpha', 'Mid', 'Zeta'])
  const [alpha, mid, zeta] = list
  assert.deepEqual(alpha, { serverId: 'rent', ownerId: 'host', name: 'Alpha', state: 'stopped', hostOnline: true, phase: 'waiting', canEdit: true })
  assert.deepEqual(mid, { serverId: 'gone', ownerId: 'host', name: 'Mid', state: 'running', hostOnline: false, phase: 'unknown' })
  assert.equal(zeta.phase, 'ready'); assert.equal(zeta.canEdit, undefined)
  assert.ok(!asked.some((a) => a.startsWith('gone:')), 'an offline host is not asked')
  assert.equal((await servers.getServer(client, 'rent')).name, 'Alpha')
  assert.equal(await servers.getServer(client, 'mc'), null)
  assert.equal(servers.hostOnline(null), true)
})

test('host heartbeats are judged by the cloud\'s clock, so a PC clock running fast does not make every host look offline', async () => {
  // one bundle, so the server list reads the same clock the cloud client sets, as in the app
  const file = join(root, 'bundle-clock', 'clock.js')
  await build({
    stdin: { contents: "export * as clock from '@companion/main/cloudClock'\nexport * as list from '@companion/main/servers'", resolveDir: repo, loader: 'ts', sourcefile: 'clock-entry.ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: file, logLevel: 'error', plugins: [aliasPlugin], external: ['@supabase/supabase-js']
  })
  const { clock, list } = require(file)
  const pcNow = Date.now(), beat = (ms) => new Date(pcNow - ms).toISOString()
  // this PC runs 5 minutes fast; the host wrote its row 5 s ago by the cloud's clock
  assert.equal(list.hostOnline(beat(305_000), pcNow), false, 'by the PC\'s own clock it looks offline')
  clock.noteServerDate(new Date(pcNow - 300_000).toUTCString(), pcNow)
  assert.equal(list.hostOnline(beat(305_000)), true)
  assert.equal(list.hostOnline(beat(300_000 + 61_000)), false, 'a host silent for over a minute is still offline')
  clock.noteServerDate('not a date'); clock.noteServerDate(null)
  assert.ok(Math.abs(clock.cloudNow(pcNow) - (pcNow - 300_000)) < 1000, 'an unreadable header leaves the clock alone')

  // every answer the cloud client gets sets the clock
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('[]', { headers: { date: new Date(Date.now() + 120_000).toUTCString() } })
  try { await (await clock.clockedFetch('https://companion-test.invalid/rest/v1/server_status')).text() } finally { globalThis.fetch = realFetch }
  assert.ok(Math.abs(clock.cloudNow() - (Date.now() + 120_000)) < 2000)
  assert.match(fs.readFileSync(join(repo, 'companion/main/cloud.ts'), 'utf8'), /createClient\([^)]*global: \{ fetch: clockedFetch \}/s, 'the Supabase client uses it')
})

// ---------- lost finishes, retries, sign-out and saved jobs ----------

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) assert.fail('timed out waiting')
    await sleep(5)
  }
}
/** Pause the controller right after the first chunk this run gets acknowledged; returns an undo. */
function pauseAfterFirstChunk(h, ctl) {
  let n = 0
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpChunk' && ++n === 1) void ctl.pause()
    return out
  }
  return () => { h.ask = realAsk }
}

test('a finish the host carried out but whose answer was lost is recognised after a restart, not uploaded again', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const first = controllerFor(h, jobs, { retry: { delaysMs: [1], forMs: 0 } })
  const found = await first.c.gameFromFolder(game)
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish') throw new Error(HOST_SILENT) // committed on the host, answer lost on the way back
    return out
  }
  assert.equal((await issueOf(first.c.upload('srv-1', found.id))).issue, 'host-offline')
  const host1 = hostApi.nvmpSetupStatus(h.dir)
  assert.equal(host1.phase, 'ready', 'the host did finish')
  assert.equal(jobs.load().session, host1.session, 'the job knows the session it started')
  assert.equal(jobs.load().userId, 'renter')

  h.ask = realAsk; h.calls.length = 0
  const second = controllerFor(h, jobs)
  await second.c.upload('srv-1', found.id)
  assert.equal(second.c.snapshot().state, 'ready')
  assert.deepEqual(h.calls, ['info', 'nvmpStatus'], 'no nvmpBegin, no chunk sent again')
  assert.equal(jobs.load(), null)
  assert.equal(second.c.pending(), null)
})

test('when the finish answer is lost mid-run, the automatic retry finds the upload done', async () => {
  const h = host(), { game } = gameFolder(), { c, events } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  const realAsk = h.ask
  let lost = 0
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish' && !lost++) throw new Error(HOST_SILENT)
    return out
  }
  await c.upload('srv-1', found.id)
  assert.equal(c.snapshot().state, 'ready')
  assert.equal(h.calls.filter((a) => a === 'nvmpBegin').length, 1)
  assert.equal(chunks(h), 9)
  assert.ok(events.some((e) => e.state === 'retrying' && e.retryReason === 'host'), 'a silent host is retried as the host, not the connection')
})

test('the edited load order survives two restarts and is what the finish sends', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs()
  fs.writeFileSync(join(data, 'Extra.esp'), randomBytes(2000))
  const edit = 'FalloutNV.esm\r\nExtra.esp\r\nMod.esp\r\n'
  const first = controllerFor(h, jobs)
  const found = await first.c.gameFromFolder(game)
  await first.c.prepare(found.id)
  assert.equal(first.c.setLoadOrder(edit).edited, true)
  let undo = pauseAfterFirstChunk(h, first.c)
  await first.c.upload('srv-1', found.id); undo()
  assert.equal(jobs.load().loadOrderText, edit)

  const second = controllerFor(h, jobs)
  undo = pauseAfterFirstChunk(h, second.c)
  await second.c.upload('srv-1', found.id); undo()
  assert.equal(second.c.snapshot().state, 'paused')
  assert.equal(jobs.load().loadOrderText, edit, 'a resume after a restart keeps the edit in the job')

  const third = controllerFor(h, jobs)
  await third.c.upload('srv-1', found.id)
  assert.equal(third.c.snapshot().state, 'ready')
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), edit)
})

test('an edit that stopped fitting is never silently replaced: the finish asks for a fix, Check shows it was dropped', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  fs.writeFileSync(join(data, 'Extra.esp'), randomBytes(2000))
  const found = await c.gameFromFolder(game)
  await c.prepare(found.id)
  c.setLoadOrder('FalloutNV.esm\r\nExtra.esp\r\nMod.esp\r\n')
  fs.rmSync(join(data, 'Extra.esp'))
  const failed = await issueOf(c.upload('srv-1', found.id))
  assert.equal(failed.issue, 'load-order')
  assert.match(failed.message, /no longer fits your files/)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'uploading', 'every file was sent; only the finish waits')
  assert.ok(jobs.load().loadOrderText.includes('Extra.esp'), 'kept, not dropped')
  const sent = chunks(h)
  const checked = await c.prepare(found.id)
  assert.equal(checked.loadOrder.edited, false)
  assert.match(checked.loadOrder.warnings[0], /no longer fits these files/)
  assert.equal(jobs.load().loadOrderText, undefined)
  await c.upload('srv-1', found.id)
  assert.equal(chunks(h), sent, 'no file sent again')
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')
})

test('a kept edit is flagged, warns about plugins switched on since, and "Use plugins.txt again" drops it', async () => {
  const h = host(), { game, data } = gameFolder(), { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  assert.equal((await c.prepare(found.id)).loadOrder.edited, false)
  c.setLoadOrder('FalloutNV.esm\r\nMod.esp\r\n')
  fs.writeFileSync(join(data, 'NewMod.esp'), randomBytes(1000))
  fs.appendFileSync(join(process.env.LOCALAPPDATA, 'FalloutNV', 'plugins.txt'), 'NewMod.esp\r\n')
  const again = await c.prepare(found.id)
  assert.equal(again.loadOrder.edited, true)
  assert.deepEqual(again.loadOrder.plugins, ['FalloutNV.esm', 'Mod.esp'])
  assert.ok(again.loadOrder.warnings.some((w) => /NewMod\.esp/.test(w) && /leaves out/.test(w)), again.loadOrder.warnings.join(' | '))
  const fresh = await c.useGameLoadOrder()
  assert.equal(fresh.edited, false)
  assert.deepEqual(fresh.plugins, ['FalloutNV.esm', 'Mod.esp', 'NewMod.esp'])
  assert.equal((await c.prepare(found.id)).loadOrder.edited, false, 'the edit is gone')
  // an edit belongs to its upload: once that finishes, the next check starts from plugins.txt again
  c.setLoadOrder('FalloutNV.esm\r\nNewMod.esp\r\nMod.esp\r\n')
  await c.upload('srv-1', found.id)
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nNewMod.esp\r\nMod.esp\r\n')
  assert.equal((await c.prepare(found.id)).loadOrder.edited, false)
})

test('a file that changes mid-upload stops every worker at once; Upload again re-scans and offers Discard and start again', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  fs.writeFileSync(join(data, 'A.esp'), randomBytes(1000)) // Data/A.esp is the first chunk read; nine more follow
  const found = await c.gameFromFolder(game)
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpBegin') { const later = new Date(Date.now() + 120_000); fs.utimesSync(join(data, 'A.esp'), later, later) }
    return out
  }
  const failed = await issueOf(c.upload('srv-1', found.id))
  assert.equal(failed.issue, 'changed')
  assert.match(failed.message, /^Data\/A\.esp changed while it was being uploaded/)
  assert.match(failed.message, /click Upload again/)
  assert.ok(chunks(h) < 4, `stopped at once, not after sending the other files (${chunks(h)} chunks sent)`)
  assert.equal(c.snapshot().state, 'error')
  h.ask = realAsk
  const again = await issueOf(c.upload('srv-1', found.id))
  assert.equal(again.issue, 'selection-differs')
  assert.match(again.message, /Discard the unfinished upload and start again/)
  await c.discard('srv-1')
  await c.upload('srv-1', found.id)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
})

test('discard still works when the host cannot read its upload progress', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  const found = await c.gameFromFolder(game)
  h.hooks.nvmpChunk = async () => { await c.pause() }
  await c.upload('srv-1', found.id)
  h.hooks = {}
  const { session } = hostApi.nvmpSetupStatus(h.dir)
  assert.equal(jobs.load().session, session)
  fs.writeFileSync(join(h.dir, '.nvmp-upload', session, '0.bits'), Buffer.alloc(0)) // cut short by a crash
  assert.throws(() => hostApi.nvmpSetupStatus(h.dir), /damaged/)
  await c.discard('srv-1')
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'waiting')
  assert.equal(jobs.load(), null)
})

test('a dropped connection waits, retries with fresh bitmaps, and Retry now skips the wait; a long outage names the connection', async () => {
  const h = host(), { game } = gameFolder()
  const { c, events } = controllerFor(h, memoryJobs(), { retry: { delaysMs: [60_000], forMs: 600_000 } })
  const found = await c.gameFromFolder(game)
  let down = true
  h.hooks.nvmpChunk = () => (down ? offline() : undefined)
  const run = c.upload('srv-1', found.id)
  await waitFor(() => c.snapshot().state === 'retrying')
  const waiting = c.snapshot()
  assert.equal(waiting.retryReason, 'connection')
  assert.ok(waiting.retryAt > Date.now() + 30_000, 'waits as long as the backoff says')
  assert.equal(waiting.running, true)
  assert.match(flow.retryLine(waiting, Date.now()), /^Connection lost — retrying in \d+ s$/)
  down = false
  c.retryNow()
  await run
  assert.equal(c.snapshot().state, 'ready')
  assert.equal(h.calls.filter((a) => a === 'nvmpBegin').length, 2, 'nvmpBegin again with the same manifest for fresh bitmaps')
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
  assert.ok(events.filter((e) => 'keepAwake' in e).some((e) => e.keepAwake), 'the PC stays awake through the retries')

  // pausing while waiting pauses at once
  const p = host()
  const paused = controllerFor(p, memoryJobs(), { retry: { delaysMs: [60_000], forMs: 600_000 } })
  await paused.c.gameFromFolder(game)
  p.hooks.nvmpChunk = () => offline()
  const pausing = paused.c.upload('srv-1', found.id)
  await waitFor(() => paused.c.snapshot().state === 'retrying')
  await paused.c.pause()
  await pausing
  assert.equal(paused.c.snapshot().state, 'paused')

  // an outage longer than the retry window stops, blaming the connection rather than the host
  const g = host()
  const { c: gaveUp } = controllerFor(g, memoryJobs(), { retry: { delaysMs: [5], forMs: 60 } })
  await gaveUp.gameFromFolder(game)
  g.hooks.nvmpChunk = () => offline()
  const failed = await issueOf(gaveUp.upload('srv-1', found.id))
  assert.equal(failed.issue, 'connection')
  assert.ok(failed.message.startsWith(OFFLINE_MESSAGE), failed.message)
  assert.ok(g.calls.filter((a) => a === 'nvmpBegin').length >= 2, 'it did retry before giving up')
})

test('the relay tells a lost connection from a silent host, and maps network and RLS failures', async () => {
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  try {
    const cut = fakeClient({ server_requests: (q) => q.op === 'insert' ? { data: { id: 'r' }, error: null } : ((skew += 30_000), { data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }) })
    await assert.rejects(relay.sendRequest(cut, 's', 'o', 'me', 'info'), (e) => e.message === OFFLINE_MESSAGE && relay.isNetworkError(e))
    const silent = fakeClient({ server_requests: (q) => q.op === 'insert' ? { data: { id: 'r' }, error: null } : ((skew += 30_000), { data: { done: false }, error: null }) })
    await assert.rejects(relay.sendRequest(silent, 's', 'o', 'me', 'info'), { message: HOST_SILENT })
  } finally { Date.now = realNow }
  const noInsert = fakeClient({ server_requests: () => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }) })
  await assert.rejects(relay.sendRequest(noInsert, 's', 'o', 'me', 'info'), { message: OFFLINE_MESSAGE })
  const denied = fakeClient({ server_requests: () => ({ data: null, error: { message: 'new row violates row-level security policy for table "server_requests"', code: '42501' }, status: 403 }) })
  await assert.rejects(relay.sendRequest(denied, 's', 'o', 'me', 'info'), (e) => e.code === relay.DENIED_CODE)
  for (const text of ['connect ECONNREFUSED 10.0.0.1:443', 'getaddrinfo ENOTFOUND x.supabase.co', 'Connect Timeout Error', 'fetch failed']) {
    assert.equal(relay.isNetworkError(new Error(text)), true, text)
  }
  assert.equal(relay.isNetworkError({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }), true)
  assert.equal(relay.isNetworkError(new Error('Stop the server before uploading or replacing its game files.')), false)
  assert.equal(relay.isNetworkError(new Error(HOST_SILENT)), false)
})

test('the saved job holds its server, belongs to its account only, and can be forgotten when its server is gone', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const a = controllerFor(h, jobs)
  const found = await a.c.gameFromFolder(game)
  h.hooks.nvmpChunk = async () => { await a.c.pause() }
  await a.c.upload('srv-1', found.id); h.hooks = {}
  // canDiscard: the job holds the host's session, so it can be discarded even if the host cannot report its progress
  assert.deepEqual(a.c.snapshot().lock, { serverId: 'srv-1', serverName: 'My NV:MP', canDiscard: true })
  await assert.rejects(a.c.upload('srv-2', found.id), /upload to My NV:MP is not finished/)

  // another account on this PC sees nothing of it, and the state it had is cleared
  a.c.setAccount('someone-else')
  const cleared = a.c.snapshot()
  assert.equal(cleared.state, 'idle'); assert.equal(cleared.serverId, undefined); assert.equal(cleared.lock, null)
  assert.equal(a.c.pending(), null)
  const b = controllerFor(h, jobs, { account: 'someone-else' })
  assert.equal(b.c.pending(), null); assert.equal(b.c.snapshot().lock, null)
  // signing out clears it too; the first account still has its job after signing back in
  a.c.setAccount(null)
  assert.equal(a.c.pending(), null)
  a.c.setAccount('renter')
  assert.equal(a.c.pending().serverId, 'srv-1')

  // the server is gone: the upload says so and Forget lets the player move on
  h.gone = true
  const gone = await issueOf(a.c.upload('srv-1', found.id))
  assert.equal(gone.issue, 'server-gone')
  assert.match(gone.message, /Forget this upload/)
  a.c.forget()
  assert.equal(a.c.pending(), null); assert.equal(jobs.load(), null); assert.equal(a.c.snapshot().lock, null)
})

test('signing out mid-upload stops it and shows the next account nothing; an expired sign-in is its own issue', async () => {
  const h = host(), { game } = gameFolder(), { c, who } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  let release
  const gate = new Promise((r) => { release = r })
  h.hooks.nvmpChunk = async () => { await gate }
  const run = c.upload('srv-1', found.id)
  await waitFor(() => h.calls.includes('nvmpChunk'))
  c.setAccount(null)
  release(); await run
  assert.equal(c.snapshot().state, 'idle'); assert.equal(c.snapshot().lock, null); assert.equal(c.snapshot().serverId, undefined)

  h.hooks = {}
  who.account = null
  const expired = await issueOf(c.upload('srv-1', found.id))
  assert.equal(expired.issue, 'signed-out'); assert.equal(expired.message, SIGNED_OUT_MESSAGE)
  // a refused row is a lost sign-in when the account check fails too, else lost access
  who.account = 'renter'; c.setAccount('renter')
  h.hooks.nvmpBegin = () => Object.assign(new Error('This server is no longer shared with your account, or your sign-in expired.'), { code: relay.DENIED_CODE })
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'no-access')
  h.hooks.nvmpBegin = () => { who.account = null; return Object.assign(new Error('denied'), { code: relay.DENIED_CODE }) }
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'signed-out')
})

test('pausing is its own state until pieces in flight land; a second Resume joins the first instead of failing', async () => {
  const h = host(), { game } = gameFolder(), { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  let release
  const gate = new Promise((r) => { release = r })
  h.hooks.nvmpChunk = async () => { await gate }
  const run = c.upload('srv-1', found.id)
  await waitFor(() => h.calls.includes('nvmpChunk'))
  await c.pause()
  const settling = c.snapshot()
  assert.equal(settling.state, 'pausing'); assert.equal(settling.running, true)
  assert.match(settling.message, /Finishing the pieces already on their way \(up to a minute\)/)
  assert.equal(flow.canResume(settling), false)
  release(); await run
  assert.equal(c.snapshot().state, 'paused'); assert.equal(flow.canResume(c.snapshot()), true)
  h.hooks = {}
  await Promise.all([c.upload('srv-1', found.id), c.upload('srv-1', found.id)])
  assert.equal(c.snapshot().state, 'ready')
})

test('files reached through a link outside the game upload only with the player\'s consent, kept for the job', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  const elsewhere = temp()
  fs.writeFileSync(join(elsewhere, 'notes.txt'), 'outside')
  fs.symlinkSync(elsewhere, join(data, 'Textures', 'extra'), 'junction')
  const found = await c.gameFromFolder(game)
  const prepared = await c.prepare(found.id)
  assert.equal(prepared.scan.outsideLinks.length, 1)
  const [link] = prepared.scan.outsideLinks
  assert.equal(link.rel, 'Textures/extra')
  const refused = await issueOf(c.upload('srv-1', found.id))
  assert.equal(refused.issue, 'links')
  assert.match(refused.message, /outside your game/)
  assert.ok(refused.message.includes('Data/Textures/extra'))
  assert.ok(!h.calls.includes('nvmpBegin'), 'nothing was begun without consent')
  // with consent for exactly the links shown; then a pause: the resume after a restart needs no second consent for the same links
  h.hooks.nvmpChunk = async () => { await c.pause() }
  await c.upload('srv-1', found.id, { approvedLinks: prepared.scan.outsideLinks }); h.hooks = {}
  assert.deepEqual(jobs.load().allowedLinks, [`Textures/extra -> ${link.target}`])
  const later = controllerFor(h, jobs)
  await later.c.upload('srv-1', found.id)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
  assert.equal(fs.readFileSync(join(h.dir, 'Data', 'Textures', 'extra', 'notes.txt'), 'utf8'), 'outside')
})

test('an archived server is refused for uploads and commands', async () => {
  const h = host(), { game } = gameFolder()
  h.state = 'archived'
  const { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  const refused = await issueOf(c.upload('srv-1', found.id))
  assert.equal(refused.issue, 'no-access'); assert.match(refused.message, /This server is archived\. Ask your host to restore it/)
  assert.deepEqual(h.calls, [], 'refused from the server row, before asking a host that refuses info for archived servers')
  await assert.rejects(c.command('srv-1', 'stop'), /archived/)
  await assert.rejects(c.discard('srv-1'), /archived/)
  assert.deepEqual(h.commands, [])
  // the row still says stopped (it lags), the host already refuses as archived: the same next step, not a looping Resume
  h.state = 'stopped'; h.archivedOnHost = true
  const lagging = await issueOf(c.upload('srv-1', found.id))
  assert.equal(lagging.issue, 'no-access'); assert.match(lagging.message, /archived/)
})

test('a failed share lookup is an error, not "no servers"; offline reads as offline', async () => {
  const sharesFail = fakeClient({
    server_status: () => ({ data: [], error: null }),
    server_shares: () => ({ data: null, error: { message: 'permission denied for table server_shares', code: '42501' }, status: 403 })
  })
  await assert.rejects(servers.listServers(sharesFail, 'me', () => async () => ({})), /no longer shared|permission denied/)
  const off = fakeClient({
    server_status: () => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }),
    server_shares: () => ({ data: [], error: null })
  })
  await assert.rejects(servers.listServers(off, 'me', () => async () => ({})), { message: OFFLINE_MESSAGE })
  await assert.rejects(servers.getServer(off, 'x'), { message: OFFLINE_MESSAGE })
})

test('sign-out removes the stored session even when the cloud cannot be told; an expired sign-in is refused plainly', async () => {
  process.env.TEST_USERDATA = temp()
  const calls = [], warned = []
  const realFetch = globalThis.fetch, realWarn = console.warn, realError = console.error, realSetTimeout = globalThis.setTimeout
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('fetch failed') }
  console.warn = (...args) => warned.push(args.join(' '))
  console.error = () => {} // auth-js reports each failed refresh attempt
  // auth-js backs off for up to ~25 s between refresh attempts; the same attempts, without the waiting
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 2), ...args)
  try {
    const file = join(process.env.TEST_USERDATA, 'cloud-session.json')
    const now = Math.floor(Date.now() / 1000)
    // a laptop wakes offline, its access token expired two hours ago
    const stored = {
      access_token: 'header.payload.signature', refresh_token: 'refresh-token-1', token_type: 'bearer', expires_in: 3600, expires_at: now - 7200,
      user: { id: 'u-1', email: 'a@example.test', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
    }
    fs.writeFileSync(file, JSON.stringify({ 'sb-companion-test-auth-token': { value: JSON.stringify(stored), encrypted: false } }))
    // a refresh this PC could not send is "offline", not "signed out" (the session stays for later)
    await assert.rejects(cloud.session(), { message: OFFLINE_MESSAGE })
    assert.ok(fs.readFileSync(file, 'utf8').includes('refresh-token-1'))
    await cloud.signOut() // auth-js cannot load the session, so it keeps it on disk; the companion must not
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {})
    assert.equal(await cloud.session(), null)
    assert.ok(warned.some((w) => /Signed out on this PC/.test(w)), 'the failed revocation is only a warning')
    // anything that needs the account says so in the words the window matches
    await assert.rejects(cloud.requireAccount(), (e) => e.message === SIGNED_OUT_MESSAGE && cloud.isSignedOutError(e))
    // an offline sign-in reads as offline; auth wordings are explained
    await assert.rejects(cloud.signIn('a@example.test', 'pw'), { message: OFFLINE_MESSAGE })
    assert.equal(cloud.authErrorText({ name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 }), OFFLINE_MESSAGE)
    assert.match(cloud.authErrorText({ message: 'Email not confirmed' }), /^Confirm your email first/)
    assert.equal(cloud.authErrorText({ message: 'Invalid login credentials' }), 'That email and password do not match an eLauncher account.')
    assert.ok(calls.length > 0 && calls.every((u) => u.startsWith('https://companion-test.invalid/')), 'no request went anywhere real')
  } finally {
    globalThis.fetch = realFetch
    globalThis.setTimeout = realSetTimeout
    console.warn = realWarn
    console.error = realError
    try { await cloud.getClient().auth.stopAutoRefresh() } catch { /* not started */ }
  }
})

test('the window decides servers, Done, Resume and spoken progress', () => {
  const a = { serverId: 'a', ownerId: 'h', name: 'Courier co-op', state: 'stopped', hostOnline: true }
  const b = { ...a, serverId: 'b', name: 'Friends server' }
  const lock = { serverId: 'a', serverName: 'Courier co-op' }
  // an archived server is refused
  assert.match(flow.blockedReason({ ...a, state: 'archived' }), /archived/)
  assert.equal(flow.blockedReason(a), null)
  // the job's server holds the choice; Done is about the uploaded server only
  assert.match(flow.blockedReason(b, lock), /Your upload to Courier co-op is not finished/)
  assert.equal(flow.blockedReason(a, lock), null)
  assert.equal(flow.chosenServer([a, b], b, lock), a)
  assert.equal(flow.chosenServer([a, b], b, null), b)
  assert.equal(flow.chosenServer([b], b, lock), null, 'a held server that is gone is not swapped for another')
  const ready = { state: 'ready', serverId: 'a', sentBytes: 1, totalBytes: 1 }
  assert.equal(flow.doneServer(b, ready), null)
  assert.equal(flow.doneServer(a, ready), a)
  assert.equal(flow.doneServer({ ...b, phase: 'ready' }, ready).serverId, 'b')
  // Resume waits for a pause to settle
  assert.equal(flow.canResume({ state: 'paused', running: true, sentBytes: 0, totalBytes: 0 }), false)
  assert.equal(flow.canResume({ state: 'paused', running: false, sentBytes: 0, totalBytes: 0 }), true)
  // the spoken line changes only in 5 % steps and on state changes
  const lines = new Set()
  for (let sent = 0; sent <= 1000; sent += 7) lines.add(flow.spokenProgress({ state: 'uploading', sentBytes: sent, totalBytes: 1000 }))
  assert.equal(lines.size, 20)
  assert.equal(flow.spokenProgress({ state: 'uploading', sentBytes: 123, totalBytes: 1000 }), 'Uploading: 10%')
  assert.equal(flow.spokenProgress({ state: 'retrying', retryReason: 'host', sentBytes: 1, totalBytes: 2 }), 'The server’s host is not answering, retrying')
  assert.equal(flow.retryLine({ state: 'retrying', retryReason: 'connection', retryAt: 10_500, sentBytes: 0, totalBytes: 0 }, 0), 'Connection lost — retrying in 11 s')
  assert.equal(flow.isSignedOut(new Error(SIGNED_OUT_MESSAGE)), true)
  // no live region on the per-tick card; multi-line notices keep their lines
  const step = fs.readFileSync(join(repo, 'companion/renderer/src/steps/UploadStep.tsx'), 'utf8')
  assert.equal((step.match(/aria-live/g) ?? []).length, 1)
  assert.match(step, /className="sr-only" aria-live="polite"/)
  const css = fs.readFileSync(join(repo, 'companion/renderer/src/styles.css'), 'utf8')
  assert.match(css, /\.formerr,\s*\.formwarn,\s*\.formnote\s*\{\s*white-space: pre-line;/)
})

/** The window's real step components, bundled once for server-side rendering. */
let windowBundle = null
function windowUi() {
  windowBundle ??= (async () => {
    const bundle = join(root, 'bundle-window', 'steps.js')
    await build({
      stdin: {
        contents: [
          "export { renderToStaticMarkup } from 'react-dom/server'",
          "export { createElement } from 'react'",
          `export { UploadStep } from ${JSON.stringify(`${repo}/companion/renderer/src/steps/UploadStep.tsx`)}`,
          `export { ServerStep } from ${JSON.stringify(`${repo}/companion/renderer/src/steps/ServerStep.tsx`)}`,
          `export { CheckStep, linkPlaces } from ${JSON.stringify(`${repo}/companion/renderer/src/steps/CheckStep.tsx`)}`,
          `export { DoneStep } from ${JSON.stringify(`${repo}/companion/renderer/src/steps/DoneStep.tsx`)}`,
          `export { SignIn, OfflineStart } from ${JSON.stringify(`${repo}/companion/renderer/src/steps/SignIn.tsx`)}`
        ].join('\n'),
        resolveDir: repo, loader: 'ts', sourcefile: 'steps-entry.ts'
      },
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'error', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, plugins: [aliasPlugin]
    })
    globalThis.window ??= { companion: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
    return require(bundle)
  })()
  return windowBundle
}
const noop = () => {}, later = async () => {}
const buttonOf = (markup, label) => new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? ''
const courier = { serverId: 'a', ownerId: 'h', name: 'Courier co-op', state: 'stopped', hostOnline: true, phase: 'uploading', canEdit: true }
const uploadProps = (progress, server = courier) => ({
  server, progress, actionError: '', onPause: noop, onResume: noop, onRetryNow: noop, onStop: later, onDiscard: later,
  onDiscardAndRestart: later, onForget: later, onEditLoadOrder: noop, onBackToCheck: noop, onBackToServers: noop
})
/** Every live region in some markup (aria-live, role=status, role=alert), as plain text. */
const liveRegions = (markup) => [...markup.matchAll(/<(\w+)[^>]*(?:role="(?:status|alert)"|aria-live="[^"]+")[^>]*>(.*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())

test('window: the steps render their states (server-side render of the real components)', async () => {
  const ui = await windowUi()
  const html = (component, props) => ui.renderToStaticMarkup(ui.createElement(component, props))
  const server = courier

  // while pieces in flight land, Resume shows but waits, with the reason
  const pausing = html(ui.UploadStep, uploadProps({ state: 'pausing', running: true, sentBytes: 5, totalBytes: 10, message: 'Finishing the pieces already on their way (up to a minute)…' }))
  assert.match(buttonOf(pausing, 'Resume upload'), /disabled/)
  assert.match(pausing, /Finishing the pieces already on their way/)
  assert.equal(buttonOf(pausing, 'Pause'), '')
  assert.doesNotMatch(buttonOf(html(ui.UploadStep, uploadProps({ state: 'paused', running: false, sentBytes: 5, totalBytes: 10 })), 'Resume upload'), /disabled/)
  // the countdown and Retry now
  const retrying = html(ui.UploadStep, uploadProps({ state: 'retrying', running: true, retryReason: 'connection', retryAt: Date.now() + 15_000, sentBytes: 5, totalBytes: 10 }))
  assert.match(retrying, /Connection lost — retrying in 1[45] s/)
  assert.notEqual(buttonOf(retrying, 'Retry now'), '')
  // the per-tick card is not a live region; one coarse line is
  const uploading = html(ui.UploadStep, uploadProps({ state: 'uploading', running: true, sentBytes: 123, totalBytes: 1000, bytesPerSecond: 2e6, file: 'Data/x.bsa' }))
  assert.equal((uploading.match(/aria-live/g) ?? []).length, 1)
  assert.match(uploading, /<p class="sr-only" aria-live="polite" aria-atomic="true">Uploading: 10%<\/p>/)
  // a changed file, a server that is gone, a different selection: the matching next step
  assert.notEqual(buttonOf(html(ui.UploadStep, uploadProps({ state: 'error', issue: 'changed', sentBytes: 0, totalBytes: 0, message: 'x' })), 'Upload again'), '')
  assert.notEqual(buttonOf(html(ui.UploadStep, uploadProps({ state: 'error', issue: 'server-gone', sentBytes: 0, totalBytes: 0, message: 'x' })), 'Forget this upload'), '')
  assert.notEqual(buttonOf(html(ui.UploadStep, uploadProps({ state: 'error', issue: 'selection-differs', sentBytes: 0, totalBytes: 0, message: 'x' })), 'Discard and start again'), '')

  // the held server stays choosable, the others say why not; archived is refused
  const other = { ...server, serverId: 'b', name: 'Friends server', phase: 'ready' }
  const archived = { ...server, serverId: 'c', name: 'Old server', state: 'archived' }
  const serverProps = { servers: { list: [server, other, archived], loading: false, error: '' }, selected: server, busy: false,
    lock: { serverId: 'a', serverName: 'Courier co-op' }, pending: { serverId: 'a', serverName: 'Courier co-op', gameId: 'g', gameRoot: 'C:\\g', startedAt: 1 },
    onSelect: noop, onRefresh: noop, onContinue: noop, onResume: noop, onGoToUpload: noop, onForget: later }
  const choose = html(ui.ServerStep, serverProps)
  assert.match(choose, /Your upload to <b>Courier co-op<\/b> stopped before it finished/)
  assert.notEqual(buttonOf(choose, 'Forget this upload'), '')
  assert.match(choose, /<button type="button" class="choice" aria-pressed="false" disabled="">.*?Friends server.*?Your upload to Courier co-op is not finished/)
  assert.match(choose, /This server is archived/)
  const gone = html(ui.ServerStep, { ...serverProps, servers: { list: [other], loading: false, error: '' }, selected: null })
  assert.match(gone, /that server is no longer on this account/)
  assert.equal(buttonOf(gone, 'Resume upload'), '')

  // links outside the game are listed with a consent box; an edit says so and can be dropped
  const game = { id: 'g', root: 'C:\\g', data: 'C:\\g\\Data', source: 'manual', label: 'g', hasNvmpLauncher: true, supported: true, warnings: [] }
  const loadOrder = { plugins: ['FalloutNV.esm'], text: 'FalloutNV.esm\r\n', source: 'plugins.txt', warnings: [], edited: true }
  const prepared = { gameId: 'g', loadOrder, scan: { files: 3, totalBytes: 10, skippedExecutables: [], problems: [], outsideLinks: [{ rel: 'Textures/extra', target: 'D:\\Elsewhere' }] } }
  const check = html(ui.CheckStep, { server: { ...server, phase: 'waiting' }, game, prepared, progress: { state: 'idle', sentBytes: 0, totalBytes: 0 }, busy: false, editFirst: false,
    onPrepared: noop, onLoadOrder: noop, onUpload: noop, onStop: later, onDiscard: later, onChooseGame: noop })
  assert.match(check, /Data\/Textures\/extra → D:\\Elsewhere/)
  assert.match(check, /<input type="checkbox"\/><span>Upload these files from outside the game folder too<\/span>/)
  assert.match(buttonOf(check, 'Upload game files'), /disabled/, 'Upload waits for the box')
  assert.match(check, /Using your edited load order/)
  assert.notEqual(buttonOf(check, 'Use plugins.txt again'), '')

  // back at Sign in, the player is told why
  assert.match(html(ui.SignIn, { notice: SIGNED_OUT_MESSAGE, onSignedIn: noop }), /Your sign-in expired\. Sign in again\./)
})

test('window: every outside link the box approves is on screen, and the places they point to are summed up first', async () => {
  const ui = await windowUi()
  // 60 links into a mod manager's staging folder hide one personal folder among them
  const staged = Array.from({ length: 60 }, (_, i) => ({ rel: `Textures/pack${i}`, target: `E:\\Vortex\\falloutnv\\mod${i}\\Textures` }))
  const personal = { rel: 'Textures/pack60', target: 'C:\\Users\\Player\\Documents' }
  const outsideLinks = [...staged.slice(0, 30), personal, ...staged.slice(30)]
  assert.deepEqual(ui.linkPlaces(outsideLinks), [{ place: 'E:\\Vortex\\falloutnv\\…', count: 60 }, { place: 'C:\\Users\\Player\\…', count: 1 }])
  assert.deepEqual(ui.linkPlaces([{ rel: 'a', target: 'D:\\Mods' }, { rel: 'b', target: 'd:\\mods' }]), [{ place: 'D:\\Mods', count: 2 }], 'short paths are their own place, case ignored')
  const unread = 'C:\\g\\Data\\Textures\\lost (where this link points cannot be read)'
  assert.equal(ui.linkPlaces([{ rel: 'Textures/lost', target: unread }]).length, 1)

  const game = { id: 'g', root: 'C:\\g', data: 'C:\\g\\Data', source: 'manual', label: 'g', hasNvmpLauncher: true, supported: true, warnings: [] }
  const loadOrder = { plugins: ['FalloutNV.esm'], text: 'FalloutNV.esm\r\n', source: 'plugins.txt', warnings: [] }
  const prepared = { gameId: 'g', loadOrder, scan: { files: 61, totalBytes: 61, skippedExecutables: [], problems: [], outsideLinks } }
  const check = ui.renderToStaticMarkup(ui.createElement(ui.CheckStep, {
    server: { ...courier, phase: 'waiting' }, game, prepared, progress: { state: 'idle', sentBytes: 0, totalBytes: 0 }, busy: false, editFirst: false,
    onPrepared: noop, onLoadOrder: noop, onUpload: noop, onStop: later, onDiscard: later, onChooseGame: noop
  }))
  assert.match(check, /They point to these places:/)
  assert.match(check, /<li>E:\\Vortex\\falloutnv\\… \(60 links\)<\/li>/)
  assert.match(check, /<li>C:\\Users\\Player\\… \(1 link\)<\/li>/)
  assert.match(check, /Every link \(61\):/)
  for (const link of outsideLinks) assert.ok(check.includes(`Data/${link.rel} → ${link.target}`), `${link.rel} is listed`)
  assert.doesNotMatch(check, /and \d+ more/, 'nothing approved is hidden behind a count')
})

// ---------- consent, per-account jobs and interrupted commits ----------

test('consent: a link that appears after the player agreed is refused, listing only it, until the player approves it', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  const shared = temp(); fs.writeFileSync(join(shared, 'shared.dds'), 'shared texture')
  fs.symlinkSync(shared, join(data, 'Textures', 'shared'), 'junction')
  const found = await c.gameFromFolder(game)
  const first = await c.prepare(found.id)
  assert.deepEqual(first.scan.outsideLinks.map((l) => l.rel), ['Textures/shared'])
  const ticked = first.scan.outsideLinks // what the window showed and the player ticked
  h.hooks.nvmpChunk = async () => { await c.pause() }
  await c.upload('srv-1', found.id, { approvedLinks: ticked }); h.hooks = {}
  assert.equal(c.snapshot().state, 'paused')
  // while paused, a junction to a personal folder appears in Data
  const home = temp(); fs.mkdirSync(join(home, '.ssh')); fs.writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
  fs.symlinkSync(home, join(data, 'Textures', 'home'), 'junction')
  const now = await c.prepare(found.id)
  assert.deepEqual(now.scan.outsideLinks.map((l) => l.rel), ['Textures/home', 'Textures/shared'])
  const homeLink = now.scan.outsideLinks.find((l) => l.rel === 'Textures/home')
  const begins = () => h.calls.filter((a) => a === 'nvmpBegin').length
  const before = begins()
  // Resume with the consent given before (what a stale window would send), with none (the banner after a restart),
  // and with a made-up approval for another target under the same name
  for (const approvedLinks of [ticked, [], [...ticked, { rel: 'Textures/home', target: shared }]]) {
    const refused = await issueOf(c.upload('srv-1', found.id, { approvedLinks }))
    assert.equal(refused.issue, 'links')
    assert.ok(refused.message.includes(`Data/Textures/home → ${homeLink.target}`), refused.message)
    assert.ok(!refused.message.includes('Data/Textures/shared'), 'only the link nobody approved is listed')
  }
  assert.equal(begins(), before, 'nothing was begun while the new link was unapproved')
  // Discard and start again with the old consent: still refused, nothing of the new folder on the server
  await c.discard('srv-1')
  assert.equal((await issueOf(c.upload('srv-1', found.id, { approvedLinks: ticked }))).issue, 'links')
  assert.equal(fs.existsSync(join(h.dir, 'Data', 'Textures', 'home')), false)
  // the player sees both links on Check and ticks the box: now it uploads, and the job keeps exactly those
  h.hooks.nvmpChunk = async () => { await c.pause() }
  await c.upload('srv-1', found.id, { approvedLinks: now.scan.outsideLinks }); h.hooks = {}
  assert.deepEqual(jobs.load().allowedLinks, now.scan.outsideLinks.map((l) => `${l.rel} -> ${l.target}`))
  await controllerFor(h, jobs).c.upload('srv-1', found.id) // a resume after a restart needs no second consent
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
  assert.equal(fs.readFileSync(join(h.dir, 'Data', 'Textures', 'home', '.ssh', 'id_ed25519'), 'utf8'), 'PRIVATE KEY')
})

test('a damaged upload offers Discard and start again after a restart; Check offers Discard while the host cannot report it', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const first = controllerFor(h, jobs)
  const found = await first.c.gameFromFolder(game)
  h.hooks.nvmpChunk = async () => { await first.c.pause() }
  await first.c.upload('srv-1', found.id); h.hooks = {}
  const { session } = hostApi.nvmpSetupStatus(h.dir)
  fs.writeFileSync(join(h.dir, '.nvmp-upload', session, '0.bits'), Buffer.alloc(0)) // a host power loss cut it short
  const second = controllerFor(h, jobs) // restart; banner Resume
  const resumed = await issueOf(second.c.upload('srv-1', found.id))
  assert.equal(resumed.issue, 'selection-differs', 'the window offers Discard and start again, not a Resume that fails forever')
  assert.match(resumed.message, /cannot be resumed: the progress it saved is damaged/)
  // the server list cannot read its phase; the saved job still holds the session, so Check offers Discard
  const row = await servers.checkServer({ serverId: 'srv-1', ownerId: 'host-owner', name: 'My NV:MP', state: 'stopped', hostOnline: true }, h.ask)
  assert.equal(row.phase, 'unknown')
  const lock = second.c.snapshot().lock
  assert.deepEqual(lock, { serverId: 'srv-1', serverName: 'My NV:MP', canDiscard: true })
  assert.equal(flow.unfinishedUpload(row, lock), 'unreadable')
  assert.equal(flow.unfinishedUpload(row, { serverId: 'srv-1', serverName: 'My NV:MP' }), null, 'no saved session: nothing to discard with')
  assert.equal(flow.unfinishedUpload({ ...row, phase: 'uploading' }, null), 'reported')
  await second.c.discard('srv-1')
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'waiting')
  await second.c.upload('srv-1', found.id)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
})

/** Hold a file open with FileShare.None from another process; resolves to a release function, or null. */
function lockFile(file) {
  const script = `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $f.Close()`
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  const exited = new Promise((r) => ps.once('close', r))
  const release = async () => { ps.stdin.end('\n'); await exited }
  return new Promise((resolve) => {
    ps.stdout.once('data', () => resolve(release))
    ps.once('error', () => resolve(null))
    exited.then(() => resolve(null))
  })
}

test('a file held open while fingerprinting gets the close-the-game advice, not a raw EBUSY; it uploads once released', { skip: process.platform !== 'win32' && 'Windows file sharing' }, async (t) => {
  const h = host(), { game, data } = gameFolder(), { c } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  const release = await lockFile(join(data, 'Mod.esp'))
  if (!release) { t.skip('PowerShell could not lock the file'); return }
  let failed
  try { failed = await issueOf(c.upload('srv-1', found.id)) } finally { await release() }
  assert.deepEqual(failed, {
    issue: 'incomplete',
    message: 'Data/Mod.esp could not be read (another program has it open). If the game or your mod manager has it open, close them, then try again.'
  })
  assert.ok(!h.calls.includes('nvmpBegin'), 'stopped while fingerprinting')
  await c.upload('srv-1', found.id)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
})

test('each account keeps its own saved job; another account uploading on this PC never overwrites it', async () => {
  const jobs = memoryJobs(), hA = host(), { game, data } = gameFolder()
  fs.writeFileSync(join(data, 'Extra.esp'), randomBytes(100))
  const edit = 'FalloutNV.esm\r\nExtra.esp\r\nMod.esp\r\n'
  const alice = controllerFor(hA, jobs, { account: 'alice' })
  const found = await alice.c.gameFromFolder(game)
  await alice.c.prepare(found.id); alice.c.setLoadOrder(edit)
  hA.hooks.nvmpChunk = async () => { await alice.c.pause() }
  await alice.c.upload('srv-1', found.id); hA.hooks = {}
  // Bob signs in on the same PC and pauses an upload to his own server
  const hB = host(), bob = controllerFor(hB, jobs, { account: 'bob' })
  assert.equal(bob.c.pending(), null)
  await bob.c.gameFromFolder(game)
  hB.hooks.nvmpChunk = async () => { await bob.c.pause() }
  await bob.c.upload('srv-1', found.id); hB.hooks = {}
  assert.deepEqual(jobs.accounts().sort(), ['alice', 'bob'])
  // Alice signs back in: her Resume, edit and session are all still there
  const back = controllerFor(hA, jobs, { account: 'alice' })
  assert.equal(back.c.pending()?.serverId, 'srv-1')
  assert.equal(jobs.load('alice').loadOrderText, edit)
  await back.c.upload('srv-1', found.id)
  assert.equal(fs.readFileSync(join(hA.dir, 'plugins_override.txt'), 'utf8'), edit)
  assert.equal(jobs.load('alice'), null)
  assert.equal(jobs.load('bob').serverId, 'srv-1', "Bob's job is untouched")
})

test('job files are per account; the single file of earlier versions moves to its owner and no one else', () => {
  const dir = temp(), store = jobStore.accountJobs(() => dir)
  const base = { serverId: 's', serverName: 'S', gameId: 'g', gameRoot: 'C:\\g', startedAt: 1 }
  store.save({ ...base, userId: 'alice', loadOrderText: 'A\n' })
  store.save({ ...base, userId: 'bob' })
  assert.equal(store.load('alice').loadOrderText, 'A\n'); assert.equal(store.load('bob').userId, 'bob')
  store.clear('bob')
  assert.equal(store.load('bob'), null); assert.equal(store.load('alice').userId, 'alice')
  store.save({ ...base }) // no account: never saved
  assert.deepEqual(fs.readdirSync(dir), ['upload-job-alice.json'])
  fs.copyFileSync(join(dir, 'upload-job-alice.json'), jobStore.jobFile('mallory', dir))
  assert.equal(store.load('mallory'), null, "a file holding another account's job is not handed out")
  const legacy = join(dir, 'upload-job.json')
  jobStore.saveJob({ ...base, userId: 'carol', session: 'x' }, legacy)
  assert.equal(store.load('dave'), null)
  assert.ok(fs.existsSync(legacy), "another account's old job stays for it")
  assert.equal(store.load('carol').session, 'x')
  assert.ok(!fs.existsSync(legacy), 'moved to its owner')
  assert.equal(jobStore.loadJob(jobStore.jobFile('carol', dir)).session, 'x')
  jobStore.saveJob({ ...base }, legacy)
  assert.equal(store.load('erin'), null, 'an old job of no account is never used')
})

test('a lost finish of an interrupted commit with no saved job is recognised by its session, never sent again', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs)
  const found = await c.gameFromFolder(game)
  h.hooks.nvmpFinish = () => new Error('disk hiccup')
  await issueOf(c.upload('srv-1', found.id))
  const state = JSON.parse(fs.readFileSync(join(h.dir, '.nvmp-upload', 'state.json'), 'utf8'))
  fs.writeFileSync(join(h.dir, '.nvmp-upload', 'state.json'), JSON.stringify({ ...state, phase: 'committing' }))
  c.forget() // or it was started from the web panel: the companion holds no job for it
  assert.equal(jobs.load(), null)
  h.hooks = {}; h.calls.length = 0
  const realAsk = h.ask
  let lost = 0
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish' && !lost++) throw new Error(HOST_SILENT) // committed, answer lost
    return out
  }
  await c.upload('srv-1', found.id)
  h.ask = realAsk
  assert.equal(c.snapshot().state, 'ready')
  assert.equal(c.snapshot().message, 'Game files validated. You can start your server now.')
  assert.equal(h.calls.filter((a) => a === 'nvmpBegin').length, 0, 'no new upload begun over the finished one')
  assert.equal(chunks(h), 0)
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready')
  assert.equal(jobs.load(), null, 'done: nothing left to resume')
})

test('after a lost finish, a newer load order is never claimed as applied; the edit is kept and the next upload sends it', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs(), { c } = controllerFor(h, jobs, { retry: { delaysMs: [1], forMs: 0 } })
  const found = await c.gameFromFolder(game)
  await c.prepare(found.id)
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish') throw new Error(HOST_SILENT)
    return out
  }
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'host-offline')
  h.ask = realAsk
  assert.equal(hostApi.nvmpSetupStatus(h.dir).phase, 'ready', 'the host did finish')
  await c.prepare(found.id)
  c.setLoadOrder('FalloutNV.esm\r\n')
  const sent = chunks(h)
  await c.upload('srv-1', found.id)
  const told = c.snapshot()
  assert.equal(told.state, 'ready')
  assert.doesNotMatch(told.message, /validated/)
  assert.match(told.message, /finished this upload earlier/)
  assert.match(told.warning, /\(FalloutNV\.esm, Mod\.esp\), not the one you have now/)
  assert.match(told.warning, /upload again: every file is sent again/)
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')
  assert.equal(chunks(h), sent, 'nothing was sent')
  assert.equal(jobs.load(), null, 'the finished job is done with, so later uploads run normally')
  const checked = await c.prepare(found.id)
  assert.deepEqual([checked.loadOrder.edited, checked.loadOrder.text], [true, 'FalloutNV.esm\r\n'], 'the edit is kept')
  await c.upload('srv-1', found.id)
  assert.equal(c.snapshot().message, 'Game files validated. You can start your server now.')
  assert.equal(c.snapshot().warning, undefined)
  assert.ok(chunks(h) > sent, 'a real upload this time')
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\n')
})

test('after a restart too, an edit made after a lost finish is reported rather than dropped', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const first = controllerFor(h, jobs, { retry: { delaysMs: [1], forMs: 0 } })
  const found = await first.c.gameFromFolder(game)
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish') throw new Error(HOST_SILENT)
    return out
  }
  await issueOf(first.c.upload('srv-1', found.id))
  h.ask = realAsk
  assert.equal(jobs.load().finishedEdit, '', 'the finish went out with the game\'s own order')
  await first.c.prepare(found.id)
  first.c.setLoadOrder('FalloutNV.esm\r\n')
  const second = controllerFor(h, jobs)
  await second.c.upload('srv-1', found.id)
  assert.equal(second.c.snapshot().state, 'ready')
  assert.match(second.c.snapshot().warning, /not the one you have now/)
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')
})

test('an interrupted commit the companion finishes becomes its job, so a lost answer is still recognised after a restart', async () => {
  const h = host(), { game } = gameFolder(), jobs = memoryJobs()
  const first = controllerFor(h, jobs, { retry: { delaysMs: [1], forMs: 0 } })
  const found = await first.c.gameFromFolder(game)
  h.hooks.nvmpFinish = () => new Error('disk hiccup')
  await issueOf(first.c.upload('srv-1', found.id))
  const state = JSON.parse(fs.readFileSync(join(h.dir, '.nvmp-upload', 'state.json'), 'utf8'))
  fs.writeFileSync(join(h.dir, '.nvmp-upload', 'state.json'), JSON.stringify({ ...state, phase: 'committing' }))
  first.c.forget() // no job holds this session
  h.hooks = {}
  const realAsk = h.ask
  h.ask = async (action, params) => {
    const out = await realAsk(action, params)
    if (action === 'nvmpFinish') throw new Error(HOST_SILENT) // committed, answer lost, no retry left
    return out
  }
  assert.equal((await issueOf(first.c.upload('srv-1', found.id))).issue, 'host-offline')
  h.ask = realAsk
  assert.equal(jobs.load().session, state.session, 'the session it finished is saved')
  h.calls.length = 0
  const second = controllerFor(h, jobs)
  await second.c.upload('srv-1', found.id)
  assert.deepEqual(h.calls, ['info', 'nvmpStatus'], 'recognised: nothing begun or sent again')
  assert.equal(second.c.snapshot().message, 'Game files validated. You can start your server now.')
})

test('on Resume, an edit that leaves out plugins switched on since is shown, and the finish waits for the player', async () => {
  const h = host(), { game, data } = gameFolder(), jobs = memoryJobs()
  fs.writeFileSync(join(data, 'NewMod.esp'), randomBytes(1000)) // installed, not switched on yet
  const first = controllerFor(h, jobs)
  const found = await first.c.gameFromFolder(game)
  await first.c.prepare(found.id)
  assert.equal(first.c.setLoadOrder('FalloutNV.esm\r\nMod.esp\r\n').leftOut, undefined)
  h.hooks.nvmpChunk = async () => { await first.c.pause() }
  await first.c.upload('srv-1', found.id); h.hooks = {}
  // later the player switches NewMod.esp on in the game, restarts the companion and presses Resume on the banner
  fs.appendFileSync(join(process.env.LOCALAPPDATA, 'FalloutNV', 'plugins.txt'), 'NewMod.esp\r\n')
  const second = controllerFor(h, jobs)
  const stopped = await issueOf(second.c.upload('srv-1', found.id))
  assert.equal(stopped.issue, 'edit-leaves-out')
  assert.match(stopped.message, /switches on NewMod\.esp, which your edited load order leaves out/)
  assert.match(stopped.message, /only the finish waits/)
  assert.ok(second.events.some((e) => e.state === 'uploading' && /NewMod\.esp/.test(e.warning ?? '')), 'shown while the files went up')
  const status = hostApi.nvmpSetupStatus(h.dir)
  assert.equal(status.phase, 'uploading'); assert.equal(status.completedFiles, status.totalFiles, 'every file is on the server')
  // "Finish with my edit": finishes as edited, nothing sent again
  const sent = chunks(h)
  await second.c.upload('srv-1', found.id)
  assert.equal(second.c.snapshot().state, 'ready')
  assert.equal(chunks(h), sent)
  assert.equal(fs.readFileSync(join(h.dir, 'plugins_override.txt'), 'utf8'), 'FalloutNV.esm\r\nMod.esp\r\n')

  // shown on Check before uploading: no second question at the finish
  const h2 = host(), { c } = controllerFor(h2)
  await c.gameFromFolder(game)
  await c.prepare(found.id)
  assert.deepEqual(c.setLoadOrder('FalloutNV.esm\r\nMod.esp\r\n').leftOut, ['NewMod.esp'])
  await c.upload('srv-1', found.id)
  assert.equal(c.snapshot().state, 'ready')
})

test('while a run stopped by a lost sign-in settles, the next account sees none of it and can wait for it', async () => {
  const h = host(), { game } = gameFolder(), { c } = controllerFor(h, memoryJobs(), { account: 'alice' })
  const found = await c.gameFromFolder(game)
  let release
  const gate = new Promise((r) => { release = r })
  h.hooks.nvmpChunk = async () => { await gate }
  const run = c.upload('srv-1', found.id)
  await waitFor(() => h.calls.includes('nvmpChunk'))
  assert.equal(c.stopping, false)
  await assert.rejects(c.beforeSignIn(), /Pause the upload before signing in again/, 'a running upload of the signed-in account is paused first')
  c.setAccount(null) // another IPC call found the sign-in gone
  assert.equal(c.stopping, true)
  // the sign-in handler waits for the run to settle before Bob's sign-in takes over
  let settled = false
  const waiting = c.beforeSignIn().then(() => { settled = true })
  await sleep(30)
  assert.equal(settled, false, 'still settling: the sign-in waits for it')
  // and even if an account switch got there first, Bob sees none of Alice's upload
  c.setAccount('bob')
  const seen = c.snapshot()
  assert.deepEqual([seen.state, seen.lock, seen.serverId, seen.running, seen.sentBytes], ['idle', null, undefined, false, 0])
  release(); await run; await waiting
  assert.equal(settled, true)
  assert.equal(c.busy, false)
  assert.equal(c.snapshot().lock, null)
  assert.equal(c.snapshot().state, 'idle')
})

test('a refusal while pieces are sent is a lost sign-in (or a lost share), not "incomplete"', async () => {
  const h = host(), { game } = gameFolder(), { c, who } = controllerFor(h)
  const found = await c.gameFromFolder(game)
  const denied = () => Object.assign(new Error('This server is no longer shared with your account, or your sign-in expired.'), { code: relay.DENIED_CODE })
  let n = 0
  h.hooks.nvmpChunk = () => {
    if (++n < 2) return undefined
    who.account = null // auth-js dropped the revoked session: the insert went out with the anon key
    return denied()
  }
  assert.deepEqual(await issueOf(c.upload('srv-1', found.id)), { issue: 'signed-out', message: SIGNED_OUT_MESSAGE })
  who.account = 'renter'
  n = 0
  h.hooks.nvmpChunk = () => (++n < 2 ? undefined : denied())
  assert.equal((await issueOf(c.upload('srv-1', found.id))).issue, 'no-access')
})

test('Stop, Start and Discard say the sign-in expired, not that the server left the account', async () => {
  const h = host(), { c, who } = controllerFor(h)
  who.account = null
  h.gone = true // a signed-out request cannot see the server row
  for (const call of [() => c.command('srv-1', 'stop'), () => c.command('srv-1', 'start'), () => c.discard('srv-1')]) {
    await assert.rejects(call(), (e) => e.message === SIGNED_OUT_MESSAGE && relay.isSignedOutError(e))
  }
  assert.deepEqual(h.calls, []); assert.deepEqual(h.commands, [])
})

test('the retry backoff grows 5, 15, 30, 60 s, stays at 60 s, starts over after progress, and gives up after 30 min', () => {
  const { RetryClock } = companion('upload')
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  try {
    const clock = new RetryClock([5_000, 15_000, 30_000, 60_000], 30 * 60_000)
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => clock.next(100)), [5_000, 15_000, 30_000, 60_000, 60_000, 60_000])
    assert.equal(clock.next(200), 5_000, 'pieces got through: back to the first delay')
    assert.equal(clock.next(200), 15_000)
    t += 29 * 60_000
    assert.equal(clock.next(200), 30_000)
    t += 60_000
    assert.equal(clock.next(200), null, 'no progress for 30 minutes: give up')
  } finally { Date.now = realNow }
})

test('window: consent never outlives its scan, the countdown is not spoken, new issues have their next step', async () => {
  // consent belongs to one scan of one game
  const links = [{ rel: 'Textures/x', target: 'D:\\x' }]
  assert.deepEqual(flow.approvedFor({ gameId: 'g', approvedLinks: links }, 'g'), links)
  assert.deepEqual(flow.approvedFor({ gameId: 'g', approvedLinks: links }, 'other'), [])
  assert.deepEqual(flow.approvedFor({ gameId: 'g' }, 'g'), [], 'a new scan starts without consent')
  assert.deepEqual(flow.approvedFor(null, 'g'), [])
  // the spoken line: state changes only, "Reconnected" once the upload moves again
  const said = []
  let memory = { retrying: false }
  for (const p of [
    { state: 'uploading', sentBytes: 40, totalBytes: 100 },
    { state: 'retrying', retryReason: 'connection', retryAt: 9_000, sentBytes: 40, totalBytes: 100 },
    { state: 'retrying', retryReason: 'connection', retryAt: 9_000, sentBytes: 40, totalBytes: 100 },
    { state: 'starting', sentBytes: 40, totalBytes: 100 },
    { state: 'uploading', sentBytes: 41, totalBytes: 100 },
    { state: 'uploading', sentBytes: 42, totalBytes: 100 },
    { state: 'uploading', sentBytes: 46, totalBytes: 100 }
  ]) {
    const next = flow.spokenLine(p, memory)
    said.push(next.line); memory = next.memory
  }
  assert.deepEqual(said, ['Uploading: 40%', 'Connection lost, retrying', 'Connection lost, retrying', 'Getting ready',
    'Reconnected. Uploading: 40%', 'Reconnected. Uploading: 40%', 'Uploading: 45%'])

  const ui = await windowUi()
  const html = (component, props) => ui.renderToStaticMarkup(ui.createElement(component, props))
  // while retrying, every live region reads the same from one second to the next; the countdown itself moves
  const realNow = Date.now, t0 = 5_000_000
  const ticks = []
  try {
    for (const now of [t0, t0 + 1000, t0 + 2000]) {
      Date.now = () => now
      ticks.push(html(ui.UploadStep, uploadProps({ state: 'retrying', running: true, retryReason: 'connection', retryAt: t0 + 60_000, sentBytes: 5, totalBytes: 10 })))
    }
  } finally { Date.now = realNow }
  assert.match(ticks[0], /retrying in 60 s/); assert.match(ticks[1], /retrying in 59 s/)
  assert.deepEqual(liveRegions(ticks[1]), liveRegions(ticks[0])); assert.deepEqual(liveRegions(ticks[2]), liveRegions(ticks[0]))
  assert.ok(liveRegions(ticks[0]).includes('Connection lost, retrying'))
  assert.ok(!liveRegions(ticks[0]).some((text) => /retrying in/.test(text)), 'the countdown is in no live region')
  // new issues and notices
  const error = (issue) => html(ui.UploadStep, uploadProps({ state: 'error', issue, sentBytes: 0, totalBytes: 0, message: 'x' }))
  assert.notEqual(buttonOf(error('links'), 'Back to your files'), '')
  assert.equal(buttonOf(error('links'), 'Resume upload'), '')
  assert.notEqual(buttonOf(error('edit-leaves-out'), 'Finish with my edit'), '')
  assert.notEqual(buttonOf(error('edit-leaves-out'), 'Edit load order'), '')
  assert.notEqual(buttonOf(error('selection-differs'), 'Discard and start again'), '')
  assert.match(html(ui.UploadStep, uploadProps({ state: 'uploading', running: true, sentBytes: 1, totalBytes: 10, warning: 'Your plugins.txt switches on NewMod.esp' })), /class="formwarn" role="status">Your plugins\.txt switches on NewMod\.esp/)
  // E: Check offers Discard for this account's damaged upload whose phase the host cannot report
  const game = { id: 'g', root: 'C:\\g', data: 'C:\\g\\Data', source: 'manual', label: 'g', hasNvmpLauncher: true, supported: true, warnings: [] }
  const prepared = { gameId: 'g', loadOrder: { plugins: ['FalloutNV.esm'], text: 'FalloutNV.esm\r\n', source: 'plugins.txt', warnings: [] }, scan: { files: 1, totalBytes: 1, skippedExecutables: [], problems: [], outsideLinks: [] } }
  const checkProps = (lock) => ({ server: { ...courier, phase: 'unknown' }, game, prepared, progress: { state: 'idle', sentBytes: 0, totalBytes: 0, lock }, busy: false, editFirst: false,
    onPrepared: noop, onLoadOrder: noop, onUpload: noop, onStop: later, onDiscard: later, onChooseGame: noop })
  const damaged = html(ui.CheckStep, checkProps({ serverId: 'a', serverName: 'Courier co-op', canDiscard: true }))
  assert.notEqual(buttonOf(damaged, 'Discard unfinished upload'), '')
  assert.match(damaged, /cannot report how far it got/)
  assert.equal(buttonOf(html(ui.CheckStep, checkProps(null)), 'Discard unfinished upload'), '')
  assert.match(buttonOf(html(ui.CheckStep, { ...checkProps(null), progress: { state: 'error', issue: 'edit-leaves-out', serverId: 'a', sentBytes: 0, totalBytes: 0 } }), 'Finish setup'), /<button/)
  // A: Done tells the player a newer load order was not applied
  const done = html(ui.DoneStep, { server: { ...courier, phase: 'ready' }, notice: 'Your server already has these game files.', warning: 'It uses the load order it was finished with.', onStart: later, onUploadAgain: noop })
  assert.match(done, /class="formwarn" role="status">It uses the load order it was finished with\./)
  // offline at launch, the kept sign-in is tried again; no password form
  const offlineStart = html(ui.OfflineStart, { notice: OFFLINE_MESSAGE, onRetry: later, onSignIn: noop })
  assert.match(offlineStart, /<h1[^>]*>Cannot reach the eLauncher cloud<\/h1>/)
  assert.notEqual(buttonOf(offlineStart, 'Try again'), '')
  assert.notEqual(buttonOf(offlineStart, 'Sign in with your password instead'), '')
  assert.doesNotMatch(offlineStart, /type="password"/)
})
