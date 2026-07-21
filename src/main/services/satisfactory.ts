import { request } from 'https'

/**
 * Satisfactory's dedicated server admin channel: an HTTPS JSON API, rather than
 * the RCON/telnet/stdin the other games use.
 *
 * Two things about it are traps. The certificate is self-signed and generated
 * per server, so verification has to be off — it is reached on localhost, where
 * there is no one to impersonate it. And the official documentation names every
 * response field in PascalCase while the server actually emits camelCase, so a
 * client written from the docs authenticates and then reads undefined. The
 * field names below follow the wire, not the docs.
 */

const API_PATH = '/api/v1'
/** Long enough for a save on a large factory, short enough to not hang a stop. */
const CALL_TIMEOUT_MS = 30_000

export interface ServerGameState {
  activeSessionName?: string
  numConnectedPlayers?: number
  playerLimit?: number
  techTier?: number
  gamePhase?: string
  isGameRunning?: boolean
  totalGameDuration?: number
  isGamePaused?: boolean
  averageTickRate?: number
}

interface ApiEnvelope {
  data?: unknown
  errorCode?: string
  errorMessage?: string
}

/**
 * Turn one HTTP reply into either the `data` object or an error. Split out from
 * the socket work because this is where the format actually bites: 204 carries
 * a successful empty body, errors arrive with HTTP 200 and an errorCode, and
 * everything inside `data` is camelCase.
 */
export function parseApiResponse(status: number, body: string): Record<string, unknown> {
  // SaveGame, Shutdown and VerifyAuthenticationToken answer 204 with no body
  if (status === 204 || body.trim() === '') {
    if (status >= 400) throw new Error(`Server API returned HTTP ${status}.`)
    return {}
  }
  let parsed: ApiEnvelope
  try {
    parsed = JSON.parse(body) as ApiEnvelope
  } catch {
    throw new Error(`Server API returned unreadable data (HTTP ${status}).`)
  }
  if (parsed.errorCode) {
    throw new Error(parsed.errorMessage ? `${parsed.errorCode}: ${parsed.errorMessage}` : parsed.errorCode)
  }
  if (status >= 400) throw new Error(`Server API returned HTTP ${status}.`)
  return (parsed.data as Record<string, unknown>) ?? {}
}

/** One API call. `token` is omitted for the very first passwordless login. */
function call(
  port: number,
  fn: string,
  data: Record<string, unknown>,
  token?: string
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ function: fn, data })
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: API_PATH,
        method: 'POST',
        // the cert is self-signed and per-server; this only ever talks to loopback
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        timeout: CALL_TIMEOUT_MS
      },
      (res) => {
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => {
          try {
            resolve(parseApiResponse(res.statusCode ?? 0, text))
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`Server API did not answer ${fn} in time.`)))
    req.on('error', reject)
    req.end(body)
  })
}

/** Is the API up? Answers before the save is loaded, so this is liveness, not readiness. */
export async function healthCheck(port: number): Promise<string> {
  const data = await call(port, 'HealthCheck', { clientCustomData: '' })
  return String(data.health ?? '')
}

/**
 * Take ownership of a fresh server and return the admin token.
 *
 * A never-claimed server hands out an InitialAdmin token to anyone who asks —
 * that is the whole point of the claim flow, and it means the window between
 * first boot and claiming is the one moment the server is unprotected. So this
 * runs as soon as the API answers, not when someone first opens the panel.
 */
export async function claimServer(port: number, serverName: string, adminPassword: string): Promise<string> {
  const initial = await call(port, 'PasswordlessLogin', { minimumPrivilegeLevel: 'InitialAdmin' })
  const initialToken = String(initial.authenticationToken ?? '')
  if (!initialToken) throw new Error('Server did not hand out an initial admin token.')
  const claimed = await call(port, 'ClaimServer', { serverName, adminPassword }, initialToken)
  const token = String(claimed.authenticationToken ?? '')
  if (!token) throw new Error('Server did not return an admin token after the claim.')
  return token
}

/** Log in to an already-claimed server. */
export async function adminLogin(port: number, adminPassword: string): Promise<string> {
  const data = await call(port, 'PasswordLogin', { minimumPrivilegeLevel: 'Administrator', password: adminPassword })
  const token = String(data.authenticationToken ?? '')
  if (!token) throw new Error('Server rejected the admin password.')
  return token
}

/**
 * Live state. `isGameRunning` is the real readiness signal — the API answers
 * while the save is still loading, and only this flips when it is playable.
 */
export async function queryServerState(port: number, token: string): Promise<ServerGameState> {
  const data = await call(port, 'QueryServerState', {}, token)
  return (data.serverGameState as ServerGameState) ?? {}
}

/** Save the running session. `saveName` overwrites when it already exists. */
export async function saveGame(port: number, token: string, saveName: string): Promise<void> {
  await call(port, 'SaveGame', { saveName }, token)
}

/** Ask the server to exit. It saves nothing on its own — save first. */
export async function shutdown(port: number, token: string): Promise<void> {
  await call(port, 'Shutdown', {}, token)
}

/** Run a console command and return whatever it printed. */
export async function runCommand(port: number, token: string, command: string): Promise<string> {
  const data = await call(port, 'RunCommand', { command }, token)
  return String(data.commandResult ?? '')
}
