import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PlanLimits, ServerAutomation, ServerGame, ServerKind } from '@shared/types'
import { Button, Console, Skeleton } from '@web/ui'
import type { TabProps } from './types'
import './Automation.css'

/**
 * Automation tab: the schedules that run on the host without anyone watching,
 * the console scrollback the heartbeat is too small to carry, and the one
 * control on this screen that destroys a world.
 *
 * The through-line is that a schedule nobody can verify is worse than no
 * schedule at all, so every setting here either says when it next fires or says
 * plainly that it will do nothing for this game.
 */

/** `info`, narrowed to the fields this tab acts on. */
interface ServerInfo {
  game: ServerGame
  kind: ServerKind
  minecraftVersion: string
  automation: ServerAutomation
  /** the asker is the host account or an admin, so the plan clamps do not apply */
  owner: boolean
  limits: PlanLimits | null
}

/** One page of the host's log buffer, oldest-first, as `logs` returns it. */
interface LogPage {
  lines: string[]
  /** index this page starts at, for asking for the page above it */
  start: number
  total: number
  atStart: boolean
}

const LOG_PAGE = 300

const SAVE_MINUTES: { value: number; label: string }[] = [
  { value: 0, label: 'never automatically' },
  { value: 5, label: 'every 5 minutes' },
  { value: 10, label: 'every 10 minutes' },
  { value: 15, label: 'every 15 minutes' },
  { value: 30, label: 'every 30 minutes' },
  { value: 60, label: 'every hour' }
]

const BACKUP_HOURS: { value: number; label: string }[] = [
  { value: 0, label: 'never' },
  { value: 1, label: 'hourly' },
  { value: 3, label: 'every 3 hours' },
  { value: 6, label: 'every 6 hours' },
  { value: 12, label: 'every 12 hours' },
  { value: 24, label: 'daily' }
]

const BACKUP_KEEP = [3, 5, 10, 20]

const MEMORY_LIMITS: { value: number; label: string }[] = [
  { value: 0, label: 'never — off' },
  { value: 4096, label: '4 GB' },
  { value: 8192, label: '8 GB' },
  { value: 12288, label: '12 GB' },
  { value: 16384, label: '16 GB' }
]

const LOADERS: ServerKind[] = ['paper', 'vanilla', 'fabric', 'neoforge', 'forge']

/** Recent releases, so a rebuild still has something to offer when Mojang is unreachable. */
const MC_FALLBACK = ['1.21.4', '1.21.1', '1.20.1']

async function releaseVersions(): Promise<string[]> {
  try {
    const res = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    const manifest = (await res.json()) as { versions: { id: string; type: string }[] }
    return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id).slice(0, 40)
  } catch {
    return MC_FALLBACK
  }
}

/**
 * When the next scheduled restart actually lands.
 *
 * The schedule is computable, and not showing it is the whole reason these
 * settings used to feel like guesswork.
 */
function nextRestartAt(auto: ServerAutomation, startedAt: string | null): Date | null {
  const mode = auto.restartMode ?? 'off'
  if (mode === 'off') return null
  if (mode === 'daily') {
    const [h, m] = String(auto.restartDailyAt ?? '04:00').split(':').map(Number)
    const next = new Date()
    next.setHours(h || 0, m || 0, 0, 0)
    if (next <= new Date()) next.setDate(next.getDate() + 1)
    return next
  }
  const hours = Math.max(1, Number(auto.restartEveryHours) || 6)
  // the timer is armed when the server reaches 'running', so it counts from there
  const base = startedAt ? new Date(startedAt).getTime() : Date.now()
  let next = base + hours * 3_600_000
  while (next <= Date.now()) next += hours * 3_600_000
  return new Date(next)
}

function inWords(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

function Note({ tone, children }: { tone?: 'warn'; children: ReactNode }): React.JSX.Element {
  return <p className={tone === 'warn' ? 'formnote auto-warn' : 'formnote'}>{children}</p>
}

function Group({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="surface pad stack auto-group">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Picker({
  id,
  label,
  value,
  options,
  onChange
}: {
  id: string
  label: string
  value: number
  options: { value: number; label: string }[]
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function Check({
  id,
  checked,
  onChange,
  children
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="auto-check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{children}</label>
    </div>
  )
}

export function Automation({ row, userId, ask }: TabProps): React.JSX.Element {
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState('')

  const [auto, setAuto] = useState<ServerAutomation>({})
  /** the last state the host confirmed, serialised — what "unsaved" is measured against */
  const [saved, setSaved] = useState('{}')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState('')
  const [savedNote, setSavedNote] = useState('')

  // Nothing guarantees the shell hands down a stable `ask`, and an identity that
  // changes every render would turn the load below into an endless relay loop.
  const askRef = useRef(ask)
  askRef.current = ask

  useEffect(() => {
    let alive = true
    setInfo(null)
    setLoadFailed('')
    askRef
      .current<ServerInfo>('info')
      .then((res) => {
        if (!alive) return
        const current = res.automation ?? {}
        setInfo(res)
        setAuto(current)
        setSaved(JSON.stringify(current))
      })
      .catch((e: unknown) => {
        if (alive) setLoadFailed(e instanceof Error ? e.message : 'Could not read this server.')
      })
    return () => {
      alive = false
    }
  }, [row.server_id])

  if (loadFailed) {
    return (
      <p className="formerr" role="alert">
        {loadFailed}
      </p>
    )
  }

  if (!info) {
    return (
      <div className="stack">
        <Skeleton height={188} />
        <Skeleton height={232} />
        <Skeleton height={196} />
      </div>
    )
  }

  const patch = (change: Partial<ServerAutomation>): void => {
    setAuto((a) => ({ ...a, ...change }))
    setSavedNote('')
    setSaveFailed('')
  }

  const dirty = JSON.stringify(auto) !== saved

  async function save(): Promise<void> {
    setSaving(true)
    setSaveFailed('')
    setSavedNote('')
    try {
      // the host replaces the record with exactly this object, which is safe only
      // because it started life as the one the host handed back
      await ask('setAutomation', { automation: auto })
      setSaved(JSON.stringify(auto))
      setSavedNote('Saved. Timers re-arm now if the server is running, otherwise on its next start.')
    } catch (e) {
      setSaveFailed(e instanceof Error ? e.message : 'Could not save that.')
    } finally {
      setSaving(false)
    }
  }

  const mode = auto.restartMode ?? 'off'
  // the host warns for at least a minute whatever is stored, so show what it does
  const warnMin = Math.max(1, auto.restartWarningMin ?? 5)
  const when = nextRestartAt(auto, row.state === 'running' ? row.started_at : null)
  const running = row.state === 'running'

  // sampling covers Windows and Linux, so a running server with no reading is
  // either seconds old or on a launcher build too old to report one
  const memoryBlind = running && row.memory_mb === null
  // hosted, non-Minecraft servers have the guard pinned to the plan's RAM ceiling
  // on the way in — the picker below cannot lift it and cannot switch it off
  const memoryPinned = !info.owner && info.game !== 'minecraft' ? (info.limits?.memoryMb ?? 0) : 0

  return (
    <div className="stack autopane">
      <Group title="Keeping the world safe">
        <Picker
          id="auto-save"
          label="Save the world"
          value={auto.saveIntervalMin ?? 0}
          options={SAVE_MINUTES}
          onChange={(v) => patch({ saveIntervalMin: v })}
        />
        {info.game === 'valheim' && (
          <Note tone="warn">
            Valheim ships no console, so there is no save command to send — this setting has no effect for it. The
            server still saves on its own schedule and on shutdown.
          </Note>
        )}
        <Picker
          id="auto-backup"
          label="Back up the world"
          value={auto.backupIntervalHours ?? 0}
          options={BACKUP_HOURS}
          onChange={(v) => patch({ backupIntervalHours: v })}
        />
        {(auto.backupIntervalHours ?? 0) > 0 && (
          <Picker
            id="auto-keep"
            label="And keep"
            value={auto.backupKeep ?? 5}
            options={BACKUP_KEEP.map((k) => ({ value: k, label: `${k} of them` }))}
            onChange={(v) => patch({ backupKeep: v })}
          />
        )}
        <Note>
          Backups are folder copies under <code>backups/</code>, not zips — fast, but they take real disk. Keep fewer
          if space is tight.
        </Note>
      </Group>

      <Group title="Restarts">
        <div className="field">
          <label htmlFor="auto-mode">Restart this server</label>
          <select
            id="auto-mode"
            className="input"
            value={mode}
            onChange={(e) => {
              const next = e.target.value as ServerAutomation['restartMode']
              if (next === 'interval') patch({ restartMode: 'interval', restartEveryHours: auto.restartEveryHours ?? 6 })
              else if (next === 'daily') patch({ restartMode: 'daily', restartDailyAt: auto.restartDailyAt ?? '04:00' })
              else patch({ restartMode: 'off' })
            }}
          >
            <option value="off">never</option>
            <option value="interval">on a repeating timer</option>
            <option value="daily">at the same time daily</option>
          </select>
        </div>

        {mode === 'interval' && (
          <div className="field">
            <label htmlFor="auto-every">Every … hours</label>
            <input
              id="auto-every"
              className="input"
              type="number"
              min={1}
              max={168}
              value={auto.restartEveryHours ?? 6}
              onChange={(e) => patch({ restartEveryHours: Math.min(168, Math.max(1, Number(e.target.value) || 6)) })}
            />
          </div>
        )}

        {mode === 'daily' && (
          <div className="field">
            <label htmlFor="auto-at">At</label>
            <input
              id="auto-at"
              className="input"
              type="time"
              value={auto.restartDailyAt ?? '04:00'}
              onChange={(e) => patch({ restartDailyAt: e.target.value || '04:00' })}
            />
          </div>
        )}

        {mode !== 'off' && (
          <>
            <div className="field">
              <label htmlFor="auto-warn">Warn players … minutes first</label>
              <input
                id="auto-warn"
                className="input"
                type="number"
                min={1}
                max={60}
                value={warnMin}
                onChange={(e) => patch({ restartWarningMin: Math.min(60, Math.max(1, Number(e.target.value) || 5)) })}
              />
            </div>
            {when && (
              <Note>
                <b>Next restart {when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b>
                {running ? ` · in ${inWords(when.getTime() - Date.now())}` : ''} · players warned {warnMin} min before
                {running ? '' : ' · timers only run while the server is running, so this starts counting once it is up'}
              </Note>
            )}
          </>
        )}
      </Group>

      <Group title="Safety nets">
        <Picker
          id="auto-mem"
          label="Restart if memory goes above"
          value={auto.restartAboveMemoryMB ?? 0}
          options={MEMORY_LIMITS}
          onChange={(v) => patch({ restartAboveMemoryMB: v })}
        />
        {memoryPinned > 0 && (
          <Note tone="warn">
            This server is capped at {(memoryPinned / 1024).toFixed(1)} GB by its plan, and the host pins the guard to
            that ceiling on every save — a higher pick, or “never”, is written back down to it.
          </Note>
        )}
        {memoryBlind && (
          <Note tone="warn">
            This host is not reporting per-server memory yet, so the guard has nothing to act on. It saves fine —
            readings appear within about ten seconds of a start, and if one never does, the host is on an older
            launcher build and needs updating.
          </Note>
        )}
        <Check
          id="auto-crash"
          checked={Boolean(auto.restartOnCrash)}
          onChange={(v) => patch({ restartOnCrash: v })}
        >
          Restart automatically after a crash
        </Check>
        <Note>
          A crash within 90 seconds of starting is treated as a failed start, not a crash, so a broken server cannot
          restart-loop.
        </Note>
        <Check id="auto-boot" checked={Boolean(auto.autoStart)} onChange={(v) => patch({ autoStart: v })}>
          Start this server when the launcher opens
        </Check>
        {row.owner_id !== userId && (
          <Note>That is the launcher on the machine hosting this server, not anything you have to run.</Note>
        )}
      </Group>

      {saveFailed && (
        <p className="formerr" role="alert">
          {saveFailed}
        </p>
      )}
      {savedNote && <Note>{savedNote}</Note>}
      <Button variant="primary" block disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? 'Saving…' : dirty ? 'Save automation' : 'Saved'}
      </Button>

      <Scrollback ask={ask} serverId={row.server_id} />

      {info.game === 'minecraft' && <Rebuild ask={ask} info={info} name={row.name} />}
    </div>
  )
}

/**
 * Earlier console output.
 *
 * The heartbeat carries an 80-line tail because it is written every five seconds
 * for every server on the box; the host keeps a thousand. This is where the rest
 * of it lives, and it is loaded on request rather than on open — a crash you are
 * reading about happened once, and paying for the fetch every time anyone
 * glances at this tab is not worth it.
 */
function Scrollback({ ask, serverId }: { ask: TabProps['ask']; serverId: string }): React.JSX.Element {
  const [lines, setLines] = useState<string[] | null>(null)
  const [start, setStart] = useState<number | null>(null)
  const [atStart, setAtStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  const box = useRef<HTMLDivElement>(null)
  /** distance from the bottom to hold still across a prepend */
  const anchor = useRef<number | null>(null)

  useEffect(() => {
    // a different server's scrollback is a different log entirely
    setLines(null)
    setStart(null)
    setAtStart(false)
    setFailed('')
  }, [serverId])

  // Console pins itself to the newest line, which is right for a live tail and
  // exactly wrong the moment someone asks for the lines above it: the page they
  // just waited for would scroll straight past them.
  useLayoutEffect(() => {
    const log = box.current?.querySelector<HTMLElement>('.console-log')
    if (!log || anchor.current === null) return
    log.scrollTop = log.scrollHeight - anchor.current
    anchor.current = null
  }, [lines])

  async function loadEarlier(): Promise<void> {
    if (busy || atStart) return
    const log = box.current?.querySelector<HTMLElement>('.console-log')
    if (log) anchor.current = log.scrollHeight - log.scrollTop
    setBusy(true)
    setFailed('')
    try {
      const page = await ask<LogPage>('logs', start === null ? { lines: LOG_PAGE } : { lines: LOG_PAGE, before: start })
      const older = page.lines ?? []
      setLines((have) => (have === null ? older : older.concat(have)))
      setStart(page.start ?? 0)
      setAtStart(Boolean(page.atStart))
    } catch (e) {
      anchor.current = null
      setFailed(e instanceof Error ? e.message : 'Could not read the log.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="surface pad stack auto-group">
      <h2>Earlier console output</h2>
      <p className="dim">
        The Console tab shows the live tail. This reaches back through the thousand lines the host keeps, which is
        usually far enough to find what a crash said on its way down.
      </p>
      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}
      {lines === null ? (
        <Button block disabled={busy} onClick={() => void loadEarlier()}>
          {busy ? 'Reading the log…' : 'Load earlier output'}
        </Button>
      ) : lines.length === 0 ? (
        <p className="dim">This server has written nothing to its log yet.</p>
      ) : (
        <div ref={box}>
          <Console text={lines.join('\n')}>
            <span className="dim auto-logcount">
              {lines.length} lines{atStart ? ' · start of the buffer' : ''}
            </span>
            <Button size="sm" disabled={busy || atStart} onClick={() => void loadEarlier()}>
              {busy ? 'Loading…' : atStart ? 'Nothing earlier' : 'Load earlier'}
            </Button>
          </Console>
        </div>
      )}
    </section>
  )
}

/**
 * Rebuild.
 *
 * Minecraft only, and not out of caution: the host wipes the folder and installs
 * a Minecraft server into it, so running this against a Valheim or Palworld
 * server would destroy one game and leave another in its place.
 */
function Rebuild({
  ask,
  info,
  name
}: {
  ask: TabProps['ask']
  info: ServerInfo
  name: string
}): React.JSX.Element {
  const [loader, setLoader] = useState<ServerKind>(info.kind)
  const [version, setVersion] = useState(info.minecraftVersion)
  const [versions, setVersions] = useState<string[] | null>(null)
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    let alive = true
    void releaseVersions().then((list) => {
      if (!alive) return
      // the version it is on now may be older than the window the manifest gives
      setVersions(list.includes(info.minecraftVersion) ? list : [info.minecraftVersion, ...list])
    })
    return () => {
      alive = false
    }
  }, [info.minecraftVersion])

  async function rebuild(): Promise<void> {
    setBusy(true)
    setFailed('')
    const sentAt = Date.now()
    try {
      await ask('rebuild', { loader, version })
      setDone(`Rebuilt as ${loader} ${version} — it is starting fresh.`)
      setArming(false)
      setTyped('')
    } catch (e) {
      // A rebuild downloads a server and takes minutes; the relay stops waiting
      // after twenty seconds. The host does not stop with it, so a timeout here
      // means "no answer yet", never "nothing happened".
      setFailed(
        Date.now() - sentAt > 20_000
          ? 'The panel stopped waiting, but the host has not stopped working — a rebuild takes several minutes. Watch the console for progress. If the launcher is offline, nothing was changed.'
          : e instanceof Error
            ? e.message
            : 'Could not start the rebuild.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="surface pad stack auto-danger">
      <h2>Change loader and version</h2>
      <p className="auto-danger-lead">
        Rebuilding deletes the world, the mods, and every other file on this server, then installs a fresh one. There
        is no undo and no backup is taken.
      </p>

      <div className="field">
        <label htmlFor="rb-loader">Loader</label>
        <select
          id="rb-loader"
          className="input"
          value={loader}
          onChange={(e) => {
            setLoader(e.target.value as ServerKind)
            setArming(false)
          }}
        >
          {LOADERS.map((k) => (
            <option key={k} value={k}>
              {k[0].toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="rb-version">Version</label>
        <select
          id="rb-version"
          className="input"
          value={version}
          disabled={versions === null}
          onChange={(e) => {
            setVersion(e.target.value)
            setArming(false)
          }}
        >
          {(versions ?? [info.minecraftVersion]).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}
      {done && <Note>{done}</Note>}

      {!arming ? (
        // Rebuilding to the same loader and version is not a no-op — it is how a
        // server that has been broken beyond repair gets put back — so it stays
        // available and the label says what it really is.
        <Button
          variant="danger"
          block
          onClick={() => {
            setArming(true)
            setFailed('')
            setDone('')
          }}
        >
          {loader === info.kind && version === info.minecraftVersion
            ? `Reinstall ${loader} ${version} from scratch…`
            : `Rebuild as ${loader} ${version}…`}
        </Button>
      ) : (
        <div className="stack auto-confirm">
          <p>
            <b>“{name}”</b> becomes a fresh {loader} {version} server. Its world, its {info.kind} setup, its mods, its
            server.properties and everything anyone has built are deleted from the host first. Players are not warned
            and the server is stopped to do it.
          </p>
          <div className="field">
            <label htmlFor="rb-confirm">Type REBUILD to confirm</label>
            <input
              id="rb-confirm"
              className="input"
              value={typed}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <Button variant="danger" block disabled={busy || typed.trim() !== 'REBUILD'} onClick={() => void rebuild()}>
            {busy ? 'Rebuilding…' : 'Delete every file and rebuild'}
          </Button>
          <Button
            variant="ghost"
            block
            disabled={busy}
            onClick={() => {
              setArming(false)
              setTyped('')
            }}
          >
            Keep the server as it is
          </Button>
        </div>
      )}
    </section>
  )
}
