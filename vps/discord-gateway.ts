// discord-gateway — runs the Discord bot on a plain VPS, no domain required.
//
// The bot proper is supabase/functions/discord-bot/index.ts: an HTTP handler
// that answers signed interaction payloads. Discord can deliver those two
// ways — POST them to a public HTTPS URL, or push them down a websocket the
// bot opens itself. A bare-IP VPS can't have the first (Discord demands a
// valid-certificate HTTPS URL), so this shim provides the second and keeps
// the handler byte-for-byte identical to what runs on Supabase:
//
//   gateway websocket ──INTERACTION_CREATE──▶ this shim
//     shim signs the payload with its own throwaway Ed25519 key
//     ──POST──▶ the function, spawned as a local child on 127.0.0.1:8000
//     ◀─{type,data}── response
//   shim ──POST──▶ discord /interactions/{id}/{token}/callback
//
// The child is started with DISCORD_PUBLIC_KEY set to the shim's key, so the
// function's real signature check keeps working unmodified — the shim is just
// a second "Discord" it happens to trust. No code is duplicated; whatever the
// edge deployment does, this does.
//
// The panel's routes (redeem / guildinfo / decided / meta / register) keep
// living on the Supabase deployment — browsers can't call a bare IP over
// https, and that function authenticates those routes with user JWTs anyway.
// Only interactions move here. With no Interactions Endpoint URL set on the
// Discord app, Discord falls back to gateway delivery automatically.
//
// Run under systemd (see discord-bot.service):
//   deno run --allow-net --allow-env --allow-run=deno /opt/elauncher-discord/discord-gateway.ts
// Env (see discord-bot.env.example): DISCORD_BOT_TOKEN, DISCORD_APP_ID,
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
//
// `--selftest` starts the child, fires a signed PING and a forged-signature
// probe through the exact forward path, and exits — no Discord involved.

const BOT_TOKEN = Deno.env.get('DISCORD_BOT_TOKEN') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const FUNCTION_FILE = Deno.env.get('DISCORD_FUNCTION_FILE') ??
  new URL('./index.ts', import.meta.url).pathname
const LOCAL = 'http://127.0.0.1:8000/'
const API = 'https://discord.com/api/v10'
const GATEWAY_FALLBACK = 'wss://gateway.discord.gg/?v=10&encoding=json'
// exiting with this tells systemd (RestartPreventExitStatus=78) not to retry:
// the config is wrong and a restart loop would just hammer Discord
const EX_CONFIG = 78

const enc = new TextEncoder()
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a)

// ============================================================
// the shim's own signing identity, minted fresh every boot
// ============================================================

const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
const PUB_HEX = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))

async function signedHeaders(body: string): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, enc.encode(ts + body))))
  return { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }
}

// ============================================================
// the function, as a supervised child on localhost
// ============================================================

let child: Deno.ChildProcess | null = null

async function startFunction(): Promise<Deno.ChildProcess> {
  const env: Record<string, string> = { DISCORD_PUBLIC_KEY: PUB_HEX }
  // pass the rest of the environment through untouched (tokens, supabase)
  for (const [k, v] of Object.entries(Deno.env.toObject())) if (k !== 'DISCORD_PUBLIC_KEY') env[k] = v
  const proc = new Deno.Command(Deno.execPath(), {
    args: ['run', '--quiet', '--allow-net', '--allow-env', FUNCTION_FILE],
    env,
    stdout: 'inherit',
    stderr: 'inherit'
  }).spawn()
  child = proc
  // if the handler dies, die with it — systemd restarts the pair as one unit
  proc.status.then((s) => {
    log(`function child exited (${s.code}) — shutting down for a clean restart`)
    Deno.exit(1)
  })
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(LOCAL, { method: 'GET' })
      log(`function is up on ${LOCAL} (key ${PUB_HEX.slice(0, 8)}…)`)
      return proc
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  log('function never started listening')
  Deno.exit(1)
}

/** Hand one interaction to the function, exactly as Discord's POST would. */
async function askFunction(payload: unknown): Promise<{ status: number; body: { type?: number; data?: unknown } | null }> {
  const body = JSON.stringify(payload)
  const res = await fetch(LOCAL, { method: 'POST', headers: await signedHeaders(body), body })
  return { status: res.status, body: (await res.json().catch(() => null)) as { type?: number } | null }
}

// ============================================================
// interactions in, callbacks out
// ============================================================

interface GatewayInteraction {
  id: string
  token: string
  type: number
  [k: string]: unknown
}

async function onInteraction(i: GatewayInteraction): Promise<void> {
  try {
    const { status, body } = await askFunction(i)
    if (!body || typeof body.type !== 'number') {
      log(`function gave no interaction response (${status}) — dropping ${i.id}`)
      return
    }
    // same 3-second contract as the webhook transport, opposite direction
    const cb = await fetch(`${API}/interactions/${i.id}/${i.token}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!cb.ok) log(`callback for ${i.id} refused: ${cb.status} ${(await cb.text()).slice(0, 200)}`)
  } catch (e) {
    log('interaction forward failed:', e)
  }
}

/** Idempotent global-command registration, through the function's own route. */
async function registerCommands(): Promise<void> {
  if (!SERVICE_KEY) return log('no service key — skipping command registration')
  try {
    const res = await fetch(LOCAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ kind: 'register' })
    })
    log('command registration:', res.status, JSON.stringify(await res.json().catch(() => null))?.slice(0, 200))
  } catch (e) {
    log('command registration failed:', e)
  }
}

// ============================================================
// the gateway connection
// ============================================================
// Implemented directly on WebSocket — the protocol is four opcodes and a
// heartbeat, which is not worth a client library on a box that hosts game
// servers. Reconnects resume the session where Discord allows it.

let ws: WebSocket | null = null
let seq: number | null = null
let sessionId = ''
let resumeUrl = ''
let acked = true
let beat: ReturnType<typeof setInterval> | undefined
let firstBeat: ReturnType<typeof setTimeout> | undefined
let registered = false

function stopHeartbeat(): void {
  clearInterval(beat)
  clearTimeout(firstBeat)
}

function heartbeat(interval: number): void {
  stopHeartbeat()
  const send = (): void => {
    if (ws?.readyState !== WebSocket.OPEN) return
    if (!acked) {
      // half-open TCP: the beats go out, nothing comes back. Reconnect.
      log('heartbeat never acknowledged — reconnecting')
      try {
        ws.close(4900)
      } catch {
        /* already gone */
      }
      return
    }
    acked = false
    ws.send(JSON.stringify({ op: 1, d: seq }))
  }
  // first beat at interval*jitter per the docs, then steady
  firstBeat = setTimeout(() => {
    send()
    beat = setInterval(send, interval)
  }, Math.floor(interval * Math.random()))
}

function connect(resume: boolean): void {
  const url = resume && resumeUrl ? `${resumeUrl}?v=10&encoding=json` : GATEWAY_FALLBACK
  log(`gateway: connecting (${resume ? 'resume' : 'fresh'})`)
  ws = new WebSocket(url)

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { op: number; d: unknown; s: number | null; t: string | null }
    if (msg.s !== null) seq = msg.s

    if (msg.op === 10) {
      const { heartbeat_interval } = msg.d as { heartbeat_interval: number }
      acked = true
      heartbeat(heartbeat_interval)
      if (resume && sessionId) {
        ws!.send(JSON.stringify({ op: 6, d: { token: BOT_TOKEN, session_id: sessionId, seq } }))
      } else {
        seq = null
        ws!.send(
          JSON.stringify({
            op: 2,
            d: {
              token: BOT_TOKEN,
              // interactions arrive with zero intents — the bot never reads
              // messages or members, which is also why it needs no privileged
              // toggles in the portal
              intents: 0,
              properties: { os: 'linux', browser: 'elauncher', device: 'elauncher' }
            }
          })
        )
      }
      return
    }
    if (msg.op === 11) {
      acked = true
      return
    }
    if (msg.op === 1) {
      ws?.send(JSON.stringify({ op: 1, d: seq }))
      return
    }
    if (msg.op === 7) {
      log('gateway asked us to reconnect')
      try {
        ws?.close(4901)
      } catch {
        /* closing a closed socket */
      }
      return
    }
    if (msg.op === 9) {
      // closing (not reconnecting directly) keeps exactly one socket alive:
      // every reconnect flows through onclose, so two chains can never race
      const resumable = msg.d === true
      log(`invalid session (resumable: ${resumable})`)
      if (!resumable) {
        sessionId = ''
        resumeUrl = ''
      }
      try {
        ws?.close(4902)
      } catch {
        /* already gone */
      }
      return
    }
    if (msg.op === 0) {
      if (msg.t === 'READY') {
        const d = msg.d as { session_id: string; resume_gateway_url: string; user: { username: string; id: string } }
        sessionId = d.session_id
        resumeUrl = d.resume_gateway_url
        log(`ready as ${d.user.username} (${d.user.id})`)
        if (!registered) {
          registered = true
          void registerCommands()
        }
        return
      }
      if (msg.t === 'RESUMED') {
        log('session resumed')
        return
      }
      if (msg.t === 'INTERACTION_CREATE') {
        void onInteraction(msg.d as GatewayInteraction)
        return
      }
    }
  }

  ws.onclose = (ev) => {
    stopHeartbeat()
    if (ev.code === 4004) {
      log('gateway rejected the token (4004) — fix DISCORD_BOT_TOKEN and restart')
      Deno.exit(EX_CONFIG)
    }
    // 4901 is our own op-7 close (Discord wants a resume), 4902 our op-9
    // invalid-session close; everything else gets a longer breather so a
    // flapping network doesn't turn into a storm
    const delay = ev.code === 4901 ? 500 : ev.code === 4902 ? 2000 + Math.random() * 3000 : 5000 + Math.random() * 5000
    log(`gateway closed (${ev.code}) — reconnecting in ${Math.round(delay)}ms`)
    setTimeout(() => connect(Boolean(sessionId)), delay)
  }

  ws.onerror = () => {
    /* the close handler right above does the actual recovery */
  }
}

// ============================================================
// entry
// ============================================================

if (Deno.args.includes('--selftest')) {
  const proc = await startFunction()
  const ping = await askFunction({ type: 1 })
  const pingOk = ping.status === 200 && ping.body?.type === 1
  const forged = await fetch(LOCAL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-ed25519': 'ab'.repeat(32), 'x-signature-timestamp': '1' },
    body: '{"type":1}'
  })
  const forgedOk = forged.status === 401
  await forged.body?.cancel()
  console.log(`selftest: signed ping ${pingOk ? 'OK' : 'FAILED'} · forged signature ${forgedOk ? 'rejected OK' : 'NOT rejected'}`)
  try {
    proc.kill()
  } catch {
    /* already exiting */
  }
  Deno.exit(pingOk && forgedOk ? 0 : 1)
}

if (!BOT_TOKEN) {
  log('DISCORD_BOT_TOKEN is not set — fill /etc/elauncher/discord-bot.env')
  Deno.exit(EX_CONFIG)
}

await startFunction()
connect(false)
