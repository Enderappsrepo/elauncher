import { useEffect, useRef, useState } from 'react'
import type { LocalServer } from '@shared/types'
import { BEAMMP_DEFAULT_MAP, BEAMMP_DEFAULT_PLAYERS, BEAMMP_DEFAULT_CARS, BEAMMP_MAPS } from '@shared/beammp'
import { useToast } from '../../toast'
import Select from '../Select'

const FLAGS = [
  ['Private', 'Hide from the public server list'],
  ['AllowGuests', 'Allow guest accounts'],
  ['LogChat', 'Log player chat'],
  ['Debug', 'Debug logging'],
  ['InformationPacket', 'Answer server information requests']
] as const

/** AuthKey is write-only: the host returns a configured flag, never the key. */
export default function BeamMPSettingsTab({ server }: { server: LocalServer }): React.JSX.Element {
  const toast = useToast()
  const [props, setProps] = useState<Record<string, string> | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const currentServer = useRef(server.id)
  currentServer.current = server.id
  useEffect(() => {
    let alive = true
    setProps(null)
    setEdits({})
    setError('')
    setSaving(false)
    window.elauncher.server.getProperties(server.id).then(
      (value) => { if (alive) setProps({ ...value, AuthKey: '' }) },
      (reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : 'Could not load settings.') }
    )
    return () => { alive = false }
  }, [server.id])
  const get = (key: string, fallback = ''): string => edits[key] ?? props?.[key] ?? fallback
  const change = (key: string, value: string): void => setEdits((old) => ({ ...old, [key]: value }))
  const dirty = Object.keys(edits).filter((key) =>
    key === 'AuthKey' ? edits[key].trim() !== '' : edits[key] !== (props?.[key] ?? '')
  )
  async function save(): Promise<void> {
    const serverId = server.id
    const updates = Object.fromEntries(dirty.map((key) => [key, edits[key]]))
    setSaving(true)
    setError('')
    try {
      const written = await window.elauncher.server.setProperties(serverId, updates)
      if (currentServer.current !== serverId) return
      setProps({ ...written, AuthKey: '' })
      setEdits({})
      toast.success('Saved — restart the server to apply changes')
    } catch (reason) {
      if (currentServer.current !== serverId) return
      setError(reason instanceof Error ? reason.message : 'Could not save settings.')
    } finally {
      if (currentServer.current === serverId) setSaving(false)
    }
  }
  if (error && !props) return <div className="error-banner">{error}</div>
  if (!props) return <div className="skeleton" style={{ height: 180 }} />
  const configured = props.AuthKeyConfigured === 'true'
  const map = get('Map', BEAMMP_DEFAULT_MAP)
  return (
    <div className="card settings-section">
      <div className="section-title">BeamMP server settings</div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="beammp-name">Server name</label>
        <input id="beammp-name" value={get('Name', server.name)} onChange={(event) => change('Name', event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="beammp-description">Description</label>
        <input id="beammp-description" value={get('Description')} onChange={(event) => change('Description', event.target.value)} />
      </div>
      <div className="field">
        <label>Map</label>
        <Select value={map} onChange={(value) => change('Map', value)} options={[
          ...BEAMMP_MAPS,
          ...(!BEAMMP_MAPS.some((entry) => entry.value === map) ? [{ value: map, label: map }] : [])
        ]} />
        <div className="hint">Custom map path</div>
        <input aria-label="Custom map path" value={map} placeholder={BEAMMP_DEFAULT_MAP} onChange={(event) => change('Map', event.target.value)} />
      </div>
      <div className="props-grid">
        {[
          ['MaxPlayers', 'Max players', BEAMMP_DEFAULT_PLAYERS],
          ['MaxCars', 'Cars per player', BEAMMP_DEFAULT_CARS]
        ].map(([key, label, fallback]) => (
          <div className="field" key={key}>
            <label htmlFor={`beammp-${key}`}>{label}</label>
            <input id={`beammp-${key}`} type="number" min={1} max={key === 'MaxPlayers' ? 128 : 20} step={1} value={get(String(key), String(fallback))}
              onChange={(event) => change(String(key), event.target.value)} />
          </div>
        ))}
      </div>
      <div className="field">
        <label htmlFor="beammp-auth">BeamMP authentication key</label>
        <input id="beammp-auth" type="password" autoComplete="new-password" value={edits.AuthKey ?? ''}
          placeholder={configured ? 'Key configured — leave blank to keep it' : 'Required before the server can start'}
          onChange={(event) => change('AuthKey', event.target.value)} />
        <div className="hint">
          Get your server&apos;s key from <a href="https://keymaster.beammp.com/" target="_blank" rel="noreferrer">BeamMP Keymaster</a>.
          {' '}Use a separate key for each server. Blank keeps the existing key.
        </div>
      </div>
      {FLAGS.map(([key, label]) => (
        <label className="checkbox-row" key={key}>
          <input type="checkbox" checked={get(key) === 'true'} onChange={(event) => change(key, String(event.target.checked))} />
          <span>{label}</span>
        </label>
      ))}
      <p className="hint">Changes apply on the next start. Client mods belong in Resources/Client; server Lua plugins belong in Resources/Server.</p>
      {dirty.length > 0 && (
        <div className="row">
          <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : `Save ${dirty.length} changes`}</button>
          <button className="ghost" disabled={saving} onClick={() => setEdits({})}>Discard</button>
        </div>
      )}
    </div>
  )
}
