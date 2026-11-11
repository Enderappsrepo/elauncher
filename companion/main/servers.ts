import type { SupabaseClient } from '@supabase/supabase-js'
import type { NvmpSetupStatus } from '@shared/nvmpUpload'
import type { CompanionServer } from '../shared/types'
import { cloudNow } from './cloudClock'
import { cloudError, type Ask } from './relay'

/**
 * The panel's server list (web/src/panel/useServers.ts load()) as one call: servers this
 * account hosts, plus the ones shared with it. A rented NV:MP server always arrives through
 * the share, owned by the host's account.
 */

const COLUMNS = 'server_id,owner_id,game,name,state,updated_at'
const STATES = ['running', 'stopped', 'starting', 'stopping', 'error', 'archived']
const PHASES: ReadonlyArray<NonNullable<CompanionServer['phase']>> = ['waiting', 'uploading', 'committing', 'ready']

/**
 * web/src/panel/data.ts isStale, inverted: hosts rewrite their rows every few seconds while running.
 * Judged by the cloud's clock (cloudClock.ts), not this PC's, so a PC clock that is off does not make
 * every host look offline.
 */
export function hostOnline(updatedAt: unknown, now = cloudNow()): boolean {
  if (typeof updatedAt !== 'string' || !updatedAt) return true
  return now - new Date(updatedAt).getTime() <= 60_000
}

interface StatusRow extends CompanionServer {
  game: string | null
}

function toRow(raw: Record<string, unknown>): StatusRow {
  return {
    serverId: String(raw.server_id),
    ownerId: String(raw.owner_id ?? ''),
    game: raw.game ? String(raw.game) : null,
    name: String(raw.name ?? 'Server'),
    // the column is free text; the panel treats anything unrecognised as stopped
    state: STATES.includes(String(raw.state)) ? String(raw.state) : 'stopped',
    hostOnline: hostOnline(raw.updated_at)
  }
}

const strip = ({ game: _game, ...server }: StatusRow): CompanionServer => server

async function nvmpRows(client: SupabaseClient, userId: string): Promise<CompanionServer[]> {
  const [mineRes, sharesRes] = await Promise.all([
    client.from('server_status').select(COLUMNS).eq('owner_id', userId),
    client.from('server_shares').select('server_id').eq('grantee_id', userId)
  ])
  if (mineRes.error) throw cloudError(mineRes.error, mineRes.status)
  // a renting customer owns no rows: a failed share lookup must not read as "no servers yet"
  if (sharesRes.error) throw cloudError(sharesRes.error, sharesRes.status)
  const mine = (mineRes.data ?? []).map((r) => toRow(r as Record<string, unknown>))
  const mineIds = new Set(mine.map((r) => r.serverId))
  let shared: StatusRow[] = []
  const shareIds = (sharesRes.data ?? [])
    .map((s) => String((s as { server_id: string }).server_id))
    .filter((id) => !mineIds.has(id))
  if (shareIds.length) {
    const { data, error, status } = await client.from('server_status').select(COLUMNS).in('server_id', shareIds)
    if (error) throw cloudError(error, status)
    shared = (data ?? []).map((r) => toRow(r as Record<string, unknown>))
  }
  return [...mine, ...shared]
    .filter((r) => r.game === 'nvmp')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(strip)
}

/** Fill phase and edit rights from the host itself; a host that cannot answer leaves them unknown. */
export async function checkServer(server: CompanionServer, ask: Ask): Promise<CompanionServer> {
  if (!server.hostOnline) return { ...server, phase: 'unknown' }
  const [status, info] = await Promise.allSettled([
    ask<NvmpSetupStatus>('nvmpStatus', {}),
    ask<{ canShare?: boolean }>('info')
  ])
  const phase = status.status === 'fulfilled' && PHASES.includes(status.value?.phase) ? status.value.phase : 'unknown'
  const canEdit = info.status === 'fulfilled' ? Boolean(info.value?.canShare) : undefined
  return { ...server, phase, canEdit }
}

export async function listServers(
  client: SupabaseClient,
  userId: string,
  askFor: (server: CompanionServer) => Ask
): Promise<CompanionServer[]> {
  const rows = await nvmpRows(client, userId)
  return Promise.all(rows.map((row) => checkServer(row, askFor(row))))
}

/** One server's current row, without asking its host anything. */
export async function getServer(client: SupabaseClient, serverId: string): Promise<CompanionServer | null> {
  const { data, error, status } = await client.from('server_status').select(COLUMNS).eq('server_id', serverId).maybeSingle()
  if (error) throw cloudError(error, status)
  if (!data) return null
  const row = toRow(data as Record<string, unknown>)
  return row.game === 'nvmp' ? strip(row) : null
}
