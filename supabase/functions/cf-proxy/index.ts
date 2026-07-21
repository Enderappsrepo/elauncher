// cf-proxy — a thin, authenticated CurseForge relay for the paid-hosting flow.
//
// Why this exists: the launcher's paid modpack hosting lets a customer buy a
// CurseForge-modpack server without owning a CurseForge API key. The shared key
// can't ship in the desktop app (an Electron asar is trivially unpacked) or sit
// on the game-server box (the store's pack search runs in the customer's
// browser and can't reach it). It lives here as a Supabase secret and is
// injected server-side.
//
// Two things keep it from being an open CurseForge proxy for the whole internet
// (which would drain the shared quota or get the key banned):
//   1. every request must carry a real, signed-in launcher user's JWT — the
//      bare anon key is rejected;
//   2. only the handful of endpoints the purchase flow needs are forwarded.
//
// Deploy:
//   supabase functions deploy cf-proxy --project-ref <ref>
//   supabase secrets set CURSEFORGE_API_KEY=<key> --project-ref <ref>
// verify_jwt stays at its default (true): the gateway rejects malformed tokens
// before this code runs, and the user check below rejects the anon role.

const CURSEFORGE = 'https://api.curseforge.com/v1'
const USER_AGENT = 'ELauncher/0.1.0 (hosting cf-proxy)'

const CF_KEY = Deno.env.get('CURSEFORGE_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
}

/**
 * The endpoints the store (pack search + resolve) and the provisioner (bulk
 * file resolve) actually call. Anything else is refused, so a leaked token
 * can't be turned into a general-purpose CurseForge key.
 */
function allowed(method: string, path: string): boolean {
  if (method === 'GET') {
    return (
      path === '/mods/search' ||
      /^\/mods\/\d+$/.test(path) ||
      /^\/mods\/\d+\/files$/.test(path) ||
      /^\/mods\/\d+\/files\/\d+$/.test(path)
    )
  }
  if (method === 'POST') return path === '/mods/files'
  return false
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })

/** True only for a genuine signed-in user; the anon key resolves to no user. */
async function isRealUser(authorization: string): Promise<boolean> {
  if (!authorization) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: SUPABASE_ANON_KEY }
    })
    if (!res.ok) return false
    const user = await res.json()
    return Boolean(user?.id && user?.aud === 'authenticated')
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  if (!CF_KEY) return json(500, { error: 'cf-proxy is not configured: set the CURSEFORGE_API_KEY secret.' })

  if (!(await isRealUser(req.headers.get('Authorization') ?? ''))) {
    return json(401, { error: 'Sign in to the launcher to use the hosting store.' })
  }

  const url = new URL(req.url)
  // the function is mounted at /functions/v1/cf-proxy — strip that prefix to the CF subpath
  const path = url.pathname.replace(/^\/functions\/v1\/cf-proxy/, '').replace(/^\/cf-proxy/, '')
  if (!allowed(req.method, path)) return json(403, { error: `cf-proxy does not forward ${req.method} ${path}` })

  const upstream = await fetch(`${CURSEFORGE}${path}${url.search}`, {
    method: req.method,
    headers: {
      'x-api-key': CF_KEY,
      'User-Agent': USER_AGENT,
      ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
    },
    body: req.method === 'POST' ? await req.text() : undefined
  })

  // pass the CurseForge response straight through (status + body), plus CORS
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS,
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json'
    }
  })
})
