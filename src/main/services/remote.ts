import type { RealtimeChannel } from '@supabase/supabase-js'
import type { LocalServer, LocalServerState, ManagedServer, PlanLimits, ServerShare } from '@shared/types'
import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient, getUser } from './cloud'
import { collectHostVitals } from './hostHealth'
import {
  archiveServer,
  deleteServer,
  deleteServerPath,
  editServerRoster,
  forceStopServer,
  getPalworldPlayerDetails,
  getServerAutomation,
  getServerLogs,
  getServerPorts,
  getServerProperties,
  getServerStates,
  installServerMod,
  listArchivedServers,
  listLocalServers,
  listServerBackups,
  listServerFiles,
  listServerMods,
  makeServerBackup,
  restoreServer,
  restoreServerBackup,
  palworldModerate,
  playerCapKey,
  readServerFile,
  readServerRoster,
  rebuildServer,
  removeServerMod,
  sendServerCommand,
  setCommunityServer,
  setServerAutomation,
  setServerLimitsOverride,
  setServerPorts,
  setServerProperties,
  startServer,
  stopServer,
  writeServerFile
} from './server'
import type { PlayerFileKind } from './server'
import type { PalworldModerationAction, RemoteCommandAction, ServerAutomation } from '@shared/types'

/**
 * Remote server management, relayed through the shared cloud:
 * - the HOST launcher heartbeats each shared server's status (state, players,
 *   address, console tail) and polls for queued commands to execute;
 * - a MANAGER launcher reads those statuses and queues start/stop/console
 *   commands for servers that were shared with it.
 * Row Level Security limits everything to explicit owner→grantee grants.
 */

/** status snapshots are published on this cadence (and instantly after executing work) */
const HEARTBEAT_MS = 5_000
/** queued commands/requests are polled this often — the realtime kick makes it near-instant */
const TICK_MS = 2_000
const CONSOLE_TAIL_LINES = 80
/**
 * Ceiling on one `logs` reply. The host buffers 1000 lines; a single Supabase
 * row carrying all of them is a ~200 KB round trip, so the panel pages instead.
 */
const MAX_PANEL_LOG_LINES = 500
/** Valid `rosterEdit` targets — the request carries a raw string off the wire. */
const ROSTER_LISTS: PlayerFileKind[] = ['whitelist', 'ops', 'banned-players']
/** shares are re-checked this often so new grants start syncing without a restart */
const SHARE_REFRESH_MS = 60_000
/** machine vitals move far slower than server state — no need to ride the 5s beat */
const HOST_HEALTH_MS = 15_000

/** destructive or plan-lifting actions only the host owner or an admin may trigger */
const PRIVILEGED_ACTIONS = new Set(['delete', 'archive', 'restore', 'setLimits'])
/**
 * Handing out panel access. Wider than PRIVILEGED_ACTIONS — the customer renting
 * a hosted server invites their own friends — but deliberately narrower than the
 * ordinary grantee set: whoever they invite cannot pass access on again.
 */
const ACCESS_ACTIONS = new Set(['shares', 'share', 'unshare'])
const adminCache = new Map<string, { admin: boolean; at: number }>()
const ADMIN_CACHE_MS = 5 * 60_000
/** hosted server -> the account renting it, cached off hosting_orders */
let customerByServer = new Map<string, string>()
let customersAt = 0
const CUSTOMER_CACHE_MS = 60_000

/** Is this requester an admin? (profiles.is_admin, cached — it gates every privileged request.) */
async function isAdminUser(supabase: ReturnType<typeof getClient>, userId: string): Promise<boolean> {
  const hit = adminCache.get(userId)
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit.admin
  const { data } = await supabase.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  const admin = Boolean((data as { is_admin?: boolean } | null)?.is_admin)
  adminCache.set(userId, { admin, at: Date.now() })
  return admin
}

/**
 * Which account is a hosted server actually *for*? The host owns every grant, so
 * server_shares alone can't tell the customer renting a box from a friend they
 * invited — hosting_orders can, and the provisioner already keeps it in step.
 * Nothing comes back for a plain self-hosted server (no order), which is right:
 * there the owner is the only one who hands out access.
 */
async function customerOf(supabase: ReturnType<typeof getClient>, serverId: string): Promise<string | null> {
  if (Date.now() - customersAt > CUSTOMER_CACHE_MS) {
    const { data } = await supabase.from('hosting_orders').select('server_id, user_id').eq('status', 'active')
    const rows = (data as { server_id: string | null; user_id: string }[] | null) ?? []
    customerByServer = new Map(rows.filter((o) => o.server_id).map((o) => [o.server_id as string, o.user_id]))
    customersAt = Date.now() // a missing/denied table caches empty and retries on the next beat
  }
  return customerByServer.get(serverId) ?? null
}

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
  // over the relay `me` is the HOST account, not whoever asked — so this reads
  // correctly both for an owner typing their own name and for a customer typing
  // the name of the machine hosting their server
  if (profile.id === me.id) throw new Error('That account hosts this server — it already has full access.')
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
    granteeId: r.grantee_id,
    granteeName: names.get(r.grantee_id) ?? 'unknown'
  }))
}

/** Everyone who can open one server's panel, shaped for the web panel's Access tab. */
async function listAccess(serverId: string): Promise<{
  owner: string
  people: { id: string; name: string; customer: boolean }[]
}> {
  const supabase = getClient()
  const me = await getUser()
  if (!me) throw new Error('the host launcher is signed out')
  const [customer, shares] = await Promise.all([customerOf(supabase, serverId), listShares(serverId)])
  return {
    owner: me.username,
    people: shares
      .map((s) => ({ id: s.id, name: s.granteeName, customer: s.granteeId === customer }))
      // the person paying for the server reads first; the rest alphabetically
      .sort((a, b) => Number(b.customer) - Number(a.customer) || a.name.localeCompare(b.name))
  }
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
  action: RemoteCommandAction,
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
let heartbeatTimer: NodeJS.Timeout | null = null
/** false once the cloud rejects the stats columns (migration not run yet) */
let statusHasStatsColumns = true
/** false once the cloud rejects just the newer community column */
let statusHasCommunityColumn = true
let statsRetryAt = 0
let sharedServerIds: Set<string> = new Set()
let sharesDirty = true
let lastShareRefresh = 0
let ticking = false
let publishing = false
/** cached from the last tick so the heartbeat never waits on a session read */
let hostUserId: string | null = null
let lastPublish = 0
let lastHealthPublish = 0
/** false once the cloud rejects host_health (fleet-health migration not run yet) */
let hostHealthAvailable = true
let hostHealthRetryAt = 0
let kickUser: string | null = null
let kickChannel: RealtimeChannel | null = null
let pendingKick = false

/**
 * Realtime accelerator: when the cloud's realtime publication includes the
 * relay tables, an inserted command/request kicks the tick immediately instead
 * of waiting out the poll. Strictly a bonus — the poll below stays the source
 * of truth, so nothing breaks on clouds without the realtime migration or on
 * runtimes without a global WebSocket.
 */
function armRealtimeKick(me: string): void {
  if (kickUser === me || typeof globalThis.WebSocket === 'undefined') return
  try {
    const supabase = getClient()
    if (kickChannel) void supabase.removeChannel(kickChannel)
    const kick = (): void => {
      if (ticking) pendingKick = true
      else void hostTick()
    }
    kickChannel = supabase
      .channel(`host-kick-${me}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'server_commands', filter: `owner_id=eq.${me}` }, kick)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'server_requests', filter: `owner_id=eq.${me}` }, kick)
      .subscribe()
    kickUser = me
  } catch {
    // realtime unavailable — polling covers it
  }
}

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
    if (!me) {
      hostUserId = null // signed out — don't let the heartbeat publish as a stale user
      return
    }
    hostUserId = me
    armRealtimeKick(me)

    if (sharesDirty || Date.now() - lastShareRefresh > SHARE_REFRESH_MS) {
      await refreshSharedIds()
      sharesDirty = false
      lastShareRefresh = Date.now()
    }

    const local = listLocalServers()
    const archived = listArchivedServers()
    if (local.length === 0 && archived.length === 0) return
    const localIds = new Set(local.map((s) => s.id))
    const archivedIds = new Set(archived.map((a) => a.id))

    // 1. execute queued commands
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
        else if (cmd.action === 'forceStop') forceStopServer(cmd.server_id)
        else if (cmd.action === 'command' && cmd.payload.trim()) {
          sendServerCommand(cmd.server_id, cmd.payload)
        }
      } catch (e) {
        console.warn(`[remote] command ${cmd.action} from ${cmd.sender_name} failed:`, e)
      }
    }

    // 2. execute control-panel requests (settings, players, automation) with responses
    const { data: requests } = await supabase
      .from('server_requests')
      .select('*')
      .eq('owner_id', me)
      .eq('done', false)
      .order('created_at', { ascending: true })
      .limit(20)
    for (const req of (requests as {
      id: string
      server_id: string
      requester_id: string
      action: string
      params: Record<string, unknown>
    }[]) ?? []) {
      let response: unknown = null
      let error: string | null = null
      try {
        const archivedHere = archivedIds.has(req.server_id)
        if (!localIds.has(req.server_id) && !archivedHere) throw new Error('server is not on this machine')
        let privileged = req.requester_id === me
        let canShare = privileged
        if (!privileged) {
          // the host owner can do anything; admins can do anything; grantees
          // (customers) are limited to non-destructive actions while shared
          const admin = await isAdminUser(supabase, req.requester_id)
          if (PRIVILEGED_ACTIONS.has(req.action) && !admin) {
            throw new Error('Only the host owner or an admin can do that.')
          }
          if (!admin && !sharedServerIds.has(req.server_id)) throw new Error('access was revoked')
          privileged = admin
          // the customer renting this server invites their own friends; those
          // friends are ordinary grantees and cannot pass access on again
          canShare = admin || (await customerOf(supabase, req.server_id)) === req.requester_id
        }
        if (ACCESS_ACTIONS.has(req.action) && !canShare) {
          throw new Error('Only the owner, an admin, or the customer this server belongs to can manage access.')
        }
        if (archivedHere && !PRIVILEGED_ACTIONS.has(req.action)) {
          throw new Error('This server is archived — restore it first.')
        }
        response = await runPanelRequest(req.server_id, req.action, req.params, privileged, canShare)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      await supabase
        .from('server_requests')
        .update({ done: true, response: response ?? null, error })
        .eq('id', req.id)
    }

    // 3. publish a snapshot straight after executing work, so the panel sees
    // the effect of its click at once. The steady beat runs on its own timer —
    // see publishHeartbeat, which is deliberately not called from here.
    if ((commands?.length ?? 0) > 0 || (requests?.length ?? 0) > 0) {
      // re-list: a request may have deleted a server mid-tick, and publishing
      // the stale snapshot would resurrect the status row forgetServer removed
      await publishStatuses(supabase, me, listLocalServers())
      lastPublish = Date.now()
    }
  } catch (e) {
    console.warn('[remote] host tick failed:', e)
  } finally {
    ticking = false
    if (pendingKick) {
      // a realtime kick landed mid-tick — run again so its work isn't left waiting
      pendingKick = false
      setTimeout(() => void hostTick(), 25)
    }
  }
}

/**
 * Publish status snapshots and machine vitals on a fixed beat, deliberately
 * outside hostTick.
 *
 * hostTick is serialised by `ticking` and awaits whatever work it finds: a
 * queued start can hold it for the length of a Steam update, and delete/archive
 * wait out ensureStopped (up to 60s). While it was the tick's last step, the
 * heartbeat stopped for exactly as long as the machine was busy — and a
 * snapshot older than HEARTBEAT_MS * 4 renders as "PC offline" in every panel.
 * So the box looked dead precisely when it was working hardest, most visibly
 * right after someone clicked Stop.
 */
async function publishHeartbeat(): Promise<void> {
  if (publishing || !isCloudConfigured()) return
  publishing = true
  try {
    const supabase = getClient()
    const me = hostUserId ?? (await supabase.auth.getSession()).data.session?.user.id
    if (!me) return
    hostUserId = me
    const local = listLocalServers()
    if (local.length === 0 && listArchivedServers().length === 0) return
    await publishStatuses(supabase, me, local)
    lastPublish = Date.now()
    // vitals move far slower than server state — they ride a slower beat
    if (Date.now() - lastHealthPublish >= HOST_HEALTH_MS) {
      lastHealthPublish = Date.now()
      await publishHostHealth(supabase, me, local)
    }
  } catch (e) {
    console.warn('[remote] heartbeat failed:', e)
  } finally {
    publishing = false
  }
}

/**
 * Publish every local server's snapshot: grantees see the shared ones, and you
 * can monitor your own from a launcher on another device (work, laptop, …).
 */
async function publishStatuses(supabase: ReturnType<typeof getClient>, me: string, local: LocalServer[]): Promise<void> {
  // archived servers publish too (state 'archived') so the owner/admin panel can offer restore
  const archived = listArchivedServers()
  if (local.length === 0 && archived.length === 0) return // e.g. the last server was deleted this tick
  const states = getServerStates()
  // live stats ride along once the columns exist
  const snapshot = (server: LocalServer, withStats: boolean): Record<string, unknown> => {
    const status = states[server.id]
    const row: Record<string, unknown> = {
      server_id: server.id,
      owner_id: me,
      name: server.name,
      state: status?.state ?? 'stopped',
      players: status?.players ?? [],
      address: status?.tunnelAddress ?? null,
      console: getServerLogs(server.id).slice(-CONSOLE_TAIL_LINES).join('\n'),
      updated_at: new Date().toISOString()
    }
    if (withStats) {
      row.memory_mb = status?.memoryMB ?? null
      row.cpu_percent = status?.cpuPercent ?? null
      row.started_at = status?.startedAt ? new Date(status.startedAt).toISOString() : null
      row.version = status?.version ?? null
      // palworld community-browser listing — panels show a badge and a toggle
      if (statusHasCommunityColumn) row.community = Boolean(server.communityServer)
    }
    return row
  }
  const archivedSnapshot = (a: LocalServer, withStats: boolean): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      server_id: a.id,
      owner_id: me,
      name: a.name,
      state: 'archived',
      players: [],
      address: null,
      console: '[ELauncher] Archived — every file is kept. Restore it to bring it back.',
      updated_at: new Date().toISOString()
    }
    if (withStats) {
      row.memory_mb = null
      row.cpu_percent = null
      row.started_at = null
      row.version = null
      if (statusHasCommunityColumn) row.community = false
    }
    return row
  }
  const allRows = (withStats: boolean): Record<string, unknown>[] => [
    ...local.map((s) => snapshot(s, withStats)),
    ...archived.map((a) => archivedSnapshot(a, withStats))
  ]
  // re-probe hourly so a stats migration run mid-flight starts working without a restart
  if (!statusHasStatsColumns && Date.now() > statsRetryAt) {
    statusHasStatsColumns = true
    statusHasCommunityColumn = true
  }
  if (statusHasStatsColumns) {
    let { error } = await supabase.from('server_status').upsert(allRows(true))
    // a cloud with stats but not the newer community column: retry without just that field
    if (error && statusHasCommunityColumn && /community/i.test(error.message ?? '')) {
      statusHasCommunityColumn = false
      ;({ error } = await supabase.from('server_status').upsert(allRows(true)))
    }
    // clouds that haven't run the stats migration yet fall back to the legacy shape
    if (error && /column|schema cache/i.test(error.message ?? '')) {
      statusHasStatsColumns = false
      statsRetryAt = Date.now() + 3_600_000
    }
  }
  if (!statusHasStatsColumns) {
    await supabase.from('server_status').upsert(allRows(false))
  }
}

/**
 * Publish machine-wide vitals (CPU, memory, disk, uptime) plus what this box is
 * currently carrying. One row per hosting account; admins read the fleet from it.
 */
async function publishHostHealth(
  supabase: ReturnType<typeof getClient>,
  me: string,
  local: LocalServer[]
): Promise<void> {
  // re-probe hourly so a migration run mid-flight starts working without a restart
  if (!hostHealthAvailable && Date.now() < hostHealthRetryAt) return
  hostHealthAvailable = true
  try {
    const vitals = await collectHostVitals()
    const states = getServerStates()
    let running = 0
    let playersOnline = 0
    for (const server of local) {
      const status = states[server.id]
      if (status?.state === 'running') {
        running += 1
        playersOnline += status.players.length
      }
    }
    const { error } = await supabase.from('host_health').upsert({
      owner_id: me,
      host_name: vitals.hostName,
      platform: vitals.platform,
      app_version: vitals.appVersion,
      headless: vitals.headless,
      cpu_model: vitals.cpuModel,
      cpu_threads: vitals.cpuThreads,
      cpu_percent: vitals.cpuPercent,
      ram_used_mb: vitals.ramUsedMB,
      ram_total_mb: vitals.ramTotalMB,
      disk_free_gb: vitals.diskFreeGB,
      disk_total_gb: vitals.diskTotalGB,
      uptime_seconds: vitals.uptimeSeconds,
      load1: vitals.load1,
      servers_running: running,
      servers_total: local.length + listArchivedServers().length,
      players_online: playersOnline,
      updated_at: new Date().toISOString()
    })
    if (error && /relation|column|schema cache/i.test(error.message ?? '')) {
      hostHealthAvailable = false
      hostHealthRetryAt = Date.now() + 3_600_000
    }
  } catch {
    // vitals are a nicety — never let them break the relay tick
  }
}

/**
 * Plan caps a customer request can't cross. Purely the fast-feedback layer —
 * the same caps are re-clamped at every server start, so bypassing this
 * (e.g. hand-crafted requests) still can't buy more than the plan.
 */
function guardCustomerLimits(serverId: string, action: string, params: Record<string, unknown>): void {
  const record = listLocalServers().find((s) => s.id === serverId)
  const limits = record?.limits
  if (!record || !limits) return
  if (action === 'setProps' && limits.maxPlayers && playerCapKey(record.game ?? 'minecraft')) {
    const key = playerCapKey(record.game ?? 'minecraft')!
    const updates = (params.updates as Record<string, string>) ?? {}
    if (key in updates) {
      const wanted = Number(updates[key])
      if (!Number.isFinite(wanted) || wanted > limits.maxPlayers) {
        throw new Error(`Your plan includes ${limits.maxPlayers} player slots — upgrade the plan to raise this.`)
      }
    }
  }
  if (action === 'setAutomation' && limits.memoryMb && (record.game ?? 'minecraft') !== 'minecraft') {
    // the memory guard is the plan's RAM ceiling — customers can tighten it, never lift it
    const automation = (params.automation as ServerAutomation) ?? {}
    if (!automation.restartAboveMemoryMB || automation.restartAboveMemoryMB > limits.memoryMb) {
      automation.restartAboveMemoryMB = limits.memoryMb
    }
  }
  if (action === 'writeFile') {
    const target = String(params.path ?? '').replace(/\\/g, '/').toLowerCase()
    if (
      target.endsWith('palworldsettings.ini') ||
      target.endsWith('server.properties') ||
      target.endsWith('serverconfig.xml') ||
      target.endsWith('elauncher-valheim.json')
    ) {
      throw new Error('Game settings on hosted servers are edited in the Settings tab, where plan limits apply.')
    }
  }
}

/** Execute one control-panel request against a local server and return its result. */
async function runPanelRequest(
  serverId: string,
  action: string,
  params: Record<string, unknown>,
  privileged = true,
  canShare = privileged
): Promise<unknown> {
  if (!privileged) guardCustomerLimits(serverId, action, params)
  switch (action) {
    case 'info': {
      const record = listLocalServers().find((s) => s.id === serverId)
      if (!record) throw new Error('server not found')
      return {
        game: record.game ?? 'minecraft',
        kind: record.kind,
        minecraftVersion: record.minecraftVersion,
        port: record.port,
        memoryMax: record.memoryMax,
        communityServer: Boolean(record.communityServer),
        automation: getServerAutomation(serverId),
        limits: record.limits ?? null,
        limitsPlan: record.limitsPlan ?? null,
        limitsOverride: record.limitsOverride ?? null,
        owner: privileged,
        // drives whether the panel offers an Access tab at all
        canShare
      }
    }
    case 'getProps':
      return getServerProperties(serverId)
    case 'setProps':
      return setServerProperties(serverId, (params.updates as Record<string, string>) ?? {})
    case 'setAutomation':
      setServerAutomation(serverId, (params.automation as ServerAutomation) ?? {})
      return { ok: true }
    case 'setLimits': {
      // PRIVILEGED_ACTIONS gates this upstream — re-checked here so no path skips it
      if (!privileged) throw new Error('Only the host owner or an admin can change resource limits.')
      const raw = (params.override ?? {}) as Record<string, unknown>
      const override: PlanLimits = {}
      const memoryMb = Math.round(Number(raw.memoryMb))
      const cpuCores = Math.round(Number(raw.cpuCores))
      if (Number.isFinite(memoryMb) && memoryMb > 0) override.memoryMb = memoryMb
      if (Number.isFinite(cpuCores) && cpuCores > 0) override.cpuCores = cpuCores
      return { ok: true, limits: setServerLimitsOverride(serverId, override) ?? null }
    }
    case 'players':
      return getPalworldPlayerDetails(serverId)
    case 'moderate':
      await palworldModerate(
        serverId,
        params.action as PalworldModerationAction,
        String(params.target ?? ''),
        params.message ? String(params.message) : undefined
      )
      return { ok: true }
    case 'ports':
      return getServerPorts(serverId)
    case 'setPorts':
      // the blocklist and the cross-server conflict check live in the service,
      // so a hand-crafted request can't punch a hole this path wouldn't
      return await setServerPorts(serverId, params.ports)
    case 'mods':
      return listServerMods(serverId)
    case 'files':
      return listServerFiles(serverId, String(params.path ?? ''))
    case 'readFile':
      return readServerFile(serverId, String(params.path ?? ''))
    case 'writeFile':
      writeServerFile(serverId, String(params.path ?? ''), String(params.content ?? ''))
      return { ok: true }
    case 'deleteFile':
      deleteServerPath(serverId, String(params.path ?? ''))
      return { ok: true }
    case 'installMod':
      await installServerMod(serverId, String(params.projectId ?? ''))
      return { ok: true }
    case 'removeMod':
      return removeServerMod(serverId, String(params.fileName ?? ''))
    case 'rebuild': {
      const kind = String(params.loader ?? 'paper') as 'vanilla' | 'paper' | 'fabric' | 'neoforge' | 'forge'
      await rebuildServer(serverId, kind, String(params.version ?? ''))
      await startServer(serverId).catch(() => {})
      return { ok: true }
    }
    case 'delete':
      await deleteServer(serverId) // stops it first if running; also purges archives
      await forgetServer(serverId) // and drop the cloud rows so every panel loses it
      return { ok: true }
    case 'archive':
      await archiveServer(serverId) // stops it first if running
      await dropShares(serverId) // the lapsed customer loses panel access until re-shared
      return { ok: true }
    case 'restore':
      await restoreServer(serverId) // back in the pool, stopped; re-share to hand it back
      return { ok: true }
    case 'setCommunity':
      setCommunityServer(serverId, Boolean(params.on))
      return { ok: true }
    case 'logs': {
      // The heartbeat only carries an 80-line tail, but the host buffers 1000.
      // This hands the panel real scrollback without growing the beat.
      //
      // Paging is by index into that buffer. The buffer rotates once it passes
      // MAX_LOG_LINES, so on a very chatty server an old `before` can drift by
      // however many lines arrived in between — acceptable for a log tail, and
      // the alternative (a monotonic sequence on every pushLog) costs more than
      // it buys here.
      const all = getServerLogs(serverId)
      const wanted = Number(params.lines)
      const limit = Math.min(Number.isFinite(wanted) && wanted > 0 ? wanted : 400, MAX_PANEL_LOG_LINES)
      const before = Number(params.before)
      const end = Number.isFinite(before) ? Math.max(0, Math.min(before, all.length)) : all.length
      const start = Math.max(0, end - limit)
      return { lines: all.slice(start, end), start, total: all.length, atStart: start === 0 }
    }
    // ---- panel access (ACCESS_ACTIONS gates who gets this far) ----
    case 'shares':
      return listAccess(serverId)
    case 'share': {
      const record = listLocalServers().find((s) => s.id === serverId)
      await grantAccess(serverId, record?.name ?? '', String(params.username ?? ''))
      return listAccess(serverId)
    }
    case 'unshare': {
      // resolve against this server's own grants, so a share id from elsewhere
      // (or one already revoked) can't be used to reach past it
      const target = (await listAccess(serverId)).people.find((p) => p.id === String(params.shareId ?? ''))
      if (!target) throw new Error('That person no longer has access to this server.')
      if (target.customer && !privileged) {
        throw new Error('This server belongs to that account — only the host owner or an admin can remove it.')
      }
      await revokeAccess(target.id)
      return listAccess(serverId)
    }
    case 'roster':
      return readServerRoster(serverId)
    case 'rosterEdit': {
      const list = String(params.list ?? 'whitelist') as PlayerFileKind
      if (!ROSTER_LISTS.includes(list)) throw new Error(`unknown list: ${list}`)
      const op = params.op === 'remove' ? 'remove' : 'add'
      return editServerRoster(serverId, list, op, String(params.name ?? ''))
    }
    case 'backups': {
      const op = String(params.op ?? 'list')
      if (op === 'make') {
        const { stamp } = await makeServerBackup(serverId)
        return { stamp, backups: listServerBackups(serverId) }
      }
      if (op === 'restore') {
        await restoreServerBackup(serverId, String(params.stamp ?? ''))
        return { backups: listServerBackups(serverId) }
      }
      if (op === 'list') return { backups: listServerBackups(serverId) }
      throw new Error(`unknown backup op: ${op}`)
    }
    default:
      throw new Error(`unknown request: ${action}`)
  }
}

/** Start the host-side relay loop (cheap no-op ticks when signed out or nothing is shared). */
export function startRemoteHost(): void {
  if (loopTimer || heartbeatTimer || !isCloudConfigured()) return
  loopTimer = setInterval(() => void hostTick(), TICK_MS)
  // its own timer, so a long-running command can never starve the beat
  heartbeatTimer = setInterval(() => void publishHeartbeat(), HEARTBEAT_MS)
}

/** Remove every grant for a server (used on archive — the owner re-shares when the customer returns). */
async function dropShares(serverId: string): Promise<void> {
  try {
    const supabase = getClient()
    const me = (await supabase.auth.getSession()).data.session?.user.id
    if (!me) return
    await supabase.from('server_shares').delete().eq('server_id', serverId).eq('owner_id', me)
    sharesDirty = true
  } catch {
    // cloud unreachable — the grants linger but the archived server rejects grantee requests anyway
  }
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
