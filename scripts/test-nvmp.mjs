// Offline regression tests. No network, Proton, SteamCMD, game process or cloud calls.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { test, after } from 'node:test'
import { transformSync } from 'esbuild'
import { parse } from '@babel/parser'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'elauncher-nvmp-test-'))
after(() => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  assert.ok(root.includes('elauncher-nvmp-test-'))
  rmSync(root, { recursive: true, force: true })
})
let serial = 0
const temp = () => { const d = join(root, String(++serial)); mkdirSync(d); return d }
const noCall = (name) => () => { throw new Error(`Unexpected external call: ${name}`) }
function load(file, imports = {}, globals = {}, append = '') {
  const code = transformSync(readFileSync(join(repo, file), 'utf8') + append, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const localRequire = (id) => {
    if (id in imports) return imports[id]
    if (id.startsWith('.') || id.startsWith('@')) throw new Error(`Unmocked import: ${id}`)
    return require(id)
  }
  const module = { exports: {} }
  const names = ['require', 'module', 'exports', ...Object.keys(globals)]
  runInThisContext(`(function(${names.join(',')}) { ${code}\n})`, { filename: file })(localRequire, module, module.exports, ...Object.values(globals))
  return module.exports
}

function fixture() {
  const calls = { spawn: [], kill: [], handoff: [], download: [], proton: 0, signals: [] }
  const timers = new Set()
  const env = { PATH: '/usr/bin', HOME: '/root', ELAUNCHER_PASSWORD: 'test-only-secret', SUPABASE_SERVICE_ROLE_KEY: 'test-only-key' }
  const fakeProcess = { platform: 'linux', arch: 'x64', env, kill: (...args) => calls.signals.push(args) }
  const runtime = { script: '/test/proton', version: 'test-Proton' }
  const gameUser = {
    env: (base) => ({ ...base, HOME: '/var/lib/elauncher-game', USER: 'elauncher-game' }),
    wrap: (exe, args) => ['setpriv', ['--reuid', 'elauncher-game', '--', exe, ...args]]
  }
  const proton = {
    ensureProton: async () => { calls.proton++; return runtime },
    readProton: () => runtime,
    protonPrefixDir: (dir) => join(dir, 'protonprefix'),
    protonEnv: (prefix) => ({ STEAM_COMPAT_DATA_PATH: prefix, STEAM_COMPAT_CLIENT_INSTALL_PATH: '/shared/steam' })
  }
  const downloads = { downloadToFile: async (...args) => { calls.download.push(args); throw new Error('mock download failed') } }
  const nvmp = load('src/main/services/nvmp.ts', {
    './nvmpUpload': load('src/main/services/nvmpUpload.ts', { '@shared/nvmpUpload': load('src/shared/nvmpUpload.ts') }),
    './proton': proton,
    './mods': downloads,
    './gameuser': {
      ensureSteamGameUser: async () => gameUser,
      prepareServerDirForGameUser: async (_user, dir) => calls.handoff.push(readFileSync(join(dir, 'server.cfg'), 'utf8'))
    },
    './proctree': { killProcessTree: (proc) => calls.kill.push(proc) },
    child_process: { spawn: (...args) => {
      const proc = Object.assign(new EventEmitter(), { pid: 42, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (signal) => calls.signals.push(signal) })
      calls.spawn.push({ args, proc }); return proc
    } }
  }, {
    process: fakeProcess,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer },
    clearTimeout: (timer) => timers.delete(timer)
  })
  return { nvmp, calls, timers, env, fakeProcess, proton, downloads }
}
function data(dir = temp()) {
  mkdirSync(join(dir, 'Data'))
  writeFileSync(join(dir, 'Data', 'FalloutNV.esm'), 'synthetic test data')
  writeFileSync(join(dir, 'Data', 'Example.esp'), 'synthetic mod')
  writeFileSync(join(dir, 'plugins_override.txt'), '\uFEFFFalloutNV.esm\r\n# comment\r\nExample.esp\r\n')
  return dir
}
async function running(f = fixture()) {
  const dir = data()
  writeFileSync(join(dir, 'nvmp_storyserver.exe'), 'not executable: test fixture')
  await f.nvmp.prepareNvmpStart(dir, 27016, () => {})
  const events = { log: [], ready: 0, players: [], exit: [] }
  const handle = f.nvmp.startNvmp(dir, 27016, '2,3', {
    onLog: (line) => events.log.push(line), onReady: () => events.ready++,
    onPlayers: (players) => events.players.push(players), onExit: (code) => events.exit.push(code)
  })
  return { ...f, dir, events, handle, proc: handle.proc }
}

test('host eligibility rejects Windows, ARM and missing/relative templates before downloads', async () => {
  const f = fixture()
  assert.match(f.nvmp.nvmpHostProblem(), /ELAUNCHER_NVMP_ROOT/)
  f.env.ELAUNCHER_NVMP_ROOT = 'relative'
  assert.match(f.nvmp.nvmpHostProblem(), /absolute/)
  f.env.ELAUNCHER_NVMP_ROOT = data()
  assert.equal(f.nvmp.nvmpHostProblem(), null)
  f.fakeProcess.platform = 'win32'
  await assert.rejects(f.nvmp.installNvmp(temp(), { port: 27015 }, () => {}), /Linux/)
  f.fakeProcess.platform = 'linux'; f.fakeProcess.arch = 'arm64'
  assert.match(f.nvmp.nvmpHostProblem(), /x64/)
  assert.equal(f.calls.proton, 0); assert.equal(f.calls.download.length, 0)
})

test('load order preserves order and rejects missing, duplicate and traversal plugins', () => {
  const { nvmp } = fixture(); const dir = data()
  assert.deepEqual(nvmp.readNvmpPlugins(dir), ['FalloutNV.esm', 'Example.esp'])
  for (const text of ['', 'Example.esp\nFalloutNV.esm', 'FalloutNV.esm\nfalloutnv.ESM', 'FalloutNV.esm\n../outside.esp', 'FalloutNV.esm\nMissing.esp']) {
    writeFileSync(join(dir, 'plugins_override.txt'), text)
    assert.throws(() => nvmp.readNvmpPlugins(dir))
  }
})

test('linked Data directory is rejected', () => {
  const { nvmp } = fixture(); const source = data(); const dir = temp()
  symlinkSync(join(source, 'Data'), join(dir, 'Data'), 'junction')
  copyFileSync(join(source, 'plugins_override.txt'), join(dir, 'plugins_override.txt'))
  assert.throws(() => nvmp.readNvmpPlugins(dir), /real Data/)
})

test('settings round-trip preserves operator sections and rejects unmanaged values', () => {
  const { nvmp } = fixture(); const dir = temp()
  writeFileSync(join(dir, 'server.cfg'), '[Network]\nPort=27018\n[Server]\n; keep comment\nEnableVATS=true\nDifficulty=3\n[Experimental]\nMainThreadDispatching=true\n')
  assert.equal(nvmp.setNvmpSettings(dir, { EnableVATS: 'false', EnableSaving: 'true' }).EnableVATS, 'false')
  const saved = readFileSync(join(dir, 'server.cfg'), 'utf8')
  assert.match(saved, /Difficulty=3/); assert.match(saved, /; keep comment/); assert.match(saved, /MainThreadDispatching=true/); assert.match(saved, /Port=27018/)
  for (const bad of [{ Port: '27099' }, { Hostname: '*' }, { MaxPlayers: '20' }, { EnableVATS: 'yes' }, { EnableVATS: 'false\nPort=1' }]) {
    assert.throws(() => nvmp.setNvmpSettings(dir, bad), /Invalid/)
    assert.equal(readFileSync(join(dir, 'server.cfg'), 'utf8'), saved)
  }
})

test('installer rejects ignored passwords and unsupported player caps before runtime setup', async () => {
  const f = fixture(); f.env.ELAUNCHER_NVMP_ROOT = data()
  for (const settings of [{ port: 27015, serverPassword: 'password' }, { port: 27015, maxPlayers: 9 }, { port: 27015, maxPlayers: 11 }]) {
    await assert.rejects(f.nvmp.installNvmp(temp(), settings, () => {}))
  }
  await assert.rejects(f.nvmp.installNvmp(join(f.env.ELAUNCHER_NVMP_ROOT, 'nested'), { port: 27015 }, () => {}), /outside/)
  assert.equal(f.calls.proton, 0); assert.equal(f.calls.download.length, 0)
})

test('download failure cleans the temporary archive and keeps template contents intact', async () => {
  const f = fixture(); const source = data(); f.env.ELAUNCHER_NVMP_ROOT = source
  f.downloads.downloadToFile = async (_url, file) => { writeFileSync(file, 'partial download'); throw new Error('interrupted') }
  const dir = temp()
  await assert.rejects(f.nvmp.installNvmp(dir, { port: 27015, maxPlayers: 10 }, () => {}), /interrupted/)
  assert.equal(existsSync(join(dir, '.nvmp-download.zip')), false)
  assert.equal(readFileSync(join(source, 'Data', 'FalloutNV.esm'), 'utf8'), 'synthetic test data')
  assert.equal(existsSync(join(dir, 'nvmp_storyserver.exe')), false)
})

test('corrupt archive is rejected before extracting any file', () => {
  const { nvmp } = fixture(); const dir = temp(); const archive = join(temp(), 'bad.zip')
  writeFileSync(archive, 'not an official archive')
  assert.throws(() => nvmp.extractNvmpServer(archive, dir), /checksum mismatch/)
  assert.deepEqual(readdirSync(dir), [])
})

test('customer installation does not require or copy a host game-data template', { skip: !process.env.NVMP_TEST_ARCHIVE }, async () => {
  const f = fixture(); f.env.ELAUNCHER_NVMP_ROOT = data()
  f.downloads.downloadToFile = async (_url, dest) => copyFileSync(process.env.NVMP_TEST_ARCHIVE, dest)
  const dir = temp()
  await f.nvmp.installNvmp(dir, { port: 27015, maxPlayers: 10, nvmpCustomerFiles: true }, () => {})
  assert.equal(existsSync(join(dir, 'nvmp_storyserver.exe')), true)
  assert.equal(existsSync(join(dir, 'Data')), false)
  assert.equal(JSON.parse(readFileSync(join(dir, '.nvmp-upload/state.json'), 'utf8')).phase, 'waiting')
  await assert.rejects(f.nvmp.prepareNvmpStart(dir, 27015, () => {}), /Game setup/)
  delete f.env.ELAUNCHER_NVMP_ROOT
  const another = temp()
  await f.nvmp.installNvmp(another, { port: 27016, maxPlayers: 10, nvmpCustomerFiles: true }, () => {})
  assert.equal(existsSync(join(another, 'Data')), false)
})

test('prepare pins the allocated port before transferring ownership', async () => {
  const r = await running()
  assert.match(r.calls.handoff[0], /Port=27016/)
  assert.match(r.calls.handoff[0], /Hostname=\*/)
  assert.throws(() => r.nvmp.startNvmp(r.dir, 27016, null, {}), /not prepared/)
  await assert.rejects(r.nvmp.prepareNvmpStart(r.dir, 80, () => {}), /Invalid.*port/)
  r.proc.emit('exit', 0)
})

test('launch uses Proton, an isolated prefix and game user without hosting secrets', async () => {
  const r = await running(); const [exe, args, opts] = r.calls.spawn[0].args
  assert.equal(exe, 'taskset'); assert.deepEqual(args.slice(0, 4), ['-c', '2,3', 'setpriv', '--reuid'])
  assert.ok(args.includes('/test/proton')); assert.equal(args.at(-1), join(r.dir, 'nvmp_storyserver.exe'))
  assert.equal(opts.env.ELAUNCHER_PASSWORD, undefined); assert.equal(opts.env.SUPABASE_SERVICE_ROLE_KEY, undefined)
  assert.equal(opts.env.HOME, '/var/lib/elauncher-game')
  assert.equal(opts.env.STEAM_COMPAT_DATA_PATH, join(r.dir, 'protonprefix'))
  assert.equal(opts.env.STEAM_COMPAT_CLIENT_INSTALL_PATH, join(r.dir, 'steam-compat'))
  assert.equal(opts.detached, true); assert.equal(r.handle.command, undefined)
  r.proc.emit('exit', 0)
})

test('readiness requires the complete listening log; stdout and stderr stay separate', async () => {
  const r = await running()
  r.proc.stdout.emit('data', Buffer.from('Registering mod files from disk...\nListening on 0.0.0.0:'))
  r.proc.stderr.emit('data', Buffer.from('Wine diagnostic\n'))
  assert.equal(r.events.ready, 0)
  r.proc.stdout.emit('data', Buffer.from('27016 [max peers = 10]\n'))
  r.proc.stdout.emit('data', Buffer.from('Listening on 0.0.0.0:27016 [max peers = 10]\n'))
  assert.equal(r.events.ready, 1); assert.equal(r.timers.size, 0)
  r.proc.emit('exit', 0)
})

test('player tracking handles fragmented UTF-8, reconnects, and disconnects', async () => {
  const r = await running(); const b = Buffer.from('Player Zoë [17][account] connected\n')
  const split = b.indexOf(0xc3) + 1
  r.proc.stdout.emit('data', b.subarray(0, split)); r.proc.stdout.emit('data', b.subarray(split))
  r.proc.stdout.emit('data', Buffer.from('Player Zoë [17][account] connected\nPlayer Pat [18][account2] connected\nPlayer 17 disconnected\n'))
  assert.deepEqual(r.events.players, [['Zoë'], ['Zoë'], ['Zoë', 'Pat'], ['Pat']])
  r.proc.emit('exit', 0)
})

test('stop ignores late readiness and cleans the timeout on exit', async () => {
  const r = await running()
  r.handle.stop(); r.handle.stop()
  assert.deepEqual(r.calls.signals, [[-42, 'SIGINT']])
  assert.equal(r.timers.size, 1); assert.equal([...r.timers][0].ms, 25_000)
  r.proc.stdout.emit('data', Buffer.from('Listening on 0.0.0.0:27016 [max peers = 10]\n'))
  assert.equal(r.events.ready, 0)
  r.proc.emit('exit', 0); assert.equal(r.timers.size, 0)
  r.proc.emit('error', new Error('late error')); assert.deepEqual(r.events.exit, [0])
})

test('forced stop fallback kills the process tree once the grace period expires', async () => {
  const r = await running(); r.handle.stop(); [...r.timers][0].fn()
  assert.deepEqual(r.calls.kill, [r.proc]); r.proc.emit('exit', null)
})

test('stalled boot is killed and reports failure even for a signal exit', async () => {
  const r = await running(); const timeout = [...r.timers][0]
  assert.equal(timeout.ms, 300_000); timeout.fn()
  assert.deepEqual(r.calls.kill, [r.proc])
  r.proc.stdout.emit('data', Buffer.from('Listening on 0.0.0.0:27016 [max peers = 10]\n'))
  assert.equal(r.events.ready, 0); r.proc.emit('exit', null)
  assert.deepEqual(r.events.exit, [1]); assert.equal(r.timers.size, 0)
})

test('spawn errors report failure once and clear startup timers', async () => {
  const r = await running(); r.proc.emit('error', new Error('ENOENT')); r.proc.emit('exit', 1)
  assert.deepEqual(r.events.exit, [1]); assert.equal(r.timers.size, 0)
})

function registry() {
  const f = fixture()
  const steam = load('src/main/services/steamgames.ts', {
    '@shared/games': load('src/shared/games.ts'), '@shared/ark': load('src/shared/ark.ts'),
    './proton': f.proton, './nvmp': f.nvmp, './mods': { downloadToFile: noCall('network') },
    './steamcmd': { installSteamApp: noCall('SteamCMD') }, './proctree': { killProcessTree: noCall('kill') }
  })
  const ports = load('src/main/services/ports.ts', { './steamgames': steam, './upnp': {} })
  return { ...f, steam, ports }
}

test('registry routes NV:MP settings/install correctly without SteamCMD', async () => {
  const r = registry(); assert.equal(r.steam.isSteamGame('nvmp'), true)
  assert.equal(r.steam.STEAM_GAMES.nvmp.hasConsole, false)
  const dir = temp()
  assert.equal(r.steam.setSteamGameSettings('nvmp', dir, { EnableVATS: 'false' }).EnableVATS, 'false')
  assert.equal(r.steam.getSteamGameSettings('nvmp', dir).EnableSaving, 'true')
  await assert.rejects(r.steam.installSteamGame('nvmp', dir, { port: 27015 }, () => {}), /ELAUNCHER_NVMP_ROOT/)
})

test('network policy opens both protocols on one allocation and no Minecraft presets', () => {
  const { ports } = registry()
  assert.equal(ports.mainPortProtocol('nvmp'), 'UDP')
  assert.deepEqual(ports.companionPorts('nvmp', 27016).map(({ port, protocol }) => ({ port, protocol })), [{ port: 27016, protocol: 'TCP' }])
  assert.deepEqual(ports.portPresets('nvmp', 27016), [])
})

function provisionerFixture({ prepared = true, state = 'starting', existing = true, setupPhase = 'ready', planGame = 'nvmp', serverGame = planGame } = {}) {
  const order = { id: 'order-1', user_id: 'buyer', plan_id: 'nvmp-plan', server_name: 'My server', server_id: existing ? 'server-1' : null, note: '', status: 'active', paid_until: null }
  const plan = { id: 'nvmp-plan', name: 'NVMP', game: planGame, max_players: 10, memory_mb: 4096 }
  const server = { id: 'server-1', name: 'Test', game: serverGame, orderId: 'order-1', port: 27015, limits: { memoryMb: 4096, maxPlayers: 10 } }
  const calls = { claim: 0, open: [], companion: [], mail: [], created: [], shared: [], automation: [] }
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'admin' } } } }) },
    rpc: async (name, params) => {
      if (name === 'hosting_finish') { order.server_id = params.new_server_id; return { data: true } }
      calls.claim++; return { data: false }
    },
    functions: { invoke: async (...args) => { calls.mail.push(args); return {} } },
    from: (table) => {
      let patch = null
      const chain = {
        select: () => chain, eq: () => chain, maybeSingle: () => chain,
        update: (value) => { patch = value; return chain }, upsert: (value) => { if (table === 'server_shares') calls.shared.push(value); return chain },
        then: (done, reject) => {
          if (table === 'hosting_orders' && patch) Object.assign(order, patch)
          const result = { data: table === 'profiles' ? { is_admin: true } : table === 'hosting_plans' ? [plan] : table === 'hosting_orders' ? [{ ...order }] : [] }
          return Promise.resolve(result).then(done, reject)
        }
      }
      return chain
    }
  }
  const { tick, provision } = load('src/main/services/hostingOrders.ts', {
    '@shared/cloudConfig': { isCloudConfigured: () => true },
    './cloud': { getClient: () => client }, './device': { deviceId: () => 'node' },
    './steamgames': { isSteamGame: (game) => game === 'nvmp' }, './nvmp': { nvmpNodeProblem: () => prepared ? null : 'unsupported platform' },
    './hosting': { stopTunnel: noCall('tunnel'), startTunnel: noCall('tunnel') },
    './hostNames': { assignHost: () => false, hostPool: () => [], listAssignedHosts: () => [], updateDuckDns: async () => null },
    './notifications': { notifyPhones: () => {} }, './settings': { getSettings: () => ({}) },
    './ports': {
      mainPortProtocol: () => 'UDP', companionPorts: (_game, port) => [{ port, protocol: 'TCP' }],
      openRules: async (rules) => calls.companion.push(rules)
    },
    './upnp': { refreshExternalIp: async () => false, openPort: async (...args) => { calls.open.push(args); return { externalIp: '203.0.113.10' } } },
    './versions': {},
    './server': {
      listLocalServers: () => existing ? [server] : [], getServerPublicAddress: () => null,
      runNvmpSetupRequest: () => ({ phase: setupPhase }),
      getServerStates: () => ({ 'server-1': { state } }), announceServerByPort: () => {},
      createServer: async (value) => { calls.created.push(value); return server }, setServerLimits: () => {},
      setServerAutomation: (...args) => calls.automation.push(args), startServer: noCall('game start')
    }
  }, {}, '\nexport { tick, provision };')
  return { tick, provision: () => provision(order, plan, 'admin'), order, calls }
}

test('paid NV:MP orders share a stopped customer-upload instance without starting it', async () => {
  const f = provisionerFixture({ existing: false, setupPhase: 'waiting', state: 'stopped' })
  await f.provision()
  assert.equal(f.calls.created[0].source.nvmpCustomerFiles, true)
  assert.equal(f.calls.created[0].source.game, 'nvmp')
  assert.equal(f.order.server_id, 'server-1')
  assert.deepEqual(f.calls.shared, [{ owner_id: 'admin', server_id: 'server-1', server_name: 'Test', grantee_id: 'buyer' }])
  assert.match(f.order.note, /Waiting for your game files/)
  assert.equal(f.calls.mail.length, 0); assert.equal(f.calls.open.length, 0)
  assert.equal(f.calls.automation.length, 1)
})

test('unknown cloud games cannot fall through to Minecraft or claim an order', async () => {
  for (const planGame of ['future-game', '', 'NVMP']) {
    const f = provisionerFixture({ existing: false, planGame })
    await f.tick()
    assert.equal(f.calls.claim, 0)
    await assert.rejects(f.provision(), /does not support/)
    assert.equal(f.calls.created.length, 0)
    assert.equal(f.calls.shared.length, 0)
  }
})

test('retry refuses to adopt a Minecraft instance for a paid NVMP order', async () => {
  const f = provisionerFixture({ serverGame: null })
  await assert.rejects(f.provision(), /Server game minecraft does not match plan nvmp/)
  assert.equal(f.calls.created.length, 0)
  assert.equal(f.calls.shared.length, 0)
  assert.equal(f.calls.automation.length, 0)
})

test('reconciliation reports a mismatched game instead of advertising it as ready', async () => {
  const f = provisionerFixture({ serverGame: 'minecraft', state: 'running' })
  await f.tick()
  assert.match(f.order.note, /does not match plan nvmp/)
  assert.doesNotMatch(f.order.note, /Ready/)
  assert.equal(f.calls.open.length, 0)
  assert.equal(f.calls.shared.length, 0)
})

test('unfinished customer uploads remain waiting during order reconciliation', async () => {
  const f = provisionerFixture({ state: 'stopped', setupPhase: 'waiting' })
  await f.tick()
  assert.match(f.order.note, /Waiting for your game files/)
  assert.equal(f.calls.open.length, 0); assert.equal(f.calls.mail.length, 0)
})

test('unsupported nodes do not claim NV:MP orders away from eligible Linux nodes', async () => {
  const ineligible = provisionerFixture({ prepared: false, existing: false })
  await ineligible.tick(); assert.equal(ineligible.calls.claim, 0)
  const eligible = provisionerFixture({ prepared: true, existing: false })
  await eligible.tick(); assert.equal(eligible.calls.claim, 1)
})

test('provisioner never advertises a starting or stopped NV:MP server as Ready', async () => {
  for (const state of ['starting', 'stopped', 'stopping']) {
    const f = provisionerFixture({ state }); await f.tick()
    assert.match(f.order.note, new RegExp(`NV:MP is ${state}`))
    assert.equal(f.calls.open.length, 0); assert.equal(f.calls.mail.length, 0)
  }
})

test('running NV:MP orders expose TCP and UDP and show the launcher join instructions', async () => {
  const f = provisionerFixture({ state: 'running' }); await f.tick()
  assert.match(f.order.note, /^Ready.*Connect via IP.*203\.0\.113\.10:27015/)
  assert.deepEqual(f.calls.open[0].slice(0, 2), [27015, 'UDP'])
  assert.deepEqual(f.calls.companion, [[{ port: 27015, protocol: 'TCP' }]])
})

// Isolate the real allocation functions from Electron/cloud side effects.
test('allocation avoids existing servers, the blocked MongoDB port and overflow', () => {
  const { steam, ports } = registry()
  const source = readFileSync(join(repo, 'src/main/services/server.ts'), 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const selected = ast.program.body.filter((s) => s.type === 'FunctionDeclaration' && ['claimedPorts', 'nextFreePort'].includes(s.id?.name)).map((s) => source.slice(s.start, s.end)).join('\n')
  const js = transformSync(selected, { loader: 'ts', target: 'es2022' }).code
  const specs = structuredClone(steam.STEAM_GAMES)
  const allocate = runInThisContext(`(function(gameOf, isSteamGame, STEAM_GAMES, blockedPortReason, PALWORLD_BASE_PORT, PALWORLD_PORT_STEP, BASE_PORT) { ${js}; return nextFreePort })`)(
    (s) => s.game ?? 'minecraft', steam.isSteamGame, specs, ports.blockedPortReason, 8211, 2, 25565)
  assert.equal(allocate([], 'nvmp'), 27015)
  assert.equal(allocate([{ game: 'nvmp', port: 27015 }], 'nvmp'), 27016)
  assert.equal(allocate([{ game: 'nvmp', port: 27015 }, { game: 'minecraft', port: 27016 }], 'nvmp'), 27018)
  specs.nvmp.basePort = 65535
  assert.throws(() => allocate([{ game: 'nvmp', port: 65535 }], 'nvmp'), /No available ports/)
})

test('official archive installs only the allowlisted server files', { skip: !process.env.NVMP_TEST_ARCHIVE }, async () => {
  const f = fixture(); const template = data(); f.env.ELAUNCHER_NVMP_ROOT = template
  writeFileSync(join(template, 'server.cfg'), '[Server]\nEnableVATS=false\nDifficulty=3\n')
  f.downloads.downloadToFile = async (url, dest) => {
    assert.equal(url, f.nvmp.NVMP_URL); copyFileSync(process.env.NVMP_TEST_ARCHIVE, dest)
  }
  const dir = temp(); await f.nvmp.installNvmp(dir, { port: 27018, maxPlayers: 10 }, () => {})
  assert.deepEqual(readdirSync(dir).sort(), ['Data', 'elauncher-nvmp.json', 'libcrypto-3.dll', 'libssl-3.dll', 'nvmp_storyserver.exe', 'nvmp_storyserver_README.txt', 'plugins_override.txt', 'server.cfg'].sort())
  assert.equal(f.nvmp.getNvmpSettings(dir).EnableVATS, 'false')
  assert.match(readFileSync(join(dir, 'server.cfg'), 'utf8'), /Port=27018/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'elauncher-nvmp.json'), 'utf8')).version, '9.43')
  assert.equal(f.calls.spawn.length, 0)
})


function protonRelease(arch, names) {
  return load('src/main/services/proton.ts', {
    electron: { app: {} }, './mods': { downloadToFile: noCall('runtime download') }
  }, {
    process: { arch },
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'GE-Proton11-11', assets: names.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })) }) })
  }, '\nexport { latestRelease };').latestRelease()
}

test('Proton selects the explicit x86_64 archive even when ARM assets come first', async () => {
  const result = await protonRelease('x64', ['GE-Proton11-11-aarch64.tar.gz', 'GE-Proton11-11-x86_64.sha512sum', 'GE-Proton11-11-x86_64.tar.gz'])
  assert.match(result.url, /GE-Proton11-11-x86_64\.tar\.gz$/)
})

test('Proton still accepts legacy x86_64 archive names without a suffix', async () => {
  const result = await protonRelease('x64', ['GE-Proton10-20-aarch64.tar.gz', 'GE-Proton10-20.tar.gz'])
  assert.match(result.url, /GE-Proton10-20\.tar\.gz$/)
})

test('Proton ARM hosts select only the ARM archive', async () => {
  const result = await protonRelease('arm64', ['GE-Proton11-11-x86_64.tar.gz', 'GE-Proton11-11-aarch64.tar.gz'])
  assert.match(result.url, /-aarch64\.tar\.gz$/)
})

test('Proton refuses an incompatible archive instead of guessing', async () => {
  await assert.rejects(protonRelease('x64', ['GE-Proton11-11-aarch64.tar.gz', 'GE-Proton11-11-x86_64.sha512sum']), /no x64 build/)
  await assert.rejects(protonRelease('arm64', ['GE-Proton11-11-x86_64.tar.gz']), /no arm64 build/)
})
