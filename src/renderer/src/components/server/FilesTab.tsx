import { useCallback, useEffect, useState } from 'react'
import type { LocalServer, ServerFileEntry } from '@shared/types'
import { useToast } from '../../toast'
import { formatBytes, timeAgo } from '../../fmt'
import { IconBox, IconCheck, IconFolder, IconRefresh, IconTrash, IconX } from '../../icons'

interface EditState {
  rel: string
  content: string
  dirty: boolean
}

/** File manager scoped to the server folder: browse, edit text files, delete. */
export default function FilesTab({ server }: { server: LocalServer }): React.JSX.Element {
  const toast = useToast()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<ServerFileEntry[] | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(
    (rel: string) => {
      setEntries(null)
      window.elauncher.server.files.list(server.id, rel).then(setEntries).catch(console.error)
    },
    [server.id]
  )

  useEffect(() => {
    setPath('')
    setEditing(null)
    load('')
  }, [server.id, load])

  const goTo = (rel: string): void => {
    setPath(rel)
    setEditing(null)
    load(rel)
  }

  const open = (entry: ServerFileEntry): void => {
    const rel = path ? `${path}/${entry.name}` : entry.name
    if (entry.isDir) {
      goTo(rel)
      return
    }
    void window.elauncher.server.files.read(server.id, rel).then((res) => {
      if (res.ok && res.content !== undefined) setEditing({ rel, content: res.content, dirty: false })
      else toast.error(res.error ?? 'Could not open the file')
    })
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    setSaving(true)
    try {
      const res = await window.elauncher.server.files.write(server.id, editing.rel, editing.content)
      if (res.ok) {
        setEditing({ ...editing, dirty: false })
        toast.success(`Saved ${editing.rel.split('/').pop()}`)
      } else toast.error(res.error ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (entry: ServerFileEntry): Promise<void> => {
    const rel = path ? `${path}/${entry.name}` : entry.name
    if (!confirm(`Delete "${rel}"${entry.isDir ? ' and everything inside it' : ''}? This cannot be undone.`)) return
    const res = await window.elauncher.server.files.remove(server.id, rel)
    if (res.ok) {
      toast.success(`Deleted ${entry.name}`)
      if (editing?.rel === rel) setEditing(null)
      load(path)
    } else toast.error(res.error ?? 'Delete failed')
  }

  const crumbs = path ? path.split('/') : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="file-crumbs">
          <button className={crumbs.length === 0 ? 'active' : ''} onClick={() => goTo('')}>
            {server.name}
          </button>
          {crumbs.map((part, i) => (
            <span key={i} className="row" style={{ gap: 0 }}>
              <span className="faint">/</span>
              <button
                className={i === crumbs.length - 1 ? 'active' : ''}
                onClick={() => goTo(crumbs.slice(0, i + 1).join('/'))}
              >
                {part}
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <button className="icon-btn" title="Refresh" onClick={() => load(path)}>
            <IconRefresh size={14} />
          </button>
          <button className="ghost small" onClick={() => void window.elauncher.server.openFolder(server.id)}>
            <IconFolder size={13} /> Open in Explorer
          </button>
        </div>
      </div>

      {entries === null ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : entries.length === 0 ? (
        <div className="hint">This folder is empty.</div>
      ) : (
        <div className="file-list">
          {entries.map((entry) => (
            <div key={entry.name} className="file-row">
              <button className="file-main" onClick={() => open(entry)}>
                <span className="file-icon" style={{ color: entry.isDir ? 'var(--accent-hover)' : 'var(--text-faint)' }}>
                  {entry.isDir ? <IconFolder size={15} /> : <IconBox size={14} />}
                </span>
                <span className="file-name">{entry.name}</span>
                <span className="file-meta">
                  {entry.isDir ? 'folder' : formatBytes(entry.sizeBytes)} · {timeAgo(entry.modifiedAt)}
                </span>
              </button>
              <button className="icon-btn" title="Delete" onClick={() => void remove(entry)}>
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="card settings-section">
          <div className="section-title" style={{ justifyContent: 'space-between' }}>
            <span className="row" style={{ gap: 9 }}>
              <IconBox size={14} /> {editing.rel}
              {editing.dirty && <span className="small" style={{ color: 'var(--yellow)' }}>unsaved</span>}
            </span>
            <button className="icon-btn" title="Close editor" onClick={() => setEditing(null)}>
              <IconX size={15} />
            </button>
          </div>
          <textarea
            className="raw-editor"
            style={{ minHeight: 280 }}
            spellCheck={false}
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })}
          />
          <div className="row">
            <button className="primary" disabled={saving || !editing.dirty} onClick={() => void save()}>
              <IconCheck size={14} /> {saving ? 'Saving…' : 'Save file'}
            </button>
            <span className="small faint">Config changes apply after a server restart.</span>
          </div>
        </div>
      )}
    </div>
  )
}
