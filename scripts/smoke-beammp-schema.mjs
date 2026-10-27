// Executes the shipped migration/functions in real PostgreSQL (PGlite/WASM).
// PGlite is a test-only tool, not an ELauncher runtime dependency. Install it in
// a separate directory, then set ELAUNCHER_TEST_MODULES to that node_modules path:
// ELAUNCHER_TEST_MODULES=/tmp/db-tests/node_modules node scripts/smoke-beammp-schema.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const localRequire = createRequire(import.meta.url)
const testRequire = process.env.ELAUNCHER_TEST_MODULES
  ? createRequire(join(resolve(process.env.ELAUNCHER_TEST_MODULES), '__elauncher_tests__.cjs'))
  : localRequire
let PGlite
try {
  ;({ PGlite } = testRequire('@electric-sql/pglite'))
} catch {
  console.error('Install @electric-sql/pglite in a separate test directory and set ELAUNCHER_TEST_MODULES to its node_modules directory.')
  process.exit(1)
}

const normalize = (value) => value.replace(/\r\n/g, '\n').trim()
const schema = normalize(readFileSync(join(ROOT, 'supabase/schema.sql'), 'utf8'))
const migration = normalize(readFileSync(join(ROOT, 'supabase/migrations/2026-10-27-beammp-hosting.sql'), 'utf8'))
assert.ok(schema.endsWith(migration), 'fresh setup ends with the identical existing-cloud upgrade')
const legacySchema = schema.slice(0, -migration.length)
const functionSql = (name, source = legacySchema) => {
  const matches = [...source.matchAll(new RegExp(`create or replace function public\\.${name}\\([^]*?\\n\\$\\$;`, 'g'))]
  assert.ok(matches.length > 0, `real ${name} function found`)
  return matches.at(-1)[0]
}
const tableSql = (name) => {
  const match = legacySchema.match(new RegExp(`create table if not exists public\\.${name} \\([^]*?\\n\\);`))
  assert.ok(match, `real ${name} table found`)
  return match[0]
}
const db = new PGlite()
const ADMIN = '00000000-0000-0000-0000-000000000001'
const CUSTOMER = '00000000-0000-0000-0000-000000000002'
const games = ['minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa']
const cases = []
const test = (name, run) => cases.push({ name, run })
let passed = 0

try {
  // Supabase owns auth.uid() and the roles. Supply only that platform boundary;
  // tables, is_admin(), legacy claims, finish, and new migration are shipped SQL.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create table public.profiles (id uuid primary key, is_admin boolean not null default false);
    insert into public.profiles values ('${ADMIN}', true), ('${CUSTOMER}', false);
    ${functionSql('is_admin')}
    ${tableSql('hosting_plans')}
    alter table public.hosting_plans drop constraint hosting_plans_game_check;
    alter table public.hosting_plans add constraint hosting_plans_game_check
      check (game in ('minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa'));
    ${tableSql('hosting_orders')}
    alter table public.hosting_orders add column provisioner_id text;
    alter table public.hosting_orders add column provisioner_seen_at timestamptz;
    alter table public.hosting_orders add column target_device_id text;
    ${tableSql('hosting_hosts')}
    ${functionSql('hosting_claim')}
    ${functionSql('hosting_finish')}
    revoke execute on function public.hosting_finish(uuid, text, uuid) from public, anon;
    grant execute on function public.hosting_finish(uuid, text, uuid) to authenticated;
  `)
  for (const game of games) {
    await db.query(`insert into public.hosting_plans (id, name, game, price_monthly)
      values ($1, $1, $1, 0)`, [game])
  }
  const existingPlans = (await db.query('select * from public.hosting_plans order by id')).rows
  await db.exec(migration)
  assert.deepEqual((await db.query('select * from public.hosting_plans order by id')).rows, existingPlans)
  await db.exec(migration)
  assert.deepEqual((await db.query('select * from public.hosting_plans order by id')).rows, existingPlans)
  console.log('PASS migration is idempotent and does not create or alter paid plans')
  passed++
  await db.query(`insert into public.hosting_plans (id, name, game, price_monthly, active)
    values ('beammp', 'BeamMP test plan', 'beammp', 0, false)`)
  await assert.rejects(db.query(`insert into public.hosting_plans (id, name, game, price_monthly)
    values ('unknown', 'Unknown', 'not-a-game', 0)`), /hosting_plans_game_check/)
  console.log('PASS BeamMP game is permitted while unknown games remain rejected')
  passed++

  const asUser = async (id) => {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id])
    await db.exec('set role authenticated')
  }
  const order = async (game = 'beammp', overrides = {}) => {
    await db.exec('reset role')
    const id = randomUUID()
    await db.query(`insert into public.hosting_orders
      (id, user_id, plan_id, reference, status, target_device_id, server_id, provisioner_id, provisioner_seen_at)
      values ($1::uuid, $2, $3, $1::text, $4, $5, $6, $7, $8)`, [
      id, CUSTOMER, game, overrides.status ?? 'active', overrides.target ?? null,
      overrides.server ?? null, overrides.holder ?? null, overrides.seen ?? null
    ])
    await asUser(ADMIN)
    return id
  }
  const claim = async (id, node, beammp = true, lease) => {
    const name = beammp ? 'hosting_claim_beammp' : 'hosting_claim'
    const args = lease === undefined ? [id, node] : [id, node, lease]
    const query = lease === undefined
      ? `select public.${name}($1::uuid, $2::text) as claimed`
      : `select public.${name}($1::uuid, $2::text, $3::integer) as claimed`
    return (await db.query(query, args)).rows[0].claimed
  }
  const state = async (id) => {
    await db.exec('reset role')
    const row = (await db.query('select * from public.hosting_orders where id = $1', [id])).rows[0]
    await asUser(ADMIN)
    return row
  }
  const patch = async (id, assignments) => {
    await db.exec('reset role')
    await db.query(`update public.hosting_orders set ${assignments} where id = $1`, [id])
    await asUser(ADMIN)
  }
  const variants = [
    { game: 'beammp', beammp: true },
    { game: 'minecraft', beammp: false }
  ]

  test('old hosts can neither initially claim nor renew BeamMP orders', async () => {
    const id = await order()
    assert.equal(await claim(id, 'old-node', false), false)
    assert.equal((await state(id)).provisioner_id, null)
    await patch(id, `provisioner_id = 'old-node', provisioner_seen_at = now() - interval '5 minutes'`)
    const before = await state(id)
    assert.equal(await claim(id, 'old-node', false), false)
    assert.deepEqual((await state(id)).provisioner_seen_at, before.provisioner_seen_at)
    assert.equal(await claim(id, 'old-node', true), true)
  })

  test('legacy games retain their old RPC and cannot be claimed by the BeamMP RPC', async () => {
    for (const game of games) {
      const id = await order(game)
      assert.equal(await claim(id, 'capable-node', true), false, game)
      assert.equal(await claim(id, 'legacy-node', false), true, game)
    }
  })

  test('targeted orders are claimable only by their assigned node on both RPCs', async () => {
    for (const { game, beammp } of variants) {
      const id = await order(game, { target: 'chosen-node' })
      assert.equal(await claim(id, 'other-node', beammp), false)
      assert.equal(await claim(id, 'chosen-node', beammp), true)
    }
  })

  test('parked nodes are refused while enabled and unregistered nodes still work', async () => {
    await db.exec('reset role')
    await db.exec(`insert into public.hosting_hosts (device_id, enabled)
      values ('parked-node', false), ('enabled-node', true)`)
    for (const { game, beammp } of variants) {
      const id = await order(game)
      assert.equal(await claim(id, 'parked-node', beammp), false)
      assert.equal(await claim(id, 'enabled-node', beammp), true)
      const unregistered = await order(game)
      assert.equal(await claim(unregistered, 'unregistered-node', beammp), true)
    }
  })

  test('inactive orders and already attached servers cannot be claimed', async () => {
    for (const { game, beammp } of variants) {
      for (const status of ['awaiting_payment', 'pending_review', 'past_due', 'rejected', 'cancelled']) {
        assert.equal(await claim(await order(game, { status }), 'node', beammp), false, status)
      }
      const id = await order(game, { server: randomUUID() })
      assert.equal(await claim(id, 'node', beammp), false)
    }
  })

  test('the lease holder renews but competing nodes cannot take a fresh lease', async () => {
    for (const { game, beammp } of variants) {
      const id = await order(game, { holder: 'node-a', seen: new Date() })
      assert.equal(await claim(id, 'node-b', beammp), false)
      assert.equal(await claim(id, 'node-a', beammp), true)
      assert.equal((await state(id)).provisioner_id, 'node-a')
    }
  })

  test('expired or missing lease timestamps permit takeover, with the existing default lease', async () => {
    for (const { game, beammp } of variants) {
      const expired = await order(game, { holder: 'old-node', seen: new Date(Date.now() - 601_000) })
      assert.equal(await claim(expired, 'new-node', beammp), true)
      const missing = await order(game, { holder: 'old-node' })
      assert.equal(await claim(missing, 'new-node', beammp), true)
      const custom = await order(game, { holder: 'old-node', seen: new Date(Date.now() - 10_000) })
      assert.equal(await claim(custom, 'new-node', beammp), false, 'default remains 600 seconds')
      assert.equal(await claim(custom, 'new-node', beammp, 1), true, 'existing explicit lease parameter remains supported')
    }
  })

  test('two competing nodes have a single lease winner', async () => {
    for (const { game, beammp } of variants) {
      const id = await order(game)
      const results = await Promise.all([claim(id, 'node-a', beammp), claim(id, 'node-b', beammp)])
      assert.equal(results.filter(Boolean).length, 1)
      assert.equal((await state(id)).provisioner_id, results[0] ? 'node-a' : 'node-b')
    }
  })

  test('hosting_finish rejects an old lease holder after takeover and prevents overwriting a result', async () => {
    const id = await order('beammp', { holder: 'old-node', seen: new Date(Date.now() - 601_000) })
    assert.equal(await claim(id, 'new-node'), true)
    const serverId = randomUUID()
    const finish = async (node, server) => (await db.query(
      'select public.hosting_finish($1::uuid, $2::text, $3::uuid) as kept', [id, node, server]
    )).rows[0].kept
    assert.equal(await finish('old-node', randomUUID()), false)
    assert.equal(await finish('new-node', serverId), true)
    assert.equal(await finish('new-node', randomUUID()), false)
    assert.equal((await state(id)).server_id, serverId)
  })

  test('anonymous users lack EXECUTE and authenticated non-admins fail the real admin guard', async () => {
    const id = await order()
    await db.exec('reset role')
    for (const name of ['hosting_claim', 'hosting_claim_beammp']) {
      const signature = `public.${name}(uuid,text,integer)`
      assert.equal((await db.query(`select has_function_privilege('anon', $1, 'EXECUTE') as allowed`, [signature])).rows[0].allowed, false)
      assert.equal((await db.query(`select has_function_privilege('authenticated', $1, 'EXECUTE') as allowed`, [signature])).rows[0].allowed, true)
    }
    await db.exec('set role anon')
    await assert.rejects(claim(id, 'anon-node'), /permission denied/)
    await asUser(CUSTOMER)
    await assert.rejects(claim(id, 'customer-node'), /not authorised/)
    await assert.rejects(claim(id, 'customer-node', false), /not authorised/)
    await asUser(ADMIN)
    assert.equal(await claim(id, 'admin-node'), true)
  })

  test('claim RPCs retain SECURITY DEFINER, fixed public search path and no public grant', async () => {
    await db.exec('reset role')
    const result = await db.query(`select proname, prosecdef, proconfig,
      exists (select 1 from aclexplode(proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      from pg_proc where proname in ('hosting_claim', 'hosting_claim_beammp')`)
    assert.equal(result.rows.length, 2)
    for (const row of result.rows) {
      assert.equal(row.prosecdef, true)
      assert.ok(row.proconfig.includes('search_path=public'))
      assert.equal(row.public_execute, false)
    }
    await asUser(ADMIN)
    assert.equal(await claim(randomUUID(), 'node'), false)
    assert.equal(await claim(randomUUID(), 'node', false), false)
  })

  for (const { name, run } of cases) {
    await run()
    passed++
    console.log(`PASS ${name}`)
  }
  console.log(`\n${passed} real PostgreSQL BeamMP schema regression tests passed.`)
} catch (error) {
  console.error(`FAIL after ${passed} tests`, error)
  process.exitCode = 1
} finally {
  await db.close()
}
