import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { supabase } from '@web/lib/supabase'
import { EmptyState, Skeleton } from '@web/ui'
import './Health.css'

/**
 * The boxes doing the hosting.
 *
 * public.host_health is keyed (owner_id, device_id), not by account: a desktop
 * launcher and two VPS hosts signed into the same account are three rows, and
 * each one is a separate machine that can run out of disk on its own. Rendering
 * "the" host row would quietly hide the box that is actually on fire, so every
 * row gets a card.
 *
 * What you see is decided by row-level security rather than by this file — an
 * owner reads their own boxes, an admin reads every box in the fleet — so the
 * query is the same either way and the cards name whose account each box is on.
 */

/** One row of public.host_health: vitals a hosting launcher publishes about itself. */
interface HostRow {
  owner_id: string
  device_id: string
  host_name: string
  platform: string
  app_version: string
  headless: boolean
  cpu_model: string
  cpu_threads: number
  cpu_percent: number | null
  ram_used_mb: number | null
  ram_total_mb: number | null
  disk_free_gb: number | null
  disk_total_gb: number | null
  uptime_seconds: number | null
  load1: number | null
  servers_running: number
  servers_total: number
  players_online: number
  updated_at: string
}

interface StatusRow {
  state: string
  updated_at: string
}

/** Hosts publish about every 10s, so three missed beats means the launcher is gone. */
const HOST_STALE_MS = 45_000
/** A short silence reads amber — reboots and updates look exactly like this.
 *  Past here it turns red: the silence is the story, not a hiccup in it. */
const HOST_GONE_MS = 5 * 60_000
/** A status row that stopped being rewritten is a memory of a server, not a server. */
const SERVER_FRESH_MS = 40_000
const POLL_MS = 20_000

/** A reading that is missing is not a reading of zero — "not readable here" and
 *  "idle" have to stay distinguishable all the way to the meter. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toHost(raw: Record<string, unknown>): HostRow {
  return {
    owner_id: String(raw.owner_id ?? ''),
    device_id: String(raw.device_id ?? ''),
    host_name: String(raw.host_name ?? ''),
    platform: String(raw.platform ?? ''),
    app_version: String(raw.app_version ?? ''),
    headless: Boolean(raw.headless),
    cpu_model: String(raw.cpu_model ?? ''),
    cpu_threads: num(raw.cpu_threads) ?? 0,
    cpu_percent: num(raw.cpu_percent),
    ram_used_mb: num(raw.ram_used_mb),
    ram_total_mb: num(raw.ram_total_mb),
    disk_free_gb: num(raw.disk_free_gb),
    disk_total_gb: num(raw.disk_total_gb),
    uptime_seconds: num(raw.uptime_seconds),
    load1: num(raw.load1),
    servers_running: num(raw.servers_running) ?? 0,
    servers_total: num(raw.servers_total) ?? 0,
    players_online: num(raw.players_online) ?? 0,
    updated_at: String(raw.updated_at ?? '')
  }
}

const keyOf = (h: { owner_id: string; device_id: string }): string => `${h.owner_id}:${h.device_id}`

/** Same account, two boxes, same self-reported name — the device id is what
 *  keeps the order from shuffling between polls. */
function byName(a: HostRow, b: HostRow): number {
  return (a.host_name || '').localeCompare(b.host_name || '') || a.device_id.localeCompare(b.device_id)
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${Math.max(0, m)}m`
}

function gb(mb: number | null): string {
  if (mb === null) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** Percentages of a whole that is unknown are not 0% — they are nothing. */
function pctOf(used: number | null, total: number | null): number | null {
  if (used === null || !total) return null
  return Math.round((used / total) * 100)
}

/** A cloud that has not had the latest schema.sql run has no such table, and
 *  PostgREST's wording for that helps nobody standing in front of it. */
function readable(message: string): string {
  return /schema cache|does not exist|42P01|PGRST205/i.test(message)
    ? 'Fleet health needs one migration — open Supabase → SQL Editor and run the latest schema.sql once.'
    : message
}

interface FleetState {
  hosts: HostRow[]
  /** owner_id -> username, fetched separately: the panel never uses embedded resources */
  names: Record<string, string>
  servers: StatusRow[]
  loading: boolean
  error: string | null
}

const EMPTY: FleetState = { hosts: [], names: {}, servers: [], loading: true, error: null }

function useFleet(userId: string): FleetState {
  const [state, setState] = useState<FleetState>(EMPTY)
  // read inside the realtime handler without making it a dependency, which would
  // tear the subscription down and rebuild it on every heartbeat
  const known = useRef<Set<string>>(new Set())

  const load = useCallback(async (): Promise<void> => {
    try {
      const [healthRes, statusRes] = await Promise.all([
        supabase.from('host_health').select('*'),
        supabase.from('server_status').select('state, updated_at')
      ])
      if (healthRes.error) throw new Error(healthRes.error.message)

      const hosts = (healthRes.data ?? []).map((r) => toHost(r as Record<string, unknown>)).sort(byName)
      known.current = new Set(hosts.map(keyOf))

      const ownerIds = [...new Set(hosts.map((h) => h.owner_id))].filter(Boolean)
      const names: Record<string, string> = {}
      if (ownerIds.length) {
        const { data } = await supabase.from('profiles').select('id, username').in('id', ownerIds)
        for (const p of (data ?? []) as { id: string; username: string | null }[]) {
          names[p.id] = p.username ?? ''
        }
      }

      const servers = (statusRes.data ?? []).map((r) => ({
        state: String((r as Record<string, unknown>).state ?? ''),
        updated_at: String((r as Record<string, unknown>).updated_at ?? '')
      }))

      setState({ hosts, names, servers, loading: false, error: null })
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: readable(e instanceof Error ? e.message : 'Could not reach the cloud.')
      }))
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    void load()

    const channel = supabase
      .channel(`fleet-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'host_health' }, (payload) => {
        const raw = payload.new as Record<string, unknown> | null
        if (!raw?.device_id) return
        const row = toHost(raw)
        // a box we have never seen has no owner name yet, so it needs the full load
        if (!known.current.has(keyOf(row))) return void load()
        setState((prev) => ({
          ...prev,
          hosts: prev.hosts.map((h) => (keyOf(h) === keyOf(row) ? row : h))
        }))
      })
      .subscribe()

    // Backstop for clouds without the realtime publication — and the clock for
    // staleness besides: a box that goes dark sends nothing, so only a re-render
    // on this timer can turn its card grey.
    const timer = setInterval(() => void load(), POLL_MS)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [userId, load])

  return state
}

type Alert = { level: 'bad' | 'warn'; host: string; text: string }

export function Health({ userId }: { userId: string }): React.JSX.Element {
  const { hosts, names, servers, loading, error } = useFleet(userId)
  // recomputed on every render, and the poll guarantees one every 20s — which is
  // what ages a silent host into "Offline" without any data arriving
  const now = Date.now()

  const alerts: Alert[] = []
  let online = 0
  let players = 0

  for (const h of hosts) {
    const label = h.host_name || names[h.owner_id] || 'Unknown host'
    const age = now - new Date(h.updated_at).getTime()
    if (age > HOST_STALE_MS) {
      alerts.push({ level: 'bad', host: label, text: `No vitals for ${ago(age)} — the hosting launcher looks closed` })
      continue
    }
    online += 1
    players += h.players_online
    const diskPct = pctOf(h.disk_total_gb === null || h.disk_free_gb === null ? null : h.disk_total_gb - h.disk_free_gb, h.disk_total_gb)
    const ramPct = pctOf(h.ram_used_mb, h.ram_total_mb)
    // disk is the one that takes a host down for good, so it leads
    if (h.disk_free_gb !== null && h.disk_free_gb < 5) {
      alerts.push({ level: 'bad', host: label, text: `Only ${h.disk_free_gb} GB of disk left` })
    } else if (diskPct !== null && diskPct >= 90) {
      alerts.push({ level: 'warn', host: label, text: `Disk ${diskPct}% full` })
    }
    if (ramPct !== null && ramPct >= 92) alerts.push({ level: 'warn', host: label, text: `Memory ${ramPct}% used` })
    if (h.cpu_percent !== null && h.cpu_percent >= 92) {
      alerts.push({ level: 'warn', host: label, text: `CPU pinned at ${h.cpu_percent}%` })
    }
  }
  // an offline host or a full disk outranks a busy CPU
  alerts.sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'))

  const running = servers.filter(
    (s) => s.state === 'running' && now - new Date(s.updated_at).getTime() < SERVER_FRESH_MS
  ).length

  return (
    <>
      <div className="head rise">
        <h1>Fleet health</h1>
        <p className="dim">
          {loading ? 'Reading vitals…' : `${hosts.length} ${hosts.length === 1 ? 'box' : 'boxes'} · ${online} online`}
        </p>
      </div>

      {error && (
        <p className="formerr" role="alert">
          {error}
        </p>
      )}

      {loading && (
        <div className="grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={330} />
          ))}
        </div>
      )}

      {!loading && !error && hosts.length === 0 && (
        <EmptyState icon={<Activity size={20} />} title="No machines reporting">
          A signed-in launcher or headless host appears here on its first heartbeat — the desktop
          app while it is hosting, or a VPS running the headless host. If one is online, give it a
          minute.
        </EmptyState>
      )}

      {hosts.length > 0 && (
        <>
          <section className="surface pad rise stack fleet-summary">
            <div className="row">
              <h2>Fleet at a glance</h2>
              <span className="spacer" />
              <span className={`pill ${alerts.some((a) => a.level === 'bad') ? 'error' : alerts.length ? 'busy' : 'running'}`}>
                <span className="dot" aria-hidden />
                {alerts.length ? `${alerts.length} to check` : 'All good'}
              </span>
            </div>
            <div className="metrics">
              <Metric label="Hosts up" value={`${online}/${hosts.length}`} />
              <Metric label="Servers up" value={String(running)} />
              <Metric label="Servers" value={String(servers.length)} />
              <Metric label="Players" value={String(players)} />
            </div>
            {alerts.length > 0 && (
              <div className="fleet-alerts">
                {alerts.map((a, i) => (
                  <div key={`${i}-${a.host}`} className={`fleet-alert ${a.level}`}>
                    <span className="fleet-alert-dot" aria-hidden />
                    <span>
                      <b>{a.host}</b>
                      <i>{a.text}</i>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="grid stagger">
            {hosts.map((h, i) => (
              <HostCard key={keyOf(h)} host={h} owner={names[h.owner_id] ?? ''} now={now} index={i} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  )
}

function HostCard({
  host,
  owner,
  now,
  index
}: {
  host: HostRow
  owner: string
  now: number
  index: number
}): React.JSX.Element {
  const age = now - new Date(host.updated_at).getTime()
  const stale = age > HOST_STALE_MS
  const gone = age > HOST_GONE_MS
  const label = host.host_name || owner || 'Unknown host'
  const ramPct = pctOf(host.ram_used_mb, host.ram_total_mb)
  const diskUsed = host.disk_total_gb === null || host.disk_free_gb === null ? null : host.disk_total_gb - host.disk_free_gb
  const diskPct = pctOf(diskUsed, host.disk_total_gb)
  const sub = [owner || 'Unknown account', host.platform, host.headless ? 'headless' : ''].filter(Boolean).join(' · ')

  return (
    <article
      className={`surface fleet-card ${gone ? 'gone' : stale ? 'stale' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
    >
      <div className="row">
        <div className="fleet-who">
          <h2>{label}</h2>
          <p className="dim fleet-sub">{sub}</p>
        </div>
        <span className="spacer" />
        <span className={`pill ${stale ? 'error' : 'running'}`}>
          <span className="dot" aria-hidden />
          {stale ? 'Offline' : 'Online'}
        </span>
      </div>

      {/* the heartbeat line: alive is shown rather than implied, and silence
          ages from amber to red as it stops looking like a reboot */}
      <p className={`fleet-seen ${gone ? 'bad' : stale ? 'warn' : ''}`}>
        <span className="fleet-seen-dot" aria-hidden />
        {stale ? `last seen ${age < 60_000 ? 'moments' : ago(age)} ago` : 'reporting live'}
      </p>

      <div className="fleet-meters">
        <Meter
          label="CPU"
          pct={host.cpu_percent}
          detail={
            host.cpu_percent === null
              ? 'not readable'
              : `${host.cpu_percent}%${host.load1 !== null ? ` · load ${host.load1}` : ''}`
          }
        />
        <Meter
          label="Memory"
          pct={ramPct}
          detail={host.ram_total_mb ? `${gb(host.ram_used_mb)} of ${gb(host.ram_total_mb)}` : 'not readable'}
        />
        <Meter
          label="Disk"
          pct={diskPct}
          detail={host.disk_total_gb ? `${host.disk_free_gb} GB free of ${host.disk_total_gb} GB` : 'not readable'}
        />
      </div>

      <div className="metrics">
        <Metric label="Servers" value={`${host.servers_running}/${host.servers_total}`} />
        <Metric label="Players" value={stale ? '—' : String(host.players_online)} />
        <Metric label="Uptime" value={host.uptime_seconds ? ago(host.uptime_seconds * 1000) : '—'} />
        <Metric label="Threads" value={host.cpu_threads ? String(host.cpu_threads) : '—'} />
      </div>

      <div className="fleet-tags">
        <span className="fleet-tag">{host.cpu_model || 'Unknown CPU'}</span>
        <span className="fleet-tag">ELauncher {host.app_version || '?'}</span>
        <span className="fleet-tag mono">{host.device_id.slice(0, 12) || 'no device id'}</span>
      </div>
    </article>
  )
}

/**
 * One utilisation reading.
 *
 * A bar rather than a number because the question this view answers — is
 * anything about to fall over — is answered at a glance or not at all. An
 * unknown reading gets a flat grey track instead of an empty one: nothing to
 * report must not look like nothing wrong.
 */
function Meter({ label, pct, detail }: { label: string; pct: number | null; detail: string }): React.JSX.Element {
  const band = pct === null ? 'none' : pct >= 90 ? 'hot' : pct >= 75 ? 'warn' : ''
  const width = pct === null ? 100 : Math.max(2, Math.min(100, pct))
  return (
    <div className={`fleet-meter ${band}`}>
      <div className="fleet-meter-row">
        <b>{label}</b>
        <span>{detail}</span>
      </div>
      <div
        className="fleet-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? 'not readable' : `${pct}%`}
      >
        <div className="fleet-meter-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}
