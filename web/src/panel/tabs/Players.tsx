import { useCallback, useEffect, useRef, useState } from 'react'
import { Gavel, ListChecks, Shield, UserRoundPlus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button, EmptyState, Skeleton, Spinner, Tabs } from '@web/ui'
import { AnimatePresence, Collapse, EASE_OUT, EASE_SPRING, motion } from '@web/ui/motion'
import type { TabProps } from './types'
import './Players.css'

/**
 * Who is on the server, and what can be done about them.
 *
 * Moderation is not one feature — it is three, because the games disagree about
 * whether a server can even be told anything. Palworld answers a REST API and
 * takes kick/ban/unban/broadcast. Minecraft keeps three player files and takes
 * whitelist/op/ban edits. Valheim has no admin channel at all, and pretending
 * otherwise is how a panel earns its reputation.
 *
 * Which of the three applies used to come from a per-server `info` request that
 * is not part of this panel's action contract. So the tab asks the host two
 * questions it is allowed to ask — the Palworld player list and the Minecraft
 * roster — at the same time, and reads the answers. Only the host's own verdict
 * is trusted; nothing here guesses a game from a name or a version string.
 */

type RosterList = 'whitelist' | 'ops' | 'banned-players'

interface RosterEntry {
  name: string
  uuid?: string
}

type Roster = Record<RosterList, RosterEntry[]>

/** Live row from a Palworld server's REST API. */
interface PalPlayer {
  name?: string
  /** platform id (steam_xxx) — the handle kick and ban actually act on */
  userId?: string
  level?: number
  ping?: number
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'palworld'; players: PalPlayer[]; warning: string }
  | { kind: 'roster'; roster: Roster }
  | { kind: 'error'; message: string }

const LISTS: { key: RosterList; label: string }[] = [
  { key: 'whitelist', label: 'Whitelist' },
  { key: 'ops', label: 'Operators' },
  { key: 'banned-players', label: 'Banned' }
]

/**
 * An empty list means a different thing per file, and the difference is the
 * whole reason to say more than "empty": a bare whitelist keeps nobody out
 * until white-list is on, a bare ban list means everyone is welcome.
 */
const EMPTY_LIST: Record<RosterList, { title: string; body: string }> = {
  whitelist: {
    title: 'No one whitelisted',
    body: 'Until white-list is switched on in server.properties, everyone can join anyway. Turn it on from the Settings tab and only the names added here get in.'
  },
  ops: {
    title: 'No operators',
    body: 'Nobody can run admin commands in game. Add someone you trust by name, or press Op next to them while they are online.'
  },
  'banned-players': {
    title: 'Nobody banned',
    body: 'This list keeps no one out. Ban an online player above, or add a name here to keep them out before they ever join.'
  }
}

const LIST_ICON: Record<RosterList, React.JSX.Element> = {
  whitelist: <ListChecks size={20} />,
  ops: <Shield size={20} />,
  'banned-players': <Gavel size={20} />
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.'
}

function emptyRoster(): Roster {
  return { whitelist: [], ops: [], 'banned-players': [] }
}

/** The three lists always exist in the UI even when the host sends fewer. */
function normalise(raw: unknown): Roster {
  const source = (raw ?? {}) as Partial<Record<RosterList, unknown>>
  const out = emptyRoster()
  for (const { key } of LISTS) {
    const list = source[key]
    if (Array.isArray(list)) {
      out[key] = list
        .map((e) => e as { name?: unknown; uuid?: unknown })
        .filter((e) => typeof e.name === 'string' && e.name)
        .map((e) => ({ name: String(e.name), uuid: typeof e.uuid === 'string' ? e.uuid : undefined }))
    }
  }
  return out
}

/**
 * The host says this exactly when the game *is* Palworld but its REST API is
 * not answering, so it identifies the server rather than merely failing.
 */
function isPalworldApiDown(text: string): boolean {
  return /player list unavailable/i.test(text)
}

/** The host's refusal when a roster edit lands on a game that has no such files. */
function isMinecraftOnly(text: string): boolean {
  return /minecraft-only/i.test(text)
}

function Face({ name, head }: { name: string; head?: boolean }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span className="avatar pl-face">
      {head && !broken ? (
        // Minecraft head renders, same posture as the old panel: a service that
        // may be unreachable, falling back to the initial tile rather than a gap
        <img
          src={`https://mc-heads.net/avatar/${encodeURIComponent(name)}/52`}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        initial
      )}
    </span>
  )
}

/**
 * One breath of the online list. Players arrive and leave because the relay
 * said so, not because anyone tapped — the motion is what marks a join as
 * "just now": a join rises in, a leave fades out.
 */
function LiveRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18, ease: EASE_OUT } }}
      transition={{ duration: 0.42, ease: EASE_SPRING }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Destructive actions confirm in place rather than through window.confirm: the
 * dialog cannot name the player in the panel's own voice, and on a phone it is
 * one mis-tap away from being dismissed without anyone reading it. The commit
 * button deliberately sits at the left of the block — never on the right edge,
 * where a scrolling thumb already rests.
 */
function Confirm({
  text,
  cta,
  busy,
  onConfirm,
  onCancel
}: {
  text: string
  cta: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="formnote stack pl-confirm" role="alert">
      <span>{text}</span>
      <div className="row">
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? <Spinner /> : cta}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function Players({ row, ask }: TabProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [actionErr, setActionErr] = useState('')
  const [busy, setBusy] = useState('')

  // Palworld
  const [pending, setPending] = useState<{ action: 'kick' | 'ban'; target: string; name: string } | null>(null)
  const [broadcast, setBroadcast] = useState('')
  const [unbanId, setUnbanId] = useState('')

  // Minecraft roster
  const [active, setActive] = useState<RosterList>('whitelist')
  const [addName, setAddName] = useState('')
  const [banning, setBanning] = useState('')
  // latched once the host tells us this game keeps no such files, so the editor
  // stops offering edits that can only ever be refused
  const [rosterRefused, setRosterRefused] = useState('')

  // The shell is free to hand this tab a fresh `ask` on every render. Reading it
  // from a ref keeps that out of the effect dependencies, where it would restart
  // the probe in a loop.
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })

  // `quiet` re-reads without dropping into the skeleton: after a kick or ban the
  // row keeps its spinner until the fresh list lands, and the kicked player
  // leaves the screen the way they left the server.
  const probe = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setPhase({ kind: 'loading' })
    setActionErr('')
    // asked together rather than in turn: two rows reach the host in the same
    // tick, so identifying the game costs one round trip instead of two
    const [pal, roster] = await Promise.allSettled([
      askRef.current<PalPlayer[]>('players'),
      askRef.current<unknown>('roster')
    ])

    if (pal.status === 'fulfilled') {
      setPhase({ kind: 'palworld', players: Array.isArray(pal.value) ? pal.value : [], warning: '' })
      return
    }
    const why = msg(pal.reason)
    if (isPalworldApiDown(why)) {
      setPhase({ kind: 'palworld', players: [], warning: why })
      return
    }
    if (roster.status === 'fulfilled') {
      setPhase({ kind: 'roster', roster: normalise(roster.value) })
      return
    }
    setPhase({ kind: 'error', message: msg(roster.reason) })
  }, [])

  useEffect(() => {
    void probe()
  }, [probe, row.server_id])

  /** Resolves true only when the host accepted it, so callers know whether to clear their input. */
  async function moderate(
    action: 'kick' | 'ban' | 'unban' | 'announce',
    target: string,
    done: string
  ): Promise<boolean> {
    setBusy(action + target)
    setActionErr('')
    try {
      await askRef.current('moderate', { action, target })
      // the toast waits for the quiet re-read, so it lands on a list that
      // already agrees with what it says
      if (action === 'kick' || action === 'ban') await probe(true)
      setPending(null)
      toast.success(done)
      return true
    } catch (e) {
      setActionErr(msg(e))
      return false
    } finally {
      setBusy('')
    }
  }

  // the drafts survive a refusal — losing what someone typed because the server
  // was stopped is the wrong way to report that the server was stopped
  function sendBroadcast(): void {
    const text = broadcast.trim()
    if (!text || busy) return
    void moderate('announce', text, 'Broadcast sent.').then((ok) => {
      if (ok) setBroadcast('')
    })
  }

  function sendUnban(): void {
    const id = unbanId.trim()
    if (!id || busy) return
    void moderate('unban', id, `Ban lifted for ${id}.`).then((ok) => {
      if (ok) setUnbanId('')
    })
  }

  async function edit(list: RosterList, op: 'add' | 'remove', name: string, done: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) {
      setActionErr('Enter a player name.')
      return
    }
    setBusy(op + list + trimmed)
    setActionErr('')
    try {
      // the host answers with all three lists as they now stand, so the panel
      // never has to guess what its own edit did
      const fresh = await askRef.current<unknown>('rosterEdit', { list, op, name: trimmed })
      setPhase({ kind: 'roster', roster: normalise(fresh) })
      setActive(list)
      setAddName('')
      setBanning('')
      toast.success(done)
    } catch (e) {
      const text = msg(e)
      if (isMinecraftOnly(text)) setRosterRefused(text)
      else setActionErr(text)
    } finally {
      setBusy('')
    }
  }

  if (phase.kind === 'loading') {
    return (
      <div className="surface pad stack">
        <Skeleton height={26} width={160} />
        <Skeleton height={44} />
        <Skeleton height={44} />
        <Skeleton height={44} />
      </div>
    )
  }

  if (phase.kind === 'error') {
    return (
      <div className="surface pad stack">
        <p className="formerr" role="alert">
          {phase.message}
        </p>
        <div className="row">
          <Button size="sm" onClick={() => void probe()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  // completions go to toasts; only failures stay on the page, next to the work
  const banner = actionErr ? (
    <p className="formerr" role="alert">
      {actionErr}
    </p>
  ) : null

  if (phase.kind === 'palworld') {
    const online = phase.players.filter((p) => p.name)
    return (
      <div className="stack pl-pane">
        {banner}

        <section className="surface pad stack">
          <div className="row">
            <h2 className="pl-clip">Online now ({online.length})</h2>
            <Button size="sm" variant="ghost" onClick={() => void probe()}>
              Refresh
            </Button>
          </div>

          {phase.warning && (
            <p className="formerr" role="alert">
              {phase.warning}
            </p>
          )}

          {!phase.warning && online.length === 0 && (
            <EmptyState icon={<Users size={20} />} title="Nobody online">
              {row.state === 'running'
                ? 'The join address is on the Overview tab — anyone you send it to lands here.'
                : 'The server is stopped — start it from the Console tab before anyone can join.'}
            </EmptyState>
          )}

          <AnimatePresence initial={false}>
            {online.map((player) => {
              const name = player.name ?? ''
              const id = player.userId ?? ''
              // matched on the platform id, not the name: Palworld names are not unique
              const asked = pending !== null && id !== '' && pending.target === id
              return (
                <LiveRow key={id || name}>
                  <div className="row pl-row">
                    <Face name={name} />
                    <div className="pl-col">
                      <span className="pl-clip">{name}</span>
                      <span className="dim mono pl-sub">
                        lvl {player.level ?? '?'} · {id || 'no platform id yet'}
                      </span>
                    </div>
                    {/* kick and ban act on the platform id; without one there is
                        nothing to send, so no button is offered */}
                    {id ? (
                      <>
                        <Button
                          className="pl-act"
                          disabled={busy !== ''}
                          onClick={() => setPending({ action: 'kick', target: id, name })}
                        >
                          Kick
                        </Button>
                        <Button
                          className="pl-act"
                          variant="danger"
                          disabled={busy !== ''}
                          onClick={() => setPending({ action: 'ban', target: id, name })}
                        >
                          Ban
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {/* the question opens under the row instead of replacing it, so
                      the list never shifts and a repeat action needs no re-scroll */}
                  <Collapse open={asked}>
                    {asked && pending && (
                      <Confirm
                        text={
                          pending.action === 'ban'
                            ? `Ban ${name} (${id})? They are disconnected and cannot rejoin until unbanned.`
                            : `Kick ${name} (${id})? They can rejoin straight away.`
                        }
                        cta={pending.action === 'ban' ? 'Ban' : 'Kick'}
                        busy={busy !== ''}
                        onConfirm={() =>
                          void moderate(
                            pending.action,
                            id,
                            `${name} ${pending.action === 'ban' ? 'banned' : 'kicked'}.`
                          )
                        }
                        onCancel={() => setPending(null)}
                      />
                    )}
                  </Collapse>
                </LiveRow>
              )
            })}
          </AnimatePresence>
        </section>

        <section className="surface pad stack">
          <h2>Broadcast</h2>
          <div className="row">
            <input
              className="input"
              value={broadcast}
              placeholder="Message to everyone…"
              onChange={(e) => setBroadcast(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendBroadcast()
              }}
            />
            <Button variant="primary" disabled={!broadcast.trim() || busy !== ''} onClick={sendBroadcast}>
              {busy.startsWith('announce') ? <Spinner /> : 'Send'}
            </Button>
          </div>

          <h2>Unban</h2>
          <div className="row">
            <input
              className="input mono"
              value={unbanId}
              spellCheck={false}
              autoComplete="off"
              placeholder="steam_7656…"
              onChange={(e) => setUnbanId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendUnban()
              }}
            />
            <Button disabled={!unbanId.trim() || busy !== ''} onClick={sendUnban}>
              {busy.startsWith('unban') ? <Spinner /> : 'Unban'}
            </Button>
          </div>
          <p className="dim pl-fine">
            Bans are held by platform id, not by name, so unbanning needs the id the ban was made against.
            Every action here needs the server running.
          </p>
        </section>
      </div>
    )
  }

  const roster = phase.roster
  const list = roster[active]
  const listLabel = LISTS.find((l) => l.key === active)?.label ?? 'List'
  const online = row.state === 'running' ? row.players : []

  const listTabs = LISTS.map((entry) => entry.key)
  const listLabels = Object.fromEntries(
    LISTS.map((entry) => [entry.key, `${entry.label} · ${roster[entry.key].length}`])
  ) as Record<RosterList, string>

  return (
    <div className="stack pl-pane">
      {banner}

      <section className="surface pad stack">
        <h2>Online now ({online.length})</h2>

        {online.length === 0 && (
          <EmptyState icon={<Users size={20} />} title="Nobody online">
            {row.state === 'running'
              ? 'The join address is on the Overview tab — anyone you send it to lands here.'
              : 'The server is stopped — start it from the Console tab before anyone can join.'}
          </EmptyState>
        )}

        <AnimatePresence initial={false}>
          {online.map((name) => (
            <LiveRow key={name}>
              <div className="row pl-row">
                <Face name={name} head />
                <span className="pl-clip">{name}</span>
                {!rosterRefused && (
                  <>
                    <Button
                      className="pl-act"
                      disabled={busy !== ''}
                      onClick={() => void edit('ops', 'add', name, `${name} is now an operator.`)}
                    >
                      {busy === `addops${name}` ? <Spinner /> : 'Op'}
                    </Button>
                    <Button className="pl-act" variant="danger" disabled={busy !== ''} onClick={() => setBanning(name)}>
                      Ban
                    </Button>
                  </>
                )}
              </div>
              <Collapse open={banning === name}>
                {banning === name && (
                  <Confirm
                    text={`Ban ${name}? They are disconnected and stay out until pardoned.`}
                    cta="Ban"
                    busy={busy !== ''}
                    onConfirm={() => void edit('banned-players', 'add', name, `${name} banned.`)}
                    onCancel={() => setBanning('')}
                  />
                )}
              </Collapse>
            </LiveRow>
          ))}
        </AnimatePresence>

        <p className="dim pl-fine">
          Kicking is a console command rather than a player-file edit — send it from the Console tab.
        </p>
      </section>

      <section className="surface pad stack">
        <h2>Player lists</h2>

        {rosterRefused ? (
          <>
            <p className="formnote">{rosterRefused}</p>
            <p className="dim pl-fine">
              Games outside Minecraft handle access their own way, and some have no admin channel at all —
              Valheim has no console, so who can join is decided by the join password in Settings.
            </p>
          </>
        ) : (
          <>
            <Tabs tabs={listTabs} value={active} onChange={setActive} labels={listLabels} />

            <div className="row">
              <input
                className="input"
                value={addName}
                autoComplete="off"
                spellCheck={false}
                placeholder="PlayerName"
                aria-label={`Add a player to ${listLabel}`}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !addName.trim() || busy) return
                  void edit(active, 'add', addName, `${addName.trim()} added to ${listLabel.toLowerCase()}.`)
                }}
              />
              <Button
                variant="primary"
                disabled={!addName.trim() || busy !== ''}
                onClick={() =>
                  void edit(active, 'add', addName, `${addName.trim()} added to ${listLabel.toLowerCase()}.`)
                }
              >
                {busy === `add${active}${addName.trim()}` ? (
                  <Spinner />
                ) : (
                  <>
                    <UserRoundPlus size={16} aria-hidden /> Add
                  </>
                )}
              </Button>
            </div>

            {list.length === 0 && (
              <EmptyState icon={LIST_ICON[active]} title={EMPTY_LIST[active].title}>
                {EMPTY_LIST[active].body}
              </EmptyState>
            )}

            {list.map((entry) => (
              <div className="row pl-row" key={`${active}-${entry.name}`}>
                <Face name={entry.name} head />
                <div className="pl-col">
                  <span className="pl-clip">{entry.name}</span>
                  {entry.uuid && <span className="dim mono pl-sub">{entry.uuid}</span>}
                </div>
                {active === 'banned-players' ? (
                  // lifting a ban is the good news on this screen, so it keeps
                  // its word rather than hiding behind an icon
                  <Button
                    className="pl-act"
                    disabled={busy !== ''}
                    aria-label={`Unban ${entry.name}`}
                    onClick={() => void edit(active, 'remove', entry.name, `Ban lifted for ${entry.name}.`)}
                  >
                    {busy === `remove${active}${entry.name}` ? <Spinner /> : 'Unban'}
                  </Button>
                ) : (
                  <Button
                    className="pl-x"
                    variant="danger"
                    disabled={busy !== ''}
                    aria-label={`Remove ${entry.name} from ${listLabel.toLowerCase()}`}
                    onClick={() => void edit(active, 'remove', entry.name, `${entry.name} removed.`)}
                  >
                    {busy === `remove${active}${entry.name}` ? <Spinner /> : <X size={16} aria-hidden />}
                  </Button>
                )}
              </div>
            ))}

            <p className="dim pl-fine">
              Edits apply whether the server is running or stopped — a running server is told over its
              console, a stopped one has its <code>{active}.json</code> edited directly. These three lists
              are Minecraft&rsquo;s own; other games control access from Settings instead.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
