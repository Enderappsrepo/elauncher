import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@web/lib/supabase'
import { Button, Console, Skeleton, StatusPill, Tabs } from '@web/ui'
import { Auth } from './Auth'
import { mockServers, uptime } from './data'
import type { ServerRow } from './data'
import { primeSenderName, queueCommand } from './relay'
import { useServers } from './useServers'

/** Send an instruction to the machine running a server. */
type Control = (row: ServerRow, action: 'start' | 'stop' | 'command', payload?: string) => Promise<void>
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
    if (userId) void primeSenderName(userId)
  }, [userId])

  const control = useCallback<Control>(
    async (row, action, payload) => {
      // checked before the session, because preview mode deliberately has no
      // session and "Not signed in" would misdescribe why nothing happened.
      // Pretending it worked would be worse: a control that reports success for
      // something that never left the browser.
      if (mock) throw new Error('Preview mode — no host is connected.')
      if (!userId) throw new Error('Not signed in.')
      await queueCommand(row.server_id, row.owner_id || userId, userId, action, payload)
    },
    [userId, mock]
  )

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
            <Detail row={open} control={control} onBack={() => setOpenId(null)} />
          ) : live.loading && !mock ? (
            <ListSkeleton />
          ) : (
            <ServerList rows={servers} error={live.error} control={control} onOpen={setOpenId} />
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
  control,
  onOpen
}: {
  rows: ServerRow[]
  error: string | null
  control: Control
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
          <ServerCard
            key={row.server_id}
            row={row}
            index={i}
            control={control}
            onOpen={() => onOpen(row.server_id)}
          />
        ))}
      </div>
    </>
  )
}

function ServerCard({
  row,
  index,
  control,
  onOpen
}: {
  row: ServerRow
  index: number
  control: Control
  onOpen: () => void
}): React.JSX.Element {
  const live = row.state === 'running'
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  // The host reports the real state within a beat, so there is no optimistic
  // rewrite here — just a disabled control while the command is in flight.
  // Claiming "Running" before the machine agrees is how a panel starts lying.
  async function press(): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      await control(row, live ? 'stop' : 'start')
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not send that.')
    } finally {
      setBusy(false)
    }
  }

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
      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}
      <div className="row actions">
        <Button size="sm" variant={live ? 'danger' : 'primary'} disabled={busy} onClick={press}>
          {busy ? 'Sending…' : live ? 'Stop' : 'Start'}
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

/**
 * Console tab.
 *
 * Keeps a history ring reachable with the arrow keys, because the commands
 * people send from a phone are the ones they send over and over — /save-all,
 * /stop, a whitelist add — and retyping them on a touch keyboard is miserable.
 */
function ConsoleTab({ row, control }: { row: ServerRow; control: Control }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [at, setAt] = useState(-1)
  const [failed, setFailed] = useState('')
  const live = row.state === 'running'

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setHistory((h) => [text, ...h].slice(0, 50))
    setAt(-1)
    setFailed('')
    try {
      await control(row, 'command', text)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not send that.')
      setDraft(text) // hand it back rather than losing what they typed
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') return void send()
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const next = e.key === 'ArrowUp' ? Math.min(at + 1, history.length - 1) : Math.max(at - 1, -1)
    setAt(next)
    setDraft(next === -1 ? '' : history[next])
  }

  return (
    <>
      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}
      <Console text={row.console}>
        <input
          className="console-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={!live}
          placeholder={live ? 'Type a command…  ↑ for history' : 'start the server to send commands'}
        />
        <Button size="sm" variant="primary" disabled={!live || !draft.trim()} onClick={send}>
          Send
        </Button>
      </Console>
    </>
  )
}

function Detail({
  row,
  control,
  onBack
}: {
  row: ServerRow
  control: Control
  onBack: () => void
}): React.JSX.Element {
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
        {tab === 'console' && <ConsoleTab row={row} control={control} />}
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
