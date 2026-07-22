import { useEffect, useMemo, useState } from 'react'
import type { LocalServer, SteamServerGame } from '@shared/types'
import { useToast } from '../../toast'
import { IconSearch, IconServer, IconSliders } from '../../icons'
import Select from '../Select'
import { STEAM_SETTINGS, prettifyKey, type SteamField } from './steamSettingsSpec'

/**
 * The settings tab for every SteamCMD game. Curated essentials from the spec
 * table up top, then everything else the game's own config file happens to
 * contain, searchable — so a key ELauncher doesn't model is still editable
 * without dropping into the files tab.
 */
export default function SteamSettingsTab({ server }: { server: LocalServer }): React.JSX.Element {
  const toast = useToast()
  const game = server.game as SteamServerGame
  const spec = STEAM_SETTINGS[game]
  const [props, setProps] = useState<Record<string, string> | null>(null)
  const [dirty, setDirty] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setDirty({})
    setQuery('')
    setProps(null)
    window.elauncher.server.getProperties(server.id).then(setProps).catch(console.error)
  }, [server.id])

  const merged = useMemo(() => ({ ...(props ?? {}), ...dirty }), [props, dirty])
  const get = (key: string, fallback = ''): string => merged[key] ?? fallback
  const set = (key: string, value: string): void => setDirty((d) => ({ ...d, [key]: value }))
  const dirtyCount = Object.keys(dirty).length

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.elauncher.server.setProperties(server.id, dirty)
      setProps(next)
      setDirty({})
      toast.success('Saved — applies next time the server starts')
    } catch (e) {
      // games reject their own invalid values (valheim's password rules, ARK's
      // map list) — the message from the main process is the useful one
      toast.error(e instanceof Error ? e.message : 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }

  /** Keys the curated fields, the locked list and the hidden list don't already cover. */
  const advanced = useMemo(() => {
    const covered = new Set([
      ...spec.fields.map((f) => f.key),
      ...Object.keys(spec.locked),
      ...(spec.hidden ?? [])
    ])
    const q = query.trim().toLowerCase()
    return Object.keys(merged)
      .filter((k) => !covered.has(k))
      .filter((k) => !q || `${k} ${prettifyKey(k)}`.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
  }, [merged, query, spec])

  if (!props) return <div className="skeleton" style={{ height: 180 }} />

  const field = (f: SteamField): React.JSX.Element => {
    if (f.type === 'bool') {
      return (
        <label className="checkbox-row" key={f.key}>
          <input
            type="checkbox"
            checked={get(f.key, f.off).trim().toLowerCase() === f.on.toLowerCase()}
            onChange={(e) => set(f.key, e.target.checked ? f.on : f.off)}
          />
          <span>
            {f.label} {f.hint && <span className="faint small">— {f.hint}</span>}
          </span>
        </label>
      )
    }
    return (
      <div className="field" key={f.key}>
        <label>{f.label}</label>
        {f.type === 'select' ? (
          <Select value={get(f.key, f.options[0]?.value ?? '')} onChange={(v) => set(f.key, v)} options={f.options} />
        ) : f.type === 'number' ? (
          <input
            type="number"
            min={f.min}
            max={f.max}
            value={get(f.key, f.fallback)}
            onChange={(e) => {
              // blank stays blank where the spec allows it: for these games an
              // empty value means "leave it to the game", which is not zero
              const raw = e.target.value
              if (raw === '') return set(f.key, '')
              set(f.key, String(Math.min(f.max, Math.max(f.min, Number(raw) || f.min))))
            }}
          />
        ) : (
          <input value={get(f.key)} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
        )}
        {f.hint && <div className="hint">{f.hint}</div>}
      </div>
    )
  }

  const [checkboxes, inputs] = [
    spec.fields.filter((f) => f.type === 'bool'),
    spec.fields.filter((f) => f.type !== 'bool')
  ]
  const lockedKeys = Object.entries(spec.locked).filter(([key]) => key in merged)

  return (
    <>
      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconServer size={15} /> Server settings
          </span>
        </div>
        {/* single-column for the first two so long names and hints have room */}
        {inputs.slice(0, 2).map(field)}
        <div className="props-grid">{inputs.slice(2).map(field)}</div>
        {checkboxes.map(field)}
      </div>

      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconSliders size={15} /> Advanced
          </span>
          <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
            <IconSearch size={14} />
            <input
              value={query}
              placeholder="Search settings"
              style={{ width: 180 }}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {lockedKeys.length > 0 && (
          <div className="props-grid">
            {lockedKeys.map(([key, why]) => (
              <div className="field" key={key}>
                <label>{prettifyKey(key)}</label>
                <input value={get(key)} disabled />
                <div className="hint">{why}</div>
              </div>
            ))}
          </div>
        )}

        {advanced.length === 0 && (
          <div className="hint">
            {query
              ? 'No settings match that search.'
              : 'Nothing else in this config yet — start the server once and the game writes its full defaults here.'}
          </div>
        )}
        <div className="props-grid">
          {advanced.map((key) => {
            const value = get(key)
            const bool = /^(true|false)$/i.test(value.trim())
            return (
              <div className="field" key={key}>
                <label>{prettifyKey(key)}</label>
                {bool ? (
                  <Select
                    value={/^true$/i.test(value.trim()) ? 'true' : 'false'}
                    onChange={(v) => {
                      // match the casing the file already uses — ARK reads True,
                      // the others read true, and a mismatched literal is ignored
                      const upper = /^[A-Z]/.test(value.trim())
                      set(key, upper ? (v === 'true' ? 'True' : 'False') : v)
                    }}
                    options={[
                      { value: 'true', label: 'True' },
                      { value: 'false', label: 'False' }
                    ]}
                  />
                ) : (
                  <input value={value} onChange={(e) => set(key, e.target.value)} />
                )}
              </div>
            )
          })}
        </div>

        <div className="hint" style={{ marginTop: 10 }}>
          Values map 1:1 to {spec.configName} — keys ELauncher doesn&apos;t model are preserved, and changes apply on the
          next server start.
        </div>
      </div>

      {dirtyCount > 0 && (
        <div
          className="card"
          style={{ position: 'sticky', bottom: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}
        >
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : `Save ${dirtyCount} ${dirtyCount === 1 ? 'change' : 'changes'}`}
          </button>
          <span className="small faint">restart the server to apply</span>
          <button className="ghost small" style={{ marginLeft: 'auto' }} disabled={saving} onClick={() => setDirty({})}>
            Discard
          </button>
        </div>
      )}
    </>
  )
}
