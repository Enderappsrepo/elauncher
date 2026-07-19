import type { RealtimeChannel } from '@supabase/supabase-js'
import type { LocalServer, LocalServerState, ManagedServer, ServerShare } from '@shared/types'
import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient, getUser } from './cloud'
import {
  archiveServer,
  deleteServer,
  deleteServerPath,
  getPalworldPlayerDetails,
  getServerAutomation,
  getServerLogs,
  getServerProperties,
  getServerStates,
  installServerMod,
  listArchivedServers,
  listLocalServers,
  listServerFiles,
  listServerMods,
  restoreServer,
  palworldModerate,
  playerCapKey,
  readServerFile,
  rebuildServer,
  removeServerMod,
  sendServerCommand,
  setCommunityServer,
  setServerAutomation,
  setServerProperties,
  startServer,
  stopServer,
  writeServerFile
} from './server'
import type { PalworldModerationAction, ServerAutomation } from '@shared/types'

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
/** shares are re-checked this often so new grants start syncing without a restart */
const SHARE_REFRESH_MS = 60_000

/** destructive lifecycle actions only the host owner or an admin may trigger */
const PRIVILEGED_ACTIONS = new Set(['delete', 'archive', 'restore'])
const adminCache = new Map<string, { admin: boolean; at: number }>()
const ADMIN_CACHE_MS = 5 * 60_000

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
/** false once the cloud rejects the stats columns (migration not run yet) */
let statusHasStatsColumns = true
/** false once the cloud rejects just the newer community column */
let statusHasCommunityColumn = true
let statsRetryAt = 0
let sharedServerIds: Set<string> = new Set()
let sharesDirty = true
let lastShareRefresh = 0
let ticking = false
let lastPublish = 0
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
    if (!me) return
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
        if (!privileged) {
          // the host owner can do anything; admins can do anything; grantees
          // (customers) are limited to non-destructive actions while shared
          const admin = await isAdminUser(supabase, req.requester_id)
          if (PRIVILEGED_ACTIONS.has(req.action) && !admin) {
            throw new Error('Only the host owner or an admin can do that.')
          }
          if (!admin && !sharedServerIds.has(req.server_id)) throw new Error('access was revoked')
          privileged = admin
        }
        if (archivedHere && !PRIVILEGED_ACTIONS.has(req.action)) {
          throw new Error('This server is archived — restore it first.')
        }
        response = await runPanelRequest(req.server_id, req.action, req.params, privileged)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      await supabase
        .from('server_requests')
        .update({ done: true, response: response ?? null, error })
        .eq('id', req.id)
    }

    // 3. publish status snapshots — right after executing work so the panel
    // sees the effect of its click at once, otherwise on the heartbeat cadence
    const didWork = (commands?.length ?? 0) > 0 || (requests?.length ?? 0) > 0
    if (didWork || Date.now() - lastPublish >= HEARTBEAT_MS) {
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
async function runPanelRequest(serverId: string, action: string, params: Record<string, unknown>, privileged = true): Promise<unknown> {
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
        owner: privileged
      }
    }
    case 'getProps':
      return getServerProperties(serverId)
    case 'setProps':
      return setServerProperties(serverId, (params.updates as Record<string, string>) ?? {})
    case 'setAutomation':
      setServerAutomation(serverId, (params.automation as ServerAutomation) ?? {})
      return { ok: true }
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
    default:
      throw new Error(`unknown request: ${action}`)
  }
}

/** Start the host-side relay loop (cheap no-op ticks when signed out or nothing is shared). */
export function startRemoteHost(): void {
  if (loopTimer || !isCloudConfigured()) return
  loopTimer = setInterval(() => void hostTick(), TICK_MS)
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
