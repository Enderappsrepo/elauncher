import type { LocalServerState, ManagedServer, ServerShare } from '@shared/types'
import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient, getUser } from './cloud'
import {
  getServerLogs,
  getServerStates,
  listLocalServers,
  sendServerCommand,
  startServer,
  stopServer
} from './server'

/**
 * Remote server management, relayed through the shared cloud:
 * - the HOST launcher heartbeats each shared server's status (state, players,
 *   address, console tail) and polls for queued commands to execute;
 * - a MANAGER launcher reads those statuses and queues start/stop/console
 *   commands for servers that were shared with it.
 * Row Level Security limits everything to explicit owner→grantee grants.
 */

const HEARTBEAT_MS = 10_000
const CONSOLE_TAIL_LINES = 80
/** shares are re-checked this often so new grants start syncing without a restart */
const SHARE_REFRESH_MS = 60_000

/**
 * PostgREST reports missing tables as "Could not find the table '…' in the schema
 * cache" (or 42P01). That just means the migration hasn't been run — say so.
 */
function friendly(error: { message?: string; code?: string } | null | undefined): Error {
  const message = error?.message ?? 'Unknown cloud error'
  if (message.includes('schema cache') || error?.code === '42P01' || error?.code === 'PGRST205') {
    return new Error(
      'Your cloud is missing the remote-management tables. Open Supabase → SQL Editor, run the "Remote server management" block from supabase/schema.sql once, then try again.'
    )
  }
  return new Error(message)
}

// ---------- owner: grants ----------

export async function grantAccess(serverId: string, serverName: string, username: string): Promise<ServerShare[]> {
  const supabase = getClient()
  const me = await getUser()
  if (!me) throw new Error('Sign in to your ELauncher account first.')
  const { data: profile, error: findError } = await supabase
    .from('profiles')
    .select('id, username')
    .ilike('username', username.trim())
    .maybeSingle()
  if (findError) throw friendly(findError)
  if (!profile) throw new Error(`No ELauncher user named "${username.trim()}".`)
  if (profile.id === me.id) throw new Error("That's you — you already manage this server.")
  const { error } = await supabase.from('server_shares').upsert(
    {
      owner_id: me.id,
      server_id: serverId,
      server_name: serverName,
      grantee_id: profile.id
    },
    { onConflict: 'server_id,grantee_id' }
  )
  if (error) throw friendly(error)
  sharesDirty = true
  return listShares(serverId)
}

export async function revokeAccess(shareId: string): Promise<void> {
  const supabase = getClient()
  const { error } = await supabase.from('server_shares').delete().eq('id', shareId)
  if (error) throw friendly(error)
  sharesDirty = true
}

/** Grants the signed-in owner has issued for one server. */
export async function listShares(serverId: string): Promise<ServerShare[]> {
  const supabase = getClient()
  const me = (await supabase.auth.getSession()).data.session?.user.id
  if (!me) return []
  const { data, error } = await supabase
    .from('server_shares')
    .select('id, server_id, server_name, grantee_id')
    .eq('owner_id', me)
    .eq('server_id', serverId)
  if (error) throw friendly(error)
  const rows = data as { id: string; server_id: string; server_name: string; grantee_id: string }[]
  if (rows.length === 0) return []
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username')
    .in('id', rows.map((r) => r.grantee_id))
  const names = new Map((profiles as { id: string; username: string }[] | null)?.map((p) => [p.id, p.username]))
  return rows.map((r) => ({
    id: r.id,
    serverId: r.server_id,
    serverName: r.server_name,
    granteeName: names.get(r.grantee_id) ?? 'unknown'
  }))
}

// ---------- manager: servers shared with me ----------

interface StatusRow {
  server_id: string
  name: string
  state: string
  players: string[]
  address: string | null
  console: string
  updated_at: string
}

function toManaged(
  status: StatusRow | undefined,
  serverId: string,
  fallbackName: string,
  ownerName: string,
  isMine: boolean
): ManagedServer {
  // a stale heartbeat means the hosting launcher is closed — show the server as stopped
  const fresh = status && Date.now() - new Date(status.updated_at).getTime() < HEARTBEAT_MS * 4
  return {
    serverId,
    ownerName,
    isMine,
    name: status?.name || fallbackName,
    state: (fresh ? (status!.state as LocalServerState) : 'stopped') satisfies LocalServerState,
    players: fresh ? (status!.players ?? []) : [],
    address: fresh ? (status!.address ?? undefined) : undefined,
    console: status?.console ?? '',
    updatedAt: status?.updated_at ?? ''
  }
}

export async function listManagedServers(): Promise<ManagedServer[]> {
  if (!isCloudConfigured()) return []
  const supabase = getClient()
  const me = (await supabase.auth.getSession()).data.session?.user.id
  if (!me) return []
  // servers shared with me, plus my own servers published by my launcher on any device
  const [sharesRes, mineRes] = await Promise.all([
    supabase.from('server_shares').select('server_id, server_name, owner_id').eq('grantee_id', me),
    supabase.from('server_status').select('*').eq('owner_id', me)
  ])
  if (sharesRes.error) throw friendly(sharesRes.error)
  const shareRows = sharesRes.data as { server_id: string; server_name: string; owner_id: string }[]
  const mineRows = (mineRes.data ?? []) as StatusRow[]

  const mine = mineRows.map((status) => toManaged(status, status.server_id, status.name, 'You', true))

  if (shareRows.length === 0) return mine

  const [{ data: statuses }, { data: owners }] = await Promise.all([
    supabase.from('server_status').select('*').in('server_id', shareRows.map((s) => s.server_id)),
    supabase.from('profiles').select('id, username').in('id', [...new Set(shareRows.map((s) => s.owner_id))])
  ])
  const statusMap = new Map((statuses as StatusRow[] | null)?.map((s) => [s.server_id, s]))
  const ownerNames = new Map((owners as { id: string; username: string }[] | null)?.map((o) => [o.id, o.username]))

  const shared = shareRows.map((share) =>
    toManaged(statusMap.get(share.server_id), share.server_id, share.server_name, ownerNames.get(share.owner_id) ?? 'unknown', false)
  )
  return [...mine, ...shared]
}

/** Queue a start/stop/console command for a remote server (the hosting launcher executes it). */
export async function sendRemoteCommand(
  serverId: string,
  action: 'start' | 'stop' | 'command',
  payload = ''
): Promise<void> {
  const supabase = getClient()
  const me = await getUser()
  if (!me) throw new Error('Sign in to your ELauncher account first.')
  const { data: share } = await supabase
    .from('server_shares')
    .select('owner_id')
    .eq('server_id', serverId)
    .eq('grantee_id', me.id)
    .maybeSingle()
  let ownerId = (share as { owner_id: string } | null)?.owner_id
  if (!ownerId) {
    // not shared with me — it may be my own server hosted on another device
    const { data: mine } = await supabase
      .from('server_status')
      .select('server_id')
      .eq('server_id', serverId)
      .eq('owner_id', me.id)
      .maybeSingle()
    if (mine) ownerId = me.id
  }
  if (!ownerId) throw new Error('This server is no longer shared with you.')
  const { error } = await supabase.from('server_commands').insert({
    server_id: serverId,
    owner_id: ownerId,
    sender_id: me.id,
    sender_name: me.username,
    action,
    payload
  })
  if (error) throw friendly(error)
}

// ---------- host: heartbeat + command execution loop ----------

let loopTimer: NodeJS.Timeout | null = null
let sharedServerIds: Set<string> = new Set()
let sharesDirty = true
let lastShareRefresh = 0
let ticking = false

async function refreshSharedIds(): Promise<void> {
  const supabase = getClient()
  const me = (await supabase.auth.getSession()).data.session?.user.id
  if (!me) {
    sharedServerIds = new Set()
    return
  }
  const { data } = await supabase.from('server_shares').select('server_id').eq('owner_id', me)
  sharedServerIds = new Set((data as { server_id: string }[] | null)?.map((r) => r.server_id))
}

async function hostTick(): Promise<void> {
  if (ticking || !isCloudConfigured()) return
  ticking = true
  try {
    const supabase = getClient()
    const me = (await supabase.auth.getSession()).data.session?.user.id
    if (!me) return

    if (sharesDirty || Date.now() - lastShareRefresh > SHARE_REFRESH_MS) {
      await refreshSharedIds()
      sharesDirty = false
      lastShareRefresh = Date.now()
    }

    // publish every local server: grantees see the shared ones, and you can
    // monitor your own from a launcher on another device (work, laptop, …)
    const local = listLocalServers()
    if (local.length === 0) return
    const localIds = new Set(local.map((s) => s.id))
    const states = getServerStates()

    // 1. publish status snapshots
    await supabase.from('server_status').upsert(
      local.map((server) => {
        const status = states[server.id]
        return {
          server_id: server.id,
          owner_id: me,
          name: server.name,
          state: status?.state ?? 'stopped',
          players: status?.players ?? [],
          address: status?.tunnelAddress ?? null,
          console: getServerLogs(server.id).slice(-CONSOLE_TAIL_LINES).join('\n'),
          updated_at: new Date().toISOString()
        }
      })
    )

    // 2. execute queued commands
    const { data: commands } = await supabase
      .from('server_commands')
      .select('*')
      .eq('owner_id', me)
      .eq('executed', false)
      .order('created_at', { ascending: true })
      .limit(20)
    for (const cmd of (commands as {
      id: string
      server_id: string
      sender_id: string
      sender_name: string
      action: string
      payload: string
    }[]) ?? []) {
      await supabase.from('server_commands').update({ executed: true }).eq('id', cmd.id)
      if (!localIds.has(cmd.server_id)) continue // hosted by another of my devices
      // my own commands always run; grantee commands stop once the grant is revoked
      if (cmd.sender_id !== me && !sharedServerIds.has(cmd.server_id)) continue
      try {
        if (cmd.action === 'start') await startServer(cmd.server_id)
        else if (cmd.action === 'stop') stopServer(cmd.server_id)
        else if (cmd.action === 'command' && cmd.payload.trim()) {
          sendServerCommand(cmd.server_id, cmd.payload)
        }
      } catch (e) {
        console.warn(`[remote] command ${cmd.action} from ${cmd.sender_name} failed:`, e)
      }
    }
  } catch (e) {
    console.warn('[remote] host tick failed:', e)
  } finally {
    ticking = false
  }
}

/** Start the host-side relay loop (cheap no-op ticks when signed out or nothing is shared). */
export function startRemoteHost(): void {
  if (loopTimer || !isCloudConfigured()) return
  loopTimer = setInterval(() => void hostTick(), HEARTBEAT_MS)
}

/** Drop the cloud rows for a deleted server so other devices stop listing a ghost. */
export async function forgetServer(serverId: string): Promise<void> {
  if (!isCloudConfigured()) return
  try {
    const supabase = getClient()
    const me = (await supabase.auth.getSession()).data.session?.user.id
    if (!me) return
    await supabase.from('server_status').delete().eq('server_id', serverId).eq('owner_id', me)
    await supabase.from('server_shares').delete().eq('server_id', serverId).eq('owner_id', me)
  } catch {
    // cloud unreachable — the row just goes stale and reads as stopped
  }
}
