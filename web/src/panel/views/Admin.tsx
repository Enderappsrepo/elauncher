import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@web/lib/supabase'
import { Button, Skeleton, Tabs } from '@web/ui'
import './Admin.css'

/**
 * The operator's side of hosting.
 *
 * Everything here is gated twice. The panel checks profiles.is_admin so a
 * customer is never shown controls they cannot use, and every write is behind
 * an RLS policy or a security-definer function that re-checks is_admin() in the
 * database — so this file being wrong can only ever cost a confusing screen,
 * never an unauthorised change.
 *
 * What an admin can do here is exactly what the schema permits and no more:
 * approve, renew and reject orders (hosting_orders), point an order at a
 * particular box (hosting_assign), open or close the shop and list or hide
 * plans (hosting_settings, hosting_plans), and name or park a host
 * (hosting_hosts). Money is deliberately absent. Approving an order records
 * that it is paid until a date; it does not take a payment, and there is no
 * refund path in the schema to expose — refunds happen in PayPal or Stripe.
 */

type OrderStatus = 'awaiting_payment' | 'pending_review' | 'active' | 'past_due' | 'rejected' | 'cancelled'

const STATUSES: readonly OrderStatus[] = [
  'awaiting_payment',
  'pending_review',
  'active',
  'past_due',
  'rejected',
  'cancelled'
]

const STATUS_LOOK: Record<OrderStatus, [string, string]> = {
  awaiting_payment: ['busy', 'Awaiting payment'],
  pending_review: ['busy', 'Payment under review'],
  active: ['running', 'Active'],
  past_due: ['error', 'Past due'],
  rejected: ['error', 'Rejected'],
  cancelled: ['stopped', 'Cancelled']
}

/** Sort key, not a severity: an order waiting on you comes before one that is
 *  already running, whatever order the cloud handed them over in. */
const RANK: Record<OrderStatus, number> = {
  pending_review: 0,
  past_due: 1,
  active: 2,
  awaiting_payment: 3,
  rejected: 4,
  cancelled: 5
}

const GAME_LABEL: Record<string, string> = {
  minecraft: 'Minecraft',
  palworld: 'Palworld',
  valheim: 'Valheim',
  sdtd: '7 Days to Die',
  zomboid: 'Project Zomboid',
  tmodloader: 'tModLoader',
  ark: 'ARK: Survival Evolved',
  arksa: 'ARK: Survival Ascended'
}

interface OrderRow {
  id: string
  user_id: string
  plan_id: string
  server_name: string
  reference: string
  status: OrderStatus
  server_id: string | null
  paid_until: string | null
  note: string
  created_at: string
  target_device_id: string | null
  provisioner_id: string | null
}

interface PlanRow {
  id: string
  name: string
  game: string
  max_players: number
  memory_mb: number
  price_monthly: number
  currency: string
  active: boolean
  sort: number
}

/** One box, as the operator sees it: telemetry it published about itself merged
 *  with the naming and on/off switch that live in hosting_hosts. */
interface FleetHost {
  device_id: string
  label: string
  region: string
  enabled: boolean
  /** false when the box has never been named — parking it creates the row */
  registered: boolean
  host_name: string
  platform: string
  headless: boolean
  servers_running: number
  updated_at: string | null
}

const POLL_MS = 20_000
/**
 * A box is "online" here on a far looser clock than in Fleet health. That view
 * asks whether a machine is alive right now; this one asks whether it is worth
 * pointing an order at, and a host that checked in two minutes ago plainly is.
 */
const HOST_SEEN_MS = 10 * 60_000
const DAY_MS = 86_400_000

function toOrder(raw: Record<string, unknown>): OrderRow {
  const status = String(raw.status ?? '')
  return {
    id: String(raw.id),
    user_id: String(raw.user_id ?? ''),
    plan_id: String(raw.plan_id ?? ''),
    server_name: String(raw.server_name ?? 'Server'),
    reference: String(raw.reference ?? ''),
    status: STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : 'awaiting_payment',
    server_id: (raw.server_id as string | null) ?? null,
    paid_until: (raw.paid_until as string | null) ?? null,
    note: String(raw.note ?? ''),
    created_at: String(raw.created_at ?? ''),
    target_device_id: (raw.target_device_id as string | null) ?? null,
    provisioner_id: (raw.provisioner_id as string | null) ?? null
  }
}

function toPlan(raw: Record<string, unknown>): PlanRow {
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    game: String(raw.game ?? ''),
    max_players: Number(raw.max_players ?? 0),
    memory_mb: Number(raw.memory_mb ?? 0),
    price_monthly: Number(raw.price_monthly ?? 0),
    currency: String(raw.currency ?? 'USD'),
    // older clouds predate the column; an absent flag has always meant listed
    active: raw.active !== false,
    sort: Number(raw.sort ?? 0)
  }
}

/** A box can appear in either table alone — one named before it ever checked in,
 *  one checked in but never named — so they are merged by device id, not joined. */
function mergeHosts(health: Record<string, unknown>[], named: Record<string, unknown>[]): FleetHost[] {
  const by = new Map<string, FleetHost>()
  for (const raw of health) {
    const id = String(raw.device_id ?? '')
    if (!id) continue
    const seen = String(raw.updated_at ?? '')
    const prev = by.get(id)
    // the same device id under two accounts would otherwise render twice; the
    // fresher heartbeat is the one worth believing
    if (prev && prev.updated_at && prev.updated_at > seen) continue
    by.set(id, {
      device_id: id,
      label: '',
      region: '',
      enabled: true,
      registered: false,
      host_name: String(raw.host_name ?? ''),
      platform: String(raw.platform ?? ''),
      headless: Boolean(raw.headless),
      servers_running: Number(raw.servers_running ?? 0),
      updated_at: seen || null
    })
  }
  for (const raw of named) {
    const id = String(raw.device_id ?? '')
    if (!id) continue
    const base = by.get(id) ?? {
      device_id: id,
      label: '',
      region: '',
      enabled: true,
      registered: false,
      host_name: '',
      platform: '',
      headless: false,
      servers_running: 0,
      updated_at: null
    }
    by.set(id, {
      ...base,
      label: String(raw.label ?? ''),
      region: String(raw.region ?? ''),
      enabled: raw.enabled !== false,
      registered: true
    })
  }
  return [...by.values()].sort((a, b) => hostLabel(a).localeCompare(hostLabel(b)) || a.device_id.localeCompare(b.device_id))
}

/** What you called the box, else what it calls itself, else its id. */
function hostLabel(h: FleetHost): string {
  return h.label || h.host_name || h.device_id.slice(0, 12)
}

function hostSeen(h: FleetHost): boolean {
  return Boolean(h.updated_at) && Date.now() - new Date(h.updated_at as string).getTime() < HOST_SEEN_MS
}

function describeHost(h: FleetHost): string {
  return [hostLabel(h), h.region, hostSeen(h) ? '' : 'offline', h.enabled ? '' : 'parked'].filter(Boolean).join(' · ')
}

function money(amount: number, currency: string): string {
  return currency === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

function readable(message: string): string {
  return /schema cache|does not exist|42P01|PGRST205/i.test(message)
    ? 'Hosting needs one migration — open Supabase → SQL Editor and run the latest schema.sql once.'
    : message
}

interface OperatorState {
  orders: OrderRow[]
  plans: PlanRow[]
  hosts: FleetHost[]
  /** user_id -> username, so an order says who it belongs to */
  customers: Record<string, string>
  shopOpen: boolean
  paypal: string
  loading: boolean
  error: string | null
}

const EMPTY: OperatorState = {
  orders: [],
  plans: [],
  hosts: [],
  customers: {},
  shopOpen: true,
  paypal: '',
  loading: true,
  error: null
}

function useOperator(userId: string, enabled: boolean): OperatorState & { reload: () => Promise<void> } {
  const [state, setState] = useState<OperatorState>(EMPTY)

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return
    try {
      const [ordersRes, plansRes, settingsRes, healthRes, hostsRes] = await Promise.all([
        supabase.from('hosting_orders').select('*').order('created_at', { ascending: false }),
        supabase.from('hosting_plans').select('*').order('sort'),
        supabase.from('hosting_settings').select('*').eq('id', 1).maybeSingle(),
        supabase
          .from('host_health')
          .select('device_id, host_name, platform, headless, servers_running, updated_at'),
        supabase.from('hosting_hosts').select('*')
      ])
      if (ordersRes.error) throw new Error(ordersRes.error.message)

      const orders = (ordersRes.data ?? []).map((r) => toOrder(r as Record<string, unknown>))
      const userIds = [...new Set(orders.map((o) => o.user_id))].filter(Boolean)
      const customers: Record<string, string> = {}
      if (userIds.length) {
        const { data } = await supabase.from('profiles').select('id, username').in('id', userIds)
        for (const p of (data ?? []) as { id: string; username: string | null }[]) {
          customers[p.id] = p.username ?? ''
        }
      }
      const cfg = (settingsRes.data ?? null) as Record<string, unknown> | null

      setState({
        orders,
        plans: (plansRes.data ?? []).map((r) => toPlan(r as Record<string, unknown>)),
        hosts: mergeHosts(
          (healthRes.data ?? []) as Record<string, unknown>[],
          (hostsRes.data ?? []) as Record<string, unknown>[]
        ),
        customers,
        // old clouds without the column read as open, which is how they behave
        shopOpen: cfg?.shop_open !== false,
        paypal: String(cfg?.paypal_me ?? ''),
        loading: false,
        error: null
      })
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: readable(e instanceof Error ? e.message : 'Could not reach the cloud.')
      }))
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !userId) return
    void load()

    const channel = supabase
      .channel(`operator-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hosting_orders' }, () => void load())
      .subscribe()

    // a customer flagging a payment happens on their screen, and hosts claim
    // orders with no push at all, so the poll is the one that keeps this honest
    const timer = setInterval(() => void load(), POLL_MS)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [enabled, userId, load])

  return { ...state, reload: load }
}

const SECTIONS = ['orders', 'shop', 'hosts'] as const
type Section = (typeof SECTIONS)[number]
const SECTION_LABELS: Record<Section, string> = { orders: 'Orders', shop: 'Shop', hosts: 'Hosts' }

export function Admin({ userId }: { userId: string }): React.JSX.Element {
  // null while unknown: rendering the operator UI on an assumption and taking it
  // away a beat later is worse than a moment of skeleton
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [section, setSection] = useState<Section>('orders')
  const [notice, setNotice] = useState('')
  const state = useOperator(userId, admin === true)
  const { reload } = state

  useEffect(() => {
    let alive = true
    void supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setAdmin(Boolean((data as { is_admin?: boolean } | null)?.is_admin))
      })
    return () => {
      alive = false
    }
  }, [userId])

  const after = useCallback(
    async (message: string): Promise<void> => {
      setNotice(message)
      await reload()
    },
    [reload]
  )

  if (admin === null) {
    return (
      <div className="stack">
        <Skeleton height={64} />
        <Skeleton height={220} />
      </div>
    )
  }

  if (!admin) {
    return (
      <section className="surface pad rise stack">
        <h2>Operator view</h2>
        <p className="dim">
          This is where hosting orders are approved and the fleet is managed. Your account is not
          marked as an operator, so there is nothing here for you.
        </p>
      </section>
    )
  }

  const queue = state.orders.filter((o) => RANK[o.status] <= RANK.active)
  // a failed first load has nothing to draw, and "No orders yet" underneath an
  // error would read as an answer rather than as a missing one
  const blank = state.error !== null && !state.orders.length && !state.plans.length && !state.hosts.length

  return (
    <>
      <div className="head rise">
        <h1>Operator</h1>
        <p className="dim">
          {state.loading
            ? 'Loading orders…'
            : `${queue.length} live ${queue.length === 1 ? 'order' : 'orders'} · ${state.hosts.length} ${state.hosts.length === 1 ? 'box' : 'boxes'} · shop ${state.shopOpen ? 'open' : 'closed'}`}
        </p>
      </div>

      <Tabs
        tabs={SECTIONS}
        value={section}
        // the notice describes something that just happened on the section you
        // are leaving, so it goes with it
        onChange={(next) => {
          setNotice('')
          setSection(next)
        }}
        labels={SECTION_LABELS}
      />

      <div className="ops-body">
        {state.error && (
          <p className="formerr" role="alert">
            {state.error}
          </p>
        )}
        {notice && <p className="formnote">{notice}</p>}

        {state.loading && !state.error && (
          <div className="grid">
            {[0, 1].map((i) => (
              <Skeleton key={i} height={200} />
            ))}
          </div>
        )}

        {!state.loading && !blank && section === 'orders' && (
          <Orders orders={state.orders} plans={state.plans} hosts={state.hosts} customers={state.customers} after={after} />
        )}
        {!state.loading && !blank && section === 'shop' && (
          <Shop plans={state.plans} shopOpen={state.shopOpen} paypal={state.paypal} after={after} />
        )}
        {!state.loading && !blank && section === 'hosts' && <Hosts hosts={state.hosts} after={after} />}
      </div>
    </>
  )
}

function StatusPill({ status, settingUp }: { status: OrderStatus; settingUp?: boolean }): React.JSX.Element {
  const [cls, label] = settingUp ? ['busy', 'Building…'] : STATUS_LOOK[status]
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" aria-hidden />
      {label}
    </span>
  )
}

type After = (message: string) => Promise<void>

function Orders({
  orders,
  plans,
  hosts,
  customers,
  after
}: {
  orders: OrderRow[]
  plans: PlanRow[]
  hosts: FleetHost[]
  customers: Record<string, string>
  after: After
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const planById = new Map(plans.map((p) => [p.id, p]))
  const shown = orders
    .filter((o) => showAll || RANK[o.status] <= RANK.active)
    .slice()
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.created_at.localeCompare(a.created_at))

  return (
    <>
      {orders.length === 0 ? (
        <section className="surface pad stack">
          <h2>No orders yet</h2>
          <p className="dim">
            Orders appear the moment a customer picks a plan in the shop, before they have paid for
            it. Nothing here means nobody has ordered.
          </p>
        </section>
      ) : (
        <>
          <div className="row ops-toolbar">
            <span className="dim">
              {shown.length} of {orders.length} {orders.length === 1 ? 'order' : 'orders'}
            </span>
            <span className="spacer" />
            <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Only orders that need you' : 'Show every order'}
            </Button>
          </div>
          {shown.length === 0 ? (
            <section className="surface pad stack">
              <h2>Nothing needs you</h2>
              <p className="dim">
                No order is waiting on review, renewal or a build. The rest are unpaid, cancelled or
                rejected — the button above shows them.
              </p>
            </section>
          ) : (
            <div className="grid stagger">
              {shown.map((order, i) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  plan={planById.get(order.plan_id) ?? null}
                  hosts={hosts}
                  customer={customers[order.user_id] ?? ''}
                  index={i}
                  after={after}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

function OrderCard({
  order,
  plan,
  hosts,
  customer,
  index,
  after
}: {
  order: OrderRow
  plan: PlanRow | null
  hosts: FleetHost[]
  customer: string
  index: number
  after: After
}): React.JSX.Element {
  const [stage, setStage] = useState<'none' | 'approve' | 'reject'>('none')
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  // the picker answers immediately and the reload lands a beat later; without a
  // local value the select would snap back to the old host in between
  const [pick, setPick] = useState(order.target_device_id ?? '')

  useEffect(() => setPick(order.target_device_id ?? ''), [order.target_device_id])

  const settingUp = order.status === 'active' && !order.server_id
  const builtOn = hosts.find((h) => h.device_id === order.provisioner_id)
  const dayCount = Number.parseInt(days, 10)
  const validDays = Number.isFinite(dayCount) && dayCount >= 1 && dayCount <= 3650
  const until = validDays ? new Date(Date.now() + dayCount * DAY_MS) : null
  const renewing = order.status === 'past_due'

  async function run(what: () => Promise<void>, done: string): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      await what()
      setStage('none')
      await after(done)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  function approve(): void {
    if (!until) return
    void run(async () => {
      const { error } = await supabase
        .from('hosting_orders')
        .update({ status: 'active', paid_until: until.toISOString() })
        .eq('id', order.id)
      if (error) throw new Error(error.message)
    }, `${order.server_name} is active until ${until.toLocaleDateString()} — a host will build it within a minute.`)
  }

  function reject(): void {
    void run(async () => {
      const { error } = await supabase.from('hosting_orders').update({ status: 'rejected' }).eq('id', order.id)
      if (error) throw new Error(error.message)
    }, `${order.server_name} was rejected. Nothing was refunded — do that in PayPal or Stripe if they paid.`)
  }

  function assign(device: string): void {
    const previous = pick
    const target = hosts.find((h) => h.device_id === device)
    setPick(device)
    setBusy(true)
    setFailed('')
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('hosting_assign', {
          order_id: order.id,
          device: device || null
        })
        if (error) throw new Error(error.message)
        // the function refuses an order that already produced a server, and says
        // so by returning false rather than by failing
        if (data !== true) throw new Error('That order already has a server, so it cannot be moved.')
        await after(
          device
            ? `${order.server_name} will be built on ${target ? hostLabel(target) : device}.`
            : `${order.server_name} can be built by any free host.`
        )
      } catch (e) {
        // put the picker back: leaving it pointing at a box that refused the
        // order would be the panel lying about where the server will land
        setPick(previous)
        setFailed(e instanceof Error ? e.message : 'That did not go through.')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <article className="surface pad stack" style={{ '--i': index } as React.CSSProperties}>
      <div className="row">
        <h2>{order.server_name}</h2>
        <span className="spacer" />
        <StatusPill status={order.status} settingUp={settingUp} />
      </div>
      <p className="dim ops-sub">
        {plan?.name ?? order.plan_id}
        {plan && ` · ${money(plan.price_monthly, plan.currency)}/mo`}
        {customer && ` · ${customer}`}
        {' · ref '}
        <span className="mono">{order.reference}</span>
        {order.paid_until && ` · paid until ${new Date(order.paid_until).toLocaleDateString()}`}
      </p>

      {order.note && <p className={/failed/i.test(order.note) ? 'formerr' : 'formnote'}>{order.note}</p>}

      {order.server_id ? (
        <p className="dim ops-hint">
          Built on {builtOn ? hostLabel(builtOn) : (order.provisioner_id ?? 'an unknown host')}. A
          running server cannot be moved from here — its files live on that box.
        </p>
      ) : (
        <div className="field">
          <label htmlFor={`deploy-${order.id}`}>Deploy to</label>
          <select
            id={`deploy-${order.id}`}
            className="input ops-select"
            value={pick}
            disabled={busy}
            onChange={(e) => assign(e.target.value)}
          >
            <option value="">Any free host</option>
            {hosts.map((h) => (
              <option key={h.device_id} value={h.device_id}>
                {describeHost(h)}
              </option>
            ))}
          </select>
          <p className="ops-hint">
            Which box builds this order. Leave it on “Any free host” to let the first available one
            take it.
          </p>
        </div>
      )}

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      {stage === 'none' && (order.status === 'pending_review' || renewing) && (
        <div className="row ops-actions">
          <Button variant="primary" onClick={() => setStage('approve')}>
            {renewing ? 'Renew' : 'Approve'}
          </Button>
          {order.status === 'pending_review' && (
            <Button variant="danger" onClick={() => setStage('reject')}>
              Reject
            </Button>
          )}
        </div>
      )}

      {stage === 'approve' && (
        <div className="formnote stack">
          <div className="field">
            <label htmlFor={`days-${order.id}`}>Paid for how many days?</label>
            <input
              id={`days-${order.id}`}
              className="input"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <span>
            {renewing ? 'Renews' : 'Approves'} <b>{order.server_name}</b> for{' '}
            <b>{customer || 'this customer'}</b>: the order becomes <b>active</b> and paid until{' '}
            <b>{until ? until.toLocaleDateString() : '—'}</b>, and a host starts building their
            server. It does not take a payment — check the money arrived first.
          </span>
          {!validDays && <span className="ops-warn">Enter a number of days between 1 and 3650.</span>}
          <div className="row ops-actions">
            <Button variant="primary" disabled={busy || !validDays} onClick={approve}>
              {busy ? 'Saving…' : renewing ? `Renew for ${days} days` : `Approve for ${days} days`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStage('none')}>
              Back
            </Button>
          </div>
        </div>
      )}

      {stage === 'reject' && (
        <div className="formnote stack">
          <span>
            Rejects <b>{order.server_name}</b>. The customer sees the order turned down, no server is
            created, and their money is not touched — if they have already paid, refund it in PayPal
            or Stripe yourself.
          </span>
          <div className="row ops-actions">
            <Button variant="danger" disabled={busy} onClick={reject}>
              {busy ? 'Saving…' : 'Reject this order'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStage('none')}>
              Back
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}

function Shop({
  plans,
  shopOpen,
  paypal,
  after
}: {
  plans: PlanRow[]
  shopOpen: boolean
  paypal: string
  after: After
}): React.JSX.Element {
  const [busy, setBusy] = useState('')
  const [failed, setFailed] = useState('')

  async function run(key: string, what: () => Promise<void>, done: string): Promise<void> {
    setBusy(key)
    setFailed('')
    try {
      await what()
      await after(done)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'That did not go through.')
    } finally {
      setBusy('')
    }
  }

  function setShop(open: boolean): void {
    void run(
      'shop',
      async () => {
        const { error } = await supabase.from('hosting_settings').update({ shop_open: open }).eq('id', 1)
        if (error) throw new Error(error.message)
      },
      open ? 'Shop open — customers can order servers again.' : 'Shop closed — customers no longer see ordering. Servers already running are unaffected.'
    )
  }

  function setPlan(plan: PlanRow, active: boolean): void {
    void run(
      plan.id,
      async () => {
        const { error } = await supabase.from('hosting_plans').update({ active }).eq('id', plan.id)
        if (error) throw new Error(error.message)
      },
      active ? `${plan.name} is listed in the shop.` : `${plan.name} is hidden. Orders already placed on it keep running.`
    )
  }

  return (
    <div className="stack">
      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      {!paypal && (
        <p className="formnote">
          No PayPal.me handle is set, so customers have no way to pay unless a plan carries a Stripe
          link. Set <span className="mono">paypal_me</span> in Supabase → hosting_settings.
        </p>
      )}

      <section className="surface pad stack">
        <div className="row">
          <div>
            <h2>{shopOpen ? 'Shop is open' : 'Shop is closed'}</h2>
            <p className="dim ops-hint">
              {shopOpen
                ? 'Customers can order new servers.'
                : 'Ordering is hidden from customers. Existing servers keep running.'}
            </p>
          </div>
          <span className="spacer" />
          <Button
            variant={shopOpen ? 'danger' : 'primary'}
            disabled={busy === 'shop'}
            onClick={() => setShop(!shopOpen)}
          >
            {busy === 'shop' ? 'Saving…' : shopOpen ? 'Close shop' : 'Open shop'}
          </Button>
        </div>
      </section>

      {plans.length === 0 ? (
        <section className="surface pad stack">
          <h2>No plans</h2>
          <p className="dim">
            There is nothing to sell yet. Plans are rows in hosting_plans — the latest schema.sql
            seeds a starter lineup.
          </p>
        </section>
      ) : (
        <section className="surface pad stack">
          <h2>Plans</h2>
          {plans.map((p) => (
            <div key={p.id} className="row ops-plan">
              <div className="ops-plan-who">
                <b className={p.active ? '' : 'ops-muted'}>{p.name}</b>
                <p className="dim ops-hint">
                  {GAME_LABEL[p.game] ?? p.game} · {p.max_players} players ·{' '}
                  {(p.memory_mb / 1024).toFixed(1)} GB · {money(p.price_monthly, p.currency)}/mo
                </p>
              </div>
              <span className="spacer" />
              <Button disabled={busy === p.id} onClick={() => setPlan(p, !p.active)}>
                {busy === p.id ? 'Saving…' : p.active ? 'Hide' : 'List'}
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function Hosts({ hosts, after }: { hosts: FleetHost[]; after: After }): React.JSX.Element {
  if (hosts.length === 0) {
    return (
      <section className="surface pad stack">
        <h2>No hosts have checked in</h2>
        <p className="dim">
          Sign a launcher into this hosting account and the box appears here within a minute, ready
          to be named and given orders.
        </p>
      </section>
    )
  }
  return (
    <div className="grid stagger">
      {hosts.map((h, i) => (
        <HostCard key={h.device_id} host={h} index={i} after={after} />
      ))}
    </div>
  )
}

function HostCard({ host, index, after }: { host: FleetHost; index: number; after: After }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const online = hostSeen(host)

  async function patch(fields: Record<string, unknown>, done: string): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      const { error } = await supabase
        .from('hosting_hosts')
        .upsert({ device_id: host.device_id, ...fields }, { onConflict: 'device_id' })
      if (error) throw new Error(error.message)
      await after(done)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'That did not save.')
    } finally {
      setBusy(false)
    }
  }

  /** Commit on blur rather than on every keystroke: the poll would otherwise
   *  overwrite half a word with whatever the cloud still has. */
  function commit(field: 'label' | 'region', value: string): void {
    if (value === host[field]) return
    void patch({ [field]: value }, field === 'label' ? `Renamed to ${value || host.host_name || 'its own name'}.` : `Region saved.`)
  }

  return (
    <article className="surface pad stack" style={{ '--i': index } as React.CSSProperties}>
      <div className="row">
        <div className="ops-plan-who">
          <h2>{hostLabel(host)}</h2>
          <p className="dim ops-hint">
            {[host.platform || 'unknown platform', host.headless ? 'headless' : '', `${host.servers_running} running`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span className="spacer" />
        <span className={`pill ${online ? 'running' : 'stopped'}`}>
          <span className="dot" aria-hidden />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>

      <p className="mono ops-id">{host.device_id}</p>

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      <div className="field">
        <label htmlFor={`label-${host.device_id}`}>Label</label>
        <input
          id={`label-${host.device_id}`}
          className="input"
          defaultValue={host.label}
          placeholder={host.host_name || 'This box'}
          disabled={busy}
          onBlur={(e) => commit('label', e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`region-${host.device_id}`}>Region</label>
        <input
          id={`region-${host.device_id}`}
          className="input"
          defaultValue={host.region}
          placeholder="e.g. EU — Germany"
          disabled={busy}
          onBlur={(e) => commit('region', e.target.value)}
        />
      </div>

      <Button
        block
        variant={host.enabled ? 'danger' : 'primary'}
        disabled={busy}
        onClick={() =>
          void patch(
            { enabled: !host.enabled },
            host.enabled
              ? `${hostLabel(host)} is parked — it keeps running what it has and takes no new orders.`
              : `${hostLabel(host)} is taking new orders again.`
          )
        }
      >
        {busy ? 'Saving…' : host.enabled ? 'Park this box' : 'Let it take orders'}
      </Button>
    </article>
  )
}
