import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Activity, LogOut, ReceiptText, Search, Server, ShieldCheck, ShoppingBag, X } from 'lucide-react'
import { Toaster } from 'sonner'
import { supabase } from '@web/lib/supabase'
import { Button, Console, Kbd, Skeleton, StatusPill, Tabs } from '@web/ui'
import { MotionRoot, Switch } from '@web/ui/motion'
import { Auth } from './Auth'
import { Palette } from './Palette'
import { GAME_HUE, gameLabel, isStale, lastSeen, mockServers, uptime } from './data'
import type { Game, ServerRow } from './data'
import { primeSenderName, queueCommand } from './relay'
import { makeAsk } from './tabs/types'
import { useServers } from './useServers'
import '@web/styles/ui.css'
import './App.css'

/* Every tab and section past the server list loads on demand. The panel's
 * first paint is the list — the thing someone opened it to check — and a
 * 900-line Files browser has no business in that critical path. */
const Access = lazy(() => import('./tabs/Access').then((m) => ({ default: m.Access })))
const Automation = lazy(() => import('./tabs/Automation').then((m) => ({ default: m.Automation })))
const Files = lazy(() => import('./tabs/Files').then((m) => ({ default: m.Files })))
const Mods = lazy(() => import('./tabs/Mods').then((m) => ({ default: m.Mods })))
const Network = lazy(() => import('./tabs/Network').then((m) => ({ default: m.Network })))
const Players = lazy(() => import('./tabs/Players').then((m) => ({ default: m.Players })))
const Settings = lazy(() => import('./tabs/Settings').then((m) => ({ default: m.Settings })))
const Admin = lazy(() => import('./views/Admin').then((m) => ({ default: m.Admin })))
const Billing = lazy(() => import('./views/Billing').then((m) => ({ default: m.Billing })))
const Health = lazy(() => import('./views/Health').then((m) => ({ default: m.Health })))
const Shop = lazy(() => import('./views/Shop').then((m) => ({ default: m.Shop })))

/** Send an instruction to the machine running a server. */
type Control = (row: ServerRow, action: 'start' | 'stop' | 'command', payload?: string) => Promise<void>

type Phase = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'signedIn'; session: Session | null }

const TABS = [
  'overview',
  'console',
  'settings',
  'players',
  'mods',
  'files',
  'network',
  'automation',
  'access'
] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  console: 'Console',
  settings: 'Settings',
  players: 'Players',
  mods: 'Mods',
  files: 'Files',
  network: 'Network',
  automation: 'Automation',
  access: 'Access'
}

/**
 * Account-wide screens, as opposed to the per-server tabs above. Ordered the way
 * a customer moves through them — what they have, what they could buy, what they
 * owe — with the operator's fleet view after.
 */
const SECTIONS = ['servers', 'shop', 'billing', 'health', 'admin'] as const
type Section = (typeof SECTIONS)[number]
const SECTION_LABELS: Record<Section, string> = {
  servers: 'Servers',
  shop: 'Shop',
  billing: 'Billing',
  health: 'Health',
  admin: 'Admin'
}
const SECTION_ICONS: Record<Section, React.JSX.Element> = {
  servers: <Server size={17} aria-hidden />,
  shop: <ShoppingBag size={17} aria-hidden />,
  billing: <ReceiptText size={17} aria-hidden />,
  health: <Activity size={17} aria-hidden />,
  admin: <ShieldCheck size={17} aria-hidden />
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

  const [section, setSection] = useState<Section>('servers')
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    if (!userId) return
    void primeSenderName(userId)
    // decides only whether the Admin tab is offered; Admin.tsx re-checks for
    // itself, and the policies are what actually enforce it
    void supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(Boolean((data as { is_admin?: boolean } | null)?.is_admin)))
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
  const signedIn = phase.kind === 'signedIn'
  const nav = isAdmin ? SECTIONS : SECTIONS.filter((s) => s !== 'admin')
  const [palette, setPalette] = useState(false)

  const go = useCallback((next: Section): void => {
    setOpenId(null)
    setSection(next)
  }, [])

  // Staleness is a function of the clock, not of the data: a host going quiet
  // changes nothing in the rows, so a slow tick is what flips its cards to
  // "unreachable" while the page just sits there.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!signedIn) return
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [signedIn])

  // Global keys: ⌘K / Ctrl-K opens the palette anywhere; Escape steps back out
  // of a server — unless something is being typed, where Escape belongs to the
  // field being escaped from.
  useEffect(() => {
    if (!signedIn) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (e.key === 'Escape' && !palette) {
        const el = e.target as HTMLElement | null
        const typing =
          el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing) setOpenId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [signedIn, palette])

  return (
    <MotionRoot>
      <div className={`shell${signedIn ? ' with-rail' : ''}`}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {/* Desktop: a proper sidebar. It carries brand, sections, search and the
            account, so the top bar can disappear and the content own the width. */}
        {signedIn && (
          <aside className="rail">
            <button className="brand" onClick={() => go('servers')}>
              <span className="mark" aria-hidden />
              <span className="wordmark">ELauncher</span>
              <span className="chip">Remote</span>
            </button>
            <nav className="rail-nav" aria-label="Sections">
              {nav.map((s) => (
                <button
                  key={s}
                  className={`navbtn${section === s && !open ? ' on' : ''}`}
                  aria-current={section === s && !open ? 'page' : undefined}
                  onClick={() => go(s)}
                >
                  {SECTION_ICONS[s]}
                  <span>{SECTION_LABELS[s]}</span>
                </button>
              ))}
            </nav>
            <button className="navbtn" onClick={() => setPalette(true)}>
              <Search size={17} aria-hidden />
              <span>Search</span>
              <span className="spacer" />
              <Kbd>Ctrl K</Kbd>
            </button>
            <div className="rail-foot">
              <span className="who" title={phase.session?.user.email ?? 'preview'}>
                {phase.session?.user.email ?? 'preview'}
              </span>
              <button
                className="iconbtn"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => void supabase.auth.signOut()}
              >
                <LogOut size={16} aria-hidden />
              </button>
            </div>
          </aside>
        )}

        <div className="main-col">
          {/* Phones (and signed-out everywhere): the sticky glass top bar. */}
          <header className="topbar">
            <div className="wrap row">
              <button className="brand" onClick={() => go('servers')}>
                <span className="mark" aria-hidden />
                <span className="wordmark">ELauncher</span>
              </button>
              <span className="chip">Remote</span>
              <span className="spacer" />
              {signedIn && (
                <>
                  <button
                    className="iconbtn"
                    aria-label="Search — Ctrl K"
                    onClick={() => setPalette(true)}
                  >
                    <Search size={17} aria-hidden />
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => void supabase.auth.signOut()}>
                    Sign out
                  </Button>
                </>
              )}
            </div>
          </header>

          <main className="wrap page" id="main">
            <BetaNotice />
            {phase.kind === 'loading' && <ListSkeleton />}
            {phase.kind === 'signedOut' && <Auth />}
            {signedIn && (
              <Switch id={open ? `server-${open.server_id}` : section}>
                <Suspense fallback={<ListSkeleton />}>
                {section === 'servers' &&
                  (open ? (
                    <Detail
                      row={open}
                      userId={userId ?? ''}
                      preview={Boolean(mock)}
                      control={control}
                      onBack={() => setOpenId(null)}
                    />
                  ) : live.loading && !mock ? (
                    <ListSkeleton />
                  ) : (
                    <ServerList rows={servers} error={live.error} control={control} onOpen={setOpenId} />
                  ))}
                {section === 'shop' && <Shop userId={userId ?? ''} />}
                {section === 'health' && <Health userId={userId ?? ''} />}
                {section === 'billing' && <Billing userId={userId ?? ''} />}
                {section === 'admin' && isAdmin && <Admin userId={userId ?? ''} />}
                </Suspense>
              </Switch>
            )}
          </main>

          {/* Phones: sections live under the thumb, not behind a hamburger. */}
          {signedIn && (
            <nav className="bottomnav" aria-label="Sections">
              {nav.map((s) => (
                <button
                  key={s}
                  className={`navbtn${section === s && !open ? ' on' : ''}`}
                  aria-current={section === s && !open ? 'page' : undefined}
                  onClick={() => go(s)}
                >
                  {SECTION_ICONS[s]}
                  <span>{SECTION_LABELS[s]}</span>
                </button>
              ))}
            </nav>
          )}
        </div>

        {signedIn && (
          <Palette
            open={palette}
            onClose={() => setPalette(false)}
            servers={servers}
            isAdmin={isAdmin}
            goSection={go}
            openServer={(id) => {
              setSection('servers')
              setOpenId(id)
            }}
            control={(row, action) => control(row, action)}
          />
        )}
        <Toaster position="top-center" offset={16} gap={8} />
      </div>
    </MotionRoot>
  )
}

/**
 * Shown only on the staged /next/ build: the way back for someone who followed
 * the classic panel's "try the new panel" button and wants out. Disappears at
 * cutover by construction — the cutover build's BASE_URL has no /next/.
 */
function BetaNotice(): React.JSX.Element | null {
  const [hidden, setHidden] = useState(() => localStorage.getItem('elauncher:beta-note') === '1')
  if (!import.meta.env.BASE_URL.endsWith('/next/') || hidden) return null
  return (
    <div className="beta-note rise">
      <span>
        You&rsquo;re on the <b>beta</b> panel — same account, same servers.
      </span>
      <a href="/elauncher/manage/">Use classic</a>
      <button
        className="iconbtn"
        aria-label="Dismiss beta notice"
        onClick={() => {
          localStorage.setItem('elauncher:beta-note', '1')
          setHidden(true)
        }}
      >
        <X size={14} aria-hidden />
      </button>
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
  // a server mid-transition is nobody's to command; the pill already says which
  // way it is going, so the button just waits it out
  const settling = row.state === 'starting' || row.state === 'stopping'
  // a host that stopped reporting keeps its last written state — which is a
  // claim about the past, not the present, and must not render as live
  const stale = isStale(row)
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
    <article
      className={`surface card-server${stale ? ' stale' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
    >
      <button className="card-hit" onClick={onOpen} aria-label={`Open ${row.name}`} />
      <div className="row">
        <GameBadge game={row.game} />
        <div className="card-id">
          <h2>{row.name}</h2>
          {/* the game in words, coloured to match the badge — two servers named
              the same are told apart here, which is the whole point */}
          <GameTag game={row.game} />
        </div>
        <span className="spacer" />
        {stale ? (
          <span className="pill stopped" title={`Last report ${lastSeen(row)}`}>
            <span className="dot" aria-hidden />
            Unreachable
          </span>
        ) : (
          <StatusPill state={row.state} />
        )}
      </div>
      <p className="mono dim addr">
        {stale
          ? `last seen ${lastSeen(row)} — its machine is off or signed out`
          : (row.address ?? 'no address yet')}
      </p>
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
        <Button
          size="sm"
          variant={live && !stale ? 'danger' : 'primary'}
          disabled={busy || settling || stale}
          title={stale ? 'Nothing is listening — start the launcher on that machine first' : undefined}
          onClick={press}
        >
          {busy
            ? 'Sending…'
            : stale
              ? 'Host offline'
              : settling
                ? row.state === 'starting'
                  ? 'Starting…'
                  : 'Stopping…'
                : live
                  ? 'Stop'
                  : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Console
        </Button>
      </div>
    </article>
  )
}

/**
 * Which game a card is for.
 *
 * A hosting account is a list of eight servers with names their owners chose,
 * and "Creative" says nothing about whether it is Minecraft or Valheim. The
 * initial and its hue carry that at a glance; the full name is still written out
 * next to it in the detail header, and in the title attribute here, so the
 * colour is never the only thing saying it.
 */
function GameBadge({ game, big }: { game: string | null; big?: boolean }): React.JSX.Element {
  const known = game && game in GAME_HUE
  const hue = known ? GAME_HUE[game as Game] : null
  const label = gameLabel(game)
  return (
    <span
      className={`gbadge${big ? ' big' : ''}${known ? '' : ' unknown'}`}
      title={label}
      style={hue === null ? undefined : ({ '--hue': hue } as React.CSSProperties)}
      aria-hidden
    >
      {known ? label.slice(0, 1) : '?'}
    </span>
  )
}

/** The game's name in words, tinted to its hue. The text is what a colour-blind
 *  reader relies on, so it is never abbreviated to the initial alone. */
function GameTag({ game }: { game: string | null }): React.JSX.Element {
  const known = game && game in GAME_HUE
  const hue = known ? GAME_HUE[game as Game] : null
  return (
    <span
      className={`gtag${known ? '' : ' unknown'}`}
      style={hue === null ? undefined : ({ '--hue': hue } as React.CSSProperties)}
    >
      {gameLabel(game)}
    </span>
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
  userId,
  preview,
  control,
  onBack
}: {
  row: ServerRow
  userId: string
  preview: boolean
  control: Control
  onBack: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('console')
  // rebuilt only when the server changes, because several tabs treat `ask` as a
  // dependency and a fresh identity each render would loop them
  const ask = useMemo(() => {
    // Preview data has no machine behind it. Letting the request go anyway put a
    // Postgres type error on screen in every tab — the tabs were reporting it
    // correctly, but the fixture had no business asking in the first place.
    if (preview) {
      return (() =>
        Promise.reject(new Error('Preview mode — no host is connected.'))) as ReturnType<typeof makeAsk>
    }
    return makeAsk(row, userId)
  }, [preview, row.server_id, row.owner_id, userId])
  return (
    <div className="detail rise">
      <div className="head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Servers
        </Button>
      </div>
      <div className="row detail-title">
        <GameBadge game={row.game} big />
        <div className="card-id">
          <h1>{row.name}</h1>
          <GameTag game={row.game} />
        </div>
        <span className="spacer" />
        {isStale(row) ? (
          <span className="pill stopped" title={`Last report ${lastSeen(row)}`}>
            <span className="dot" aria-hidden />
            Unreachable
          </span>
        ) : (
          <StatusPill state={row.state} />
        )}
      </div>
      {isStale(row) && (
        <p className="formnote" style={{ marginBottom: 12 }}>
          This server&rsquo;s machine hasn&rsquo;t reported since {lastSeen(row)} — the launcher
          there is closed, signed out, or the box is off. What you see below is its last known
          state, and commands will wait until it returns.
        </p>
      )}
      <Tabs tabs={TABS} value={tab} onChange={setTab} labels={TAB_LABELS} />
      <div className="tabbody">
        <Suspense fallback={<Skeleton height={320} />}>
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
        {tab === 'settings' && <Settings row={row} userId={userId} ask={ask} />}
        {tab === 'players' && <Players row={row} userId={userId} ask={ask} />}
        {tab === 'mods' && <Mods row={row} userId={userId} ask={ask} />}
        {tab === 'files' && <Files row={row} userId={userId} ask={ask} />}
        {tab === 'network' && <Network row={row} userId={userId} ask={ask} />}
        {tab === 'automation' && <Automation row={row} userId={userId} ask={ask} />}
        {tab === 'access' && <Access row={row} userId={userId} ask={ask} />}
        </Suspense>
      </div>
    </div>
  )
}

export { mockServers }
