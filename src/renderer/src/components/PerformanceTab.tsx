import { useCallback, useEffect, useState } from 'react'
import type { GraphicsPreset, Instance, OptimizationPlan, PerfMod, Settings } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { IconAlert, IconBox, IconCheck, IconGauge, IconMonitor, IconRocket, IconSettings, IconSparkles, IconZap } from '../icons'

const PRESETS: { id: GraphicsPreset; label: string; sub: string }[] = [
  { id: 'performance', label: 'Max FPS', sub: 'Lowest settings, highest frames' },
  { id: 'balanced', label: 'Balanced', sub: 'Good looks, still smooth' },
  { id: 'quality', label: 'Quality', sub: 'Best visuals, needs a strong PC' }
]

const MEM_OPTIONS: { mib: number; label: string }[] = [
  { mib: 0, label: 'Auto' },
  { mib: 4096, label: '4 GB' },
  { mib: 6144, label: '6 GB' },
  { mib: 8192, label: '8 GB' }
]

function StatusChip({ status }: { status: PerfMod['status'] }): React.JSX.Element {
  if (status === 'installed')
    return (
      <span className="perf-status installed">
        <IconCheck size={11} /> Installed
      </span>
    )
  if (status === 'available') return <span className="perf-status available">Will install</span>
  if (status === 'conflict') return <span className="perf-status conflict">Conflict</span>
  return <span className="perf-status incompatible">No build</span>
}

function ModRow({
  mod,
  checked,
  onToggle
}: {
  mod: PerfMod
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  const selectable = mod.status === 'available'
  const dimmed = mod.status === 'incompatible' || mod.status === 'conflict'
  return (
    <label className={`perf-mod-row${selectable ? ' selectable' : ''}`} style={{ opacity: dimmed ? 0.55 : 1 }}>
      {mod.iconUrl ? (
        <img className="perf-mod-icon" src={mod.iconUrl} alt="" loading="lazy" />
      ) : (
        <span className="perf-mod-icon placeholder">
          <IconBox size={16} />
        </span>
      )}
      <div className="perf-mod-info">
        <div className="perf-mod-name">{mod.name}</div>
        {mod.status === 'conflict' && mod.conflictsWith ? (
          <div className="perf-mod-conflict">Clashes with {mod.conflictsWith} — remove it first</div>
        ) : (
          <div className="perf-mod-blurb">{mod.blurb}</div>
        )}
      </div>
      <StatusChip status={mod.status} />
      <span className="switch green" style={{ marginTop: 0, visibility: selectable ? 'visible' : 'hidden' }}>
        <input type="checkbox" checked={checked} disabled={!selectable} onChange={onToggle} />
        <span className="knob" />
      </span>
    </label>
  )
}

export default function PerformanceTab({
  instance,
  onOpenTab
}: {
  instance: Instance
  onOpenTab: (tab: 'mods' | 'shaders' | 'game') => void
}): React.JSX.Element {
  const { refreshInstances, runStates } = useAppState()
  const toast = useToast()
  const [plan, setPlan] = useState<OptimizationPlan | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [optimizing, setOptimizing] = useState(false)
  const [enablingShaders, setEnablingShaders] = useState(false)
  const [applyingPreset, setApplyingPreset] = useState<GraphicsPreset | null>(null)
  const [lastPreset, setLastPreset] = useState<GraphicsPreset | null>(null)

  const busy = runStates[instance.id] === 'running' || runStates[instance.id] === 'installing'

  const loadPlan = useCallback(async () => {
    try {
      const p = await window.elauncher.optimize.getPlan(instance.id)
      setPlan(p)
      setSelected(
        new Set(
          p.mods
            .filter((m) => m.status === 'available' && m.category !== 'shaders' && m.projectId)
            .map((m) => m.projectId as string)
        )
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setPlan({ loaderSupported: instance.loader !== 'vanilla', mods: [], conflicts: [] })
    }
  }, [instance.id, instance.loader, toast])

  useEffect(() => {
    void loadPlan()
  }, [loadPlan])

  useEffect(() => {
    window.elauncher.settings.get().then(setSettings).catch(console.error)
  }, [])

  const mods = plan?.mods ?? []
  const boosters = mods.filter((m) => m.category !== 'shaders')
  const core = boosters.filter((m) => m.category === 'core')
  const extra = boosters.filter((m) => m.category === 'extra')
  const shaderMod = mods.find((m) => m.category === 'shaders')
  const installedCount = boosters.filter((m) => m.status === 'installed').length
  const availableCount = boosters.filter((m) => m.status === 'available').length
  const selectedIds = [...selected]

  const toggle = (projectId?: string): void => {
    if (!projectId) return
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const optimize = async (): Promise<void> => {
    if (selectedIds.length === 0) return
    setOptimizing(true)
    try {
      const res = await window.elauncher.optimize.apply(instance.id, selectedIds)
      if (!res.ok) toast.error(res.error ?? 'Optimize failed')
      else {
        const installed = res.installed ?? 0
        const skipped = res.failed ?? 0
        const blocked = res.blocked ?? 0
        if (installed === 0 && blocked > 0) {
          toast.error('Those mods clash with mods you already have — nothing was installed.')
        } else {
          const extra = [skipped ? `${skipped} skipped` : '', blocked ? `${blocked} blocked` : ''].filter(Boolean)
          toast.success(
            `Installed ${installed} performance mod${installed === 1 ? '' : 's'}${extra.length ? ` · ${extra.join(' · ')}` : ''}`
          )
        }
      }
      await loadPlan()
    } finally {
      setOptimizing(false)
    }
  }

  const enableShaders = async (): Promise<void> => {
    if (!shaderMod?.projectId) return
    setEnablingShaders(true)
    try {
      const res = await window.elauncher.optimize.apply(instance.id, [shaderMod.projectId])
      if (!res.ok) toast.error(res.error ?? 'Could not enable shaders')
      else toast.success('Shader support installed — add a shader pack in the Shaders tab')
      await loadPlan()
    } finally {
      setEnablingShaders(false)
    }
  }

  const applyPreset = async (preset: GraphicsPreset): Promise<void> => {
    setApplyingPreset(preset)
    try {
      const res = await window.elauncher.optimize.applyPreset(instance.id, preset)
      if (res.ok) {
        setLastPreset(preset)
        toast.success(`Applied the ${PRESETS.find((p) => p.id === preset)?.label} preset — takes effect next launch`)
      } else toast.error(res.error ?? 'Could not apply preset')
    } finally {
      setApplyingPreset(null)
    }
  }

  const setMemory = async (mib: number): Promise<void> => {
    await window.elauncher.instances.update({ ...instance, memoryMax: mib })
    await refreshInstances()
    toast.success(mib === 0 ? 'Memory set to automatic' : `Memory set to ${mib / 1024} GB`)
  }

  const memoryLabel = ((): string => {
    if (instance.memoryMax > 0) return `${(instance.memoryMax / 1024).toFixed(instance.memoryMax % 1024 ? 1 : 0)} GB · fixed`
    if (settings?.autoMemory ?? true) return 'Automatic · sized from system RAM'
    return `${((settings?.defaultMemoryMax ?? 4096) / 1024).toFixed(0)} GB · global default`
  })()
  const gcLabel = settings
    ? settings.optimizedJvmFlags ?? true
      ? (settings.jvmGc ?? 'auto') === 'auto'
        ? 'Auto · ZGC on Java 21+, else G1'
        : (settings.jvmGc ?? 'auto') === 'zgc'
          ? 'Generational ZGC'
          : "Aikar's G1"
      : 'JVM default'
    : '…'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 }}>
      {/* ---------- FPS boost ---------- */}
      <div className="card settings-section perf-card">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconZap size={16} /> Boost FPS
          </span>
          {plan && plan.loaderSupported && (
            <span className="small faint">
              {installedCount} installed{availableCount > 0 ? ` · ${availableCount} ready` : ''}
            </span>
          )}
        </div>

        {plan && plan.conflicts.length > 0 && (
          <div className="perf-conflict-note">
            <IconAlert size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {plan.conflicts.map((c, i) => (
                <div key={i}>{c.reason}</div>
              ))}
            </div>
            <button className="ghost small" onClick={() => onOpenTab('mods')}>
              Manage mods
            </button>
          </div>
        )}

        {!plan ? (
          <div className="perf-mod-list">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 54 }} />
            ))}
          </div>
        ) : !plan.loaderSupported ? (
          <div className="pill-note">
            <IconAlert size={15} />
            This is a vanilla instance. Performance mods like Sodium need a mod loader — make a Fabric, NeoForge or
            Forge instance to unlock them. You can still use the graphics presets and JVM tuning below.
          </div>
        ) : mods.length === 0 ? (
          <div className="hint">Couldn't reach Modrinth to list performance mods. Check your connection and reopen this tab.</div>
        ) : (
          <>
            <p className="perf-lead">
              One click installs the community's go-to performance mods for {instance.loader} {instance.minecraftVersion}.
              They're pulled from Modrinth and dropped straight into this instance — nothing you already have is removed.
            </p>
            {core.length > 0 && <div className="perf-cat-label">Essentials — the big wins</div>}
            <div className="perf-mod-list">
              {core.map((m) => (
                <ModRow key={m.slug} mod={m} checked={selected.has(m.projectId ?? '')} onToggle={() => toggle(m.projectId)} />
              ))}
            </div>
            {extra.length > 0 && <div className="perf-cat-label">Extras — safe quality-of-life boosts</div>}
            <div className="perf-mod-list">
              {extra.map((m) => (
                <ModRow key={m.slug} mod={m} checked={selected.has(m.projectId ?? '')} onToggle={() => toggle(m.projectId)} />
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <span className="small faint">
                {selectedIds.length > 0
                  ? `${selectedIds.length} selected`
                  : availableCount === 0
                    ? 'Everything compatible is already installed 🎉'
                    : 'Nothing selected'}
              </span>
              <button className="play" disabled={optimizing || busy || selectedIds.length === 0} onClick={() => void optimize()}>
                <IconRocket size={15} /> {optimizing ? 'Installing…' : `Optimize${selectedIds.length ? ` · ${selectedIds.length} mods` : ''}`}
              </button>
            </div>

            {shaderMod && (
              <div className="perf-shader-row">
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <IconSparkles size={16} />
                  <div style={{ minWidth: 0 }}>
                    <div className="perf-mod-name">Shaders</div>
                    {shaderMod.status === 'conflict' && shaderMod.conflictsWith ? (
                      <div className="perf-mod-conflict">Clashes with {shaderMod.conflictsWith} — remove it first</div>
                    ) : (
                      <div className="perf-mod-blurb">{shaderMod.blurb}</div>
                    )}
                  </div>
                </div>
                {shaderMod.status === 'installed' ? (
                  <button className="ghost small" onClick={() => onOpenTab('shaders')}>
                    Add a shader pack
                  </button>
                ) : (
                  <button
                    className="ghost small"
                    disabled={enablingShaders || busy || shaderMod.status !== 'available'}
                    title={
                      shaderMod.status === 'conflict'
                        ? `Clashes with ${shaderMod.conflictsWith}`
                        : shaderMod.status !== 'available'
                          ? 'No compatible build for this version'
                          : undefined
                    }
                    onClick={() => void enableShaders()}
                  >
                    {enablingShaders
                      ? 'Enabling…'
                      : shaderMod.status === 'available'
                        ? 'Enable shaders'
                        : shaderMod.status === 'conflict'
                          ? 'Conflicts'
                          : 'Unavailable'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- Graphics presets ---------- */}
      <div className="card settings-section perf-card">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconMonitor size={15} /> Graphics preset
          </span>
        </div>
        <p className="perf-lead">Writes tuned in-game video settings to this instance. Fine-tune any of them in Game Settings.</p>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset-tile${lastPreset === p.id ? ' active' : ''}`}
              disabled={applyingPreset !== null}
              onClick={() => void applyPreset(p.id)}
            >
              <span className="preset-label">{p.label}</span>
              <span className="preset-sub">{applyingPreset === p.id ? 'Applying…' : p.sub}</span>
            </button>
          ))}
        </div>
        <button className="ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => onOpenTab('game')}>
          <IconSettings size={13} /> Fine-tune in Game Settings
        </button>
      </div>

      {/* ---------- Engine / JVM ---------- */}
      <div className="card settings-section perf-card">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconGauge size={15} /> Engine
          </span>
        </div>
        <div className="engine-grid">
          <div className="engine-stat">
            <span className="engine-label">Memory</span>
            <span className="engine-value">{memoryLabel}</span>
          </div>
          <div className="engine-stat">
            <span className="engine-label">Garbage collector</span>
            <span className="engine-value">{gcLabel}</span>
          </div>
          <div className="engine-stat">
            <span className="engine-label">Process priority</span>
            <span className="engine-value">{settings?.highProcessPriority ? 'Above normal' : 'Normal'}</span>
          </div>
        </div>
        <div className="field" style={{ marginTop: 4 }}>
          <label>Max memory for this instance</label>
          <div className="segmented mem-seg">
            {MEM_OPTIONS.map((o) => (
              <button
                key={o.mib}
                className={instance.memoryMax === o.mib ? 'active' : ''}
                disabled={busy}
                onClick={() => void setMemory(o.mib)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="hint">
            Auto sizes RAM from your system (more for modded). Global GC and priority live in{' '}
            <span style={{ color: 'var(--text-dim)' }}>Settings</span>.
          </div>
        </div>
      </div>
    </div>
  )
}
