import { useEffect, useState } from 'react'
import type { CloudPack, Instance, PackLink, ProgressEvent } from '@shared/types'
import { useToast } from '../toast'
import { IconAlert } from '../icons'
import Select from './Select'

interface Props {
  instance: Instance
  /** existing cloud link of this instance, if it was installed from the cloud */
  packLink: PackLink | null
  onClose: () => void
  onPublished: () => void
}

export default function PublishPackModal({ instance, packLink, onClose, onPublished }: Props): React.JSX.Element {
  const toast = useToast()
  const [packs, setPacks] = useState<CloudPack[]>([])
  const [packId, setPackId] = useState<string>(packLink?.cloudPackId ?? '')
  const [name, setName] = useState(instance.name)
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [changelog, setChangelog] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)

  useEffect(
    () =>
      window.elauncher.cloud.onPublishProgress((e) => {
        if (e.instanceId === instance.id) setProgress(e)
      }),
    [instance.id]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    window.elauncher.cloud
      .listPacks()
      .then((list) => {
        setPacks(list)
        const linked = list.find((p) => p.id === (packLink?.cloudPackId ?? ''))
        if (linked) {
          setName(linked.name)
          setDescription(linked.description)
          if (linked.latestVersion) setVersion(suggestNextVersion(linked.latestVersion.version))
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [packLink])

  const onSelectPack = (id: string): void => {
    setPackId(id)
    const pack = packs.find((p) => p.id === id)
    if (pack) {
      setName(pack.name)
      setDescription(pack.description)
      if (pack.latestVersion) setVersion(suggestNextVersion(pack.latestVersion.version))
    } else {
      setName(instance.name)
      setDescription('')
      setVersion('1.0.0')
    }
  }

  const publish = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setProgress({ instanceId: instance.id, phase: 'Preparing pack file', progress: -1 })
    const result = await window.elauncher.cloud.publish({
      instanceId: instance.id,
      packId: packId || undefined,
      name,
      description,
      version,
      changelog
    })
    if (result.ok) {
      toast.success(packId ? `Update ${result.version} published` : `"${name}" published`)
      onPublished()
      onClose()
    } else {
      setError(result.error ?? 'Publish failed')
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{packId ? 'Publish update' : 'Publish to cloud'}</h2>
        <p className="muted small" style={{ margin: '-6px 0 4px' }}>
          Everyone with an ELauncher account can then install{packId ? ' the update' : ' it'} in one click.
          Modrinth mods are stored as references, so uploads stay small.
        </p>
        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        <div className="field">
          <label>Publish as</label>
          <Select
            value={packId}
            onChange={onSelectPack}
            options={[
              { value: '', label: 'New modpack' },
              ...packs.map((p) => ({
                value: p.id,
                label: `Update "${p.name}" (latest: ${p.latestVersion?.version ?? 'none'})`
              }))
            ]}
          />
        </div>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Description</label>
          <input
            value={description}
            placeholder="What is this pack about?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Version</label>
          <input value={version} placeholder="1.0.0" onChange={(e) => setVersion(e.target.value)} />
        </div>
        <div className="field">
          <label>Changelog (optional)</label>
          <input
            value={changelog}
            placeholder="Added Create, removed broken shaders…"
            onChange={(e) => setChangelog(e.target.value)}
          />
        </div>
        {busy && progress && (
          <div style={{ marginTop: 4 }}>
            <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>{progress.phase}</span>
              {progress.progress >= 0 && <span>{Math.round(progress.progress * 100)}%</span>}
            </div>
            <div className="progress-track">
              <div
                className={`progress-fill${progress.progress < 0 ? ' indeterminate' : ''}`}
                style={{ width: progress.progress >= 0 ? `${Math.round(progress.progress * 100)}%` : undefined }}
              />
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim() || !version.trim()}
            onClick={() => void publish()}
          >
            {busy ? 'Uploading…' : packId ? 'Publish update' : 'Publish modpack'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 1.2.3 -> 1.2.4; falls back to the same string if it isn't dotted numbers. */
function suggestNextVersion(current: string): string {
  const parts = current.split('.')
  const last = Number(parts[parts.length - 1])
  if (Number.isNaN(last)) return current
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
}
