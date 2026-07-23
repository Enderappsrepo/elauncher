import { useCallback, useEffect, useRef, useState } from 'react'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@shared/cloudConfig'
import { supabase } from '@web/lib/supabase'
import { Button, Skeleton, Tabs } from '@web/ui'
import { GAME_HUE, gameLabel } from '../data'
import type { Game } from '../data'
import './Shop.css'

/**
 * The shop: choose a plan, configure it, place an order.
 *
 * No money moves here, and the screen says so at every step. Placing an order
 * writes one row to hosting_orders and leaves it in awaiting_payment with a
 * reference code — the customer pays out of band on PayPal or Stripe, flags it
 * through hosting_mark(), and an operator has to approve that before any server
 * is built. A shop that implies otherwise is worse than no shop, so the words
 * "nothing has been charged" are on the confirmation itself rather than in a
 * help page nobody opens.
 *
 * Everything a customer can do from here is what the schema permits and no
 * more: insert their own order (the RLS check pins user_id, status, server_id
 * and paid_until), and move it to pending_review through hosting_mark. There is
 * no refund or capture operation in the database, so none is offered.
 *
 * This sits beside Billing, which is where an order lives once it exists.
 */

const MC_LOADERS = ['paper', 'vanilla', 'fabric', 'neoforge', 'forge'] as const
type Loader = (typeof MC_LOADERS)[number]

const LOADER_LABEL: Record<Loader, string> = {
  paper: 'Paper',
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  neoforge: 'NeoForge',
  forge: 'Forge'
}

const LOADER_HINT: Record<Loader, string> = {
  paper: 'Paper: fast, runs Bukkit and Spigot plugins.',
  vanilla: 'Vanilla: the official server, exactly as Mojang ships it.',
  fabric: 'You can add mods once it is set up, from the Mods tab.',
  neoforge: 'You can add mods once it is set up, from the Mods tab.',
  forge: 'You can add mods once it is set up, from the Mods tab.'
}

const MODES = ['fresh', 'modpack'] as const
type Mode = (typeof MODES)[number]
const MODE_LABELS: Record<Mode, string> = { fresh: 'Fresh server', modpack: 'From a modpack' }

const SOURCES = ['modrinth', 'curseforge'] as const
type Source = (typeof SOURCES)[number]
const SOURCE_LABELS: Record<Source, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge' }

/** One line per game, so a group of plans says what you would be renting. */
const GAME_BLURB: Record<Game, string> = {
  minecraft: 'Vanilla, Paper plugins, or a full modpack.',
  palworld: 'Survival and creature collecting with friends.',
  valheim: 'Co-op Viking survival and building.',
  sdtd: 'Open-world zombie survival.',
  zomboid: 'Isometric zombie survival — brutal, slow-burn, co-op.',
  tmodloader: 'Modded Terraria. Light on resources, heavy on content.',
  ark: 'Dinosaur survival, taming and tribes. Big world, big download.',
  arksa: 'The Unreal 5 remake of ARK. The heaviest server here — allow extra time on the first start.'
}

/**
 * One-click packs, above the search so ordering a themed server does not depend
 * on knowing what to type. These are Modrinth *modpack* project ids — the host
 * resolves an .mrpack from the id, so a mod id would not install.
 *
 * Loader and Minecraft version are shown, not chosen: an .mrpack declares its
 * own, and recording them here keeps the copy from drifting from what actually
 * installs. Cobblemon has no Forge build on 1.21.1, which is exactly the sort of
 * thing someone picking a loader by hand gets wrong.
 */
const FEATURED_PACKS: readonly { id: string; name: string; loader: string; mc: string; blurb: string }[] = [
  {
    id: '5FFgwNNP',
    name: 'Cobblemon',
    loader: 'Fabric',
    mc: '1.21.1',
    blurb: 'Catch, train and battle Pokémon. The official pack from the Cobblemon team.'
  },
  {
    id: 'mHMxXbIu',
    name: 'Cobblemon · NeoForge',
    loader: 'NeoForge',
    mc: '1.21.1',
    blurb: 'The same official pack, built on NeoForge instead of Fabric.'
  },
  {
    id: 'Jkb29YJU',
    name: 'COBBLEVERSE',
    loader: 'Fabric',
    mc: '1.21.1',
    blurb: 'All 1025 Pokémon, 32 gyms and four regions — an adventure rather than a sandbox.'
  }
]

const SEARCH_DEBOUNCE_MS = 350
/** Mojang's manifest is a third party in the ordering path; past this the
 *  fallback list is a better answer than a spinner that never resolves. */
const VERSIONS_TIMEOUT_MS = 6000
const MC_FALLBACK = ['1.21.4', '1.21.1', '1.20.1']

interface PlanRow {
  id: string
  name: string
  game: string
  max_players: number
  memory_mb: number
  cpu_cores: number | null
  price_monthly: number
  currency: string
  stripe_link: string | null
  /** set → card checkout via the stripe-checkout function; null → manual flow */
  stripe_price_id: string | null
  active: boolean
  sort: number
}

interface Settings {
  shopOpen: boolean
  paypal: string
  orderNote: string
}

interface Placed {
  id: string
  reference: string
  serverName: string
  plan: PlanRow
}

interface Hit {
  id: string
  name: string
  icon: string
  downloads: number
}

/** What the host reads back off the order — see minecraftSource() in
 *  src/main/services/hostingOrders.ts. Only Minecraft takes any of it. */
interface OrderConfig {
  loader?: string
  version?: string
  modpack?: string
  modpackSource?: string
}

function toPlan(raw: Record<string, unknown>): PlanRow {
  const cores = Number(raw.cpu_cores ?? 0)
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    game: String(raw.game ?? ''),
    max_players: Number(raw.max_players ?? 0),
    memory_mb: Number(raw.memory_mb ?? 0),
    cpu_cores: cores > 0 ? cores : null,
    price_monthly: Number(raw.price_monthly ?? 0),
    currency: String(raw.currency ?? 'USD'),
    stripe_link: (raw.stripe_link as string | null) ?? null,
    stripe_price_id: (raw.stripe_price_id as string | null) ?? null,
    // older clouds predate the column; an absent flag has always meant listed
    active: raw.active !== false,
    sort: Number(raw.sort ?? 0)
  }
}

function money(amount: number, currency: string): string {
  return currency === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

function readable(message: string): string {
  return /schema cache|does not exist|42P01|PGRST205/i.test(message)
    ? 'Hosting needs one migration — open Supabase → SQL Editor and run the latest schema.sql once.'
    : message
}

function msg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

/** The code that ties a bank transfer back to an order. Kept in the format the
 *  existing orders and the host's notifications already use. */
function makeReference(): string {
  return `ELH-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

function specs(plan: PlanRow): string {
  const cores = plan.cpu_cores ? `${plan.cpu_cores} CPU core${plan.cpu_cores === 1 ? '' : 's'}` : 'Shared CPU'
  return `Up to ${plan.max_players} players · ${(plan.memory_mb / 1024).toFixed(1)} GB RAM · ${cores}`
}

/**
 * Design/debug hook, in the same family as data.ts's __mockServers: render the
 * whole shop — plans, order sheet, closed and empty states — with no cloud
 * behind it. Ordering is refused in this mode rather than faked.
 */
declare global {
  interface Window {
    __mockShop?: {
      plans?: Record<string, unknown>[]
      shopOpen?: boolean
      paypal?: string
      orderNote?: string
    }
  }
}

let mcVersions: string[] | null = null

async function loadMcVersions(): Promise<string[]> {
  if (mcVersions) return mcVersions
  try {
    const res = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
      signal: AbortSignal.timeout(VERSIONS_TIMEOUT_MS)
    })
    const body = (await res.json()) as { versions?: { id?: string; type?: string }[] }
    const releases = (body.versions ?? [])
      .filter((v) => v.type === 'release' && v.id)
      .map((v) => String(v.id))
      .slice(0, 40)
    mcVersions = releases.length ? releases : MC_FALLBACK
  } catch {
    // an unreachable manifest must not block an order; the host re-resolves the
    // version anyway and these three cover the overwhelming majority
    mcVersions = MC_FALLBACK
  }
  return mcVersions
}

async function searchModrinth(query: string): Promise<Hit[]> {
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]))
  const url = `https://api.modrinth.com/v2/search?limit=12&index=relevance&query=${encodeURIComponent(query)}&facets=${facets}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Modrinth search failed (HTTP ${res.status}).`)
  const body = (await res.json()) as {
    hits?: { project_id?: string; slug?: string; title?: string; icon_url?: string | null; downloads?: number }[]
  }
  return (body.hits ?? [])
    .filter((h) => h.project_id || h.slug)
    .map((h) => ({
      id: String(h.project_id ?? h.slug),
      name: h.title || String(h.slug ?? 'Unnamed'),
      icon: h.icon_url ?? '',
      downloads: Number(h.downloads ?? 0)
    }))
}

/**
 * CurseForge modpack search through the cf-proxy edge function, so a customer
 * needs no CurseForge key of their own — the shared one is injected server
 * side. The function rejects the bare anon key, so this needs a real session.
 */
async function searchCurseForge(query: string): Promise<Hit[]> {
  const {
    data: { session }
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Sign in to search CurseForge.')
  const url =
    `${SUPABASE_URL}/functions/v1/cf-proxy/mods/search` +
    `?gameId=432&classId=4471&sortField=2&sortOrder=desc&pageSize=12&searchFilter=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }
  })
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? 'CurseForge search needs a signed-in session. Modrinth search still works.'
        : `CurseForge search failed (HTTP ${res.status}).`
    )
  }
  const body = (await res.json()) as {
    data?: { id?: number | string; name?: string; logo?: { thumbnailUrl?: string } | null; downloadCount?: number }[]
  }
  return (body.data ?? [])
    .filter((h) => h.id !== undefined)
    .map((h) => ({
      id: String(h.id),
      name: String(h.name ?? 'Unnamed'),
      icon: h.logo?.thumbnailUrl ?? '',
      downloads: Number(h.downloadCount ?? 0)
    }))
}

interface ShopState {
  plans: PlanRow[]
  settings: Settings
  /** how many of the customer's own orders are still waiting to be paid */
  owing: number
  loading: boolean
  error: string | null
  /** true when the screen is being driven by __mockShop rather than the cloud */
  mocked: boolean
}

const EMPTY: ShopState = {
  plans: [],
  settings: { shopOpen: true, paypal: '', orderNote: '' },
  owing: 0,
  loading: true,
  error: null,
  mocked: false
}

/**
 * Loaded once rather than polled. Plans and the shop switch change about as
 * often as prices do, and a background refresh landing mid-order would rewrite
 * the sheet under someone's fingers. What matters — that the shop is still open
 * and the plan still listed — is re-read at the moment the order is placed.
 */
function useShop(userId: string): ShopState & { reload: () => Promise<void> } {
  const [state, setState] = useState<ShopState>(EMPTY)

  const load = useCallback(async (): Promise<void> => {
    const mock = typeof window === 'undefined' ? undefined : window.__mockShop
    if (mock) {
      setState({
        plans: (mock.plans ?? []).map(toPlan).filter((p) => p.active),
        settings: {
          shopOpen: mock.shopOpen !== false,
          paypal: mock.paypal ?? '',
          orderNote: mock.orderNote ?? ''
        },
        owing: 0,
        loading: false,
        error: null,
        mocked: true
      })
      return
    }
    try {
      const [plansRes, settingsRes, owingRes] = await Promise.all([
        supabase.from('hosting_plans').select('*').order('sort'),
        supabase.from('hosting_settings').select('*').eq('id', 1).maybeSingle(),
        supabase
          .from('hosting_orders')
          .select('id')
          .eq('user_id', userId)
          .in('status', ['awaiting_payment', 'past_due'])
      ])
      if (plansRes.error) throw new Error(plansRes.error.message)
      const cfg = (settingsRes.data ?? null) as Record<string, unknown> | null

      setState({
        // the hidden ones are the operator's business; a customer is only ever
        // shown what they are allowed to buy
        plans: (plansRes.data ?? []).map((r) => toPlan(r as Record<string, unknown>)).filter((p) => p.active),
        settings: {
          // old clouds without the column read as open, which is how they behave
          shopOpen: cfg?.shop_open !== false,
          paypal: String(cfg?.paypal_me ?? ''),
          orderNote: String(cfg?.order_note ?? '')
        },
        owing: (owingRes.data ?? []).length,
        loading: false,
        error: null,
        mocked: false
      })
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, error: readable(msg(e, 'Could not reach the cloud.')) }))
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { ...state, reload: load }
}

/**
 * Where Stripe Checkout drops the customer afterwards. Read once, then scrubbed
 * from the URL so a reload doesn't replay the banner (or re-announce a payment
 * that is by now last week's).
 */
function takeStripeReturn(): { kind: 'success' | 'cancelled'; reference: string } | null {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('stripe')
  if (kind !== 'success' && kind !== 'cancelled') return null
  const reference = params.get('order') ?? ''
  params.delete('stripe')
  params.delete('order')
  const rest = params.toString()
  history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  return { kind, reference }
}

export function Shop({ userId }: { userId: string }): React.JSX.Element {
  const { plans, settings, owing, loading, error, mocked, reload } = useShop(userId)
  const [chosen, setChosen] = useState<PlanRow | null>(null)
  const [placed, setPlaced] = useState<Placed | null>(null)
  const [returned, setReturned] = useState(() => takeStripeReturn())

  return (
    <>
      <div className="head rise">
        <h1>Rent a server</h1>
        <p className="dim">{headline(plans, settings, loading, error)}</p>
      </div>

      {returned && (
        <section className="surface pad rise stack" style={{ marginBottom: 14 }}>
          {returned.kind === 'success' ? (
            <>
              <div className="row">
                <h2>Payment received</h2>
                <span className="spacer" />
                <span className="pill running">
                  <span className="dot" aria-hidden />
                  Paid
                </span>
              </div>
              <p className="dim">
                Order <span className="mono">{returned.reference}</span> is paid — it activates by
                itself within a few seconds, and a hosting machine starts building your server.
                Watch it appear under <b>Servers</b>; Billing has the receipt.
              </p>
            </>
          ) : (
            <>
              <h2>Checkout cancelled</h2>
              <p className="dim">
                Nothing was charged. Order <span className="mono">{returned.reference}</span> is
                saved under Billing — you can pay it from there whenever you like, or cancel it.
              </p>
            </>
          )}
          <Button variant="ghost" onClick={() => setReturned(null)}>
            Dismiss
          </Button>
        </section>
      )}

      {/* An order that exists outranks everything else on this screen: a load
          that fails a moment after one is placed must not take the reference
          code away with it. */}
      {placed ? (
        <Receipt
          placed={placed}
          settings={settings}
          mocked={mocked}
          onDone={() => {
            setPlaced(null)
            setChosen(null)
            void reload()
          }}
        />
      ) : error ? (
        <div className="stack">
          <p className="formerr" role="alert">
            {error}
          </p>
          <div className="row">
            <Button onClick={() => void reload()}>Try again</Button>
          </div>
        </div>
      ) : loading ? (
        <div className="shop-plans">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={168} />
          ))}
        </div>
      ) : chosen ? (
        <Configure
          plan={chosen}
          userId={userId}
          mocked={mocked}
          onBack={() => setChosen(null)}
          onPlaced={setPlaced}
        />
      ) : (
        <Storefront plans={plans} settings={settings} owing={owing} onChoose={setChosen} />
      )}
    </>
  )
}

function headline(plans: PlanRow[], settings: Settings, loading: boolean, error: string | null): string {
  if (loading) return 'Loading plans…'
  // a failed load has no lineup to describe, and "nothing listed" would read as
  // an answer rather than as a missing one
  if (error && plans.length === 0) return 'Could not load the plans'
  if (!settings.shopOpen) return 'Closed right now'
  if (plans.length === 0) return 'Nothing listed yet'
  const cheapest = plans.reduce((a, b) => (b.price_monthly < a.price_monthly ? b : a))
  return `${plans.length} ${plans.length === 1 ? 'plan' : 'plans'} · from ${money(cheapest.price_monthly, cheapest.currency)}/mo`
}

function Storefront({
  plans,
  settings,
  owing,
  onChoose
}: {
  plans: PlanRow[]
  settings: Settings
  owing: number
  onChoose: (plan: PlanRow) => void
}): React.JSX.Element {
  if (!settings.shopOpen) {
    return (
      <section className="surface pad rise stack">
        <h2>The shop is closed right now</h2>
        <p className="dim">
          New orders are turned off, so there is nothing to buy at the moment — check back soon.
          Servers that are already running are unaffected, and anything you have ordered is still
          under Billing.
        </p>
      </section>
    )
  }

  if (plans.length === 0) {
    return (
      <section className="surface pad rise stack">
        <h2>No plans are listed</h2>
        <p className="dim">
          The shop is open but nothing is for sale yet. Plans are set up by the host — if you were
          expecting to see one here, ask them to list it.
        </p>
      </section>
    )
  }

  // grouped by game, keeping the operator's sort order inside each group
  const groups: [string, PlanRow[]][] = []
  for (const plan of plans) {
    const found = groups.find(([game]) => game === plan.game)
    if (found) found[1].push(plan)
    else groups.push([plan.game, [plan]])
  }

  return (
    <div className="stack">
      {owing > 0 && (
        <p className="formnote">
          {owing === 1 ? 'One of your orders is' : `${owing} of your orders are`} still waiting to be
          paid. The amount and the reference to quote are under Billing — you can order again here,
          but each order is charged separately.
        </p>
      )}

      <div className="stack stagger">
        {groups.map(([game, list], i) => (
          <section key={game} className="stack shop-group" style={{ '--i': i } as React.CSSProperties}>
            <div className="row">
              <GameBadge game={game} />
              <div className="shop-group-who">
                <h2>{gameLabel(game)}</h2>
                <p className="dim shop-hint">{game in GAME_BLURB ? GAME_BLURB[game as Game] : ''}</p>
              </div>
            </div>
            <div className="shop-plans">
              {list.map((plan) => (
                <button key={plan.id} className="surface shop-plan" onClick={() => onChoose(plan)}>
                  <span className="shop-plan-name">{plan.name}</span>
                  <span className="shop-price">
                    <b>{money(plan.price_monthly, plan.currency)}</b>
                    <span className="dim">/mo</span>
                  </span>
                  <span className="dim shop-hint">{specs(plan)}</span>
                  <span className="shop-cta">Choose plan</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="dim shop-hint">
        Nothing is charged when you order. You pick a plan, the order is created with a reference
        code, and you pay separately — your server is built once the host has checked the payment.
      </p>
    </div>
  )
}

/** The game's initial and hue, matching the server cards elsewhere in the panel. */
function GameBadge({ game }: { game: string }): React.JSX.Element {
  const hue = game in GAME_HUE ? GAME_HUE[game as Game] : null
  const label = gameLabel(game)
  return (
    <span
      className="gbadge big"
      title={label}
      style={hue === null ? undefined : ({ '--hue': hue } as React.CSSProperties)}
      aria-hidden
    >
      {label.slice(0, 1)}
    </span>
  )
}

/**
 * Name the server, and for Minecraft say what should be on it.
 *
 * Every other game is a single build with nothing to choose here — its settings
 * are edited on the server itself once it exists — so the sheet is one field.
 */
function Configure({
  plan,
  userId,
  mocked,
  onBack,
  onPlaced
}: {
  plan: PlanRow
  userId: string
  mocked: boolean
  onBack: () => void
  onPlaced: (placed: Placed) => void
}): React.JSX.Element {
  const mc = plan.game === 'minecraft'
  const [name, setName] = useState('')
  const [mode, setMode] = useState<Mode>('fresh')
  const [loader, setLoader] = useState<Loader>('paper')
  const [versions, setVersions] = useState<string[] | null>(null)
  const [version, setVersion] = useState('')
  const [source, setSource] = useState<Source>('modrinth')
  const [pack, setPack] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    if (!mc) return
    let alive = true
    void loadMcVersions().then((list) => {
      if (!alive) return
      setVersions(list)
      setVersion((v) => v || list[0] || '')
    })
    return () => {
      alive = false
    }
  }, [mc])

  const trimmed = name.trim()
  const waiting = mc && mode === 'fresh' && versions === null
  const missing = !trimmed
    ? 'Name your server to continue.'
    : mc && mode === 'modpack' && !pack
      ? 'Pick a modpack, or switch to a fresh server.'
      : ''
  const ready = !missing && !waiting

  async function place(): Promise<void> {
    if (!ready) return
    setBusy(true)
    setFailed('')
    try {
      if (mocked) throw new Error('Preview mode — there is no cloud behind this, so nothing was ordered.')

      // re-read the two flags that decide whether this order may exist at all:
      // the sheet can sit open for a while, and neither the shop closing nor the
      // plan being pulled is something to find out after taking someone's money
      const [cfgRes, planRes] = await Promise.all([
        supabase.from('hosting_settings').select('shop_open').eq('id', 1).maybeSingle(),
        supabase.from('hosting_plans').select('active').eq('id', plan.id).maybeSingle()
      ])
      const cfg = (cfgRes.data ?? null) as { shop_open?: boolean } | null
      const still = (planRes.data ?? null) as { active?: boolean } | null
      if (cfg?.shop_open === false) throw new Error('The shop closed while this was open, so no order was created.')
      if (still?.active === false) throw new Error(`${plan.name} is no longer listed, so no order was created.`)

      const config: OrderConfig = {}
      if (mc) {
        if (mode === 'modpack' && pack) {
          config.modpack = pack.id
          // a Modrinth id means nothing to CurseForge, so which platform it came
          // from travels with it
          if (source === 'curseforge') config.modpackSource = 'curseforge'
        } else {
          config.loader = loader
          config.version = version
        }
      }
      const created = await insertOrder(userId, plan, trimmed, config)
      // the emailed receipt is a courtesy; the order stands whether or not mail is up
      void supabase.functions
        .invoke('order-mail', { body: { kind: 'placed', orderId: created.id } })
        .catch(() => {})
      onPlaced({ ...created, serverName: trimmed, plan })
    } catch (e) {
      setFailed(readable(msg(e, 'Could not create the order.')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack rise">
      <div className="row">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          ← All plans
        </Button>
      </div>

      <section className="surface pad stack">
        <div className="row">
          <GameBadge game={plan.game} />
          <div className="shop-group-who">
            <h2>{plan.name}</h2>
            <p className="dim shop-hint">
              {gameLabel(plan.game)} · {specs(plan)}
            </p>
          </div>
          <span className="spacer" />
          <span className="shop-price">
            <b>{money(plan.price_monthly, plan.currency)}</b>
            <span className="dim">/mo</span>
          </span>
        </div>

        <div className="field">
          <label htmlFor="shop-name">Server name</label>
          <input
            id="shop-name"
            className="input"
            value={name}
            maxLength={60}
            autoComplete="off"
            placeholder="My Server"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {mc && (
          <>
            <Tabs tabs={MODES} value={mode} onChange={setMode} labels={MODE_LABELS} />

            {mode === 'fresh' && (
              <>
                <div className="shop-two">
                  <div className="field">
                    <label htmlFor="shop-loader">Server type</label>
                    <select
                      id="shop-loader"
                      className="input shop-select"
                      value={loader}
                      onChange={(e) => setLoader(e.target.value as Loader)}
                    >
                      {MC_LOADERS.map((k) => (
                        <option key={k} value={k}>
                          {LOADER_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="shop-version">Minecraft version</label>
                    {versions === null ? (
                      <Skeleton height={46} />
                    ) : (
                      <select
                        id="shop-version"
                        className="input shop-select"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                      >
                        {versions.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <p className="dim shop-hint">{LOADER_HINT[loader]}</p>
              </>
            )}

            {mode === 'modpack' && (
              <PackPicker
                source={source}
                pack={pack}
                onSource={(next) => {
                  // switching platform drops the pick — an id from one is
                  // meaningless to the other
                  setSource(next)
                  setPack(null)
                }}
                onPick={setPack}
              />
            )}
          </>
        )}

        {failed && (
          <p className="formerr" role="alert">
            {failed}
          </p>
        )}

        <p className="formnote">
          Ordering does not charge you. It creates an order for{' '}
          <b>{money(plan.price_monthly, plan.currency)}/mo</b> with a reference code, and the next
          screen shows how to pay it. Your server is built after the host has checked the payment —
          usually the same day.
        </p>

        <Button block variant="primary" disabled={!ready || busy} onClick={() => void place()}>
          {busy ? 'Creating order…' : `Create order · ${money(plan.price_monthly, plan.currency)}/mo`}
        </Button>
        {(missing || waiting) && (
          <p className="dim shop-hint">{missing || 'Fetching the Minecraft version list…'}</p>
        )}
      </section>
    </div>
  )
}

/**
 * Insert the order.
 *
 * The awkward part is not the insert, it is what to believe when it answers
 * with an error: a request that failed on the way back has still created the
 * row, and ordering the same server twice is the one mistake this flow must not
 * make. So a failure is checked against the reference before it is reported,
 * and only a genuinely absent row is retried — with a fresh reference, since a
 * collision on that unique column is the one error worth retrying at all.
 */
async function insertOrder(
  userId: string,
  plan: PlanRow,
  serverName: string,
  config: OrderConfig
): Promise<{ id: string; reference: string }> {
  let lastMessage = 'Could not create the order.'

  for (let attempt = 0; attempt < 2; attempt++) {
    const reference = makeReference()
    const base = { user_id: userId, plan_id: plan.id, server_name: serverName, reference }

    let { data, error } = await supabase.from('hosting_orders').insert({ ...base, config }).select('id').single()
    // clouds that predate the config column: ordering still has to work there,
    // and the host falls back to a plain Paper server on the latest release
    if (error && /config|column|schema cache/i.test(error.message)) {
      ;({ data, error } = await supabase.from('hosting_orders').insert(base).select('id').single())
    }
    if (!error && data) return { id: String((data as { id: string }).id), reference }

    lastMessage = error?.message ?? lastMessage
    const { data: landed } = await supabase
      .from('hosting_orders')
      .select('id')
      .eq('reference', reference)
      .maybeSingle()
    if (landed) return { id: String((landed as { id: string }).id), reference }

    if (!/duplicate key|already exists|23505/i.test(lastMessage)) break
  }

  throw new Error(lastMessage)
}

function PackPicker({
  source,
  pack,
  onSource,
  onPick
}: {
  source: Source
  pack: { id: string; name: string } | null
  onSource: (source: Source) => void
  onPick: (pack: { id: string; name: string }) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  // a slow platform answering after a fast one would otherwise repaint the list
  // with results from the tab you just left
  const run = useRef(0)

  useEffect(() => {
    const q = query.trim()
    const mine = ++run.current
    if (!q) {
      setHits(null)
      setSearchErr('')
      setSearching(false)
      return
    }
    setSearching(true)
    setSearchErr('')
    const timer = setTimeout(() => {
      void (source === 'curseforge' ? searchCurseForge(q) : searchModrinth(q))
        .then((found) => {
          if (run.current === mine) setHits(found)
        })
        .catch((e: unknown) => {
          if (run.current !== mine) return
          setHits(null)
          setSearchErr(msg(e, 'Search failed.'))
        })
        .finally(() => {
          if (run.current === mine) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, source])

  return (
    <>
      <Tabs tabs={SOURCES} value={source} onChange={onSource} labels={SOURCE_LABELS} />

      {source === 'modrinth' && (
        <>
          <p className="dim shop-hint">Popular packs</p>
          <div className="stack shop-list">
            {FEATURED_PACKS.map((p) => (
              <button
                key={p.id}
                className={`shop-pack${pack?.id === p.id ? ' on' : ''}`}
                onClick={() => onPick({ id: p.id, name: p.name })}
              >
                <span className="gbadge" aria-hidden>
                  {p.name.slice(0, 1)}
                </span>
                <span className="shop-pack-who">
                  <span className="shop-pack-name">{p.name}</span>
                  <span className="dim shop-hint">{p.blurb}</span>
                </span>
                <span className="shop-tag">{pack?.id === p.id ? 'Picked' : `${p.loader} ${p.mc}`}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="field">
        <label htmlFor="shop-pack-search">Search {SOURCE_LABELS[source]} modpacks</label>
        <input
          id="shop-pack-search"
          className="input"
          value={query}
          autoComplete="off"
          placeholder={source === 'curseforge' ? 'All the Mods, RLCraft…' : 'Better MC, Cobblemon…'}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {searching && <Skeleton height={46} />}

      {!searching && searchErr && (
        <p className="formerr" role="alert">
          {searchErr}
        </p>
      )}

      {!searching && !searchErr && hits === null && (
        <p className="dim shop-hint">
          Type to search{source === 'modrinth' ? ', or pick one above.' : '.'}
        </p>
      )}

      {!searching && !searchErr && hits?.length === 0 && <p className="dim shop-hint">Nothing matched that.</p>}

      {!searching && !searchErr && hits && hits.length > 0 && (
        <div className="stack shop-list shop-results">
          {hits.map((hit) => (
            <button
              key={hit.id}
              className={`shop-pack${pack?.id === hit.id ? ' on' : ''}`}
              onClick={() => onPick({ id: hit.id, name: hit.name })}
            >
              <PackIcon url={hit.icon} name={hit.name} />
              <span className="shop-pack-who">
                <span className="shop-pack-name">{hit.name}</span>
                <span className="dim shop-hint">{hit.downloads.toLocaleString()} downloads</span>
              </span>
              {pack?.id === hit.id && <span className="shop-tag">Picked</span>}
            </button>
          ))}
        </div>
      )}

      {pack && (
        <p className="formnote">
          Your server will be built from <b>{pack.name}</b>. Its own loader and Minecraft version
          come with the pack, so there is nothing else to choose.
        </p>
      )}
    </>
  )
}

function PackIcon({ url, name }: { url: string; name: string }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (!url || broken) {
    return (
      <span className="gbadge" aria-hidden>
        {name.slice(0, 1)}
      </span>
    )
  }
  return <img className="shop-icon" src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/**
 * What was just created, and what it takes to turn it into a server.
 *
 * The order exists and nothing has been paid, which is an easy state to
 * misrepresent — so it is spelt out rather than implied by a tick and a
 * "thanks". The buttons are the two real operations: an outbound payment link,
 * and hosting_mark() to tell the host the money has been sent.
 */
function Receipt({
  placed,
  settings,
  mocked,
  onDone
}: {
  placed: Placed
  settings: Settings
  mocked: boolean
  onDone: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [carding, setCarding] = useState(false)
  const [flagged, setFlagged] = useState(false)
  const [failed, setFailed] = useState('')

  const { plan } = placed
  const price = money(plan.price_monthly, plan.currency)
  const paypal = settings.paypal
    ? `https://paypal.me/${encodeURIComponent(settings.paypal)}/${plan.price_monthly.toFixed(2)}`
    : ''
  const card = Boolean(plan.stripe_price_id)

  /** Real checkout: the stripe-checkout function opens a session for this order
   *  and the webhook activates it — no review step, no reference-typing. */
  async function payByCard(): Promise<void> {
    setCarding(true)
    setFailed('')
    try {
      if (mocked) throw new Error('Preview mode — there is no cloud behind this.')
      const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>(
        'stripe-checkout',
        { body: { order_id: placed.id, return_url: `${location.origin}${location.pathname}` } }
      )
      if (error) {
        // the function writes its reason as JSON; surface that, not the wrapper
        let reason = error.message
        try {
          const ctx = (error as { context?: Response }).context
          if (ctx) reason = ((await ctx.json()) as { error?: string }).error ?? reason
        } catch {
          /* keep the wrapper message */
        }
        throw new Error(reason)
      }
      if (!data?.url) throw new Error(data?.error ?? 'Stripe did not return a checkout link.')
      window.location.assign(data.url)
      // no setCarding(false): the page is navigating away, and re-enabling the
      // button for a beat first would invite a second session
    } catch (e) {
      setFailed(msg(e, 'Could not open the card checkout.'))
      setCarding(false)
    }
  }

  async function flag(): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      if (mocked) throw new Error('Preview mode — there is no cloud behind this.')
      const { error } = await supabase.rpc('hosting_mark', { order_id: placed.id, new_status: 'pending_review' })
      if (error) throw new Error(error.message)
      setFlagged(true)
    } catch (e) {
      setFailed(msg(e, 'Could not send that.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="surface pad rise stack">
      <div className="row">
        <h2>Order created — not paid yet</h2>
        <span className="spacer" />
        <span className="pill busy">
          <span className="dot" aria-hidden />
          Awaiting payment
        </span>
      </div>

      <p className="dim shop-hint">
        {placed.serverName} · {plan.name} · {price}/mo
      </p>

      {card ? (
        <p className="formnote">
          Nothing has been charged. Pay by card and this order handles itself — it activates the
          moment Stripe confirms, and your server starts building. Reference{' '}
          <b className="mono">{placed.reference}</b> is on the receipt if you ever need to quote it.
        </p>
      ) : (
        <p className="formnote">
          Nothing has been charged. Your reference is <b className="mono">{placed.reference}</b> —
          send <b>{price}</b> and put that reference in the payment note, because it is what ties
          the payment to this order. The host checks it and your server is built after that.
        </p>
      )}

      {!paypal && !plan.stripe_link && !card && (
        <p className="formnote">
          The host has not set up a payment link yet. Contact them and quote reference{' '}
          <span className="mono">{placed.reference}</span> — the order is saved either way.
        </p>
      )}

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      <div className="stack">
        {card && (
          <Button variant="primary" block disabled={carding} onClick={() => void payByCard()}>
            {carding ? 'Opening secure checkout…' : `Pay ${price}/mo by card — instant setup`}
          </Button>
        )}
        {paypal && (
          <a
            className={`btn block${card ? '' : ' primary'}`}
            href={paypal}
            target="_blank"
            rel="noreferrer"
          >
            Pay {price} with PayPal
          </a>
        )}
        {!card && plan.stripe_link && (
          <a className="btn block" href={plan.stripe_link} target="_blank" rel="noreferrer">
            Pay by card
          </a>
        )}
        {flagged ? (
          <p className="formnote">
            Sent — your payment is with the host for review. Follow it under Billing; you will see
            the order go active once it is approved.
          </p>
        ) : (
          (paypal || plan.stripe_link) && (
            <Button block disabled={busy} onClick={() => void flag()}>
              {busy ? 'Sending…' : 'I’ve paid — submit for review'}
            </Button>
          )
        )}
        {card && (paypal || plan.stripe_link) && (
          <p className="dim shop-hint">
            Card is automatic; the other options need the &ldquo;I&rsquo;ve paid&rdquo; step and a
            human check.
          </p>
        )}
      </div>

      {settings.orderNote && <p className="dim shop-hint">From the host: {settings.orderNote}</p>}

      <p className="dim shop-hint">
        This order is under Billing from now on, with the same payment steps and the option to
        cancel it.
      </p>

      <Button variant="ghost" block onClick={onDone}>
        Back to plans
      </Button>
    </section>
  )
}
