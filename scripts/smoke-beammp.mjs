// Exercises the real provider with temporary files and mocked official HTTP/process I/O.
// No BeamMP binary is downloaded or executed; no AuthKey or listening port is needed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const cache = join(root, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const compiled = mkdtempSync(join(cache, 'beammp-test-'))
const fixtures = mkdtempSync(join(tmpdir(), 'elauncher-beammp-'))
const server = join(fixtures, 'server')
const secret = join(fixtures, 'credentials', 'beammp-auth.key')
const authKey = 'abcd1234-abcd-1234-abcd-abcd1234abcd'
const binary = Buffer.from('official BeamMP binary fixture, never executable')
const checksum = createHash('sha256').update(binary).digest('hex')
const tests = []
const test = (name, run) => tests.push({ name, run })
let spawns = []
let kills = []
const fakeSpawn = (executable, args, options) => {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.stdin = new PassThrough()
  proc.pid = 98765
  const writes = []
  proc.stdin.on('data', (chunk) => writes.push(chunk.toString()))
  spawns.push({ executable, args, options, proc, writes })
  return proc
}
const savedFetch = globalThis.fetch
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')

try {
  execFileSync(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'), join(root, 'src/main/services/beammp.ts'), '--ignoreConfig',
    '--outDir', compiled, '--module', 'commonjs', '--target', 'es2022',
    '--types', 'node', '--esModuleInterop', '--strict', '--skipLibCheck'
  ], { cwd: root, stdio: 'inherit' })
  const file = join(compiled, 'beammp.js')
  const loaded = new Module(file)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(compiled)
  loaded.require = (name) => {
    if (name === 'child_process') return { spawn: fakeSpawn }
    if (name === './proctree') return { killProcessTree: (proc) => kills.push(proc) }
    if (name === 'fs') return { ...require(name), readFileSync: (file, ...args) => file === '/etc/os-release'
      ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : readFileSync(file, ...args) }
    return require(name)
  }
  loaded._compile(readFileSync(file, 'utf8'), file)
  const provider = loaded.exports
  const { beammpAssetName, selectBeammpAsset, validateBeammpSettings, beammpDefaults,
    getBeammpSettings, setBeammpSettings, updateBeammpName, beammpEnvironment,
    redactBeammpLog, installBeammp, startBeammp, BEAMMP_SETTINGS_FILE, BEAMMP_INSTALL_FILE } = provider
  const platform = (name, arch = 'x64') => {
    Object.defineProperty(process, 'platform', { value: name })
    Object.defineProperty(process, 'arch', { value: arch })
  }
  const release = (name = 'BeamMP-Server.exe', extra = {}) => ({
    tag_name: 'v3.9.3', prerelease: false, draft: false,
    assets: [{ name, size: binary.length, digest: `sha256:${checksum}`,
      browser_download_url: `https://github.com/BeamMP/BeamMP-Server/releases/download/v3.9.3/${name}` }], ...extra
  })
  mkdirSync(server, { recursive: true })

  test('selects exact Windows and supported Ubuntu/Debian architecture builds', () => {
    assert.equal(beammpAssetName({ platform: 'win32', arch: 'x64' }), 'BeamMP-Server.exe')
    for (const [distro, version] of [['ubuntu', '22.04'], ['ubuntu', '24.04'], ['debian', '12'], ['debian', '13']]) {
      for (const arch of ['x64', 'arm64']) assert.equal(beammpAssetName({ platform: 'linux', arch,
        osRelease: `ID=${distro}\nVERSION_ID="${version}"\n` }), `BeamMP-Server.${distro}.${version}.${arch === 'x64' ? 'x86_64' : 'arm64'}`)
    }
    assert.throws(() => beammpAssetName({ platform: 'darwin', arch: 'arm64' }), /unsupported/)
    assert.throws(() => beammpAssetName({ platform: 'win32', arch: 'arm64' }), /unsupported/)
    assert.throws(() => beammpAssetName({ platform: 'linux', arch: 'x64', osRelease: 'ID=fedora\nVERSION_ID=43\n' }), /requires Ubuntu/)
    assert.throws(() => beammpAssetName({ platform: 'linux', arch: 'x64', osRelease: 'ID=ubuntu\nVERSION_ID=26.04\n' }), /requires Ubuntu/)
  })

  test('accepts only a unique stable official asset with a valid bounded size/checksum', () => {
    const host = { platform: 'win32', arch: 'x64' }
    assert.equal(selectBeammpAsset(release(), host).name, 'BeamMP-Server.exe')
    for (const change of [{ prerelease: true }, { draft: true }, { tag_name: 'v3.9.3-rc1' }, { assets: [] }]) {
      assert.throws(() => selectBeammpAsset(release(undefined, change), host))
    }
    assert.throws(() => selectBeammpAsset(release(undefined, { assets: [...release().assets, ...release().assets] }), host), /unambiguous/)
    for (const change of [{ browser_download_url: 'https://evil.test/BeamMP-Server.exe' },
      { browser_download_url: 'https://github.com/Other/BeamMP-Server/releases/download/v3.9.3/BeamMP-Server.exe' },
      { size: 0 }, { size: 151 * 1024 * 1024 }, { digest: 'sha256:bad' }]) {
      assert.throws(() => selectBeammpAsset(release(undefined, { assets: [{ ...release().assets[0], ...change }] }), host))
    }
  })

  test('rejects invalid caps, unsafe resource/map paths, unknown settings and injected control characters', () => {
    for (const updates of [{ MaxPlayers: '0' }, { MaxPlayers: '129' }, { MaxCars: '21' }, { Port: '65536' },
      { Port: '1e3' }, { Private: 'yes' }, { Name: '' }, { Description: 'first\nBEAMMP_AUTH_KEY=oops' },
      { Map: '/levels/../../secret/info.json' }, { Map: '/levels/my_map/info.json --shell' },
      { ResourceFolder: '../other-server' }, { AuthKey: authKey }]) {
      assert.throws(() => validateBeammpSettings({ ...beammpDefaults(), ...updates }))
    }
    assert.equal(validateBeammpSettings({ ...beammpDefaults(), Name: 'Ryan’s "Server" #1 = fun', Private: 'FALSE' }).Private, 'false')
  })

  test('credentials stay outside downloadable settings and API responses, with explicit clearing', () => {
    let result = setBeammpSettings(server, secret, { Name: 'Test server', AuthKey: authKey })
    assert.equal(result.AuthKeyConfigured, 'true')
    assert.equal(result.AuthKey, undefined)
    assert.equal(readFileSync(secret, 'utf8'), authKey)
    assert.ok(!readFileSync(join(server, BEAMMP_SETTINGS_FILE), 'utf8').includes(authKey))
    assert.ok(!existsSync(join(server, 'ServerConfig.toml')))
    setBeammpSettings(server, secret, { AuthKey: '', Description: 'A "quoted" # value = survives' })
    assert.equal(readFileSync(secret, 'utf8'), authKey, 'blank form does not erase the key')
    assert.equal(getBeammpSettings(server, secret).Description, 'A "quoted" # value = survives')
    updateBeammpName(server, 'New name')
    assert.equal(getBeammpSettings(server, secret).Name, 'New name')
    assert.throws(() => setBeammpSettings(server, secret, { AuthKey: 'bad key', MaxPlayers: '4' }), /AuthKey/)
    assert.equal(getBeammpSettings(server, secret).MaxPlayers, '8', 'bad update does not partially change settings')
    assert.throws(() => setBeammpSettings(server, join(server, 'inside.key'), { AuthKey: authKey }), /outside/)
    result = setBeammpSettings(server, secret, { ClearAuthKey: 'true' })
    assert.equal(result.AuthKeyConfigured, 'false')
    assert.ok(!existsSync(secret))
    setBeammpSettings(server, secret, { AuthKey: authKey })
  })

  test('config-disabled spawn environment supplies isolated settings without host BeamMP overrides', () => {
    const env = beammpEnvironment(beammpDefaults('My server', 31000), authKey, {
      PATH: '/bin', BEAMMP_PORT: 'wrong', BEAMMP_AUTH_KEY: 'someone else', BEAMMP_PROVIDER_CUSTOM: 'unsafe'
    })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.BEAMMP_PROVIDER_CUSTOM, undefined)
    assert.equal(env.BEAMMP_PROVIDER_DISABLE_CONFIG, 'true')
    assert.equal(env.BEAMMP_AUTH_KEY, authKey)
    assert.equal(env.BEAMMP_PORT, '31000')
    assert.equal(env.BEAMMP_RESOURCE_FOLDER, 'Resources')
    assert.equal(env.BEAMMP_IP, '0.0.0.0')
  })

  test('AuthKey is removed from ordinary and ANSI console output', () => {
    assert.ok(!redactBeammpLog(`\x1b[31mAuthKey = "${authKey}"\x1b[0m`, authKey).includes(authKey))
    assert.equal(redactBeammpLog(`token ${authKey}, repeated ${authKey}`, authKey), 'token [REDACTED], repeated [REDACTED]')
    assert.equal(redactBeammpLog('BEAMMP_AUTH_KEY=another-secret', ''), 'BEAMMP_AUTH_KEY=[REDACTED]')
  })

  test('unsupported macOS refuses install before fetching anything', async () => {
    platform('darwin', 'arm64')
    let calls = 0
    globalThis.fetch = async () => { calls++; throw new Error('must not fetch') }
    await assert.rejects(installBeammp(server, 'Test', 30814, () => {}), /unsupported/)
    assert.equal(calls, 0)
    platform('win32')
  })

  test('downloads only the official stable binary, verifies digest and seeds resource folders', async () => {
    platform('win32')
    const calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return calls.length === 1 ? Response.json(release()) : new Response(binary)
    }
    const version = await installBeammp(server, 'Preserve this server', 30814, () => {})
    assert.equal(version, 'v3.9.3')
    assert.equal(calls[0], 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest')
    assert.equal(calls[1], release().assets[0].browser_download_url)
    assert.deepEqual(readFileSync(join(server, 'BeamMP-Server.exe')), binary)
    assert.equal(JSON.parse(readFileSync(join(server, BEAMMP_INSTALL_FILE), 'utf8')).sha256, checksum)
    assert.equal(getBeammpSettings(server, secret).Name, 'New name', 'install preserves existing settings')
    assert.ok(existsSync(join(server, 'Resources', 'Client')))
    assert.ok(existsSync(join(server, 'Resources', 'Server')))
    assert.ok(!existsSync(join(server, 'ServerConfig.toml')))
  })

  test('bad checksums and truncated/oversized downloads leave installed binary intact and clean temp files', async () => {
    for (const bytes of [Buffer.from('bad'), Buffer.alloc(binary.length), Buffer.alloc(binary.length + 1)]) {
      let calls = 0
      globalThis.fetch = async () => ++calls === 1 ? Response.json(release()) : new Response(bytes)
      await assert.rejects(installBeammp(server, 'Test', 30814, () => {}), /incomplete|checksum|exceeded/)
      assert.deepEqual(readFileSync(join(server, 'BeamMP-Server.exe')), binary)
      assert.ok(!readdirSync(server).some((name) => name.startsWith('.beammp-download-')))
    }
  })

  test('spawns native binary without shell or credentials in argv; console and graceful exit use stdin', () => {
    platform('win32')
    const logs = [], ready = [], exits = [], players = []
    const handle = startBeammp(server, 32000, secret, null, {
      onLog: (line) => logs.push(line), onReady: () => ready.push(true), onExit: (code) => exits.push(code),
      onPlayers: (names) => players.push(names)
    })
    const run = spawns.at(-1)
    assert.equal(run.executable, join(server, 'BeamMP-Server.exe'))
    assert.deepEqual(run.args, [])
    assert.equal(run.options.cwd, server)
    assert.equal(run.options.shell, false)
    assert.equal(run.options.env.BEAMMP_PORT, '32000')
    assert.equal(run.options.env.BEAMMP_PROVIDER_DISABLE_CONFIG, 'true')
    assert.ok(!JSON.stringify(run.args).includes(authKey))
    run.proc.stdout.write(`AuthKey=${authKey.slice(0, 10)}`)
    run.proc.stdout.write(`${authKey.slice(10)}\nALL SYSTEMS STARTED SUCCESSFULLY, EVERYTHING IS OKAY\n`)
    assert.equal(ready.length, 1)
    assert.ok(logs.every((line) => !line.includes(authKey)), 'chunk boundaries do not bypass secret redaction')
    run.proc.stdout.write('[27/10/26 10:00:00] [INFO] Ryan : Connec')
    assert.deepEqual(players, [[]], 'incomplete client messages do not invent a player')
    run.proc.stdout.write('ted\n[27/10/26 10:00:01] [INFO] Alice : Connected\n')
    run.proc.stdout.write('[27/10/26 10:00:02] [INFO] Ryan Connection Terminated\n')
    assert.deepEqual(players, [[], ['Ryan'], ['Ryan', 'Alice'], ['Alice']])
    handle.command('help')
    assert.throws(() => handle.command('help\nexit'), /one BeamMP/)
    handle.stop(); handle.stop()
    assert.deepEqual(run.writes, ['help\n', 'exit\n'])
    run.proc.emit('exit', 0)
    run.proc.emit('error', new Error('late duplicate'))
    assert.deepEqual(exits, [0])
    assert.throws(() => handle.command('help'), /unavailable/)
  })

  test('unsuccessful startup is stopped immediately and cannot become ready from a late tail', () => {
    const ready = [], exits = []
    const handle = startBeammp(server, 30814, secret, null, { onLog() {}, onReady: () => ready.push(true), onExit: (code) => exits.push(code) })
    const run = spawns.at(-1)
    const killed = kills.length
    run.proc.stderr.write('STARTUP NOT SUCCESSFUL\nSTARTUP NOT SUCCESSFUL\n')
    assert.equal(kills.length, killed + 1)
    run.proc.stdout.write('ALL SYSTEMS STARTED SUCCESSFULLY')
    run.proc.emit('exit', 1)
    assert.deepEqual(ready, [])
    assert.deepEqual(exits, [1])
    handle.stop()
  })

  test('unmodelled secrets in a hand-edited settings file are rejected rather than returned', () => {
    const config = join(server, BEAMMP_SETTINGS_FILE)
    const saved = readFileSync(config, 'utf8')
    writeFileSync(config, JSON.stringify({ ...beammpDefaults(), AuthKey: authKey }))
    assert.throws(() => getBeammpSettings(server, secret), /Unsupported BeamMP setting: AuthKey/)
    writeFileSync(config, saved)
  })

  test('missing credentials stop before a process is launched', () => {
    setBeammpSettings(server, secret, { ClearAuthKey: 'true' })
    const before = spawns.length
    assert.throws(() => startBeammp(server, 30814, secret, null, { onLog() {}, onReady() {}, onExit() {} }), /AuthKey/)
    assert.equal(spawns.length, before)
  })

  test('Linux starts its native binary through a validated CPU allocation without a shell', () => {
    setBeammpSettings(server, secret, { AuthKey: authKey })
    writeFileSync(join(server, 'BeamMP-Server'), binary)
    platform('linux')
    try {
      const cb = { onLog() {}, onReady() {}, onExit() {} }
      assert.throws(() => startBeammp(server, 30814, secret, '1; touch /tmp/unsafe', cb), /CPU allocation/)
      const handle = startBeammp(server, 30814, secret, '1,3', cb)
      const run = spawns.at(-1)
      assert.equal(run.executable, 'taskset')
      assert.deepEqual(run.args, ['-c', '1,3', join(server, 'BeamMP-Server')])
      assert.equal(run.options.detached, true)
      assert.equal(run.options.shell, false)
      assert.ok(!JSON.stringify(run.args).includes(authKey))
      handle.stop()
      assert.deepEqual(run.writes, ['exit\n'])
      run.proc.emit('exit', 0)
    } finally { platform('win32') }
  })

  let passed = 0
  for (const { name, run } of tests) {
    await run()
    passed++
    console.log(`ok ${passed} - ${name}`)
  }
  console.log(`${passed} BeamMP provider tests passed.`)
} finally {
  globalThis.fetch = savedFetch
  Object.defineProperty(process, 'platform', platformDescriptor)
  Object.defineProperty(process, 'arch', archDescriptor)
  rmSync(compiled, { recursive: true, force: true })
  rmSync(fixtures, { recursive: true, force: true })
}
