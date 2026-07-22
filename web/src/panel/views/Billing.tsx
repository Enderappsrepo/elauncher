import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@web/lib/supabase'
import { Button, Skeleton } from '@web/ui'

/**
 * What you rent, what you owe, and how it is going.
 *
 * Every state change a customer is allowed to make goes through the
 * hosting_mark() function rather than an update: row-level security lets you
 * read your own orders but not write them, because status, paid_until and
 * server_id are the operator's to set. So this view can flag a payment for
 * review and cancel an order, and nothing else — no money moves through the
 * panel at all. Paying happens on PayPal or Stripe, in their own tab, and the
 * reference code is what ties the transfer back to the order.
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

/** Pill class from ui.css, and the label a customer should read. */
const STATUS_LOOK: Record<OrderStatus, [string, string]> = {
  awaiting_payment: ['busy', 'Awaiting payment'],
  pending_review: ['busy', 'Payment under review'],
  active: ['running', 'Active'],
  past_due: ['error', 'Past due'],
  rejected: ['error', 'Rejected'],
  cancelled: ['stopped', 'Cancelled']
}

interface OrderRow {
  id: string
  plan_id: string
  server_name: string
  reference: string
  status: OrderStatus
  server_id: string | null
  paid_until: string | null
  note: string
  created_at: string
}

interface PlanRow {
  id: string
  name: string
  price_monthly: number
  currency: string
  stripe_link: string | null
}

interface Settings {
  paypal_me: string
  order_note: string
}

const POLL_MS = 20_000

function toOrder(raw: Record<string, unknown>): OrderRow {
  const status = String(raw.status ?? '')
  return {
    id: String(raw.id),
    plan_id: String(raw.plan_id ?? ''),
    server_name: String(raw.server_name ?? 'Server'),
    reference: String(raw.reference ?? ''),
    // the column is a free-text check constraint; anything the panel does not
    // know about is treated as unpaid rather than silently shown as live
    status: STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : 'awaiting_payment',
    server_id: (raw.server_id as string | null) ?? null,
    paid_until: (raw.paid_until as string | null) ?? null,
    note: String(raw.note ?? ''),
    created_at: String(raw.created_at ?? '')
  }
}

function toPlan(raw: Record<string, unknown>): PlanRow {
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    price_monthly: Number(raw.price_monthly ?? 0),
    currency: String(raw.currency ?? 'USD'),
    stripe_link: (raw.stripe_link as string | null) ?? null
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

interface BillingState {
  orders: OrderRow[]
  plans: Record<string, PlanRow>
  settings: Settings
  loading: boolean
  error: string | null
}

const EMPTY: BillingState = {
  orders: [],
  plans: {},
  settings: { paypal_me: '', order_note: '' },
  loading: true,
  error: null
}

function useBilling(userId: string): BillingState & { reload: () => Promise<void> } {
  const [state, setState] = useState<BillingState>(EMPTY)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [ordersRes, plansRes, settingsRes] = await Promise.all([
        supabase
          .from('hosting_orders')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
        supabase.from('hosting_plans').select('id, name, price_monthly, currency, stripe_link'),
        supabase.from('hosting_settings').select('*').eq('id', 1).maybeSingle()
      ])
      if (ordersRes.error) throw new Error(ordersRes.error.message)

      const plans: Record<string, PlanRow> = {}
      for (const p of plansRes.data ?? []) {
        const plan = toPlan(p as Record<string, unknown>)
        plans[plan.id] = plan
      }
      const cfg = (settingsRes.data ?? null) as Record<string, unknown> | null

      setState({
        orders: (ordersRes.data ?? []).map((r) => toOrder(r as Record<string, unknown>)),
        plans,
        settings: {
          paypal_me: String(cfg?.paypal_me ?? ''),
          order_note: String(cfg?.order_note ?? '')
        },
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
  }, [userId])

  useEffect(() => {
    if (!userId) return
    void load()

    // An order changes a handful of times in its life, so a push is worth a full
    // reload here — unlike the console, there is nothing to merge row by row.
    const channel = supabase
      .channel(`billing-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hosting_orders' }, () => void load())
      .subscribe()

    // approval happens on someone else's screen, so a cloud without the realtime
    // publication still has to show it landing
    const timer = setInterval(() => void load(), POLL_MS)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [userId, load])

  return { ...state, reload: load }
}

export function Billing({ userId }: { userId: string }): React.JSX.Element {
  const { orders, plans, settings, loading, error, reload } = useBilling(userId)

  const live = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'rejected')
  const closed = orders.filter((o) => o.status === 'cancelled' || o.status === 'rejected')
  const owing = live.filter((o) => o.status === 'awaiting_payment' || o.status === 'past_due')

  return (
    <>
      <div className="head rise">
        <h1>Your hosting</h1>
        <p className="dim">
          {loading
            ? 'Loading your orders…'
            : live.length === 0
              ? 'Nothing rented yet'
              : `${live.length} ${live.length === 1 ? 'order' : 'orders'}${owing.length ? ` · ${owing.length} waiting on payment` : ''}`}
        </p>
      </div>

      {error && (
        <p className="formerr" role="alert">
          {error}
        </p>
      )}

      {loading && (
        <div className="grid">
          {[0, 1].map((i) => (
            <Skeleton key={i} height={196} />
          ))}
        </div>
      )}

      {!loading && !error && live.length === 0 && closed.length === 0 && (
        <section className="surface pad rise stack">
          <h2>Nothing rented yet</h2>
          <p className="dim">
            Servers you rent show up here with what to pay, the reference to quote, and how the setup
            is going. Ordering happens in the shop.
          </p>
        </section>
      )}

      <div className="grid stagger">
        {live.map((order, i) => (
          <OrderCard
            key={order.id}
            order={order}
            plan={plans[order.plan_id] ?? null}
            settings={settings}
            index={i}
            reload={reload}
          />
        ))}
      </div>

      {closed.length > 0 && (
        <>
          <div className="head" style={{ marginTop: 22 }}>
            <h2>Closed</h2>
            <p className="dim">Orders that were cancelled or turned down. Kept for your records.</p>
          </div>
          <div className="grid">
            {closed.map((order) => (
              <article key={order.id} className="surface pad stack">
                <div className="row">
                  <h2>{order.server_name}</h2>
                  <span className="spacer" />
                  <StatusPill status={order.status} />
                </div>
                <p className="dim">
                  {plans[order.plan_id]?.name ?? order.plan_id} · ref <span className="mono">{order.reference}</span>
                </p>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function StatusPill({ status, settingUp }: { status: OrderStatus; settingUp?: boolean }): React.JSX.Element {
  const [cls, label] = settingUp ? ['busy', 'Setting up…'] : STATUS_LOOK[status]
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" aria-hidden />
      {label}
    </span>
  )
}

function OrderCard({
  order,
  plan,
  settings,
  index,
  reload
}: {
  order: OrderRow
  plan: PlanRow | null
  settings: Settings
  index: number
  reload: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [confirming, setConfirming] = useState(false)

  // approved but no server attached yet: the host is still building it, which is
  // a different thing to say than "Active" with nothing to play on
  const settingUp = order.status === 'active' && !order.server_id
  const owing = order.status === 'awaiting_payment' || order.status === 'past_due'
  const cancellable = order.status === 'awaiting_payment' || order.status === 'pending_review'
  // hosts write their progress here, and a failed build is the one note that
  // must not be mistaken for a status update
  const noteFailed = /failed/i.test(order.note)

  async function mark(status: 'pending_review' | 'cancelled'): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      const { error } = await supabase.rpc('hosting_mark', { order_id: order.id, new_status: status })
      if (error) throw new Error(error.message)
      setConfirming(false)
      await reload()
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not send that.')
    } finally {
      setBusy(false)
    }
  }

  const price = plan ? money(plan.price_monthly, plan.currency) : null
  const paypal = plan && settings.paypal_me
    ? `https://paypal.me/${encodeURIComponent(settings.paypal_me)}/${plan.price_monthly.toFixed(2)}`
    : ''

  return (
    <article className="surface pad stack" style={{ '--i': index } as React.CSSProperties}>
      <div className="row">
        <h2>{order.server_name}</h2>
        <span className="spacer" />
        <StatusPill status={order.status} settingUp={settingUp} />
      </div>
      <p className="dim">
        {plan?.name ?? order.plan_id}
        {order.paid_until && ` · renews ${new Date(order.paid_until).toLocaleDateString()}`}
      </p>

      {order.note && (
        <p className={noteFailed ? 'formerr' : 'formnote'} role={noteFailed ? 'alert' : undefined}>
          {order.note}
        </p>
      )}

      {order.status === 'active' && order.server_id && (
        <p className="formnote">Your server is live — open it from the server list to manage it.</p>
      )}

      {owing && (
        <>
          {!plan ? (
            <p className="formnote">
              This order&apos;s plan is no longer listed, so there is nothing to quote you. Contact the
              host with reference <b>{order.reference}</b>.
            </p>
          ) : !paypal && !plan.stripe_link ? (
            <p className="formnote">
              Payment isn&apos;t set up yet — contact the host and quote reference{' '}
              <span className="mono">{order.reference}</span>.
            </p>
          ) : (
            <>
              <p className="formnote">
                Send exactly <b>{price}</b> and put your reference <b>{order.reference}</b> in the
                payment note. That reference is how your payment finds this order.
              </p>
              <div className="stack">
                {paypal && (
                  <a className="btn primary block" href={paypal} target="_blank" rel="noreferrer">
                    Pay {price} with PayPal
                  </a>
                )}
                {plan.stripe_link && (
                  <a className="btn block" href={plan.stripe_link} target="_blank" rel="noreferrer">
                    Pay by card
                  </a>
                )}
                <Button block disabled={busy} onClick={() => void mark('pending_review')}>
                  {busy ? 'Sending…' : 'I’ve paid — submit for review'}
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {/* hosting_settings.order_note is the operator's own payment instructions —
          shown only where it is actionable, next to what there is to pay */}
      {owing && settings.order_note && <p className="dim">From the host: {settings.order_note}</p>}

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      {cancellable && !confirming && (
        <Button variant="ghost" block onClick={() => setConfirming(true)}>
          Cancel order
        </Button>
      )}

      {cancellable && confirming && (
        <div className="formnote stack">
          <span>
            Cancel <b>{order.server_name}</b>? The order closes and stops waiting for payment. No
            server is created. If you have already sent money, contact the host — cancelling here does
            not refund anything.
          </span>
          <div className="row">
            <Button variant="danger" disabled={busy} onClick={() => void mark('cancelled')}>
              {busy ? 'Cancelling…' : 'Cancel this order'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}
