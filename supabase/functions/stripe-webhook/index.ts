// stripe-webhook — turns Stripe events into hosting_orders transitions.
//
// This is the automated half of card payments: checkout.session.completed
// activates the order (the provisioner on a hosting node sees `active` and
// builds the server, exactly as if an operator had approved it), invoice.paid
// extends paid_until on each renewal, and a deleted subscription leaves the
// order to lapse naturally when its paid_until passes.
//
// Stripe calls this endpoint directly, so there is no user JWT — authenticity
// comes from the Stripe-Signature header instead, verified natively against
// STRIPE_WEBHOOK_SECRET (HMAC-SHA256 over `${timestamp}.${payload}`, tolerance
// five minutes). Deploy with JWT verification off:
//
//   supabase functions deploy stripe-webhook --no-verify-jwt --project-ref <ref>
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref <ref>
//
// …and add the endpoint in the Stripe dashboard (Developers → Webhooks) for:
//   checkout.session.completed, invoice.paid, customer.subscription.deleted

const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

/** One paid cycle. A hair over a month so a renewal arriving on day 30/31
 *  never briefly suspends a paid-up server. */
const CYCLE_DAYS = 32

const ok = (): Response => new Response(JSON.stringify({ received: true }), { status: 200 })
const bad = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status })

async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {})
    }
  })
}

/** Stripe's signature scheme, implemented on Web Crypto rather than a shipped
 *  SDK: t=<unix>,v1=<hmac-sha256(`${t}.${body}`)>. */
async function verify(payload: string, header: string | null): Promise<boolean> {
  if (!header || !SECRET) return false
  const parts = new Map(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return [kv.slice(0, i), kv.slice(i + 1)] as const
    })
  )
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (!t || !v1) return false
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false // replay guard

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')

  // constant-time compare; a === on secrets is a timing oracle
  if (hex.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i)
  return diff === 0
}

function cycleEnd(from?: string | null): string {
  const base = Math.max(Date.now(), from ? new Date(from).getTime() : 0)
  return new Date(base + CYCLE_DAYS * 86_400_000).toISOString()
}

/** First order matching a PostgREST filter, or null. */
async function findOrder(filter: string): Promise<Record<string, unknown> | null> {
  const res = await db(`/hosting_orders?${filter}&select=id,status,paid_until,reference&limit=1`)
  if (!res.ok) return null
  const rows = await res.json()
  return rows[0] ?? null
}

async function patchOrder(id: string, patch: Record<string, unknown>): Promise<void> {
  await db(`/hosting_orders?id=eq.${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return bad(405, 'POST only.')
  if (!SECRET || !SERVICE_KEY) return bad(500, 'stripe-webhook is not configured.')

  const payload = await req.text()
  if (!(await verify(payload, req.headers.get('Stripe-Signature')))) {
    return bad(400, 'Bad signature.')
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(payload)
  } catch {
    return bad(400, 'Bad JSON.')
  }
  const obj = event.data?.object ?? {}

  switch (event.type) {
    // The purchase. Activate the order; a provisioning host takes it from here.
    case 'checkout.session.completed': {
      const orderId = (obj.metadata as Record<string, string> | undefined)?.order_id ?? obj.client_reference_id
      if (!orderId) return ok()
      const order = await findOrder(`id=eq.${encodeURIComponent(String(orderId))}`)
      if (!order) return ok()
      // idempotent: Stripe retries deliveries, and a second activation of an
      // already-active order must not push paid_until out an extra cycle
      if (order.status === 'active' && order.paid_until && new Date(String(order.paid_until)) > new Date()) return ok()
      await patchOrder(String(order.id), {
        status: 'active',
        paid_until: cycleEnd(),
        stripe_session_id: obj.id ?? null,
        stripe_subscription_id: obj.subscription ?? null
      })
      return ok()
    }

    // A renewal (or the first invoice — covered by the idempotent extend).
    case 'invoice.paid': {
      const sub = (obj as { subscription?: string }).subscription
      if (!sub) return ok()
      const order = await findOrder(`stripe_subscription_id=eq.${encodeURIComponent(sub)}`)
      if (!order) return ok()
      await patchOrder(String(order.id), {
        status: 'active',
        paid_until: cycleEnd(order.paid_until as string | null)
      })
      return ok()
    }

    // Cancelled at Stripe. Nothing to do right now: the order stays active
    // until its paid-for time runs out, then the host suspends it as past_due —
    // the same lapse path a stopped manual payment takes.
    case 'customer.subscription.deleted':
      return ok()

    default:
      return ok() // unhandled event types are acknowledged, not errors
  }
})
