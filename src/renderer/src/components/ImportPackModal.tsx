import { useEffect, useState } from 'react'
import { useAppState } from '../state'
import { IconAlert, IconFolder, IconLink } from '../icons'

interface Props {
  onClose: () => void
  onImported: (id: string, name: string) => void
}

export default function ImportPackModal({ onClose, onImported }: Props): React.JSX.Element {
  const { packTasks } = useAppState()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'file' | 'url' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const task = busy ? packTasks['import'] : undefined

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const fromFile = async (): Promise<void> => {
    setBusy('file')
    setError(null)
    try {
      const instance = await window.elauncher.packs.importPack()
      if (instance) onImported(instance.id, instance.name)
      else setBusy(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  const fromUrl = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed) return
    setBusy('url')
    setError(null)
    try {
      const instance = await window.elauncher.packs.importPackFromUrl(trimmed)
      onImported(instance.id, instance.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Install modpack</h2>
        <p className="muted small" style={{ margin: '-6px 0 4px' }}>
          Install a shared .mrpack in one click. Packs installed from a link can later be updated in one
          click from the instance page.
        </p>
        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        {busy ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>
            <div className="row small muted" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task?.phase ?? 'Starting install…'}
              </span>
              {task && task.progress >= 0 && <span>{Math.round(task.progress * 100)}%</span>}
            </div>
            <div className="progress-track" style={{ height: 8 }}>
              <div
                className={`progress-fill${!task || task.progress < 0 ? ' indeterminate' : ''}`}
                style={{ width: task && task.progress >= 0 ? `${Math.round(task.progress * 100)}%` : undefined }}
              />
            </div>
            <div className="hint">
              Mods download in parallel and are verified against the pack's checksums. You can keep using
              the launcher — the new instance appears when it's ready.
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label>From a link</label>
              <div className="row">
                <input
                  value={url}
                  placeholder="https://example.com/mypack.mrpack"
                  style={{ flex: 1 }}
                  autoFocus
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void fromUrl()}
                />
                <button className="primary" disabled={!url.trim()} onClick={() => void fromUrl()}>
                  <IconLink size={14} /> Install
                </button>
              </div>
              <div className="hint">Paste the download link your friend shared (Dropbox, Drive, GitHub release…).</div>
            </div>
            <div className="field">
              <label>From a file</label>
              <button className="ghost" onClick={() => void fromFile()}>
                <IconFolder size={15} /> Choose a .mrpack file
              </button>
            </div>
          </>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="ghost" disabled={busy !== null} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
