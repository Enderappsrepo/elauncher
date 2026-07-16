import { useCallback, useEffect, useState } from 'react'
import type { ServerEntry } from '@shared/types'
import { useToast } from '../toast'
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconServer, IconTrash, IconX } from '../icons'

interface EditState {
  index: number | null // null = adding new
  name: string
  ip: string
}

export default function ServersTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const toast = useToast()
  const [servers, setServers] = useState<ServerEntry[] | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    window.elauncher.servers.list(instanceId).then(setServers).catch(console.error)
  }, [instanceId])

  useEffect(() => refresh(), [refresh])

  const persist = async (next: ServerEntry[]): Promise<void> => {
    setSaving(true)
    const result = await window.elauncher.servers.save(instanceId, next)
    setSaving(false)
    if (result.ok) setServers(result.servers)
    else toast.error(result.error ?? 'Could not save the server list')
  }

  const submitEdit = async (): Promise<void> => {
    if (!edit || !servers) return
    const ip = edit.ip.trim()
    if (!ip) {
      toast.error('Enter the server address')
      return
    }
    const entry: ServerEntry = {
      name: edit.name.trim() || 'Minecraft Server',
      ip,
      icon: edit.index != null ? servers[edit.index]?.icon : undefined
    }
    const next = [...servers]
    if (edit.index != null) next[edit.index] = entry
    else next.push(entry)
    await persist(next)
    setEdit(null)
    toast.success(edit.index != null ? 'Server updated' : 'Server added')
  }

  const remove = async (index: number): Promise<void> => {
    if (!servers) return
    const target = servers[index]
    if (!confirm(`Remove "${target.name}" from the server list?`)) return
    await persist(servers.filter((_, i) => i !== index))
  }

  const move = async (index: number, delta: -1 | 1): Promise<void> => {
    if (!servers) return
    const to = index + delta
    if (to < 0 || to >= servers.length) return
    const next = [...servers]
    ;[next[index], next[to]] = [next[to], next[index]]
    await persist(next)
  }

  if (servers === null) {
    return (
      <div className="mod-list">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 68 }} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="muted small">
          {servers.length} server{servers.length === 1 ? '' : 's'} — written to servers.dat, picked up by the game on
          next launch
        </div>
        <button className="primary" onClick={() => setEdit({ index: null, name: '', ip: '' })}>
          <IconPlus size={14} /> Add server
        </button>
      </div>

      {servers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <IconServer size={28} />
          </div>
          <h2>No servers saved</h2>
          <p>Add your favorite multiplayer servers here and they'll be waiting in the in-game server list.</p>
        </div>
      ) : (
        <div className="mod-list">
          {servers.map((server, index) => (
            <div className="server-row" key={`${server.ip}-${index}`}>
              {server.icon ? (
                <img className="server-icon" src={`data:image/png;base64,${server.icon}`} alt="" />
              ) : (
                <div className="server-icon-placeholder">
                  <IconServer size={19} />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4 style={{ fontSize: 14, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {server.name}
                </h4>
                <div className="server-addr">{server.ip}</div>
              </div>
              <button className="icon-btn" title="Move up" disabled={index === 0 || saving} onClick={() => void move(index, -1)}>
                <IconArrowUp size={14} />
              </button>
              <button
                className="icon-btn"
                title="Move down"
                disabled={index === servers.length - 1 || saving}
                onClick={() => void move(index, 1)}
              >
                <IconArrowDown size={14} />
              </button>
              <button
                className="icon-btn"
                title="Edit"
                onClick={() => setEdit({ index, name: server.name, ip: server.ip })}
              >
                <IconEdit size={14} />
              </button>
              <button className="icon-btn" title="Remove" disabled={saving} onClick={() => void remove(index)}>
                <IconTrash size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{edit.index != null ? 'Edit server' : 'Add server'}</h2>
              <button className="icon-btn" onClick={() => setEdit(null)}>
                <IconX size={16} />
              </button>
            </div>
            <div className="field">
              <label>Server name</label>
              <input
                value={edit.name}
                placeholder="My friend's server"
                autoFocus
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Address</label>
              <input
                value={edit.ip}
                placeholder="play.example.com or 192.168.1.10:25565"
                onChange={(e) => setEdit({ ...edit, ip: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitEdit()
                }}
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button className="primary" disabled={saving} onClick={() => void submitEdit()}>
                {edit.index != null ? 'Save' : 'Add server'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
