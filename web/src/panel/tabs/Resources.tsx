import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { PlanLimits, ServerGame } from '@shared/types'
import { Button, Skeleton, Spinner } from '@web/ui'
import { AnimatePresence, Collapse, EASE_OUT, EASE_SPRING, motion, staggerChild, staggerParent } from '@web/ui/motion'
import type { TabProps } from './types'
import './Resources.css'

/**
 * Resources tab: the RAM and CPU an operator hands a single server, above or
 * below whatever its plan includes.
 *
 * This is an admin lift, not a customer control — the host gates `setLimits`
 * behind is_admin (and the owner of the box), so the panel only ever offers this
 * tab to an admin, and the database re-checks anyway. The override lives apart
 * from the plan on purpose: the provisioner reconciles a server's plan caps every
 * minute, so a bump written into the plan would be reverted within one. Written
 * as an override, it survives and wins, field by field, until it is cleared.
 *
 * What the two numbers actually do depends on the game and the host's OS, and the
 * notes under each control say so rather than implying a uniform hard cap that
 * only Linux + Java can deliver.
 */

/** `info`, narrowed to the fields this tab reads and writes. */
interface ResourceInfo {
  game: ServerGame
  /** Minecraft heap in MiB; 0 for games that size their own memory */
  memoryMax: number
  /** the caps in force = plan merged with any override */
  limits: PlanLimits | null
  /** the plan's own caps, the baseline an override lifts from */
  limitsPlan: PlanLimits | null
  /** the admin lift over the plan, per field — null/empty means "follows the plan" */
  limitsOverride: PlanLimits | null
  /** the asker is the host account or an admin, so a write is allowed */
  owner: boolean
}

const MIB = 1024
const MIN_GB = 1
const MAX_GB = 128
const MIN_CORES = 1
const MAX_CORES = 64
const DEFAULT_GB = 4
const DEFAULT_CORES = 2

const say = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.')

/** MiB → a short GB label, e.g. 8192 → "8 GB", 1536 → "1.5 GB". */
function gbLabel(mib: number | null | undefined): string {
  if (!mib || mib <= 0) return '—'
  return `${Math.round((mib / MIB) * 10) / 10} GB`
}

/** True when an override is actually setting something, not just an empty husk. */
function hasOverride(limits: PlanLimits | null | undefined): boolean {
  return Boolean(limits && (limits.memoryMb || limits.cpuCores))
}

/** One editable value serialised, so "unsaved" is a plain string compare. */
const key = (gb: number, cores: number): string => `${gb}|${cores}`

/**
 * A number with thumb-sized ends. The input in the middle stays real — a jump
 * from 4 to 32 is typed, not tapped — but on a phone the minus and plus are the
 * control. Lifted in spirit from the Automation tab's stepper so the two admin
 * screens feel like one family.
 */
function Stepper({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  disabled?: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  const clamp = (n: number): number =>
    Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n * 10) / 10 : min))
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="res-step">
        <Button aria-label={`${label} — less`} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - step))}>
          <Minus size={16} aria-hidden />
        </Button>
        <div className="res-stepval">
          <input
            id={id}
            className="input"
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(clamp(Number(e.target.value)))}
          />
          <span className="res-stepunit" aria-hidden>
            {unit}
          </span>
        </div>
        <Button aria-label={`${label} — more`} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))}>
          <Plus size={16} aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function Note({ tone, children }: { tone?: 'warn'; children: ReactNode }): React.JSX.Element {
  return <p className={tone === 'warn' ? 'formnote res-warn' : 'formnote'}>{children}</p>
}

export function Resources({ row, ask }: TabProps): React.JSX.Element {
  const [info, setInfo] = useState<ResourceInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState('')

  const [gb, setGb] = useState(DEFAULT_GB)
  const [coresLimited, setCoresLimited] = useState(false)
  const [cores, setCores] = useState(DEFAULT_CORES)
  /** the last state the host confirmed, serialised — what "unsaved" measures against */
  const [saved, setSaved] = useState('')

  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  // The shell is free to hand down a fresh `ask` each render; keying the load
  // below off it directly would turn it into an endless relay loop.
  const askRef = useRef(ask)
  askRef.current = ask

  useEffect(() => {
    let alive = true
    setInfo(null)
    setLoadFailed('')
    setFailed('')
    askRef
      .current<ResourceInfo>('info')
      .then((res) => {
        if (!alive) return
        // effective RAM: the cap in force, else the Minecraft heap, else a sane default
        const memMib = res.limits?.memoryMb || (res.memoryMax > 0 ? res.memoryMax : 0)
        const g = memMib > 0 ? Math.round((memMib / MIB) * 10) / 10 : DEFAULT_GB
        const capped = (res.limits?.cpuCores ?? 0) > 0
        const c = res.limits?.cpuCores || DEFAULT_CORES
        setInfo(res)
        setGb(g)
        setCoresLimited(capped)
        setCores(c)
        setSaved(key(g, capped ? c : 0))
      })
      .catch((e: unknown) => {
        if (alive) setLoadFailed(say(e))
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
    // shaped like the screen it becomes: intro card, two control cards
    return (
      <div className="stack" aria-busy="true">
        <Skeleton height={140} />
        <Skeleton height={150} />
        <Skeleton height={190} />
      </div>
    )
  }

  const minecraft = info.game === 'minecraft'
  const overridden = hasOverride(info.limitsOverride)
  const planned = hasOverride(info.limitsPlan)
  const effCores = coresLimited ? cores : 0
  const dirty = key(gb, effCores) !== saved
  const readOnly = !info.owner || busy

  async function apply(override: PlanLimits): Promise<void> {
    setBusy(true)
    setFailed('')
    try {
      const res = await askRef.current<{ ok: boolean; limits: PlanLimits | null }>('setLimits', { override })
      // reflect what the host now holds: the override we sent (positive fields
      // only, mirroring the host), and the effective caps it computed back
      const nextOverride: PlanLimits = {}
      if (override.memoryMb && override.memoryMb > 0) nextOverride.memoryMb = override.memoryMb
      if (override.cpuCores && override.cpuCores > 0) nextOverride.cpuCores = override.cpuCores
      const eff = res.limits ?? null
      const memMib = eff?.memoryMb || (info!.memoryMax > 0 ? info!.memoryMax : 0)
      const g = memMib > 0 ? Math.round((memMib / MIB) * 10) / 10 : DEFAULT_GB
      const capped = (eff?.cpuCores ?? 0) > 0
      const c = eff?.cpuCores || DEFAULT_CORES
      setInfo((prev) => (prev ? { ...prev, limits: eff, limitsOverride: Object.keys(nextOverride).length ? nextOverride : null } : prev))
      setGb(g)
      setCoresLimited(capped)
      setCores(c)
      setSaved(key(g, capped ? c : 0))
      toast.success(
        row.state === 'running'
          ? 'Resources saved — restart the server to apply them.'
          : 'Resources saved — they apply the next time this server starts.'
      )
    } catch (e) {
      setFailed(say(e))
    } finally {
      setBusy(false)
    }
  }

  function save(): void {
    void apply({ memoryMb: Math.round(gb * MIB), cpuCores: effCores })
  }

  function reset(): void {
    // an empty override clears the lift on the host, dropping the server back to
    // its plan allowance
    void apply({})
  }

  function discard(): void {
    const memMib = info!.limits?.memoryMb || (info!.memoryMax > 0 ? info!.memoryMax : 0)
    setGb(memMib > 0 ? Math.round((memMib / MIB) * 10) / 10 : DEFAULT_GB)
    const capped = (info!.limits?.cpuCores ?? 0) > 0
    setCoresLimited(capped)
    setCores(info!.limits?.cpuCores || DEFAULT_CORES)
    setFailed('')
  }

  return (
    <motion.div className="stack respane" variants={staggerParent} initial="hidden" animate="show">
      <motion.section variants={staggerChild} className="surface pad stack">
        <div className="row">
          <h2 className="res-grow">Server resources</h2>
          {overridden ? (
            <span className="pill busy">
              <span className="dot" aria-hidden />
              Custom
            </span>
          ) : planned ? (
            <span className="pill running">
              <span className="dot" aria-hidden />
              On plan
            </span>
          ) : null}
        </div>
        <p className="dim">
          The RAM and CPU this one server gets. Setting them here overrides its plan for this server alone and takes
          effect the next time it starts. The plan stays its baseline — clear the override to fall back to it.
        </p>
        <div className="res-plan">
          <div className="res-planitem">
            <span className="res-plank">Plan RAM</span>
            <span className="res-planv mono">{gbLabel(info.limitsPlan?.memoryMb)}</span>
          </div>
          <div className="res-planitem">
            <span className="res-plank">Plan CPU</span>
            <span className="res-planv mono">
              {info.limitsPlan?.cpuCores ? `${info.limitsPlan.cpuCores} core${info.limitsPlan.cpuCores === 1 ? '' : 's'}` : 'all cores'}
            </span>
          </div>
        </div>
        {!planned && (
          <Note>
            This server has no plan attached — it is self-hosted, so the values below simply become its resource limits
            rather than lifting anything.
          </Note>
        )}
        {overridden && (
          <div className="row">
            <span className="dim res-grow">
              Currently overridden to <b>{gbLabel(info.limitsOverride?.memoryMb) !== '—' ? gbLabel(info.limitsOverride?.memoryMb) : 'plan RAM'}</b>
              {info.limitsOverride?.cpuCores ? ` · ${info.limitsOverride.cpuCores} core${info.limitsOverride.cpuCores === 1 ? '' : 's'}` : ''}.
            </span>
            <Button variant="ghost" disabled={readOnly} onClick={reset}>
              Reset to plan
            </Button>
          </div>
        )}
      </motion.section>

      <motion.section variants={staggerChild} className="surface pad stack">
        <h2>Memory (RAM)</h2>
        <Stepper
          id="res-ram"
          label="Give this server"
          value={gb}
          min={MIN_GB}
          max={MAX_GB}
          step={1}
          unit="GB"
          disabled={readOnly}
          onChange={(v) => {
            setGb(v)
            setFailed('')
          }}
        />
        {minecraft ? (
          <Note>
            This is the server&rsquo;s Java heap — the hard ceiling it runs within (Xmx). Bigger worlds and heavier
            modpacks need more; leaving too little is what makes a modded server stutter and crash under load.
          </Note>
        ) : (
          <Note>
            This game sizes its own memory, so this is the ceiling that trips an automatic restart if the server climbs
            past it — a safety net against leaks rather than a hard cap. Give it headroom above what it normally uses.
          </Note>
        )}
        <Note tone="warn">Don&rsquo;t hand out more than the host box physically has, or the server won&rsquo;t start.</Note>
      </motion.section>

      <motion.section variants={staggerChild} className="surface pad stack">
        <h2>CPU cores</h2>
        <div className="field" role="group" aria-label="CPU cores">
          <span className="res-label">Cores this server may use</span>
          <div className="res-seg">
            <Button
              variant={!coresLimited ? 'primary' : undefined}
              aria-pressed={!coresLimited}
              disabled={readOnly}
              onClick={() => {
                setCoresLimited(false)
                setFailed('')
              }}
            >
              All available
            </Button>
            <Button
              variant={coresLimited ? 'primary' : undefined}
              aria-pressed={coresLimited}
              disabled={readOnly}
              onClick={() => {
                setCoresLimited(true)
                setFailed('')
              }}
            >
              Limit to…
            </Button>
          </div>
        </div>
        <Collapse open={coresLimited}>
          <Stepper
            id="res-cores"
            label="Number of cores"
            value={cores}
            min={MIN_CORES}
            max={MAX_CORES}
            step={1}
            unit={cores === 1 ? 'core' : 'cores'}
            disabled={readOnly}
            onChange={(v) => {
              setCores(Math.round(v))
              setFailed('')
            }}
          />
        </Collapse>
        <Note>
          CPU limits are enforced on <b>Linux</b> hosts, which pin the server&rsquo;s whole process tree to this many
          cores. Windows and macOS hosts store the number but can&rsquo;t hard-cap cores there, so the memory guard and
          process priority carry the load instead. A limit at or above the box&rsquo;s core count is the same as
          &ldquo;all available&rdquo;.
        </Note>
      </motion.section>

      {/* The dock rides the bottom of the screen while there are edits to keep or a
          failure to read — nothing here survives leaving the tab, and it says so
          instead of letting anyone find out. Twin of the Automation/Settings docks. */}
      <AnimatePresence>
        {(dirty || failed) && (
          <motion.div
            className="res-dock"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18, transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ duration: 0.32, ease: EASE_SPRING }}
          >
            {failed && (
              <p className="formerr" role="alert">
                {failed}
              </p>
            )}
            {dirty && (
              <>
                <p className="res-dockmsg">
                  Unsaved resource changes — leaving this tab loses them. They apply on the server&rsquo;s next start.
                </p>
                <div className="row">
                  <Button variant="ghost" disabled={busy} onClick={discard}>
                    Discard
                  </Button>
                  <span className="spacer" />
                  <Button variant="primary" disabled={busy} onClick={save}>
                    {busy && <Spinner />}
                    {busy ? 'Saving…' : 'Save resources'}
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
