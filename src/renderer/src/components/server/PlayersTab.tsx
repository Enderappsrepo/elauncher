import { useCallback, useEffect, useState } from 'react'
import type { LocalServer, PlayerListEntry } from '@shared/types'
import { useToast } from '../../toast'
import { IconCheck, IconPlus, IconRefresh, IconTrash, IconUsers } from '../../icons'

/** Face thumbnail straight from the public avatar CDN (same one the sidebar uses). */
function Face({ name, uuid }: { name: string; uuid?: string }): React.JSX.Element {
  return (
    <img
      className="player-face"
      src={`https://mc-heads.net/avatar/${uuid?.replace(/-/g, '') ?? encodeURIComponent(name)}/48`}
      alt=""
      loading="lazy"
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}

/** Online players with moderation actions, plus whitelist / ops / bans management. */
export default function PlayersTab({
  server,
  online,
  running
}: {
  server: LocalServer
  online: string[]
  running: boolean
}): React.JSX.Element {
  const toast = useToast()
  const [whitelist, setWhitelist] = useState<PlayerListEntry[] | null>(null)
  const [ops, setOps] = useState<PlayerListEntry[]>([])
  const [banned, setBanned] = useState<PlayerListEntry[]>([])
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(() => {
    window.elauncher.server.players.list(server.id, 'whitelist').then(setWhitelist).catch(console.error)
    window.elauncher.server.players.list(server.id, 'ops').then(setOps).catch(console.error)
    window.elauncher.server.players.list(server.id, 'banned-players').then(setBanned).catch(console.error)
  }, [server.id])

  useEffect(() => refresh(), [refresh])

  const command = async (cmd: string, okMsg: string): Promise<void> => {
    const res = await window.elauncher.server.command(server.id, cmd)
    if (res.ok) {
      toast.success(okMsg)
      // give the server a moment to persist its json files before re-reading
      setTimeout(refresh, 1500)
    } else toast.error(res.error ?? 'Command failed')
  }

  const add = async (): Promise<void> => {
    if (!addName.trim()) return
    setAdding(true)
    try {
      const res = await window.elauncher.server.players.whitelistAdd(server.id, addName)
      if (res.ok) {
        setWhitelist(res.players)
        toast.success(`Whitelisted ${addName.trim()}`)
        setAddName('')
        if (running) setTimeout(refresh, 1500)
      } else toast.error(res.error ?? 'Could not whitelist that player')
    } finally {
      setAdding(false)
    }
  }

  const removeFromWhitelist = async (name: string): Promise<void> => {
    setWhitelist(await window.elauncher.server.players.whitelistRemove(server.id, name))
    toast.success(`Removed ${name} from the whitelist`)
  }

  const opNames = new Set(ops.map((o) => o.name.toLowerCase()))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card settings-section">
        <div className="section-title" style={{ justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 9 }}>
            <IconUsers size={15} /> Online now {online.length > 0 && <span className="faint small">· {online.length}</span>}
          </span>
          <button className="icon-btn" title="Refresh lists" onClick={refresh}>
            <IconRefresh size={14} />
          </button>
        </div>
        {!running ? (
          <div className="hint">Start the server to see and moderate online players.</div>
        ) : online.length === 0 ? (
          <div className="hint">Nobody is online right now.</div>
        ) : (
          <div className="pick-list">
            {online.map((name) => (
              <div key={name} className="pick-row static">
                <Face name={name} />
                <span className="pick-name">
                  {name} {opNames.has(name.toLowerCase()) && <span className="chip on-banner">op</span>}
                </span>
                {opNames.has(name.toLowerCase()) ? (
                  <button className="ghost small" onClick={() => void command(`deop ${name}`, `${name} is no longer an operator`)}>
                    De-op
                  </button>
                ) : (
                  <button className="ghost small" onClick={() => void command(`op ${name}`, `${name} is now an operator`)}>
                    Make op
                  </button>
                )}
                <button className="ghost small" onClick={() => void command(`kick ${name}`, `Kicked ${name}`)}>
                  Kick
                </button>
                <button
                  className="ghost small"
                  style={{ color: 'var(--red)' }}
                  onClick={() => {
                    if (confirm(`Ban ${name} from this server?`)) void command(`ban ${name}`, `Banned ${name}`)
                  }}
                >
                  Ban
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconCheck size={15} /> Whitelist
          </span>
          {whitelist && whitelist.length > 0 && <span className="small faint">{whitelist.length} allowed</span>}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            placeholder="Player name to allow…"
            style={{ flex: 1 }}
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
          />
          <button className="primary" type="submit" disabled={adding || !addName.trim()}>
            <IconPlus size={14} /> {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
        <div className="hint">
          The whitelist only applies when it's turned on in Settings. Names are verified against Mojang, so typos are
          caught here rather than in-game.
        </div>
        {whitelist === null ? (
          <div className="skeleton" style={{ height: 60 }} />
        ) : whitelist.length > 0 ? (
          <div className="pick-list">
            {whitelist.map((entry) => (
              <div key={entry.name} className="pick-row static">
                <Face name={entry.name} uuid={entry.uuid} />
                <span className="pick-name">{entry.name}</span>
                <button className="icon-btn" title="Remove from whitelist" onClick={() => void removeFromWhitelist(entry.name)}>
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {(ops.length > 0 || banned.length > 0) && (
        <div className="card settings-section">
          <div className="section-title">
            <span className="row" style={{ gap: 9 }}>
              <IconUsers size={15} /> Operators & bans
            </span>
          </div>
          {ops.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="small faint">Operators:</span>
              {ops.map((o) => (
                <span key={o.name} className="chip on-banner">
                  {o.name}
                </span>
              ))}
            </div>
          )}
          {banned.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="small faint">Banned:</span>
              {banned.map((b) => (
                <span key={b.name} className="chip" style={{ color: 'var(--red)', background: 'var(--red-soft)' }}>
                  {b.name}
                </span>
              ))}
              {running && (
                <span className="hint">Unban from the console: pardon &lt;name&gt;</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
