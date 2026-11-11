import type { SupabaseClient } from '@supabase/supabase-js'
import type { RequestAction } from '@web/panel/relay'
import type { TabProps } from '@web/panel/tabs/types'
import { OFFLINE_MESSAGE, SIGNED_OUT_MESSAGE } from '../preload/api'

/**
 * The panel's relay (web/src/panel/relay.ts), taking the client as a parameter: that module
 * builds the browser's localStorage client when it loads, so main must not import it.
 * Same table rows, deadlines, polling and messages, so the host cannot tell the two apart.
 */

export type Ask = TabProps['ask']

export interface ServerRef {
  serverId: string
  ownerId: string
}

// ---------- failures the player can act on ----------

/** Codes main puts on its own errors; they survive being re-thrown inside main (not across IPC). */
export const OFFLINE_CODE = 'CLOUD_UNREACHABLE'
export const DENIED_CODE = 'REQUEST_DENIED'
export const SIGNED_OUT_CODE = 'SIGNED_OUT'

/** Main's "the sign-in is gone" refusal; the window matches the message (SIGNED_OUT_MESSAGE). */
export function signedOutError(): Error {
  return Object.assign(new Error(SIGNED_OUT_MESSAGE), { code: SIGNED_OUT_CODE })
}

export function isSignedOutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return code === SIGNED_OUT_CODE || message === SIGNED_OUT_MESSAGE
}

/** fetch/undici, auth-js and postgrest wordings for "this PC could not reach the server at all". */
const NETWORK_TEXT =
  /fetch failed|failed to fetch|networkerror|network request failed|socket hang up|ECONN(RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_|timed? ?out/i

interface CloudFailure {
  message?: unknown
  name?: unknown
  code?: unknown
  status?: unknown
  cause?: unknown
}

/** True for a failure of this PC's connection (not an answer from the cloud or the host). */
export function isNetworkError(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as CloudFailure).cause, depth++) {
    const { message, name, code, status } = e as CloudFailure
    if (code === OFFLINE_CODE || message === OFFLINE_MESSAGE) return true
    if (name === 'AuthRetryableFetchError') return true
    // postgrest reports a failed fetch with status 0; a gateway in front of the cloud answers 502-504
    if (status === 0 || status === 502 || status === 503 || status === 504) return true
    if (typeof code === 'string' && NETWORK_TEXT.test(code)) return true
    if (typeof message === 'string' && NETWORK_TEXT.test(message)) return true
  }
  return typeof error === 'string' && NETWORK_TEXT.test(error)
}

export function offlineError(cause?: unknown): Error {
  return Object.assign(new Error(OFFLINE_MESSAGE, cause === undefined ? undefined : { cause }), { code: OFFLINE_CODE })
}

/** Row-level security refused the row: the share was removed, or the request went out without a sign-in. */
function isDenied(error: CloudFailure): boolean {
  return error.code === '42501' || (typeof error.message === 'string' && /row-level security/i.test(error.message))
}

/** A Supabase query error as one readable Error: network failures read the same everywhere. */
export function cloudError(error: CloudFailure, status?: number): Error {
  if (isNetworkError(status === undefined ? error : { ...error, status })) return offlineError(error)
  if (isDenied(error)) {
    return Object.assign(new Error('This server is no longer shared with your account, or your sign-in expired.'), { code: DENIED_CODE })
  }
  return new Error(typeof error.message === 'string' && error.message ? error.message : 'The eLauncher cloud refused the request.')
}

// ---------- console attribution ----------

let senderName = ''
let primedFor = ''

/** The console prints "<name> ran /stop", so the host needs a name, not just an id. */
export async function primeSenderName(client: SupabaseClient, userId: string): Promise<void> {
  if (primedFor === userId) return
  const { data, error } = await client.from('profiles').select('username').eq('id', userId).maybeSingle()
  if (error) {
    // never let one account's name ride along with another account's commands
    if (primedFor !== userId) senderName = ''
    return
  }
  senderName = (data as { username?: string } | null)?.username ?? ''
  primedFor = userId
}

/** Sign-out: the next account primes its own name. */
export function resetSenderName(): void {
  senderName = ''
  primedFor = ''
}

export async function queueCommand(
  client: SupabaseClient,
  serverId: string,
  ownerId: string,
  senderId: string,
  action: 'start' | 'stop' | 'command',
  payload = ''
): Promise<void> {
  const { error, status } = await client.from('server_commands').insert({
    server_id: serverId,
    owner_id: ownerId,
    sender_id: senderId,
    sender_name: primedFor === senderId ? senderName : '',
    action,
    payload
  })
  if (error) throw cloudError(error, status)
}

// ---------- requests answered by the host ----------

const REQUEST_TIMEOUT_MS = 22_000

const SLOW_ACTIONS: Partial<Record<RequestAction, number>> = {
  nvmpBegin: 60_000,
  nvmpChunk: 60_000,
  nvmpFinish: 60_000,
  nvmpDiscard: 60_000
}

export const POLL_MS = 900

export const HOST_SILENT_MESSAGE = 'No answer from the machine hosting this server — is the launcher running?'

export async function sendRequest<T = unknown>(
  client: SupabaseClient,
  serverId: string,
  ownerId: string,
  requesterId: string,
  action: RequestAction,
  params: Record<string, unknown> = {}
): Promise<T> {
  if (!serverId) throw new Error('No server selected — pick the server again and retry.')
  const { data, error, status } = await client
    .from('server_requests')
    .insert({ server_id: serverId, owner_id: ownerId, requester_id: requesterId, action, params })
    .select('id')
    .single()
  if (error) throw cloudError(error, status)

  const id = (data as { id: string }).id
  const deadline = Date.now() + (SLOW_ACTIONS[action] ?? REQUEST_TIMEOUT_MS)
  // whether the latest poll failed on this side: at the deadline that means the connection, not the host
  let lostConnection: unknown = null
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const polled = await client.from('server_requests').select('done,response,error').eq('id', id).maybeSingle()
    lostConnection = polled.error && isNetworkError({ ...polled.error, status: polled.status }) ? polled.error : null
    const settled = polled.data as { done?: boolean; response?: unknown; error?: string } | null
    if (settled?.done) {
      if (settled.error) throw new Error(settled.error)
      return settled.response as T
    }
    if (Date.now() > deadline) {
      if (lostConnection) throw offlineError(lostConnection)
      throw new Error(HOST_SILENT_MESSAGE)
    }
  }
}

/** Bind the relay to one server: queued against the host's account, asked by the player. */
export function makeAsk(server: ServerRef, userId: string, client: SupabaseClient): Ask {
  return (action, params = {}) => sendRequest(client, server.serverId, server.ownerId || userId, userId, action, params)
}
