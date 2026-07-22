import { supabase } from '@web/lib/supabase'

/**
 * Talking to the machine that actually runs a server.
 *
 * Two shapes, and the difference matters. A *command* is fire-and-forget — start,
 * stop, a line typed into the console — and its result shows up as a change in
 * the server's state, so there is nothing to wait for. A *request* asks a
 * question (list the files, read the properties) or wants a confirmation, so it
 * carries an id and is settled when the host writes an answer back.
 *
 * Both are rows in a table rather than a call to the host. The host polls and is
 * also nudged by realtime, so an inserted row reaches it in well under a second
 * — and nothing here needs the host to be addressable from the internet, which
 * is the whole reason the relay works from behind a home router.
 */

/** Servers shared with you are queued against their owner, not against you. */
export type OwnerLookup = (serverId: string) => string

let senderName = ''

/** The console prints "<name> ran /stop", so the host needs a name, not just an id. */
export async function primeSenderName(userId: string): Promise<void> {
  const { data } = await supabase.from('profiles').select('username').eq('id', userId).maybeSingle()
  senderName = (data as { username?: string } | null)?.username ?? ''
}

export async function queueCommand(
  serverId: string,
  ownerId: string,
  senderId: string,
  action: 'start' | 'stop' | 'command',
  payload = ''
): Promise<void> {
  const { error } = await supabase.from('server_commands').insert({
    server_id: serverId,
    owner_id: ownerId,
    sender_id: senderId,
    sender_name: senderName,
    action,
    payload
  })
  if (error) throw new Error(error.message)
}

export type RequestAction =
  | 'info'
  | 'files' | 'readFile' | 'writeFile' | 'deleteFile' | 'deleteFiles' | 'mkdir' | 'movePath'
  | 'downloadChunk' | 'uploadChunk'
  | 'mods' | 'installMod' | 'removeMod'
  | 'players' | 'roster' | 'rosterEdit' | 'moderate'
  | 'getProps' | 'setProps'
  | 'ports' | 'setPorts' | 'setCommunity'
  | 'logs' | 'setAutomation' | 'rebuild'
  | 'shares' | 'share' | 'unshare'

const REQUEST_TIMEOUT_MS = 22_000

/**
 * Some requests do real work before they can answer — downloading a mod and its
 * dependencies, rebuilding a server, moving a chunk of a large file. Giving up
 * on those at the default deadline reports a failure for something that is still
 * running and will succeed.
 *
 * Kept here rather than passed by each caller so the knowledge of what is slow
 * lives in one place, and a tab cannot get it wrong by omission.
 */
const SLOW_ACTIONS: Partial<Record<RequestAction, number>> = {
  installMod: 40_000,
  rebuild: 120_000,
  uploadChunk: 60_000,
  downloadChunk: 60_000,
  writeFile: 40_000,
  // a world folder is tens of thousands of small files, and the host deletes
  // them before it answers
  deleteFile: 45_000,
  deleteFiles: 45_000
}

/**
 * Ask the host something and wait for its answer.
 *
 * Polls rather than relying on realtime alone: this is the path that produces
 * every file listing and settings screen, and a cloud without the realtime
 * publication would otherwise leave the caller hanging forever rather than
 * merely feeling slow.
 */
export async function sendRequest<T = unknown>(
  serverId: string,
  ownerId: string,
  requesterId: string,
  action: RequestAction,
  params: Record<string, unknown> = {}
): Promise<T> {
  if (!serverId) throw new Error('No server selected — pick the server again and retry.')
  const { data, error } = await supabase
    .from('server_requests')
    .insert({ server_id: serverId, owner_id: ownerId, requester_id: requesterId, action, params })
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  const id = (data as { id: string }).id
  const deadline = Date.now() + (SLOW_ACTIONS[action] ?? REQUEST_TIMEOUT_MS)
  for (;;) {
    await new Promise((r) => setTimeout(r, 900))
    const { data: row } = await supabase
      .from('server_requests')
      .select('done,response,error')
      .eq('id', id)
      .maybeSingle()
    const settled = row as { done?: boolean; response?: unknown; error?: string } | null
    if (settled?.done) {
      if (settled.error) throw new Error(settled.error)
      return settled.response as T
    }
    if (Date.now() > deadline) {
      // the host being offline is the common case, and it is worth saying so
      // rather than reporting a bare timeout
      throw new Error('No answer from the machine hosting this server — is the launcher running?')
    }
  }
}
