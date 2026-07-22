import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@web/lib/supabase'
import { Button, Console, Skeleton, StatusPill, Tabs } from '@web/ui'
import { Auth } from './Auth'
import { mockServers, uptime } from './data'
import type { ServerRow } from './data'
import { useServers } from './useServers'
import '@web/styles/ui.css'
import './App.css'

type Phase = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'signedIn'; session: Session | null }

const TABS = ['overview', 'console', 'players', 'settings'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  console: 'Console',
  players: 'Players',
  settings: 'Settings'
}

export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [openId, setOpenId] = useState<string | null>(null)

  // Preview hook wins over the cloud so the design can be driven with no session.
  // sessionStorage as well as the global because the global does not survive the
  // reload you need to re-enter the app from a signed-out state.
  const mock = useMemo(() => {
    if (typeof window === 'undefined') return undefined
    if (window.__mockServers) return window.__mockServers
    return sessionStorage.getItem('elauncher:preview') === '1' ? mockServers() : undefined
  }, [])
  const userId = phase.kind === 'signedIn' ? (phase.session?.user.id ?? null) : null
  const live = useServers(userId, !mock && phase.kind === 'signedIn')
  const servers = mock ?? live.rows

  useEffect(() => {
    if (mock) {
      setPhase({ kind: 'signedIn', session: null })
      return
    }
    let alive = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setPhase(data.session ? { kind: 'signedIn', session: data.session } : { kind: 'signedOut' })
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!alive) return
      setPhase(session ? { kind: 'signedIn', session } : { kind: 'signedOut' })
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [mock])

  const open = servers.find((s) => s.server_id === openId) ?? null

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap row">
          <button className="brand" onClick={() => setOpenId(null)}>
            <span className="mark" aria-hidden />
            <span className="wordmark">ELauncher</span>
          </button>
          <span className="chip">Remote</span>
          <span className="spacer" />
          {phase.kind === 'signedIn' && (
            <>
              <span className="who">{phase.session?.user.email ?? 'preview'}</span>
              <Button size="sm" variant="ghost" onClick={() => void supabase.auth.signOut()}>
                Sign out
              </Button>
            </>
          )}
        </div>
      </header>

      <main className="wrap page">
        {phase.kind === 'loading' && <ListSkeleton />}
        {phase.kind === 'signedOut' && <Auth />}
        {phase.kind === 'signedIn' &&
          (open ? (
            <Detail row={open} onBack={() => setOpenId(null)} />
          ) : live.loading && !mock ? (
            <ListSkeleton />
          ) : (
            <ServerList rows={servers} error={live.error} onOpen={setOpenId} />
          ))}
      </main>
    </div>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="grid" style={{ marginTop: 20 }}>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={132} />
      ))}
    </div>
  )
}

/** Nothing to show is nearly always the same cause, so name it rather than
 *  leaving a blank page that looks broken. */
function Empty(): React.JSX.Element {
  return (
    <section className="surface pad rise stack">
      <h2>No servers reporting yet</h2>
      <p className="dim">
        Servers appear here once a launcher signed into this account is running them — either the
        desktop app or a headless host. If one is online, give it a few seconds to publish.
      </p>
    </section>
  )
}

function ServerList({
  rows,
  error,
  onOpen
}: {
  rows: ServerRow[]
  error: string | null
  onOpen: (id: string) => void
}): React.JSX.Element {
  const running = rows.filter((r) => r.state === 'running').length
  return (
    <>
      <div className="head rise">
        <div>
          <h1>Servers</h1>
          <p className="dim">
            {rows.length} total · {running} running
          </p>
        </div>
      </div>
      {error && (
        <p className="formerr" role="alert">
          {error}
        </p>
      )}
      {!error && rows.length === 0 && <Empty />}
      <div className="grid stagger">
        {rows.map((row, i) => (
          <ServerCard key={row.server_id} row={row} index={i} onOpen={() => onOpen(row.server_id)} />
        ))}
      </div>
    </>
  )
}

function ServerCard({
  row,
  index,
  onOpen
}: {
  row: ServerRow
  index: number
  onOpen: () => void
}): React.JSX.Element {
  const live = row.state === 'running'
  return (
    <article className="surface card-server" style={{ '--i': index } as React.CSSProperties}>
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${row.name}`} />
      <div className="row">
        <h2>{row.name}</h2>
        <span className="spacer" />
        <StatusPill state={row.state} />
      </div>
      <p className="mono dim addr">{row.address ?? 'no address yet'}</p>
      <div className="metrics">
        <Metric label="Players" value={live ? String(row.players.length) : '—'} />
        <Metric label="Memory" value={row.memory_mb ? `${(row.memory_mb / 1024).toFixed(1)} GB` : '—'} />
        <Metric label="CPU" value={row.cpu_percent !== null ? `${row.cpu_percent}%` : '—'} />
        <Metric label="Uptime" value={uptime(row.started_at)} />
      </div>
      <div className="row actions">
        <Button size="sm" variant={live ? 'danger' : 'primary'}>
          {live ? 'Stop' : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Console
        </Button>
      </div>
    </article>
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

function Detail({ row, onBack }: { row: ServerRow; onBack: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('console')
  return (
    <div className="detail rise">
      <div className="head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Servers
        </Button>
      </div>
      <div className="row detail-title">
        <h1>{row.name}</h1>
        <span className="spacer" />
        <StatusPill state={row.state} />
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} labels={TAB_LABELS} />
      <div className="tabbody">
        {tab === 'console' && (
          <Console text={row.console}>
            <input className="console-input" placeholder="Type a command…  ↑ for history" />
            <Button size="sm" variant="primary">
              Send
            </Button>
          </Console>
        )}
        {tab === 'overview' && (
          <div className="surface pad">
            <div className="metrics">
              <Metric label="Version" value={row.version ?? '—'} />
              <Metric label="Players" value={String(row.players.length)} />
              <Metric label="Memory" value={row.memory_mb ? `${(row.memory_mb / 1024).toFixed(1)} GB` : '—'} />
              <Metric label="Uptime" value={uptime(row.started_at)} />
            </div>
          </div>
        )}
        {tab === 'players' && (
          <div className="surface pad stack">
            {row.players.length === 0 && <p className="dim">Nobody online.</p>}
            {row.players.map((p) => (
              <div key={p} className="row player">
                <span className="avatar" aria-hidden />
                {p}
              </div>
            ))}
          </div>
        )}
        {tab === 'settings' && (
          <div className="surface pad">
            <p className="dim">Settings port pending.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export { mockServers }
