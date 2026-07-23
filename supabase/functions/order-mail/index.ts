// order-mail — the four emails a hosting order sends over its life.
//
// placed    → receipt to the customer: reference, price, how to pay
// paid      → payment confirmed, a machine is building the server
// ready     → the address, the moment it exists
// past_due  → paid time ran out; the world is kept, renewing revives it
//
// Same architecture and the same secrets as invite-mail (one mail setup powers
// both): the caller never supplies a recipient — the address is looked up from
// the order row's owner — and the bare anon key is rejected. Who may send what:
// the customer sends their own `placed`; `paid`/`ready`/`past_due` come from an
// admin session (the panel or a hosting node) or from the service key itself
// (the stripe webhook).
//
// Deploy:
//   supabase functions deploy order-mail --project-ref <ref>
// Secrets are shared with invite-mail — INVITE_MAIL_FROM, INVITE_SITE_URL and
// RESEND_API_KEY / BREVO_API_KEY / INVITE_DISCORD_WEBHOOK. Nothing here blocks
// the order flow: with no provider configured it returns 200 and says what it
// skipped, and Billing remains the source of truth a customer can always open.

const RESEND_API = 'https://api.resend.com/emails'
const BREVO_API = 'https://api.brevo.com/v3/smtp/email'

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const BREVO_KEY = Deno.env.get('BREVO_API_KEY') ?? ''
const DISCORD_WEBHOOK = Deno.env.get('INVITE_DISCORD_WEBHOOK') ?? ''
const MAIL_FROM = Deno.env.get('INVITE_MAIL_FROM') ?? ''
const SITE_URL = (Deno.env.get('INVITE_SITE_URL') ?? '').replace(/\/+$/, '')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } })

/** The signed-in user behind this request, or null for anon/garbage tokens. */
async function callerId(auth: string): Promise<string | null> {
  if (!auth.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY }
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user.id ?? null
}

async function fetchRow(table: string, query: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  })
  if (!res.ok) return null
  const rows = (await res.json()) as Record<string, unknown>[]
  return rows[0] ?? null
}

/** auth.users is not a table PostgREST exposes; the Auth admin API is the way in. */
async function userEmail(id: string): Promise<string> {
  if (!id) return ''
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  })
  if (!res.ok) return ''
  const user = (await res.json()) as { email?: string }
  return user.email ?? ''
}

async function isAdmin(id: string): Promise<boolean> {
  const row = await fetchRow('profiles', `id=eq.${encodeURIComponent(id)}&select=is_admin`)
  return Boolean(row?.is_admin)
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** Plain, readable HTML — no images, no tracking, nothing to trip a spam filter. */
function wrap(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#131820;line-height:1.55">
<h2 style="margin:0 0 14px;font-size:19px">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="margin-top:26px;font-size:12px;color:#7c8896">Sent by ELauncher about your server order.</p>
</div>`
}

const box = (tone: string, inner: string): string =>
  `<div style="background:#f4f6f9;border-left:3px solid ${tone};padding:12px 14px;border-radius:6px;white-space:pre-wrap">${inner}</div>`

function splitFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return m ? { name: m[1] || undefined, email: m[2] } : { email: from.trim() }
}

type SendResult = { sent: boolean; via?: string; reason?: string }

async function send(to: string, subject: string, html: string): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no recipient address' }
  if (!MAIL_FROM) return { sent: false, reason: 'INVITE_MAIL_FROM is not set' }

  if (RESEND_KEY) {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
    })
    if (res.ok) return { sent: true, via: 'resend' }
    return { sent: false, via: 'resend', reason: `${res.status}: ${(await res.text()).slice(0, 200)}` }
  }

  if (BREVO_KEY) {
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: splitFrom(MAIL_FROM), to: [{ email: to }], subject, htmlContent: html })
    })
    if (res.ok) return { sent: true, via: 'brevo' }
    return { sent: false, via: 'brevo', reason: `${res.status}: ${(await res.text()).slice(0, 200)}` }
  }

  return { sent: false, reason: 'no email provider configured' }
}

/** New-order ping for the operator's Discord — no domain, no provider, no DNS. */
async function pingDiscord(content: string): Promise<SendResult> {
  if (!DISCORD_WEBHOOK) return { sent: false, reason: 'no webhook configured' }
  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } })
  })
  if (!res.ok) return { sent: false, via: 'discord', reason: `${res.status}` }
  return { sent: true, via: 'discord' }
}

function money(amount: number, currency: string): string {
  return currency === 'USD' || !currency ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

const KINDS = ['placed', 'paid', 'ready', 'past_due'] as const
type Kind = (typeof KINDS)[number]

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!SERVICE_KEY) return json({ error: 'function is missing its service key' }, 500)

  const auth = req.headers.get('authorization') ?? ''
  // the stripe webhook (and any future server-side caller) authenticates as the
  // system itself; everyone else is a person whose id gets checked per kind
  const system = auth === `Bearer ${SERVICE_KEY}`
  const me = system ? null : await callerId(auth)
  if (!system && !me) return json({ error: 'sign-in required' }, 401)

  let body: { kind?: string; orderId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'expected a json body' }, 400)
  }
  const kind = body.kind as Kind | undefined
  const orderId = body.orderId
  if (!orderId || !kind || !KINDS.includes(kind)) {
    return json({ error: 'kind (placed|paid|ready|past_due) and orderId are required' }, 400)
  }

  const order = await fetchRow('hosting_orders', `id=eq.${encodeURIComponent(orderId)}&select=*`)
  if (!order) return json({ error: 'unknown order' }, 404)
  const customerId = String(order.user_id ?? '')

  // placed is the customer's own receipt; the rest are operator/system events
  if (!system) {
    const mine = me === customerId
    if (kind === 'placed' ? !mine : !(await isAdmin(me as string))) {
      return json({ error: 'not yours to send' }, 403)
    }
  }

  const plan = await fetchRow('hosting_plans', `id=eq.${encodeURIComponent(String(order.plan_id))}&select=*`)
  const planName = String(plan?.name ?? order.plan_id ?? 'plan')
  const price = money(Number(plan?.price_monthly ?? 0), String(plan?.currency ?? 'USD'))
  const serverName = String(order.server_name ?? 'your server')
  const reference = String(order.reference ?? '')
  const to = await userEmail(customerId)
  const panelUrl = SITE_URL ? `${SITE_URL}/manage/` : ''
  const panelLine = panelUrl
    ? `<p style="font-size:13px;color:#4d5a68">Everything about this order lives under <a href="${escapeHtml(panelUrl)}">Billing in your panel</a>.</p>`
    : ''

  if (kind === 'placed') {
    const settings = await fetchRow('hosting_settings', 'id=eq.1&select=*')
    const paypal = String(settings?.paypal_me ?? '')
    const payLine = paypal
      ? `<p>Pay by card straight from the panel, or send <b>${escapeHtml(price)}</b> to <a href="https://paypal.me/${encodeURIComponent(paypal)}">paypal.me/${escapeHtml(paypal)}</a> with the reference in the note.</p>`
      : `<p>Pay from the panel — the receipt there has your options.</p>`
    const receipt = await send(
      to,
      `Order ${reference} — ${serverName}`,
      wrap(
        `Your order is in`,
        `<p>${escapeHtml(serverName)} · ${escapeHtml(planName)} · ${escapeHtml(price)}/mo</p>
         ${box('#7c6cff', `Reference: ${escapeHtml(reference)}`)}
         <p>Nothing has been charged yet.</p>
         ${payLine}
         ${panelLine}`
      )
    )
    const discord = await pingDiscord(
      `**New order ${reference}** — ${serverName} (${planName}, ${price}/mo). Review it in the panel's Admin view.`
    )
    return json({ ok: true, receipt, discord })
  }

  if (kind === 'paid') {
    const out = await send(
      to,
      `Payment received — ${serverName} is being built`,
      wrap(
        `${serverName} is on its way`,
        `<p>Your payment for order <b>${escapeHtml(reference)}</b> is confirmed. One of our machines is
         building the server now — it usually lands in your panel within the hour, and you'll get
         one more email with the join address the moment it's ready.</p>
         ${panelLine}`
      )
    )
    return json({ ok: true, mail: out })
  }

  if (kind === 'ready') {
    // the address the host published; the order's server_id points at it
    const status = order.server_id
      ? await fetchRow('server_status', `server_id=eq.${encodeURIComponent(String(order.server_id))}&select=address`)
      : null
    const address = String(status?.address ?? '')
    const out = await send(
      to,
      address ? `${serverName} is ready — join at ${address}` : `${serverName} is ready`,
      wrap(
        `${serverName} is live`,
        `${address ? box('#3ba55d', `Join at: ${escapeHtml(address)}`) : '<p>The join address is on your server card in the panel.</p>'}
         <p>It starts itself, restarts itself if it crashes, and backs itself up. The console,
         settings, files and player tools are all in your panel.</p>
         ${panelLine}`
      )
    )
    return json({ ok: true, mail: out })
  }

  // past_due
  const out = await send(
    to,
    `${serverName} is paused — renewing brings it right back`,
    wrap(
      `${serverName} ran out of paid time`,
      `<p>Order <b>${escapeHtml(reference)}</b> lapsed, so the server has been stopped.
       <b>Your world and all its files are kept</b> — renew under Billing and it picks up where
       it left off.</p>
       ${panelLine}`
    )
  )
  return json({ ok: true, mail: out })
})
