// Runs the actual hosting provisioner against fake cloud/provider boundaries.
// No network, Electron app, credentials, real servers, or database changes.
// Usage: node scripts/smoke-beammp-provisioning.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import vm from 'node:vm'

const ROOT = resolve(import.meta.dirname, '..')
const cacheRoot = join(ROOT, 'node_modules', '.cache')
mkdirSync(cacheRoot, { recursive: true })
const compiled = mkdtempSync(join(cacheRoot, 'beammp-provisioning-test-'))
const clone = (value) => JSON.parse(JSON.stringify(value))
const OWNER = 'host-account'
const ORDER = 'order-one'
const SERVER = 'server-one'
let passed = 0

try {
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    join(ROOT, 'src/main/services/hostingOrders.ts'), '--ignoreConfig',
    '--outDir', compiled, '--module', 'commonjs', '--target', 'es2022',
    '--noCheck', '--noResolve'
  ], { cwd: ROOT, stdio: 'inherit' })
  // Expose private entry points only in this disposable compiled copy. The
  // shipped module remains unchanged, and every branch under test is real code.
  const product = readFileSync(join(compiled, 'hostingOrders.js'), 'utf8') +
    '\nmodule.exports.__test = { tick, provision, claimOrder, finishClaim };\n'

  function harness(options = {}) {
    const plan = { id: 'beammp-plan', name: 'BeamMP', game: 'beammp', max_players: 12, memory_mb: 1024, cpu_cores: 2 }
    const order = {
      id: ORDER, user_id: 'customer-account', plan_id: plan.id, server_name: 'Customer BeamMP',
      reference: 'BEAM-1', status: 'active', server_id: options.attached ? SERVER : null,
      paid_until: '2099-01-01T00:00:00.000Z', note: '', config: null
    }
    const tables = {
      profiles: [{ id: OWNER, is_admin: options.admin !== false }],
      hosting_plans: [plan], hosting_orders: [order], server_shares: []
    }
    const calls = { rpc: [], writes: [], create: [], start: [], remove: [], limits: [], automation: [], mail: [], notices: [], open: [], rules: [], announce: [] }
    const records = options.adopted || options.attached ? [{
      id: SERVER, name: order.server_name, game: 'beammp', port: 30814, orderId: ORDER,
      limitsPlan: { memoryMb: 1024, maxPlayers: 12, cpuCores: 2 }
    }] : []
    const states = { [SERVER]: { state: options.state ?? 'stopped' } }
    const timers = new Map()
    let nextTimer = 0
    class Query {
      constructor(table) { this.table = table; this.filters = []; this.action = 'select' }
      select() { return this }
      eq(key, value) { this.filters.push([key, value]); return this }
      update(value) { this.action = 'update'; this.value = value; return this }
      upsert(value) { this.action = 'upsert'; this.value = value; return this }
      delete() { this.action = 'delete'; return this }
      async execute() {
        const rows = tables[this.table] ?? []
        const matching = rows.filter((row) => this.filters.every(([key, value]) => row[key] === value))
        if (this.action === 'select') return { data: clone(matching), error: null }
        calls.writes.push({ table: this.table, action: this.action, value: clone(this.value ?? {}), filters: clone(this.filters) })
        if (this.action === 'update') matching.forEach((row) => Object.assign(row, clone(this.value)))
        if (this.action === 'upsert') {
          const existing = rows.find((row) => row.server_id === this.value.server_id && row.grantee_id === this.value.grantee_id)
          if (existing) Object.assign(existing, clone(this.value))
          else rows.push(clone(this.value))
        }
        if (this.action === 'delete') tables[this.table] = rows.filter((row) => !matching.includes(row))
        return { data: null, error: null }
      }
      async maybeSingle() { const result = await this.execute(); return { ...result, data: result.data?.[0] ?? null } }
      then(onResult, onError) { return this.execute().then(onResult, onError) }
    }
    const supabase = {
      auth: { getSession: async () => ({ data: { session: { user: { id: OWNER } } } }) },
      from: (table) => new Query(table),
      rpc: async (name, params) => {
        calls.rpc.push({ name, params: clone(params) })
        const result = await options.rpc?.(name, params) ?? { data: true, error: null }
        if (name === 'hosting_finish' && result.data === true && !result.error) {
          const target = tables.hosting_orders.find((row) => row.id === params.order_id)
          Object.assign(target, { server_id: params.new_server_id, note: 'Starting your server…' })
        }
        return result
      },
      functions: { invoke: async (name, body) => { calls.mail.push({ name, ...clone(body) }); return { error: null } } }
    }
    const modules = {
      'dns/promises': { resolve4: async () => [] },
      '@shared/cloudConfig': { isCloudConfigured: () => true },
      './cloud': { getClient: () => supabase, getAccessToken: async () => 'test-session-token' },
      './device': { deviceId: () => 'capable-node' },
      './steamgames': { isSteamGame: () => false },
      './hosting': {
        getShareInfo: async () => ({ publicIp: '203.0.113.10' }),
        startTunnel: async () => { throw new Error('BeamMP must never use the Minecraft TCP tunnel') },
        stopTunnel: () => {}
      },
      './hostNames': { assignHost: () => false, hostPool: () => [], listAssignedHosts: () => [], updateDuckDns: async () => null },
      './notifications': { notifyPhones: (...args) => calls.notices.push(args) },
      './settings': { getSettings: () => ({}) },
      './ports': {
        mainPortProtocol: () => 'UDP', companionPorts: (_game, port) => [{ port, protocol: 'TCP' }],
        openRules: async (...args) => calls.rules.push(clone(args)), closeRules: async () => {},
        statusOf: () => ({ open: options.tcpOpen !== false, error: 'TCP mapping refused' })
      },
      './upnp': {
        refreshExternalIp: async () => false, closePort: async () => {},
        openPort: async (...args) => {
          calls.open.push(clone(args))
          if (options.udpOpen === false) throw new Error('UDP mapping refused')
          return { externalIp: '203.0.113.10' }
        }
      },
      './versions': { getMinecraftVersions: async () => { throw new Error('BeamMP must not resolve a Minecraft version') } },
      './server': {
        listLocalServers: () => records.slice(),
        getServerProperties: () => ({ AuthKeyConfigured: options.configured ? 'true' : 'false' }),
        getServerStates: () => states,
        getServerPublicAddress: () => options.existingAddress ?? null,
        announceServerByPort: (...args) => calls.announce.push(args),
        createServer: async (input) => {
          calls.create.push(clone(input))
          await options.onCreate?.({ timers, calls })
          const record = { id: SERVER, name: input.name, game: input.source.type, orderId: input.orderId, port: 30814 }
          records.push(record)
          return record
        },
        deleteServer: async (id) => { calls.remove.push(id); records.splice(records.findIndex((record) => record.id === id), 1) },
        setServerLimits: (...args) => calls.limits.push(clone(args)),
        setServerAutomation: (...args) => calls.automation.push(clone(args)),
        setServerProperties: () => { throw new Error('BeamMP plan must not write Minecraft properties') },
        startServer: async (id) => {
          calls.start.push(id)
          states[id] = { state: options.afterStart ?? 'starting' }
          if (options.startError) throw new Error(options.startError)
        },
        stopServer: () => {}
      }
    }
    const module = { exports: {} }
    vm.runInNewContext(product, {
      module, exports: module.exports,
      require: (name) => {
        assert.ok(Object.hasOwn(modules, name), `unexpected product dependency: ${name}`)
        return modules[name]
      },
      console, Date,
      setInterval: (fn, milliseconds) => { const id = ++nextTimer; timers.set(id, { fn, milliseconds }); return id },
      clearInterval: (id) => timers.delete(id),
      setTimeout: () => { throw new Error('test must invoke the provisioner directly instead of starting background services') }
    }, { filename: 'actual-hostingOrders.js' })
    return { ...module.exports.__test, calls, tables, records, states, timers }
  }
  const noReady = (test) => {
    assert.equal(test.calls.mail.some((call) => call.body.kind === 'ready'), false, 'no premature ready email')
    assert.equal(test.tables.hosting_orders[0].note.startsWith('Ready'), false, 'no premature ready order note')
  }
  const noExposure = (test) => {
    assert.equal(test.calls.open.length, 0)
    assert.equal(test.calls.rules.length, 0)
    assert.equal(test.calls.announce.length, 0)
  }
  const tests = []
  const test = (name, run) => tests.push({ name, run })

  test('a missing BeamMP claim RPC fails closed before creating or sharing any server', async () => {
    const target = harness({ rpc: async () => ({ data: null, error: { message: 'Could not find function public.hosting_claim_beammp in the schema cache' } }) })
    await target.tick()
    assert.equal(target.calls.create.length, 0)
    assert.equal(target.tables.server_shares.length, 0)
    assert.equal(target.tables.hosting_orders[0].server_id, null)
    assert.match(target.tables.hosting_orders[0].note, /BeamMP.*migration/i)
    noReady(target)
    noExposure(target)
  })

  test('a refused or unreachable claim never creates a competing server', async () => {
    for (const result of [{ data: false, error: null }, { data: null, error: { message: 'network unavailable' } }]) {
      const target = harness({ rpc: async () => result })
      await target.tick()
      assert.equal(target.calls.create.length, 0)
      assert.equal(target.tables.server_shares.length, 0)
      noReady(target)
    }
  })

  test('missing AuthKey installs, attaches and shares BeamMP without starting or announcing readiness', async () => {
    const target = harness()
    await target.tick()
    assert.equal(target.calls.create.length, 1)
    assert.deepEqual(target.calls.create[0].source, { type: 'beammp', maxPlayers: 12 })
    assert.equal(target.calls.create[0].orderId, ORDER)
    assert.equal(target.tables.hosting_orders[0].server_id, SERVER)
    assert.equal(target.tables.server_shares.length, 1)
    assert.equal(target.tables.server_shares[0].grantee_id, 'customer-account')
    assert.equal(target.calls.automation[0][1].autoStart, false)
    assert.equal(target.calls.start.length, 0)
    assert.match(target.tables.hosting_orders[0].note, /authentication key.*Start/i)
    assert.equal(/AuthKey|authKey/.test(JSON.stringify(target.calls.writes)), false, 'credentials never enter SQL writes')
    assert.equal(target.calls.rpc.some((call) => call.name === 'hosting_claim_beammp'), true)
    assert.equal(target.calls.rpc.some((call) => call.name === 'hosting_finish'), true)
    assert.equal(target.timers.size, 0, 'lease renewal is stopped after provisioning finishes')
    noReady(target)
    noExposure(target)
  })

  test('lost finish ownership deletes the losing copy before enabling automation or sharing it', async () => {
    const target = harness({ rpc: async (name) => ({ data: name !== 'hosting_finish', error: null }) })
    await target.tick()
    assert.deepEqual(target.calls.remove, [SERVER])
    assert.equal(target.tables.hosting_orders[0].server_id, null)
    assert.equal(target.tables.server_shares.length, 0)
    assert.equal(target.calls.automation.length, 0)
    assert.equal(target.calls.start.length, 0)
    assert.equal(target.timers.size, 0)
    noReady(target)
    noExposure(target)
  })

  test('an unreachable finish preserves the local order copy for later adoption', async () => {
    const target = harness({ rpc: async (name) => name === 'hosting_finish'
      ? { data: null, error: { message: 'network unavailable' } } : { data: true, error: null } })
    await target.tick()
    assert.equal(target.calls.create.length, 1)
    assert.equal(target.calls.remove.length, 0)
    assert.equal(target.records[0].orderId, ORDER)
    assert.equal(target.tables.server_shares.length, 0)
    assert.equal(target.calls.start.length, 0)
    noReady(target)
    noExposure(target)
  })

  test('an adopted BeamMP copy is reused instead of downloading a second server', async () => {
    const target = harness({ adopted: true })
    await target.tick()
    assert.equal(target.calls.create.length, 0)
    assert.equal(target.tables.hosting_orders[0].server_id, SERVER)
    assert.equal(target.tables.server_shares.length, 1)
    assert.equal(target.calls.start.length, 0)
    noReady(target)
  })

  test('legacy claim fallback cannot bypass BeamMP claim or finish ownership RPCs', async () => {
    const target = harness({ rpc: async (name) => name === 'hosting_claim'
      ? { data: null, error: { message: 'function hosting_claim not found' } } : { data: true, error: null } })
    assert.equal(await target.claimOrder('legacy-order', 'minecraft'), true)
    await target.tick()
    assert.deepEqual(target.calls.rpc.map((call) => call.name), ['hosting_claim', 'hosting_claim_beammp', 'hosting_finish'])
    assert.equal(target.calls.writes.some((call) => call.table === 'hosting_orders' && 'server_id' in call.value), false,
      'BeamMP ownership must never be attached by the legacy direct-update fallback')
    assert.equal(target.tables.hosting_orders[0].server_id, SERVER)
  })

  test('legacy fail-open mode still refuses BeamMP when its capability RPC is missing', async () => {
    const target = harness({ rpc: async () => ({ data: null, error: { message: 'function is missing from schema cache' } }) })
    assert.equal(await target.claimOrder('legacy-order', 'minecraft'), true)
    await target.tick()
    assert.deepEqual(target.calls.rpc.map((call) => call.name), ['hosting_claim', 'hosting_claim_beammp'])
    assert.equal(target.calls.create.length, 0)
    assert.equal(target.tables.server_shares.length, 0)
    noReady(target)
    noExposure(target)
  })

  test('long BeamMP builds renew through the BeamMP-specific claim RPC', async () => {
    const target = harness({ onCreate: async ({ timers }) => {
      assert.equal(timers.size, 1)
      for (const { fn, milliseconds } of timers.values()) { assert.equal(milliseconds, 30_000); fn() }
      await Promise.resolve()
    } })
    await target.tick()
    const renewals = target.calls.rpc.filter((call) => call.name === 'hosting_claim_beammp')
    assert.equal(renewals.length, 2)
    renewals.forEach((call) => assert.deepEqual(call.params, { order_id: ORDER, node: 'capable-node', lease_seconds: 600 }))
    assert.equal(target.timers.size, 0)
  })

  test('configured new and adopted copies cannot announce Ready while starting or after failed start', async () => {
    for (const adopted of [false, true]) {
      for (const failed of [false, true]) {
        const target = harness({ adopted, configured: true, afterStart: failed ? 'stopped' : 'starting', startError: failed ? 'backend refused authentication' : undefined })
        await target.tick()
        assert.deepEqual(target.calls.start, [SERVER])
        noReady(target)
        noExposure(target)
      }
    }
  })

  test('attached orders with a missing key or a non-running BeamMP state remain unannounced', async () => {
    for (const configured of [false, true]) {
      for (const state of ['stopped', 'starting', 'error']) {
        const target = harness({ attached: true, configured, state })
        await target.tick()
        assert.equal(target.calls.create.length, 0)
        assert.equal(target.calls.start.length, 0, 'customer explicitly starts the configured server')
        assert.equal(target.tables.server_shares.length, 1)
        noReady(target)
        noExposure(target)
      }
    }
  })

  test('a running authenticated BeamMP server becomes Ready only after both transport mappings succeed', async () => {
    const target = harness({ attached: true, configured: true, state: 'running' })
    await target.tick()
    assert.equal(target.calls.open.length, 1)
    assert.equal(target.calls.open[0][1], 'UDP')
    assert.equal(target.calls.rules.length, 1)
    assert.equal(target.calls.rules[0][0][0].protocol, 'TCP')
    assert.match(target.tables.hosting_orders[0].note, /^Ready.*203\.0\.113\.10:30814/)
    assert.equal(target.calls.mail.filter((call) => call.body.kind === 'ready').length, 1)
    await target.tick()
    assert.equal(target.calls.mail.filter((call) => call.body.kind === 'ready').length, 1, 'steady readiness does not send duplicate emails')
  })

  test('a configured copy which completes startup can announce its address and send one ready email', async () => {
    const target = harness({ adopted: true, configured: true, afterStart: 'running' })
    await target.tick()
    assert.equal(target.calls.create.length, 0)
    assert.deepEqual(target.calls.start, [SERVER])
    assert.match(target.tables.hosting_orders[0].note, /^Ready.*203\.0\.113\.10:30814/)
    assert.equal(target.calls.mail.filter((call) => call.body.kind === 'ready').length, 1)
  })

  test('missing TCP or UDP mapping never turns a running BeamMP order Ready, including retry backoff', async () => {
    for (const transports of [{ tcpOpen: false }, { udpOpen: false }]) {
      const target = harness({ attached: true, configured: true, state: 'running', existingAddress: 'host.test:30814', ...transports })
      await target.tick()
      noReady(target)
      await target.tick()
      noReady(target)
    }
  })

  for (const { name, run } of tests) {
    await run()
    passed++
    console.log(`PASS ${name}`)
  }
  console.log(`\n${passed} actual provisioner integration tests passed.`)
} catch (error) {
  console.error(`FAIL after ${passed} tests`, error)
  process.exitCode = 1
} finally {
  assert.ok(compiled.startsWith(cacheRoot + sep))
  rmSync(compiled, { recursive: true, force: true })
}
