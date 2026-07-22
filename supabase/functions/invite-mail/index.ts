// invite-mail — the three emails the application flow sends.
//
// Why this exists: applications are worthless if nobody is told about them. An
// applicant needs a receipt, the owner needs to know something is waiting, and
// the decision has to reach the applicant with whatever join instructions the
// owner wrote. None of that can come from the browser — it would mean shipping
// a mail provider's key to every visitor.
//
// Two things keep it from being an open relay for the whole internet:
//   1. every request carries a real signed-in user's JWT — the bare anon key is
//      rejected, same as cf-proxy;
//   2. the caller never supplies a recipient. The address is looked up from the
//      application row, and only ever the applicant's own or the owner's, so a
//      stolen token cannot address mail to a stranger.
//
// Deploy:
//   supabase functions deploy invite-mail --project-ref <ref>
//   supabase secrets set INVITE_MAIL_FROM="Your Servers <invites@yourdomain>" --project-ref <ref>
//   supabase secrets set INVITE_SITE_URL="https://enderappsrepo.github.io/elauncher" --project-ref <ref>
//
// Then whichever notification channels you can actually get. All optional, and
// none of them block the flow:
//
//   RESEND_API_KEY          best sender, but needs a verified domain first
//   BREVO_API_KEY           fallback: 300/day free, sends from a single
//                           confirmed address with no DNS to wait on
//   INVITE_DISCORD_WEBHOOK  owner alerts only, no domain or provider at all —
//                           channel settings → Integrations → Webhooks
//
// Resend wins when both mail keys are set. With no channel configured the
// function still returns 200 and reports what it skipped: applications are
// recorded either way, and the invite page shows an applicant their status and
// join instructions whenever they reopen the link. Notifications make the flow
// timely; they are not what makes it work.

const RESEND_API = 'https://api.resend.com/emails'
const BREVO_API = 'https://api.brevo.com/v3/smtp/email'

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
// Brevo is the fallback provider: 300/day free and it will send from an
// unverified single address, so it works before DNS is sorted out
const BREVO_KEY = Deno.env.get('BREVO_API_KEY') ?? ''
// Owner alerts can skip email entirely — a Discord webhook needs no domain, no
// provider account and no DNS, just a channel the owner already has
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

/** Read a row with the service key — RLS is re-implemented by hand below. */
async function fetchRow(table: string, query: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  })
  if (!res.ok) return null
  const rows = (await res.json()) as Record<string, unknown>[]
  return rows[0] ?? null
}

/**
 * A user's email. It lives in auth.users, which PostgREST does not expose at
 * all, so this goes through the Auth admin API with the service key — there is
 * no table to select from.
 */
async function userEmail(id: string): Promise<string> {
  if (!id) return ''
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  })
  if (!res.ok) return ''
  const user = (await res.json()) as { email?: string }
  return user.email ?? ''
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** Plain, readable HTML — no images, no tracking, nothing to trip a spam filter. */
function wrap(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#131820;line-height:1.55">
<h2 style="margin:0 0 14px;font-size:19px">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="margin-top:26px;font-size:12px;color:#7c8896">Sent by ELauncher because you used a server invite link.</p>
</div>`
}

/** "Name <addr@host>" or a bare address — Brevo wants the two parts separately. */
function splitFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return m ? { name: m[1] || undefined, email: m[2] } : { email: from.trim() }
}

type SendResult = { sent: boolean; via?: string; reason?: string }

/**
 * Send one email through whichever provider is configured.
 *
 * Both are plain HTTP APIs of the same shape, so supporting two costs almost
 * nothing and removes a hard dependency on any single signup. Resend wins when
 * both are set because it is the better sender once a domain is verified; Brevo
 * exists precisely because that verification is the slow part and it will send
 * from a single confirmed address in the meantime.
 *
 * Returning `sent:false` rather than throwing is deliberate: a decision must
 * still be recorded when mail is unavailable.
 */
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

/**
 * Ping the owner's Discord channel. Independent of email on purpose: it needs no
 * domain, no provider account and no DNS, so an owner with no mail set up at all
 * still hears about an application the moment it lands.
 */
async function pingDiscord(content: string): Promise<SendResult> {
  if (!DISCORD_WEBHOOK) return { sent: false, reason: 'no webhook configured' }
  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // suppress mention parsing: an applicant-supplied name must not be able to
    // @everyone the owner's server
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } })
  })
  if (!res.ok) return { sent: false, via: 'discord', reason: `${res.status}` }
  return { sent: true, via: 'discord' }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const me = await callerId(req.headers.get('authorization') ?? '')
  if (!me) return json({ error: 'sign-in required' }, 401)
  if (!SERVICE_KEY) return json({ error: 'function is missing its service key' }, 500)

  let body: { kind?: string; applicationId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'expected a json body' }, 400)
  }
  const { kind, applicationId } = body
  if (!applicationId || !kind) return json({ error: 'kind and applicationId are required' }, 400)

  const app = await fetchRow('server_applications', `id=eq.${encodeURIComponent(applicationId)}&select=*`)
  if (!app) return json({ error: 'unknown application' }, 404)

  const applicantId = String(app.applicant_id ?? '')
  const ownerId = String(app.owner_id ?? '')
  // the caller must be one of the two parties — this is the check that stops a
  // stolen token mailing anyone it likes
  if (me !== applicantId && me !== ownerId) return json({ error: 'not your application' }, 403)

  const invite = await fetchRow('server_invites', `code=eq.${encodeURIComponent(String(app.code))}&select=*`)
  const serverName = String(invite?.server_name ?? app.server_id ?? 'the server')
  const applicantName = String(app.applicant_name || 'a player')
  const applicantEmail = String(app.applicant_email ?? '')
  const inviteUrl = SITE_URL ? `${SITE_URL}/i/?c=${encodeURIComponent(String(app.code))}` : ''

  if (kind === 'submitted') {
    // receipt to the applicant, and a heads-up to the owner
    if (me !== applicantId) return json({ error: 'only the applicant sends this' }, 403)
    const receipt = await send(
      applicantEmail,
      `Application received — ${serverName}`,
      wrap(`Your application to ${serverName} is in`, `<p>Thanks — the owner has been notified and will review it. You'll get another email when they decide.</p>
        ${inviteUrl ? `<p style="font-size:13px;color:#4d5a68">You can check the status any time at <a href="${escapeHtml(inviteUrl)}">your invite link</a>.</p>` : ''}`)
    )

    // The owner is told twice over, because these fail independently: email
    // needs a provider and a verified domain, Discord needs neither. Either one
    // arriving is enough, and a missing owner address never fails the
    // applicant's receipt — the application is recorded regardless.
    const ownerEmail = await userEmail(ownerId)
    const notify = ownerEmail
      ? await send(
          ownerEmail,
          `New application — ${serverName}`,
          wrap(`${applicantName} applied to ${serverName}`, `<p>Review it in your ELauncher panel to approve or deny.</p>`)
        )
      : { sent: false, reason: 'owner email unavailable' }

    const discord = await pingDiscord(
      `**New application — ${serverName}**\n${applicantName} applied. Review it in your ELauncher panel.`
    )

    return json({ ok: true, receipt, notify, discord })
  }

  if (kind === 'decided') {
    if (me !== ownerId) return json({ error: 'only the owner sends this' }, 403)
    const approved = String(app.status) === 'approved'
    const note = String(app.owner_note ?? '')
    const message = approved ? String(invite?.approval_message ?? '') : note

    const out = await send(
      applicantEmail,
      approved ? `You're in — ${serverName}` : `About your application to ${serverName}`,
      wrap(
        approved ? `Welcome to ${serverName}` : `Your application to ${serverName}`,
        approved
          ? `<p>Your application was approved. Here's how to join:</p>
             <div style="background:#f4f6f9;border-left:3px solid #3ba55d;padding:12px 14px;border-radius:6px;white-space:pre-wrap">${escapeHtml(message || 'The owner did not leave instructions — reply to ask.')}</div>`
          : `<p>Your application wasn't accepted this time.</p>
             ${note ? `<div style="background:#f4f6f9;border-left:3px solid #d05353;padding:12px 14px;border-radius:6px;white-space:pre-wrap">${escapeHtml(note)}</div>` : ''}`
      )
    )
    return json({ ok: true, mail: out })
  }

  return json({ error: `unknown kind "${kind}"` }, 400)
})
