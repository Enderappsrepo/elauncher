import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@web/lib/supabase'
import type { RunState } from '@web/ui'
import type { ServerRow } from './data'

/**
 * The panel's live view of every server this account can see.
 *
 * Two sources, because "your servers" means two things: the ones you host, read
 * straight from server_status, and the ones somebody granted you, which come
 * from server_shares and then need their statuses fetched by id. Row-level
 * security would hide the second set from a plain select.
 *
 * After the first load the cloud pushes changes instead of the panel asking for
 * them. That is what makes the console live: the host now writes a server's
 * console tail within about 250ms of a line appearing, and this subscription
 * turns that write into a re-render immediately. A slow poll is kept as the
 * safety net for clouds without the realtime publication, where the push never
 * arrives at all.
 */

const POLL_MS = 15_000

const STATES: readonly RunState[] = ['running', 'stopped', 'starting', 'stopping', 'error', 'archived']

/** The DB column is free text; anything unrecognised is treated as stopped. */
function toState(value: unknown): RunState {
  return STATES.includes(value as RunState) ? (value as RunState) : 'stopped'
}

function toRow(raw: Record<string, unknown>): ServerRow {
  return {
    server_id: String(raw.server_id),
    name: String(raw.name ?? 'Server'),
    state: toState(raw.state),
    players: Array.isArray(raw.players) ? (raw.players as string[]) : [],
    address: (raw.address as string | null) ?? null,
    console: String(raw.console ?? ''),
    memory_mb: (raw.memory_mb as number | null) ?? null,
    cpu_percent: (raw.cpu_percent as number | null) ?? null,
    started_at: (raw.started_at as string | null) ?? null,
    version: (raw.version as string | null) ?? null
  }
}

export interface ServersState {
  rows: ServerRow[]
  loading: boolean
  error: string | null
}

export function useServers(userId: string | null, enabled: boolean): ServersState {
  const [rows, setRows] = useState<ServerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // read inside the realtime handler without making it a dependency, which would
  // tear down and rebuild the subscription on every incoming row
  const known = useRef<Set<string>>(new Set())

  const load = useCallback(async (): Promise<void> => {
    if (!userId) return
    try {
      const [mineRes, sharesRes] = await Promise.all([
        supabase.from('server_status').select('*').eq('owner_id', userId),
        supabase.from('server_shares').select('server_id').eq('grantee_id', userId)
      ])
      if (mineRes.error) throw new Error(mineRes.error.message)

      const mine = (mineRes.data ?? []).map((r) => toRow(r as Record<string, unknown>))
      const mineIds = new Set(mine.map((r) => r.server_id))

      // shares can fail independently (an older cloud has no such table); losing
      // them should not blank out the servers you actually host
      let shared: ServerRow[] = []
      const shareIds = (sharesRes.data ?? [])
        .map((s) => String((s as { server_id: string }).server_id))
        .filter((id) => !mineIds.has(id))
      if (shareIds.length) {
        const { data } = await supabase.from('server_status').select('*').in('server_id', shareIds)
        shared = (data ?? []).map((r) => toRow(r as Record<string, unknown>))
      }

      const all = [...mine, ...shared].sort((a, b) => a.name.localeCompare(b.name))
      known.current = new Set(all.map((r) => r.server_id))
      setRows(all)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the cloud.')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    if (!enabled || !userId) {
      setLoading(false)
      return
    }
    void load()

    const channel = supabase
      .channel(`panel-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_status' },
        (payload) => {
          const raw = payload.new as Record<string, unknown> | null
          if (!raw?.server_id) return
          const id = String(raw.server_id)
          // a server we have never seen needs the full load: the push carries the
          // status row but not whether it is ours or shared with us
          if (!known.current.has(id)) return void load()
          setRows((prev) => prev.map((r) => (r.server_id === id ? { ...r, ...toRow(raw) } : r)))
        }
      )
      .subscribe()

    // backstop for clouds without the realtime publication, where nothing above
    // ever fires; harmless duplication where it does
    const timer = setInterval(() => void load(), POLL_MS)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [enabled, userId, load])

  return { rows, loading, error }
}
