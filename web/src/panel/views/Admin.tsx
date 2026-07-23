import { useCallback, useEffect, useState } from 'react'
import { CheckCheck, CreditCard, HardDrive, Inbox, Lock, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@web/lib/supabase'
import { Button, EmptyState, Skeleton, Tabs } from '@web/ui'
import { AnimatePresence, EASE_OUT, EASE_SPRING, motion } from '@web/ui/motion'
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
 *
 * Stripe Checkout is the one path around this desk: its webhook activates the
 * order it was paid for, so a card order arrives here already active — badged
 * as such, and never asking to be approved.
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

/** What each pile of the pipeline means to the operator, not the enum's name. */
const LANE_TITLE: Record<OrderStatus, string> = {
  pending_review: 'Waiting on you',
  past_due: 'Past due',
  active: 'Active',
  awaiting_payment: 'Awaiting payment',
  rejected: 'Rejected',
  cancelled: 'Cancelled'
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
  /** set by the Stripe webhook when checkout paid for this order — older clouds
   *  have neither column, and select('*') simply never returns them */
  stripe_session_id: string | null
  stripe_subscription_id: string | null
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
    provisioner_id: (raw.provisioner_id as string | null) ?? null,
    stripe_session_id: (raw.stripe_session_id as string | null) ?? null,
    stripe_subscription_id: (raw.stripe_subscription_id as string | null) ?? null
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

/** "placed 4h ago", from created_at — the queue's age at a glance. */
function orderAge(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return 'just now'
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
      // a toast survives a section switch, which the old inline notice never did
      toast.success(message)
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
      <EmptyState icon={<Lock size={20} />} title="Operators only">
        This is where hosting orders are approved and the fleet is managed. Your account is not
        marked as an operator, so there is nothing here for you.
      </EmptyState>
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

      <Tabs tabs={SECTIONS} value={section} onChange={setSection} labels={SECTION_LABELS} />

      <div className="ops-body">
        {state.error && (
          <p className="formerr" role="alert">
            {state.error}
          </p>
        )}

        {state.loading && !state.error && (
          <div className="stack">
            <Skeleton height={22} width={190} />
            <div className="grid">
              {[0, 1].map((i) => (
                <Skeleton key={i} height={230} />
              ))}
            </div>
          </div>
        )}

        {!state.loading && !blank && section === 'orders' && (
          <Orders
            orders={state.orders}
            plans={state.plans}
            hosts={state.hosts}
            customers={state.customers}
            shopOpen={state.shopOpen}
            after={after}
          />
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

/**
 * The pipeline. Orders are piled by status rather than listed flat, with the
 * pile that needs a human first — approving and rejecting animate the card out
 * of its pile instead of snapping the whole list, so what just happened stays
 * legible on a phone held one-handed.
 */
function Orders({
  orders,
  plans,
  hosts,
  customers,
  shopOpen,
  after
}: {
  orders: OrderRow[]
  plans: PlanRow[]
  hosts: FleetHost[]
  customers: Record<string, string>
  shopOpen: boolean
  after: After
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const planById = new Map(plans.map((p) => [p.id, p]))

  if (orders.length === 0) {
    const listed = plans.some((p) => p.active)
    return (
      <EmptyState icon={<Inbox size={20} />} title="No orders yet">
        {shopOpen
          ? listed
            ? 'The shop is open and the plans are listed — an order appears here the moment a customer picks one, before they have paid. Nothing here means nobody has ordered.'
            : 'The shop is open but no plan is listed, so there is nothing for a customer to order. List one under Shop.'
          : 'The shop is closed, so nobody can order right now. Open it under Shop when you are ready to sell.'}
      </EmptyState>
    )
  }

  const lanes = [...STATUSES].sort((a, b) => RANK[a] - RANK[b])
  const grouped = new Map<OrderStatus, OrderRow[]>(lanes.map((s) => [s, []]))
  for (const order of orders) grouped.get(order.status)?.push(order)
  for (const list of grouped.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at))

  const visible = lanes.filter((s) => (showAll || RANK[s] <= RANK.active) && (grouped.get(s) ?? []).length > 0)
  const shown = visible.reduce((n, s) => n + (grouped.get(s) ?? []).length, 0)

  return (
    <>
      <div className="row ops-toolbar">
        <span className="dim">
          {shown} of {orders.length} {orders.length === 1 ? 'order' : 'orders'}
        </span>
        <span className="spacer" />
        <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Only orders that need you' : 'Show every order'}
        </Button>
      </div>

      {shown === 0 ? (
        <EmptyState icon={<CheckCheck size={20} />} title="Nothing needs you">
          No order is waiting on review, renewal or a build. The rest are unpaid, cancelled or
          rejected — the button above shows them.
        </EmptyState>
      ) : (
        <AnimatePresence>
          {visible.map((status) => {
            const list = grouped.get(status) ?? []
            const [cls] = STATUS_LOOK[status]
            return (
              <motion.section
                key={status}
                layout
                className="ops-lane"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.26, ease: EASE_OUT }}
              >
                <div className="row ops-lane-head">
                  <span className={`ops-lane-dot ${cls}`} aria-hidden />
                  <h2>{LANE_TITLE[status]}</h2>
                  <span className="ops-count">{list.length}</span>
                  {status === 'pending_review' && <span className="dim ops-hint">your queue</span>}
                </div>
                <div className="grid">
                  <AnimatePresence>
                    {list.map((order, i) => (
                      <motion.div
                        key={order.id}
                        layout
                        initial={{ opacity: 0, y: 14, scale: 0.985 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                          transition: { duration: 0.42, ease: EASE_SPRING, delay: Math.min(i, 6) * 0.045 }
                        }}
                        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.26, ease: EASE_OUT } }}
                      >
                        <OrderCard
                          order={order}
                          plan={planById.get(order.plan_id) ?? null}
                          hosts={hosts}
                          customer={customers[order.user_id] ?? ''}
                          after={after}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.section>
            )
          })}
        </AnimatePresence>
      )}
    </>
  )
}

function OrderCard({
  order,
  plan,
  hosts,
  customer,
  after
}: {
  order: OrderRow
  plan: PlanRow | null
  hosts: FleetHost[]
  customer: string
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
  const picked = hosts.find((h) => h.device_id === pick) ?? null
  // paid through Stripe Checkout: the webhook set these, renews the order by
  // card, and activates it without this desk — so no Approve is ever offered
  const cardPaid = Boolean(order.stripe_session_id || order.stripe_subscription_id)
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
      const message = e instanceof Error ? e.message : 'That did not go through.'
      setFailed(message)
      toast.error(message)
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
        const message = e instanceof Error ? e.message : 'That did not go through.'
        setFailed(message)
        toast.error(message)
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <article className="surface pad stack">
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
        {` · placed ${orderAge(order.created_at)}`}
        {order.paid_until && ` · paid until ${new Date(order.paid_until).toLocaleDateString()}`}
      </p>

      {cardPaid && (
        <div className="row">
          <span className="pill ops-card-pill">
            <CreditCard size={13} aria-hidden />
            card · auto-renews
          </span>
        </div>
      )}

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
          {picked && (!picked.enabled || !hostSeen(picked)) && (
            <p className="ops-warn">
              {hostLabel(picked)} is{' '}
              {picked.enabled
                ? 'offline — the build waits until it checks back in'
                : 'parked, so it takes no new orders — unpark it under Hosts first'}
              .
            </p>
          )}
        </div>
      )}

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      {stage === 'none' && order.status === 'pending_review' && cardPaid && (
        <p className="dim ops-hint">
          Paid by card — Stripe activates this order by itself, so there is nothing here to approve.
        </p>
      )}

      {stage === 'none' && ((order.status === 'pending_review' && !cardPaid) || renewing) && (
        <div className="row ops-actions">
          <Button variant="primary" onClick={() => setStage('approve')}>
            {renewing ? 'Renew' : 'Approve'}
          </Button>
          {order.status === 'pending_review' && !cardPaid && (
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
      const message = e instanceof Error ? e.message : 'That did not go through.'
      setFailed(message)
      toast.error(message)
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

      <section className="surface pad stack rise">
        <div className="row">
          <h2>Shop</h2>
          <span className={`pill ${shopOpen ? 'running' : 'stopped'}`}>
            <span className="dot" aria-hidden />
            {shopOpen ? 'Open' : 'Closed'}
          </span>
          <span className="spacer" />
          <Button
            variant={shopOpen ? 'danger' : 'primary'}
            disabled={busy === 'shop'}
            onClick={() => setShop(!shopOpen)}
          >
            {busy === 'shop' ? 'Saving…' : shopOpen ? 'Close shop' : 'Open shop'}
          </Button>
        </div>
        <p className="dim ops-hint">
          {shopOpen
            ? 'Customers can order new servers.'
            : 'Ordering is hidden from customers. Existing servers keep running.'}
        </p>
      </section>

      {plans.length === 0 ? (
        <EmptyState icon={<ShoppingBag size={20} />} title="No plans">
          There is nothing to sell yet. Plans are rows in hosting_plans — the latest schema.sql
          seeds a starter lineup.
        </EmptyState>
      ) : (
        <section className="surface pad stack rise">
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
              {!p.active && (
                <span className="pill stopped">
                  <span className="dot" aria-hidden />
                  Hidden
                </span>
              )}
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
      <EmptyState icon={<HardDrive size={20} />} title="No hosts have checked in">
        Sign a launcher into this hosting account and the box appears here within a minute, ready
        to be named and given orders.
      </EmptyState>
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
      const message = e instanceof Error ? e.message : 'That did not save.'
      setFailed(message)
      toast.error(message)
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
        <span className="ops-host-pills">
          {!host.enabled && (
            <span className="pill stopped">
              <span className="dot" aria-hidden />
              Parked
            </span>
          )}
          <span className={`pill ${online ? 'running' : 'stopped'}`}>
            <span className="dot" aria-hidden />
            {online ? 'Online' : 'Offline'}
          </span>
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
