// stripe-checkout — opens a Stripe Checkout session for a hosting order.
//
// The browser can't do this itself: creating a session needs the secret key,
// and the order row must be verified as belonging to the caller before any
// payment UI appears. So the shop calls here with {order_id, return_url}, and
// gets back {url} to redirect to.
//
// Flow: shop inserts the order (awaiting_payment) → this function checks the
// caller owns it, reads the plan's stripe_price_id, creates a subscription
// Checkout session with the order id in its metadata → stripe-webhook flips the
// order to active when Stripe reports the payment. Manual payment (PayPal +
// review) keeps working for plans without a price id.
//
// Deploy:
//   supabase functions deploy stripe-checkout --project-ref <ref>
//   supabase secrets set STRIPE_SECRET_KEY=sk_... --project-ref <ref>
// verify_jwt stays at its default (true); the user check below also rejects the
// bare anon role, same as cf-proxy.

const STRIPE = 'https://api.stripe.com/v1'

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })

/** The signed-in user behind the JWT, or null for the bare anon key. */
async function caller(authorization: string): Promise<{ id: string; email?: string } | null> {
  if (!authorization) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: SUPABASE_ANON_KEY }
    })
    if (!res.ok) return null
    const user = await res.json()
    return user?.id && user?.aud === 'authenticated' ? { id: user.id, email: user.email } : null
  } catch {
    return null
  }
}

/** PostgREST with the service role — the row checks below are the authorization. */
async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })
}

/**
 * Where Checkout may send the customer back to. Anything else would let a
 * crafted request bounce a paying customer to an attacker's page.
 */
function safeReturn(raw: unknown): string {
  const fallback = 'https://enderappsrepo.github.io/elauncher/manage/'
  if (typeof raw !== 'string') return fallback
  try {
    const url = new URL(raw)
    const github = url.origin === 'https://enderappsrepo.github.io'
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return github || local ? `${url.origin}${url.pathname}` : fallback
  } catch {
    return fallback
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'POST only.' })
  if (!STRIPE_KEY) return json(500, { error: 'Card payments are not configured: set the STRIPE_SECRET_KEY secret.' })

  const user = await caller(req.headers.get('Authorization') ?? '')
  if (!user) return json(401, { error: 'Sign in to pay for an order.' })

  let body: { order_id?: string; return_url?: string }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Send JSON: {order_id, return_url}.' })
  }
  const orderId = String(body.order_id ?? '')
  if (!orderId) return json(400, { error: 'order_id is required.' })

  // The caller must own the order, and it must actually be waiting for money.
  const orderRes = await db(
    `/hosting_orders?id=eq.${encodeURIComponent(orderId)}&select=id,user_id,plan_id,reference,status,server_name`
  )
  const orders = orderRes.ok ? await orderRes.json() : []
  const order = orders[0] as
    | { id: string; user_id: string; plan_id: string; reference: string; status: string; server_name: string }
    | undefined
  if (!order || order.user_id !== user.id) return json(404, { error: 'No such order on this account.' })
  if (order.status !== 'awaiting_payment' && order.status !== 'past_due') {
    return json(409, { error: `This order is ${order.status.replace('_', ' ')} — nothing to pay.` })
  }

  const planRes = await db(
    `/hosting_plans?id=eq.${encodeURIComponent(order.plan_id)}&select=id,name,stripe_price_id`
  )
  const plans = planRes.ok ? await planRes.json() : []
  const plan = plans[0] as { id: string; name: string; stripe_price_id: string | null } | undefined
  if (!plan?.stripe_price_id) {
    return json(409, { error: 'This plan has no card checkout — use the payment link instead.' })
  }

  const back = safeReturn(body.return_url)
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': plan.stripe_price_id,
    'line_items[0][quantity]': '1',
    client_reference_id: order.id,
    'metadata[order_id]': order.id,
    'metadata[reference]': order.reference,
    'subscription_data[metadata][order_id]': order.id,
    success_url: `${back}?stripe=success&order=${encodeURIComponent(order.reference)}`,
    cancel_url: `${back}?stripe=cancelled&order=${encodeURIComponent(order.reference)}`
  })
  if (user.email) form.set('customer_email', user.email)

  const stripeRes = await fetch(`${STRIPE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  })
  const session = await stripeRes.json()
  if (!stripeRes.ok || !session?.url) {
    // Stripe's message names the real misconfiguration (bad price id, live/test
    // mix-up) and there is nothing sensitive in it
    return json(502, { error: `Stripe refused the checkout: ${session?.error?.message ?? stripeRes.status}` })
  }

  // best effort — checkout works without it, but the session id on the order
  // helps the operator match things up when webhooks are delayed
  await db(`/hosting_orders?id=eq.${encodeURIComponent(order.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ stripe_session_id: session.id })
  })

  return json(200, { url: session.url })
})
