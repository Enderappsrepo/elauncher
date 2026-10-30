// Use an isolated PGlite install: PGLITE_MODULE=/absolute/path/to/dist/index.js node scripts/test-nvmp-plan.mjs
// No production connection, accounts, payments, or orders are accessed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.env.PGLITE_MODULE) throw new Error('Set PGLITE_MODULE to an installed @electric-sql/pglite/dist/index.js')
const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE)).href)
const db = new PGlite()
const root = resolve(import.meta.dirname, '..')
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8')
const migration = readFileSync(resolve(root, 'supabase/migrations/2026-10-30-nvmp-plan.sql'), 'utf8')
try {
  // Begin with the actual table declaration, but no CPU column, to cover older installs.
  const table = schema.match(/create table if not exists public\.hosting_plans \([\s\S]*?\n\);/)[0]
  await db.exec(table)
  await db.exec("insert into public.hosting_plans (id,name,game,price_monthly,active) values ('existing','Keep me','ark',12.34,false);")
  await db.exec(migration)
  let row = (await db.query("select * from public.hosting_plans where id='nvmp-10'")).rows[0]
  assert.equal(row.game, 'nvmp'); assert.equal(row.max_players, 10)
  assert.equal(row.memory_mb, 4096); assert.equal(row.cpu_cores, 2)
  assert.equal(Number(row.price_monthly), 6); assert.equal(row.currency, 'USD'); assert.equal(row.active, true)
  console.log('PASS migration creates the active $6, 10-player, 4 GB, 2-core plan on an older table')

  await db.exec(migration)
  assert.equal((await db.query("select count(*)::int as count from public.hosting_plans where game='nvmp'")).rows[0].count, 1)
  assert.deepEqual((await db.query("select name,price_monthly::text,active from public.hosting_plans where id='existing'")).rows[0], { name:'Keep me', price_monthly:'12.34', active:false })
  console.log('PASS repeated migration creates no duplicate and preserves unrelated plans')

  await assert.rejects(db.exec("update public.hosting_plans set max_players=11 where id='nvmp-10';"), /hosting_plans_nvmp_slots_check/)
  await assert.rejects(db.exec("update public.hosting_plans set game='not-a-game' where id='nvmp-10';"), /hosting_plans_game_check/)
  console.log('PASS database enforces 10 slots and the recognized game list')

  await db.exec("update public.hosting_plans set price_monthly=7.50,active=false where id='nvmp-10';")
  await db.exec(migration)
  row = (await db.query("select price_monthly::text,active from public.hosting_plans where id='nvmp-10'")).rows[0]
  assert.deepEqual(row, { price_monthly:'7.50', active:false })
  console.log('PASS rerun preserves an operator price/visibility change')

  // Run every plan-constraint and plan-seed block from the full schema with existing NVMP rows.
  const blocks = [...schema.matchAll(/alter table public\.hosting_plans (?:drop|add) constraint[\s\S]*?;|insert into public\.hosting_plans[\s\S]*?on conflict \(id\) do nothing;/g)].map((m) => m[0])
  assert.ok(blocks.length >= 8)
  for (const block of blocks) await db.exec(block)
  assert.equal((await db.query("select max_players from public.hosting_plans where id='nvmp-10'")).rows[0].max_players, 10)
  console.log('PASS every full-schema plan constraint and seed can rerun with an existing NVMP plan')
} finally { await db.close() }
