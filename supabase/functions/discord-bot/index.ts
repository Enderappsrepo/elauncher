// discord-bot — the HTTP-interactions endpoint the whole Discord flow runs on.
//
// Discord POSTs every slash command, button press and modal submit here as a
// signed request; the function replies and exits. No gateway, no websocket, no
// persistent process anywhere — which is the entire reason this can live as an
// edge function instead of a VPS daemon.
//
// One URL, two kinds of caller, told apart by how they authenticate:
//   1. Discord — carries X-Signature-Ed25519 over (timestamp + raw body).
//      That signature IS the authentication, so the function must be deployed
//      with --no-verify-jwt, same as stripe-webhook.
//   2. The panel — a JSON body with a `kind`, carrying either a signed-in
//      user's JWT (redeem / guildinfo / decided / meta) or the service role key
//      (register). Checked per-route below.
//
// What the bot does in a guild:
//   /setup   (Manage Server only) mint a claim code that the panel redeems to
//            link this guild to an ELauncher server. Redeeming proves guild
//            authority — see 2026-07-22-discord-claims.sql for why.
//   /apply   open the invite's questions as a modal; submitting writes a
//            server_applications row and posts it, with Approve/Deny buttons,
//            to the review channel.
//   /status  what happened to your application, privately.
//   Approve / Deny buttons: moderators with Manage Server decide in place;
//   the applicant is told by DM, the approved role is granted, and a denied
//   applicant gets one Appeal button (if the owner allows appeals).
//
// Deploy:
//   supabase functions deploy discord-bot --no-verify-jwt --project-ref <ref>
//   supabase secrets set DISCORD_PUBLIC_KEY=... DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... --project-ref <ref>
// then paste the function URL into the app's "Interactions Endpoint URL" and
// register the commands — the full walk-through is supabase/DEPLOY-DISCORD.md.

const PUBLIC_KEY = Deno.env.get('DISCORD_PUBLIC_KEY') ?? ''
const APP_ID = Deno.env.get('DISCORD_APP_ID') ?? ''
const BOT_TOKEN = Deno.env.get('DISCORD_BOT_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const DISCORD_API = 'https://discord.com/api/v10'

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } })

/** Keep the isolate alive for work that happens after a deferred ack. */
function bg(work: Promise<unknown>): void {
  const guarded = work.catch((e) => console.error('background work failed:', e))
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(guarded)
}

// ============================================================
// signature — the request really came from Discord
// ============================================================

const enc = new TextEncoder()

function hex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

let pubKey: CryptoKey | null = null

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const sig = req.headers.get('x-signature-ed25519')
  const ts = req.headers.get('x-signature-timestamp')
  if (!sig || !ts || !PUBLIC_KEY) return false
  try {
    pubKey ??= await crypto.subtle.importKey('raw', hex(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', pubKey, hex(sig), enc.encode(ts + rawBody))
  } catch {
    return false
  }
}

// ============================================================
// database — PostgREST with the service key
// ============================================================
// The bot has no session; RLS is re-implemented by hand where it matters (the
// panel routes check ownership explicitly before touching anything).

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'content-type': 'application/json'
}

async function sbOne<T>(table: string, query: string): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`, { headers: SB_HEADERS })
  if (!res.ok) return null
  const rows = (await res.json()) as T[]
  return rows[0] ?? null
}

async function sbInsert<T>(table: string, row: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(row)
  })
  if (!res.ok) return null
  const rows = (await res.json()) as T[]
  return rows[0] ?? null
}

async function sbUpsert<T>(table: string, row: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  })
  if (!res.ok) return null
  const rows = (await res.json()) as T[]
  return rows[0] ?? null
}

async function sbUpdate(table: string, query: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(patch)
  })
  return res.ok
}

async function sbDelete(table: string, query: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: SB_HEADERS })
}

async function sbRpc<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify(args)
  })
  if (!res.ok) return null
  return (await res.json()) as T
}

/** The signed-in user behind a panel request, or null. Same check as invite-mail. */
async function callerId(auth: string): Promise<string | null> {
  if (!auth.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY }
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user.id ?? null
}

// ============================================================
// row shapes (the columns this function actually touches)
// ============================================================

interface Question {
  id: string
  label: string
  type: string
  required?: boolean
  options?: string[]
}

interface LinkRow {
  guild_id: string
  server_id: string
  owner_id: string
  invite_code: string | null
  approved_role_id: string
  review_channel_id: string
  allow_appeals: boolean
  enabled: boolean
  guild_name?: string
}

interface InviteRow {
  code: string
  server_id: string
  owner_id: string
  server_name: string
  questions: Question[]
  approval_message: string
  enabled: boolean
  expires_at: string | null
  max_uses: number | null
  uses: number
}

interface AppRow {
  id: string
  code: string
  server_id: string
  owner_id: string
  discord_user_id: string | null
  discord_username: string | null
  applicant_name: string
  guild_id: string | null
  answers: Record<string, string>
  status: string
  owner_note: string
  appeal_text: string
  appealed_at: string | null
  review_message_id: string
}

// ============================================================
// Discord REST
// ============================================================

interface DResult {
  ok: boolean
  status: number
  // deno-lint-ignore no-explicit-any
  data: any
}

async function dapi(
  path: string,
  init: { method?: string; body?: unknown; reason?: string } = {}
): Promise<DResult> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'content-type': 'application/json',
      ...(init.reason ? { 'X-Audit-Log-Reason': encodeURIComponent(init.reason) } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

/**
 * DM a user. Two calls because Discord has no "send to user" endpoint — you
 * open (or reopen, it is idempotent) the DM channel first. Returns false when
 * the user's privacy settings refuse bot DMs, which callers surface rather
 * than swallow: "decided but untold" is a state the owner needs to know about.
 */
async function dm(userId: string, payload: Record<string, unknown>): Promise<boolean> {
  const ch = await dapi('/users/@me/channels', { method: 'POST', body: { recipient_id: userId } })
  if (!ch.ok) return false
  const msg = await dapi(`/channels/${ch.data.id}/messages`, {
    method: 'POST',
    // applicant-supplied text rides in these payloads; without this a display
    // name of "@everyone" would ping the whole guild
    body: { allowed_mentions: { parse: [] }, ...payload }
  })
  return msg.ok
}

/** Replace the content of the ephemeral "thinking…" left by a deferred ack. */
async function editOriginal(token: string, payload: Record<string, unknown>): Promise<void> {
  await dapi(`/webhooks/${APP_ID}/${token}/messages/@original`, {
    method: 'PATCH',
    body: { allowed_mentions: { parse: [] }, ...payload }
  })
}

// ============================================================
// shared pieces of the application flow
// ============================================================

const COLOR = { pending: 0x7c6cff, approved: 0x3ba55d, denied: 0xd05353, appealed: 0xf0b232 } as const

const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** The applicant's answers as embed fields, labelled with the owner's questions. */
function answerFields(app: AppRow, invite: InviteRow | null): { name: string; value: string }[] {
  const questions = invite?.questions ?? []
  const fields: { name: string; value: string }[] = []
  for (const q of questions) {
    const v = String(app.answers?.[q.id] ?? '').trim()
    if (v) fields.push({ name: trunc(q.label, 100), value: trunc(v, 1000) })
  }
  // answers whose question has since been deleted still deserve to be seen
  for (const [k, v] of Object.entries(app.answers ?? {})) {
    if (!questions.some((q) => q.id === k) && String(v).trim())
      fields.push({ name: k, value: trunc(String(v), 1000) })
  }
  return fields.slice(0, 20)
}

function decideButtons(appId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Approve', custom_id: `d:a:${appId}` },
        { type: 2, style: 4, label: 'Deny', custom_id: `d:d:${appId}` }
      ]
    }
  ]
}

function reviewEmbed(
  app: AppRow,
  invite: InviteRow | null,
  state: keyof typeof COLOR,
  footer: string
): Record<string, unknown> {
  const title =
    state === 'pending'
      ? `Application — ${app.applicant_name || app.discord_username || 'unknown'}`
      : state === 'appealed'
        ? `Appeal — ${app.applicant_name || app.discord_username || 'unknown'}`
        : `${state === 'approved' ? 'Approved' : 'Denied'} — ${app.applicant_name || app.discord_username || 'unknown'}`
  const fields = answerFields(app, invite)
  if (state === 'appealed' && app.appeal_text)
    fields.unshift({ name: 'Their appeal', value: trunc(app.appeal_text, 1000) })
  return {
    title: trunc(title, 256),
    description: app.discord_user_id ? `<@${app.discord_user_id}>` : undefined,
    color: COLOR[state],
    fields,
    footer: footer ? { text: trunc(footer, 2048) } : undefined,
    timestamp: new Date().toISOString()
  }
}

/**
 * Post (or re-post, for an appeal) an application into the review channel and
 * remember the message id so a later decision — from either side — can edit it.
 * Quietly does nothing when no channel is configured: the panel queue is the
 * fallback review surface and it needs no bot at all.
 */
async function postReview(link: LinkRow, app: AppRow, invite: InviteRow | null, appeal: boolean): Promise<void> {
  if (!link.review_channel_id) return
  const res = await dapi(`/channels/${link.review_channel_id}/messages`, {
    method: 'POST',
    body: {
      content: appeal ? 'A denied applicant is asking for another look:' : 'New application:',
      embeds: [reviewEmbed(app, invite, appeal ? 'appealed' : 'pending', 'Approve or deny here, or in the ELauncher panel')],
      components: decideButtons(app.id),
      allowed_mentions: { parse: [] }
    }
  })
  if (res.ok && res.data?.id)
    await sbUpdate('server_applications', `id=eq.${app.id}`, { review_message_id: String(res.data.id) })
}

/**
 * Everything that happens *around* a decision, regardless of where the decision
 * was made (a Discord button or the panel): grant the role, tell the applicant
 * by DM, and rewrite the review-channel post so its buttons disappear.
 *
 * Returns human-readable notes for anything that could not be done — a role the
 * bot cannot reach, a DM the applicant's privacy settings refused. The decision
 * itself stands either way; these are delivery problems, not veto power.
 */
async function decisionSideEffects(
  app: AppRow,
  link: LinkRow | null,
  invite: InviteRow | null,
  approve: boolean,
  decidedBy: string
): Promise<string[]> {
  const notes: string[] = []
  const uid = app.discord_user_id
  if (!uid) return notes

  if (approve && link?.approved_role_id && app.guild_id) {
    const role = await dapi(`/guilds/${app.guild_id}/members/${uid}/roles/${link.approved_role_id}`, {
      method: 'PUT',
      reason: 'ELauncher application approved'
    })
    if (!role.ok)
      notes.push(
        role.status === 403
          ? 'Could not assign the role — move the bot’s own role above it in Server Settings → Roles.'
          : `Could not assign the role (Discord said ${role.status}).`
      )
  }

  const serverName = invite?.server_name || 'the server'
  const sent = approve
    ? await dm(uid, {
        embeds: [
          {
            title: trunc(`You’re in — ${serverName}`, 256),
            description: trunc(
              invite?.approval_message?.trim() ||
                'Your application was approved. The owner did not leave join instructions — ask them in the server.',
              4000
            ),
            color: COLOR.approved
          }
        ]
      })
    : await dm(uid, {
        embeds: [
          {
            title: trunc(`About your application to ${serverName}`, 256),
            description: trunc(
              `Your application wasn’t accepted this time.${app.owner_note ? `\n\n> ${app.owner_note}` : ''}`,
              4000
            ),
            color: COLOR.denied
          }
        ],
        // one appeal, and only while the owner allows them
        components:
          link?.allow_appeals && !app.appealed_at
            ? [{ type: 1, components: [{ type: 2, style: 2, label: 'Appeal this decision', custom_id: `ap:${app.id}` }] }]
            : []
      })
  if (!sent) notes.push('Could not DM the applicant — their privacy settings block it. They can check with /status.')

  if (link?.review_channel_id && app.review_message_id) {
    await dapi(`/channels/${link.review_channel_id}/messages/${app.review_message_id}`, {
      method: 'PATCH',
      body: {
        content: '',
        embeds: [
          reviewEmbed(
            app,
            invite,
            approve ? 'approved' : 'denied',
            `${approve ? 'Approved' : 'Denied'} by ${decidedBy}${notes.length ? ` · ${notes.join(' ')}` : ''}`
          )
        ],
        components: [],
        allowed_mentions: { parse: [] }
      }
    })
  }

  return notes
}

/** Why a link is not currently usable, in words meant for the applicant. */
function inviteClosed(invite: InviteRow | null): string | null {
  if (!invite) return 'Applications aren’t open here right now.'
  if (!invite.enabled) return 'Applications are paused right now — try again later.'
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return 'This invite has expired.'
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return 'This invite is full.'
  return null
}

// ============================================================
// interactions
// ============================================================

interface DUser {
  id: string
  username: string
  global_name?: string | null
}

interface Interaction {
  type: number
  token: string
  guild_id?: string
  channel_id?: string
  member?: { user: DUser; permissions?: string }
  user?: DUser
  message?: { id: string }
  data?: {
    name?: string
    custom_id?: string
    components?: { components: { custom_id: string; value?: string }[] }[]
  }
}

// interaction types / response types, by their protocol numbers
const PING = 1
const COMMAND = 2
const COMPONENT = 3
const MODAL_SUBMIT = 5
const R_PONG = 1
const R_MESSAGE = 4
const R_DEFER_MESSAGE = 5
const R_DEFER_UPDATE = 6
const R_MODAL = 9
const EPHEMERAL = 64

const whoever = (i: Interaction): DUser => i.member?.user ?? i.user ?? { id: '', username: 'unknown' }

/** Manage Server or Administrator — the bar for /setup and the decide buttons. */
function canManage(i: Interaction): boolean {
  try {
    return (BigInt(i.member?.permissions ?? '0') & 0x28n) !== 0n
  } catch {
    return false
  }
}

const ephemeral = (content: string): Response => json({ type: R_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } })

const CLAIM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function claimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = ''
  for (const b of bytes) out += CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]
  return out
}

async function linkFor(guildId: string): Promise<LinkRow | null> {
  return await sbOne<LinkRow>('discord_links', `guild_id=eq.${encodeURIComponent(guildId)}&select=*`)
}

async function inviteFor(link: LinkRow | null): Promise<InviteRow | null> {
  if (!link?.invite_code) return null
  return await sbOne<InviteRow>('server_invites', `code=eq.${encodeURIComponent(link.invite_code)}&select=*`)
}

async function applicationFor(code: string, discordUserId: string): Promise<AppRow | null> {
  return await sbOne<AppRow>(
    'server_applications',
    `code=eq.${encodeURIComponent(code)}&discord_user_id=eq.${encodeURIComponent(discordUserId)}&select=*`
  )
}

/**
 * Write the application row and put it in front of the owner. Shared by the
 * modal submit and the no-questions /apply, and mirrors apply_to_invite():
 * re-applying updates the same row back to pending rather than piling up, and
 * an already-approved applicant is told so instead of being reset.
 */
async function submitApplication(
  i: Interaction,
  link: LinkRow,
  invite: InviteRow,
  answers: Record<string, string>
): Promise<void> {
  const user = whoever(i)
  const name = (user.global_name ?? '').trim() || user.username

  const existing = await applicationFor(invite.code, user.id)
  let app: AppRow | null
  if (existing?.status === 'approved') {
    await editOriginal(i.token, {
      content: `You’re already approved for **${invite.server_name || 'this server'}** — run /status to see the join instructions again.`
    })
    return
  }
  if (existing) {
    const ok = await sbUpdate('server_applications', `id=eq.${existing.id}`, {
      answers,
      status: 'pending',
      owner_note: '',
      decided_at: null,
      decided_by: null,
      appeal_text: '',
      appealed_at: null,
      discord_username: user.username,
      applicant_name: name,
      guild_id: link.guild_id
    })
    app = ok ? { ...existing, answers, status: 'pending', appeal_text: '', appealed_at: null, applicant_name: name } : null
  } else {
    app = await sbInsert<AppRow>('server_applications', {
      code: invite.code,
      server_id: link.server_id,
      owner_id: link.owner_id,
      discord_user_id: user.id,
      discord_username: user.username,
      applicant_name: name,
      guild_id: link.guild_id,
      answers,
      status: 'pending'
    })
    if (app) await sbUpdate('server_invites', `code=eq.${encodeURIComponent(invite.code)}`, { uses: invite.uses + 1 })
  }

  if (!app) {
    await editOriginal(i.token, { content: 'Something went wrong saving your application — try again in a minute.' })
    return
  }

  await postReview(link, app, invite, false)
  await editOriginal(i.token, {
    content: `✅ Your application to **${invite.server_name || 'the server'}** is in. You’ll get a DM when it’s decided — make sure DMs from members of this server are allowed, or check back with /status.`
  })
}

async function handleCommand(i: Interaction): Promise<Response> {
  const name = i.data?.name ?? ''
  const guildId = i.guild_id ?? ''
  if (!guildId) return ephemeral('This command only works inside a server.')

  if (name === 'setup') {
    if (!canManage(i)) return ephemeral('Only members with **Manage Server** can run /setup.')
    const token = i.token
    bg(
      (async () => {
        const guild = await dapi(`/guilds/${guildId}`)
        const guildName = String(guild.data?.name ?? '')
        const code = claimCode()
        // one live claim per guild — a stale code should not still work
        await sbDelete('discord_claims', `guild_id=eq.${encodeURIComponent(guildId)}`)
        const claim = await sbInsert('discord_claims', {
          code,
          guild_id: guildId,
          guild_name: guildName,
          created_by: whoever(i).id,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
        })
        if (!claim) {
          await editOriginal(token, {
            content: 'Could not mint a claim code — has `2026-07-22-discord-claims.sql` been run on the project?'
          })
          return
        }
        const link = await linkFor(guildId)
        await editOriginal(token, {
          content: [
            link
              ? `This Discord is already linked to an ELauncher server. Redeeming a new code **moves** the link — use it only if that’s what you want.`
              : `Almost there — this Discord isn’t linked to an ELauncher server yet.`,
            '',
            `Your claim code: \`${code}\` (valid 30 minutes)`,
            '',
            'In the ELauncher panel, open your server → **Access** → **Discord**, paste the code, and the link is made. Applications, roles and the review channel are all configured there.'
          ].join('\n')
        })
      })()
    )
    return json({ type: R_DEFER_MESSAGE, data: { flags: EPHEMERAL } })
  }

  const link = await linkFor(guildId)
  if (!link || !link.enabled)
    return ephemeral(
      link
        ? 'Applications are switched off right now.'
        : 'This Discord isn’t connected to a game server yet. An admin can link one with /setup.'
    )
  const invite = await inviteFor(link)

  if (name === 'status') {
    if (!invite) return ephemeral('Applications aren’t open here right now.')
    const app = await applicationFor(invite.code, whoever(i).id)
    if (!app) return ephemeral(`You haven’t applied to **${invite.server_name || 'this server'}** yet — run /apply.`)
    if (app.status === 'approved')
      return ephemeral(
        `You’re approved for **${invite.server_name || 'this server'}**.\n\n${invite.approval_message?.trim() || 'The owner did not leave join instructions — ask them here.'}`
      )
    if (app.status === 'pending') return ephemeral('Your application is in — the owner hasn’t decided yet.')
    if (app.status === 'appealed') return ephemeral('Your appeal is with the owner — hang tight.')
    return ephemeral(
      `Your application was denied.${app.owner_note ? `\n> ${app.owner_note}` : ''}${
        link.allow_appeals && !app.appealed_at ? '\nYou can apply again with /apply, or appeal from the DM the bot sent you.' : ''
      }`
    )
  }

  if (name === 'apply') {
    const closed = inviteClosed(invite)
    if (closed) return ephemeral(closed)
    const inv = invite as InviteRow

    const existing = await applicationFor(inv.code, whoever(i).id)
    if (existing?.status === 'approved')
      return ephemeral(
        `You’re already in — **${inv.server_name || 'this server'}** approved you.\n\n${inv.approval_message?.trim() || ''}`.trim()
      )
    if (existing?.status === 'pending') return ephemeral('Your application is already in — the owner hasn’t decided yet.')
    if (existing?.status === 'appealed') return ephemeral('Your appeal is still with the owner — hang tight.')

    const questions = (inv.questions ?? []).filter((q) => q.label?.trim())
    if (questions.length === 0) {
      // nothing to ask — file it straight away
      bg(submitApplication(i, link, inv, {}))
      return json({ type: R_DEFER_MESSAGE, data: { flags: EPHEMERAL } })
    }

    // Discord modals hold at most five inputs; the panel says so where owners
    // write their questions, and the first five win here.
    const rows = questions.slice(0, 5).map((q) => ({
      type: 1,
      components: [
        {
          type: 4,
          custom_id: q.id,
          style: q.type === 'textarea' ? 2 : 1,
          label: trunc(q.label, 45),
          placeholder:
            q.type === 'select' && Array.isArray(q.options) && q.options.length
              ? trunc(`One of: ${q.options.join(' / ')}`, 100)
              : undefined,
          required: q.required !== false,
          max_length: 1000
        }
      ]
    }))
    return json({
      type: R_MODAL,
      data: { custom_id: `apply:${inv.code}`, title: trunc(`Apply — ${inv.server_name || 'server'}`, 45), components: rows }
    })
  }

  return ephemeral(`Unknown command "/${name}".`)
}

async function handleComponent(i: Interaction): Promise<Response> {
  const id = i.data?.custom_id ?? ''

  // Approve / Deny buttons on the review post
  if (id.startsWith('d:')) {
    const [, verb, appId] = id.split(':')
    if (!canManage(i)) return ephemeral('Only members with **Manage Server** can decide applications.')
    const app = await sbOne<AppRow>('server_applications', `id=eq.${encodeURIComponent(appId)}&select=*`)
    if (!app) return ephemeral('This application no longer exists — its invite link was probably deleted.')
    if (app.status === 'approved' || app.status === 'denied')
      return ephemeral(`Already ${app.status} — decisions made in the panel land here too.`)

    if (verb === 'd') {
      // the reason is worth a modal: it is what the applicant reads in the DM
      return json({
        type: R_MODAL,
        data: {
          custom_id: `denym:${app.id}`,
          title: 'Deny this application',
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: 'reason',
                  style: 2,
                  label: 'Reason (optional — sent to them)',
                  required: false,
                  max_length: 900
                }
              ]
            }
          ]
        }
      })
    }

    const decider = whoever(i).username
    bg(
      (async () => {
        await sbUpdate('server_applications', `id=eq.${app.id}`, {
          status: 'approved',
          decided_at: new Date().toISOString()
        })
        const link = await linkFor(app.guild_id ?? '')
        const invite = await sbOne<InviteRow>('server_invites', `code=eq.${encodeURIComponent(app.code)}&select=*`)
        await decisionSideEffects({ ...app, status: 'approved' }, link, invite, true, decider)
      })()
    )
    return json({ type: R_DEFER_UPDATE })
  }

  // Appeal button, in the applicant's DM
  if (id.startsWith('ap:')) {
    const appId = id.slice(3)
    const app = await sbOne<AppRow>('server_applications', `id=eq.${encodeURIComponent(appId)}&select=*`)
    if (!app || app.discord_user_id !== whoever(i).id) return ephemeral('This isn’t your application to appeal.')
    if (app.status !== 'denied') return ephemeral('Only a denied application can be appealed.')
    if (app.appealed_at) return ephemeral('You’ve already appealed this one — the owner has it.')
    return json({
      type: R_MODAL,
      data: {
        custom_id: `apm:${app.id}`,
        title: 'Appeal the decision',
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: 'reason',
                style: 2,
                label: 'Why should this be reconsidered?',
                required: true,
                max_length: 900
              }
            ]
          }
        ]
      }
    })
  }

  return ephemeral('That button no longer does anything.')
}

async function handleModal(i: Interaction): Promise<Response> {
  const id = i.data?.custom_id ?? ''
  const values: Record<string, string> = {}
  for (const row of i.data?.components ?? [])
    for (const c of row.components ?? []) values[c.custom_id] = (c.value ?? '').trim()

  // an application's answers arriving
  if (id.startsWith('apply:')) {
    const code = id.slice(6)
    const guildId = i.guild_id ?? ''
    const link = await linkFor(guildId)
    const invite = link?.invite_code === code ? await inviteFor(link) : null
    // the world may have changed between the modal opening and the submit
    if (!link || !link.enabled) return ephemeral('Applications are switched off right now.')
    const closed = inviteClosed(invite)
    if (closed) return ephemeral(closed)
    bg(submitApplication(i, link, invite as InviteRow, values))
    return json({ type: R_DEFER_MESSAGE, data: { flags: EPHEMERAL } })
  }

  // a denial's reason arriving from the moderator
  if (id.startsWith('denym:')) {
    const appId = id.slice(6)
    if (!canManage(i)) return ephemeral('Only members with **Manage Server** can decide applications.')
    const decider = whoever(i).username
    const reason = values.reason ?? ''
    bg(
      (async () => {
        const app = await sbOne<AppRow>('server_applications', `id=eq.${encodeURIComponent(appId)}&select=*`)
        if (!app) return
        await sbUpdate('server_applications', `id=eq.${app.id}`, {
          status: 'denied',
          owner_note: reason,
          decided_at: new Date().toISOString()
        })
        const link = await linkFor(app.guild_id ?? '')
        const invite = await sbOne<InviteRow>('server_invites', `code=eq.${encodeURIComponent(app.code)}&select=*`)
        await decisionSideEffects({ ...app, status: 'denied', owner_note: reason }, link, invite, false, decider)
      })()
    )
    return json({ type: R_DEFER_UPDATE })
  }

  // an appeal's text arriving from the applicant's DM
  if (id.startsWith('apm:')) {
    const appId = id.slice(4)
    const token = i.token
    const channelId = i.channel_id ?? ''
    const messageId = i.message?.id ?? ''
    const userId = whoever(i).id
    bg(
      (async () => {
        const app = await sbOne<AppRow>('server_applications', `id=eq.${encodeURIComponent(appId)}&select=*`)
        if (!app || app.discord_user_id !== userId) return
        // the RPC enforces denied-only and once-only; with no auth.uid() it
        // deliberately lets the service key act for Discord-native applicants
        const res = await sbRpc<{ ok?: boolean; reason?: string }>('appeal_application', {
          application_id: app.id,
          reason: values.reason ?? ''
        })
        if (!res?.ok) {
          // a followup, not an edit — the denial DM the button sat on should
          // survive its appeal failing
          await dapi(`/webhooks/${APP_ID}/${token}`, {
            method: 'POST',
            body: { content: `Could not appeal: ${res?.reason ?? 'unknown error'}`, allowed_mentions: { parse: [] } }
          })
          return
        }
        const fresh = { ...app, status: 'appealed', appeal_text: values.reason ?? '', appealed_at: new Date().toISOString() }
        const link = await linkFor(app.guild_id ?? '')
        const invite = await sbOne<InviteRow>('server_invites', `code=eq.${encodeURIComponent(app.code)}&select=*`)
        if (link) await postReview(link, fresh, invite, true)
        // take the button off the DM so "already appealed" never needs saying
        if (channelId && messageId)
          await dapi(`/channels/${channelId}/messages/${messageId}`, {
            method: 'PATCH',
            body: { components: [] }
          })
        await dm(userId, { content: 'Your appeal is in — the owner has been asked to take another look.' })
      })()
    )
    return json({ type: R_DEFER_UPDATE })
  }

  return ephemeral('That form no longer goes anywhere.')
}

// ============================================================
// panel routes — same function, JWT-authenticated JSON instead
// ============================================================

const COMMANDS = [
  { name: 'apply', description: 'Apply to join this community’s game server', contexts: [0] },
  { name: 'status', description: 'Check what happened to your application', contexts: [0] },
  {
    name: 'setup',
    description: 'Link this Discord to an ELauncher server (admins)',
    default_member_permissions: '32',
    contexts: [0]
  }
]

async function handlePanel(req: Request): Promise<Response> {
  if (!BOT_TOKEN || !APP_ID) return json({ error: 'DISCORD_BOT_TOKEN / DISCORD_APP_ID are not set on the function' }, 500)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'expected a json body' }, 400)
  }
  const kind = String(body.kind ?? '')
  const auth = req.headers.get('authorization') ?? ''

  // registering commands rewrites the app's global command list — operator only,
  // proven by the service role key rather than any user's JWT
  if (kind === 'register') {
    if (auth !== `Bearer ${SERVICE_KEY}`) return json({ error: 'register needs the service role key' }, 403)
    const res = await dapi(`/applications/${APP_ID}/commands`, { method: 'PUT', body: COMMANDS })
    if (!res.ok) return json({ error: `Discord refused: ${res.status} ${JSON.stringify(res.data)}` }, 502)
    return json({ ok: true, commands: (res.data as { name: string }[]).map((c) => c.name) })
  }

  const me = await callerId(auth)
  if (!me) return json({ error: 'sign-in required' }, 401)

  if (kind === 'meta') return json({ ok: true, appId: APP_ID })

  if (kind === 'redeem') {
    const code = String(body.code ?? '').trim().toLowerCase()
    const serverId = String(body.serverId ?? '')
    if (!code || !serverId) return json({ error: 'code and serverId are required' }, 400)
    const claim = await sbOne<{ code: string; guild_id: string; guild_name: string; expires_at: string }>(
      'discord_claims',
      `code=eq.${encodeURIComponent(code)}&select=*`
    )
    if (!claim || new Date(claim.expires_at) < new Date())
      return json({ error: 'That code is unknown or expired — run /setup in your Discord for a fresh one.' }, 404)
    const link = await sbUpsert<LinkRow>('discord_links', {
      guild_id: claim.guild_id,
      server_id: serverId,
      owner_id: me,
      guild_name: claim.guild_name,
      invite_code: null,
      approved_role_id: '',
      review_channel_id: '',
      allow_appeals: true,
      enabled: true
    })
    if (!link) return json({ error: 'Could not save the link — has 2026-07-22-discord-bot.sql been run?' }, 500)
    await sbDelete('discord_claims', `code=eq.${encodeURIComponent(code)}`)
    return json({ ok: true, link })
  }

  if (kind === 'guildinfo') {
    const guildId = String(body.guildId ?? '')
    // only the guild's link owner may enumerate its roles and channels — this
    // is what stops any signed-in user fishing other people's guilds by id
    const link = await sbOne<LinkRow>(
      'discord_links',
      `guild_id=eq.${encodeURIComponent(guildId)}&owner_id=eq.${encodeURIComponent(me)}&select=*`
    )
    if (!link) return json({ error: 'not your guild' }, 403)

    const [meUser, roles, channels] = await Promise.all([
      dapi('/users/@me'),
      dapi(`/guilds/${guildId}/roles`),
      dapi(`/guilds/${guildId}/channels`)
    ])
    if (!roles.ok || !channels.ok)
      return json({ error: 'The bot can’t read that guild — was it kicked? Re-invite it and try again.' }, 502)

    const botId = String(meUser.data?.id ?? APP_ID)
    const member = await dapi(`/guilds/${guildId}/members/${botId}`)
    // deno-lint-ignore no-explicit-any
    const all = roles.data as any[]
    const mine = new Set<string>(((member.data?.roles ?? []) as string[]).map(String))
    const botTop = all.filter((r) => mine.has(String(r.id))).reduce((top, r) => Math.max(top, Number(r.position)), 0)

    return json({
      ok: true,
      botTop,
      roles: all
        .filter((r) => String(r.id) !== guildId && !r.managed)
        .sort((a, b) => Number(b.position) - Number(a.position))
        .map((r) => ({
          id: String(r.id),
          name: String(r.name),
          // a role at or above the bot's own top role cannot be assigned by it
          assignable: Number(r.position) < botTop
        })),
      channels: (channels.data as { id: string; name: string; type: number; position: number }[])
        .filter((c) => c.type === 0 || c.type === 5)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((c) => ({ id: String(c.id), name: String(c.name) }))
    })
  }

  if (kind === 'decided') {
    const applicationId = String(body.applicationId ?? '')
    const app = await sbOne<AppRow>('server_applications', `id=eq.${encodeURIComponent(applicationId)}&select=*`)
    if (!app) return json({ error: 'unknown application' }, 404)
    if (app.owner_id !== me) return json({ error: 'not your application to announce' }, 403)
    if (!app.discord_user_id) return json({ error: 'not a Discord applicant — invite-mail handles this one' }, 400)
    if (app.status !== 'approved' && app.status !== 'denied') return json({ error: 'application is not decided' }, 400)
    const link = await linkFor(app.guild_id ?? '')
    const invite = await sbOne<InviteRow>('server_invites', `code=eq.${encodeURIComponent(app.code)}&select=*`)
    const notes = await decisionSideEffects(app, link, invite, app.status === 'approved', 'the owner (in the panel)')
    return json({ ok: true, notes })
  }

  return json({ error: `unknown kind "${kind}"` }, 400)
}

// ============================================================
// entry
// ============================================================

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // Discord requests are told apart by their signature headers; everything else
  // is the panel. A signed request with a bad signature gets 401 — Discord
  // probes exactly this when the endpoint URL is saved.
  if (req.headers.get('x-signature-ed25519')) {
    const raw = await req.text()
    if (!(await verifySignature(req, raw))) return json({ error: 'bad signature' }, 401)
    const i = JSON.parse(raw) as Interaction
    if (i.type === PING) return json({ type: R_PONG })
    if (!SERVICE_KEY) return json({ error: 'function is missing its service key' }, 500)
    try {
      if (i.type === COMMAND) return await handleCommand(i)
      if (i.type === COMPONENT) return await handleComponent(i)
      if (i.type === MODAL_SUBMIT) return await handleModal(i)
    } catch (e) {
      console.error('interaction failed:', e)
      return ephemeral('Something went wrong on our side — try again in a minute.')
    }
    return json({ error: 'unhandled interaction type' }, 400)
  }

  return await handlePanel(req)
})
