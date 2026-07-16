import { useEffect, useMemo, useState } from 'react'
import { useToast } from '../toast'
import { IconAlert, IconMonitor, IconSliders, IconVolume } from '../icons'
import Select from './Select'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: (v: number) => string
  onChange: (v: number) => void
}

function Slider({ label, value, min, max, step = 1, display, onChange }: SliderProps): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="slider-row">
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--slider-fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{display ? display(value) : value}</span>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="switch-row" style={{ alignItems: 'center' }}>
      <span className="switch-title" style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 600 }}>{label}</span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
    </label>
  )
}

/** vanilla defaults used when options.txt doesn't exist yet */
const DEFAULTS: Record<string, string> = {
  renderDistance: '12',
  simulationDistance: '12',
  maxFps: '120',
  guiScale: '0',
  gamma: '0.5',
  fullscreen: 'false',
  enableVsync: 'true',
  graphicsMode: '1',
  particles: '0',
  ao: 'true',
  entityShadows: 'true',
  bobView: 'true',
  soundCategory_master: '1.0',
  soundCategory_music: '1.0',
  soundCategory_record: '1.0',
  soundCategory_weather: '1.0',
  soundCategory_block: '1.0',
  soundCategory_hostile: '1.0',
  soundCategory_neutral: '1.0',
  soundCategory_player: '1.0',
  soundCategory_ambient: '1.0'
}

const SOUND_CATEGORIES: { key: string; label: string }[] = [
  { key: 'soundCategory_master', label: 'Master volume' },
  { key: 'soundCategory_music', label: 'Music' },
  { key: 'soundCategory_record', label: 'Jukebox / note blocks' },
  { key: 'soundCategory_weather', label: 'Weather' },
  { key: 'soundCategory_block', label: 'Blocks' },
  { key: 'soundCategory_hostile', label: 'Hostile creatures' },
  { key: 'soundCategory_neutral', label: 'Friendly creatures' },
  { key: 'soundCategory_player', label: 'Players' },
  { key: 'soundCategory_ambient', label: 'Ambient' }
]

export default function GameSettingsTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const toast = useToast()
  const [entries, setEntries] = useState<Record<string, string> | null>(null)
  const [fileExists, setFileExists] = useState(true)
  const [dirty, setDirty] = useState<Record<string, string>>({})
  const [rawText, setRawText] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.elauncher.gameOptions
      .get(instanceId)
      .then((opts) => {
        setEntries(opts.entries)
        setFileExists(opts.exists)
        setDirty({})
      })
      .catch(console.error)
  }, [instanceId])

  const merged = useMemo(() => ({ ...DEFAULTS, ...(entries ?? {}), ...dirty }), [entries, dirty])

  useEffect(() => {
    if (showRaw) {
      setRawText(
        Object.entries(merged)
          .map(([k, v]) => `${k}:${v}`)
          .join('\n')
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRaw])

  if (entries === null) {
    return <div className="skeleton" style={{ height: 340 }} />
  }

  const get = (key: string): string => merged[key] ?? ''
  const set = (key: string, value: string): void => setDirty((d) => ({ ...d, [key]: value }))
  const getNum = (key: string, fallback: number): number => {
    const n = Number(get(key))
    return Number.isFinite(n) ? n : fallback
  }
  const getBool = (key: string): boolean => get(key) === 'true'

  const hasChanges = Object.keys(dirty).length > 0

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      let updates = dirty
      if (showRaw) {
        // raw editor: parse every line and merge everything
        updates = {}
        for (const line of rawText.split(/\r?\n/)) {
          const idx = line.indexOf(':')
          if (idx <= 0) continue
          updates[line.slice(0, idx).trim()] = line.slice(idx + 1)
        }
      } else if (!fileExists) {
        // first save on a fresh instance: write defaults + edits so the game starts with them
        updates = { ...DEFAULTS, ...dirty }
      }
      const result = await window.elauncher.gameOptions.set(instanceId, updates)
      setEntries(result.entries)
      setFileExists(result.exists)
      setDirty({})
      toast.success('Game settings saved — they apply on next launch')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
      {!fileExists && (
        <div className="pill-note">
          <IconAlert size={15} />
          This instance hasn't been launched yet, so you're editing defaults. Saving creates options.txt and the game
          will start with these settings.
        </div>
      )}

      <div className="card settings-section">
        <div className="section-title">
          <IconMonitor size={15} /> Video
        </div>
        <Slider
          label="Render distance"
          value={getNum('renderDistance', 12)}
          min={2}
          max={32}
          display={(v) => `${v} chunks`}
          onChange={(v) => set('renderDistance', String(v))}
        />
        <Slider
          label="Simulation distance"
          value={getNum('simulationDistance', 12)}
          min={5}
          max={32}
          display={(v) => `${v} chunks`}
          onChange={(v) => set('simulationDistance', String(v))}
        />
        <Slider
          label="Max framerate"
          value={getNum('maxFps', 120)}
          min={10}
          max={260}
          step={10}
          display={(v) => (v >= 260 ? 'Unlimited' : `${v} fps`)}
          onChange={(v) => set('maxFps', String(v))}
        />
        <Slider
          label="Brightness"
          value={Math.round(getNum('gamma', 0.5) * 100)}
          min={0}
          max={100}
          display={(v) => (v <= 0 ? 'Moody' : v >= 100 ? 'Bright' : `${v}%`)}
          onChange={(v) => set('gamma', (v / 100).toFixed(2))}
        />
        <Slider
          label="GUI scale"
          value={getNum('guiScale', 0)}
          min={0}
          max={4}
          display={(v) => (v === 0 ? 'Auto' : `${v}x`)}
          onChange={(v) => set('guiScale', String(v))}
        />
        <div className="slider-row">
          <span className="slider-label">Graphics</span>
          <Select
            value={get('graphicsMode') || '1'}
            onChange={(v) => set('graphicsMode', v)}
            options={[
              { value: '0', label: 'Fast' },
              { value: '1', label: 'Fancy' },
              { value: '2', label: 'Fabulous!' }
            ]}
          />
          <span />
        </div>
        <div className="slider-row">
          <span className="slider-label">Particles</span>
          <Select
            value={get('particles') || '0'}
            onChange={(v) => set('particles', v)}
            options={[
              { value: '0', label: 'All' },
              { value: '1', label: 'Decreased' },
              { value: '2', label: 'Minimal' }
            ]}
          />
          <span />
        </div>
        <Toggle label="Fullscreen" checked={getBool('fullscreen')} onChange={(v) => set('fullscreen', String(v))} />
        <Toggle label="VSync" checked={getBool('enableVsync')} onChange={(v) => set('enableVsync', String(v))} />
        <Toggle label="Smooth lighting" checked={getBool('ao')} onChange={(v) => set('ao', String(v))} />
        <Toggle label="Entity shadows" checked={getBool('entityShadows')} onChange={(v) => set('entityShadows', String(v))} />
        <Toggle label="View bobbing" checked={getBool('bobView')} onChange={(v) => set('bobView', String(v))} />
      </div>

      <div className="card settings-section">
        <div className="section-title">
          <IconVolume size={15} /> Audio
        </div>
        {SOUND_CATEGORIES.map((cat) => (
          <Slider
            key={cat.key}
            label={cat.label}
            value={Math.round(getNum(cat.key, 1) * 100)}
            min={0}
            max={100}
            display={(v) => `${v}%`}
            onChange={(v) => set(cat.key, (v / 100).toFixed(2))}
          />
        ))}
      </div>

      <div className="card settings-section">
        <div className="section-title" style={{ justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 9 }}>
            <IconSliders size={15} /> Advanced (raw options.txt)
          </span>
          <span className="switch">
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
            <span className="knob" />
          </span>
        </div>
        {showRaw ? (
          <>
            <textarea className="raw-editor" value={rawText} spellCheck={false} onChange={(e) => setRawText(e.target.value)} />
            <div className="hint">
              One <code>key:value</code> per line. Saving merges every line into options.txt (keys you remove here are
              kept in the file).
            </div>
          </>
        ) : (
          <div className="hint">
            Flip the switch to edit every option — keybinds, language, chat settings and anything mods add.
          </div>
        )}
      </div>

      <div className="row">
        <button className="primary" disabled={saving || (!hasChanges && !showRaw)} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save game settings'}
        </button>
        {hasChanges && <span className="small faint">{Object.keys(dirty).length} change(s) pending</span>}
      </div>
    </div>
  )
}
