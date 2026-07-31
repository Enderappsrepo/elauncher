import { useEffect, useMemo, useRef, useState } from 'react'
import { Cable, Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@web/lib/supabase'
import { Button, EmptyState, Skeleton } from '@web/ui'
import { AnimatePresence, EASE_OUT, EASE_SPRING, motion } from '@web/ui/motion'
import type { TabProps } from './types'
import './Network.css'

/**
 * The ports a server needs beyond the game's own.
 *
 * Mods listen where the game does not — proximity voice chat, live web maps,
 * Bedrock crossplay — and each one needs a hole punched through the router (or
 * the firewall, on a host with a public IP of its own). ELauncher opens them
 * while the server runs and releases them when it stops.
 *
 * Rules are edited locally and saved in one go, because a save is real router
 * work: the host answers with every port's live state, so the single round trip
 * both applies the change and refreshes the lights.
 */

type Protocol = 'UDP' | 'TCP'

interface Rule {
  port: number
  protocol: Protocol
  label: string
}

/** A rule plus what the host last saw of it. */
interface Live extends Rule {
  open: boolean
  address?: string
  warning?: string
  error?: string
  /** the game's own port: shown for context, not editable here */
  main?: boolean
}

interface Preset extends Rule {
  note: string
}

interface PortsView {
  ports: Live[]
  presets: Preset[]
  /** port number -> why opening it deserves a second thought (RCON, admin APIs) */
  cautions: Record<string, string>
  /** the host's IP is public, so there is no router in the way */
  direct: boolean
  maxExtra: number
}

const keyOf = (rule: Rule): string => `${rule.protocol}:${rule.port}`
const shapeOf = (rules: Rule[]): string => JSON.stringify(rules.map((r) => [r.protocol, r.port, r.label]))
const say = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.')

/** The relay carries whatever the host serialised, so nothing here is assumed. */
function toView(raw: unknown): PortsView {
  const source = (raw ?? {}) as Record<string, unknown>
  const rule = (entry: Record<string, unknown>): Rule => ({
    port: Number(entry.port),
    protocol: entry.protocol === 'UDP' ? 'UDP' : 'TCP',
    label: String(entry.label ?? '')
  })
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : []
  return {
    ports: list(source.ports)
      .map((entry) => ({
        ...rule(entry),
        open: Boolean(entry.open),
        address: entry.address ? String(entry.address) : undefined,
        warning: entry.warning ? String(entry.warning) : undefined,
        error: entry.error ? String(entry.error) : undefined,
        main: Boolean(entry.main)
      }))
      .filter((entry) => Number.isInteger(entry.port)),
    presets: list(source.presets)
      .map((entry) => ({ ...rule(entry), note: String(entry.note ?? '') }))
      .filter((entry) => Number.isInteger(entry.port)),
    cautions: (source.cautions ?? {}) as Record<string, string>,
    direct: Boolean(source.direct),
    maxExtra: Number.isFinite(Number(source.maxExtra)) ? Number(source.maxExtra) : 8
  }
}

const extrasOf = (view: PortsView): Rule[] =>
  view.ports.filter((port) => !port.main).map(({ port, protocol, label }) => ({ port, protocol, label }))

/** Palworld is the only game with a community listing, and its settings file is
 *  the only thing a tab can ask that names the game at all. */
const isPalworld = (props: Record<string, string>): boolean =>
  'PalCaptureRate' in props || 'ServerPlayerMaxNum' in props

/**
 * Whether this server is currently listed in Palworld's community browser.
 *
 * It rides the heartbeat onto the status row — the same field the old panel put
 * a badge on — and ServerRow does not carry it. Reading the column is the
 * difference between a switch that shows the truth and one that guesses; null
 * means we could not find out, and the control says so rather than picking a
 * side.
 */
async function readListing(serverId: string): Promise<boolean | null> {
  try {
    const { data } = await supabase
      .from('server_status')
      .select('community')
      .eq('server_id', serverId)
      .maybeSingle()
    const value = (data as { community?: unknown } | null)?.community
    return typeof value === 'boolean' ? value : null
  } catch {
    // a cloud that has not run the migration has no such column
    return null
  }
}

/** TCP and UDP are categories, not prose, so they wear the panel's two accent
 *  tints instead of sitting inline in the meta line. */
function Proto({ protocol }: { protocol: Protocol }): React.JSX.Element {
  return <span className={`proto ${protocol === 'UDP' ? 'udp' : 'tcp'}`}>{protocol}</span>
}

function PortRow({
  rule,
  live,
  caution,
  onRemove
}: {
  rule: Rule
  live?: Live
  caution?: string
  onRemove?: () => void
}): React.JSX.Element {
  const tone = !live ? '' : live.open ? (live.warning ? 'warn' : 'on') : live.error ? 'bad' : ''
  const where = !live
    ? 'Not saved yet'
    : live.open
      ? live.address
        ? `Open · ${live.address}`
        : 'Open'
      : live.error
        ? 'Could not open'
        : 'Opens when the server starts'
  // whatever just happened outranks the standing caution about the port itself
  const why = live?.error ?? live?.warning ?? caution

  return (
    <div className="port">
      <div className="row">
        <span className={`port-dot ${tone}`} aria-hidden />
        <div className="port-body">
          <div className="port-name">{rule.label}</div>
          <div className="port-meta">
            <Proto protocol={rule.protocol} />
            <span className="mono">{rule.port}</span>
            <span className="mono">· {where}</span>
          </div>
        </div>
        {onRemove && (
          <Button variant="danger" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      {why && <p className={live?.error ? 'formerr port-why' : 'formnote port-why'}>{why}</p>}
    </div>
  )
}

export function Network({ row, userId, ask }: TabProps): React.JSX.Element {
  const [view, setView] = useState<PortsView | null>(null)
  const [draft, setDraft] = useState<Rule[]>([])
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [label, setLabel] = useState('')
  const [protocol, setProtocol] = useState<Protocol>('UDP')
  const [port, setPort] = useState('')
  const [addError, setAddError] = useState('')

  const [palworld, setPalworld] = useState(false)
  const [listed, setListed] = useState<boolean | null>(null)
  const [listingBusy, setListingBusy] = useState(false)
  const [listingError, setListingError] = useState('')

  // Minecraft's game port is a single value, so it can be moved on its own; this
  // is the inline editor for it, kept apart from the extra-ports draft below
  const [editingPort, setEditingPort] = useState(false)
  const [portDraft, setPortDraft] = useState('')
  const [portBusy, setPortBusy] = useState(false)
  const [portError, setPortError] = useState('')

  const labelRef = useRef<HTMLInputElement>(null)

  // makeAsk hands out a fresh closure for every render of the shell, so the load
  // is keyed on the server it is about rather than on the function's identity —
  // otherwise a parent that rebuilds `ask` inline would refetch forever
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })

  useEffect(() => {
    let alive = true
    setView(null)
    setLoadError('')
    setSaveError('')
    void (async () => {
      try {
        // the game question rides along with the ports: the community listing
        // below exists only for Palworld, and a failed answer simply hides it
        const [ports, isPal, listing] = await Promise.all([
          askRef.current<unknown>('ports'),
          askRef.current<Record<string, string>>('getProps').then(isPalworld, () => false),
          readListing(row.server_id)
        ])
        if (!alive) return
        const next = toView(ports)
        setView(next)
        setDraft(extrasOf(next))
        setPalworld(isPal)
        setListed(listing)
      } catch (e) {
        if (alive) setLoadError(say(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [row.server_id, userId, attempt])

  const savedShape = useMemo(() => (view ? shapeOf(extrasOf(view)) : ''), [view])
  const changed = view !== null && shapeOf(draft) !== savedShape

  if (loadError) {
    return (
      <div className="surface pad stack">
        <p className="formerr" role="alert">
          {loadError}
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="stack">
        <Skeleton height={96} />
        <Skeleton height={180} />
        <Skeleton height={140} />
      </div>
    )
  }

  const live = new Map(view.ports.map((entry) => [keyOf(entry), entry]))
  // the game's own block: its port plus per-game neighbors (query ports, ARK's
  // raw socket) — newer hosts send them all, older ones just the game port
  const mains = view.ports.filter((entry) => entry.main)
  // Minecraft's single game port — the one the editor below moves (undefined if a
  // host reported no game port at all)
  const gamePort = mains[0]
  // whether this server takes the jar mods the presets used to assume; null
  // game = a host from before the column, which only ever ran Minecraft
  const modded = row.game === null || row.game === 'minecraft'
  const used = new Set(draft.map(keyOf))
  // clamped: a host that lowered its ceiling must not put "-1 left" on screen
  const left = Math.max(0, view.maxExtra - draft.length)
  const full = draft.length >= view.maxExtra

  function add(rule: Rule): void {
    setAddError('')
    setDraft((prev) => [...prev, rule])
  }

  function addTyped(): void {
    const wanted = Number(port)
    if (!Number.isInteger(wanted) || wanted < 1024 || wanted > 65535) {
      setAddError('Enter a port between 1024 and 65535 — anything lower belongs to system services.')
      return
    }
    const rule: Rule = { port: wanted, protocol, label: label.trim() || `Port ${wanted}` }
    if (used.has(keyOf(rule))) {
      setAddError('That port is already on the list.')
      return
    }
    if (mains.some((entry) => keyOf(entry) === keyOf(rule))) {
      setAddError("That is one of this server's own game ports, which are already open while it runs.")
      return
    }
    add(rule)
    setLabel('')
    setPort('')
  }

  function remove(index: number): void {
    setDraft((prev) => prev.filter((_, at) => at !== index))
  }

  /** The empty state's one action: put the caret where a port gets described. */
  function focusAdd(): void {
    labelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    labelRef.current?.focus({ preventScroll: true })
  }

  function beginEditPort(): void {
    if (!gamePort) return
    setPortDraft(String(gamePort.port))
    setPortError('')
    setEditingPort(true)
  }

  /**
   * Move the game port. The host does the real checks — range, the blocklist,
   * every other server's ports — so this only catches the obvious before spending
   * a round trip, and touches `view` alone so an in-progress extra-ports draft
   * survives the change.
   */
  async function saveMainPort(): Promise<void> {
    if (!gamePort) return
    const wanted = Number(portDraft)
    if (!Number.isInteger(wanted) || wanted < 1024 || wanted > 65535) {
      setPortError('Enter a port between 1024 and 65535 — anything lower belongs to system services.')
      return
    }
    if (wanted === gamePort.port) {
      setEditingPort(false)
      return
    }
    setPortBusy(true)
    setPortError('')
    try {
      setView(toView(await askRef.current<unknown>('setMainPort', { port: wanted })))
      setEditingPort(false)
      toast.success(`Port changed to ${wanted} — restart the server for players to use the new address.`)
    } catch (e) {
      setPortError(say(e))
    } finally {
      setPortBusy(false)
    }
  }

  /** The truthful version of "saved": while the server runs the save IS the
   *  apply — the host answers with live state — and while it is stopped the
   *  holes wait for the next start. */
  function savedWord(fresh: PortsView): string {
    const gate = fresh.direct ? 'firewall' : 'router'
    return row.state === 'running'
      ? `Ports saved — the ${gate} is applying them now.`
      : `Ports saved — the ${gate} opens them on the next start.`
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError('')
    const startedAt = Date.now()
    try {
      const next = toView(await askRef.current<unknown>('setPorts', { ports: draft }))
      setView(next)
      setDraft(extrasOf(next))
      toast.success(savedWord(next))
    } catch (e) {
      // Mapping a port is real router work and can outlast the relay's window
      // while still succeeding. Re-reading is the difference between "did that
      // land?" and knowing — and it only costs a round trip on a request that
      // ran long, never on one the host rejected outright.
      if (Date.now() - startedAt > 20_000) {
        const settled = await askRef.current<unknown>('ports').then(toView, () => null)
        if (settled && shapeOf(extrasOf(settled)) === shapeOf(draft)) {
          setView(settled)
          setDraft(extrasOf(settled))
          toast.success('Ports saved — the router took a while to answer.')
          return
        }
      }
      setSaveError(say(e))
    } finally {
      setSaving(false)
    }
  }

  async function refresh(): Promise<void> {
    setSaving(true)
    setSaveError('')
    try {
      const next = toView(await askRef.current<unknown>('ports'))
      setView(next)
      setDraft(extrasOf(next))
    } catch (e) {
      setSaveError(say(e))
    } finally {
      setSaving(false)
    }
  }

  async function setListing(on: boolean): Promise<void> {
    setListingBusy(true)
    setListingError('')
    try {
      await askRef.current('setCommunity', { on })
      setListed(on)
      toast.success(
        on ? 'Listed — the community browser shows it after the next restart.' : 'Delisted — applies on the next restart.'
      )
    } catch (e) {
      setListingError(say(e))
    } finally {
      setListingBusy(false)
    }
  }

  return (
    <div className="stack net">
      <section className="surface pad stack">
        <h2>The game&apos;s own {mains.length > 1 ? 'ports' : 'port'}</h2>
        {mains.length > 1 && (
          <p className="dim">
            This game listens on more than one port — server browsers and joins need the whole set, so
            ELauncher opens and releases them together with the game port.
          </p>
        )}
        {mains.length > 0 ? (
          mains.map((entry) => (
            <PortRow key={keyOf(entry)} rule={entry} live={entry} caution={view.cautions[String(entry.port)]} />
          ))
        ) : (
          <p className="dim">This host did not report a game port for this server.</p>
        )}

        {/* Minecraft's game port has no query/RCON neighbors, so it can be moved on
            its own — the one game where the panel offers it. */}
        {modded && gamePort &&
          (editingPort ? (
            <div className="stack">
              <p className="dim">
                Players connect on this port. Changing it means everyone reconnects using the new
                address, and it takes effect the next time the server starts.
              </p>
              <div className="row net-portedit">
                <input
                  className="input"
                  type="number"
                  min="1024"
                  max="65535"
                  value={portDraft}
                  disabled={portBusy}
                  aria-label="New game port"
                  onChange={(e) => setPortDraft(e.target.value)}
                />
                <Button variant="primary" disabled={portBusy} onClick={() => void saveMainPort()}>
                  {portBusy ? 'Working…' : 'Save port'}
                </Button>
                <Button variant="ghost" disabled={portBusy} onClick={() => setEditingPort(false)}>
                  Cancel
                </Button>
              </div>
              {portError && (
                <p className="formerr" role="alert">
                  {portError}
                </p>
              )}
            </div>
          ) : (
            <div className="row">
              <Button onClick={beginEditPort}>Change port</Button>
            </div>
          ))}
      </section>

      <section className="surface pad stack">
        <h2>{modded ? 'Ports your mods need' : 'Extra ports'}</h2>
        {draft.length === 0 ? (
          <EmptyState
            icon={<Cable size={20} />}
            title="No extra ports"
            action={
              <Button variant="primary" onClick={focusAdd}>
                <Plus size={16} aria-hidden /> Add a port
              </Button>
            }
          >
            {modded
              ? 'Mods that listen on a port of their own — voice chat, web maps, crossplay — get their hole '
              : 'Anything that listens beside the game — admin tools, web panels — gets its hole '}
            {view.direct ? 'opened in the firewall' : 'punched through the router'} here while this server runs.
          </EmptyState>
        ) : (
          <>
            <p className="dim">
              {modded
                ? 'Some mods listen on a port of their own — proximity voice chat, live web maps, Bedrock crossplay. '
                : 'Some things listen on a port beside the game’s own — admin tools, web panels. '}
              {view.direct
                ? 'This host has a public IP of its own, so there is no router to configure — ELauncher opens each port in the firewall while this server runs.'
                : 'ELauncher opens these on the router while this server runs and releases them when it stops.'}
            </p>
            {/* the divider lives on the motion wrapper rather than the row, so a
                row can fade out without its border flashing out of order */}
            <AnimatePresence initial={false}>
              {draft.map((rule, index) => (
                <motion.div
                  key={keyOf(rule)}
                  className="port-slot"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } }}
                  transition={{ duration: 0.38, ease: EASE_SPRING }}
                >
                  <PortRow
                    rule={rule}
                    live={live.get(keyOf(rule))}
                    caution={view.cautions[String(rule.port)]}
                    onRemove={() => remove(index)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </>
        )}
      </section>

      <section className="surface pad stack">
        <div className="row">
          <h2 className="net-grow">Add a port</h2>
          {/* the budget stays on screen, so hitting the ceiling is never a surprise */}
          <span className="dim mono net-left">
            {left} of {view.maxExtra} left
          </span>
        </div>
        {/* Each preset carries what the mod is and why it needs its own port.
            That note is the whole reason the list is worth having, so it is on
            the card rather than in a tooltip nobody on a phone can reach. */}
        {view.presets.length > 0 && (
          <div className="port-presets">
            {view.presets.map((preset) => {
              const taken = used.has(keyOf(preset))
              return (
                <Button
                  key={keyOf(preset)}
                  className="port-preset"
                  disabled={taken || full}
                  onClick={() => add({ port: preset.port, protocol: preset.protocol, label: preset.label })}
                >
                  <span className="row port-preset-top">
                    {taken ? <Check size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
                    <span className="port-name">{preset.label}</span>
                    <Proto protocol={preset.protocol} />
                    <span className="mono dim">{preset.port}</span>
                  </span>
                  <span className="port-note">{preset.note}</span>
                </Button>
              )
            })}
          </div>
        )}
        {view.presets.length > 0 && <p className="dim net-or">Not on the list? Describe it yourself:</p>}
        <div className="port-new">
          <input
            ref={labelRef}
            className="input"
            value={label}
            disabled={full}
            placeholder="What needs it — e.g. Simple Voice Chat"
            onChange={(e) => setLabel(e.target.value)}
          />
          <select
            className="input"
            value={protocol}
            disabled={full}
            aria-label="Protocol"
            onChange={(e) => setProtocol(e.target.value === 'TCP' ? 'TCP' : 'UDP')}
          >
            <option value="UDP">UDP</option>
            <option value="TCP">TCP</option>
          </select>
          <input
            className="input"
            type="number"
            min="1024"
            max="65535"
            value={port}
            disabled={full}
            placeholder="Port"
            aria-label="Port number"
            onChange={(e) => setPort(e.target.value)}
          />
          <Button variant="primary" disabled={full} onClick={addTyped}>
            Add
          </Button>
        </div>
        {addError && (
          <p className="formerr" role="alert">
            {addError}
          </p>
        )}
        {full && (
          <p className="formnote">
            That is the maximum of {view.maxExtra} extra ports. Remove one to add another.
          </p>
        )}
      </section>

      {/* Palworld's community listing is a launch flag rather than a setting in
          the ini, which is why it lives beside the ports and not in Settings. */}
      {palworld && (
        <section className="surface pad stack">
          <h2>Community server browser</h2>
          <p className="dim">
            Players can find and join a listed server straight from Palworld&apos;s in-game list, with no address
            to type. The host announces its public address itself
            {mains.length > 0 ? `, so UDP port ${mains[0].port} has to be reachable` : ''}. Applies on the next restart.
          </p>
          <div className="row port-choice">
            <Button
              variant={listed === true ? 'primary' : undefined}
              aria-pressed={listed === true}
              disabled={listingBusy || listed === true}
              onClick={() => setListing(true)}
            >
              Listed
            </Button>
            <Button
              variant={listed === false ? 'primary' : undefined}
              aria-pressed={listed === false}
              disabled={listingBusy || listed === false}
              onClick={() => setListing(false)}
            >
              Private
            </Button>
            <span className="dim">
              {listed === null
                ? 'This panel cannot read the current setting — pick the one you want.'
                : listed
                  ? 'Currently listed.'
                  : 'Currently private.'}
            </span>
          </div>
          {listingError && (
            <p className="formerr" role="alert">
              {listingError}
            </p>
          )}
        </section>
      )}

      {/* The dock rides the bottom of the screen: on a phone the save button
          belongs under the thumb, not below however many rules were added.
          Success speaks through a toast; only failure stays pinned here. */}
      <div className="port-dock">
        {saveError && (
          <p className="formerr" role="alert">
            {saveError}
          </p>
        )}
        <div className="row">
          <Button variant="ghost" disabled={saving} onClick={refresh}>
            {changed ? 'Discard changes' : 'Refresh'}
          </Button>
          <span className="spacer" />
          <Button variant="primary" disabled={saving || !changed} onClick={save}>
            {saving ? 'Working…' : 'Save ports'}
          </Button>
        </div>
      </div>
    </div>
  )
}
