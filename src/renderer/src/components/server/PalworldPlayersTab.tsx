import { useCallback, useEffect, useState } from 'react'
import type { LocalServer, PalworldPlayerDetail } from '@shared/types'
import { useToast } from '../../toast'
import { IconUsers, IconX } from '../../icons'

/** Live player list + kick/ban/unban/broadcast for a Palworld server (REST-backed). */
export default function PalworldPlayersTab({
  server,
  running
}: {
  server: LocalServer
  running: boolean
}): React.JSX.Element {
  const toast = useToast()
  const [players, setPlayers] = useState<PalworldPlayerDetail[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [unbanId, setUnbanId] = useState('')
  const [broadcast, setBroadcast] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!running) {
      setPlayers([])
      return
    }
    const res = await window.elauncher.server.pal.players(server.id)
    if (res.ok) setPlayers(res.players)
  }, [server.id, running])

  useEffect(() => {
    setPlayers(null)
    void refresh()
    const timer = setInterval(() => void refresh(), 8000)
    return () => clearInterval(timer)
  }, [refresh])

  const moderate = async (action: 'kick' | 'ban', player: PalworldPlayerDetail): Promise<void> => {
    if (!player.userId) {
      toast.error("This player has no platform id yet — try again in a few seconds.")
      return
    }
    if (!confirm(`${action === 'ban' ? 'Ban' : 'Kick'} ${player.name}?`)) return
    setBusyId(player.userId)
    try {
      const res = await window.elauncher.server.pal.moderate(server.id, action, player.userId)
      if (res.ok) {
        toast.success(`${player.name} ${action === 'ban' ? 'banned' : 'kicked'}`)
        await refresh()
      } else toast.error(res.error ?? `Could not ${action}`)
    } finally {
      setBusyId(null)
    }
  }

  const unban = async (): Promise<void> => {
    const target = unbanId.trim()
    if (!target) return
    const res = await window.elauncher.server.pal.moderate(server.id, 'unban', target)
    if (res.ok) {
      toast.success(`Unbanned ${target}`)
      setUnbanId('')
    } else toast.error(res.error ?? 'Could not unban')
  }

  const announce = async (): Promise<void> => {
    const message = broadcast.trim()
    if (!message) return
    const res = await window.elauncher.server.pal.moderate(server.id, 'announce', message)
    if (res.ok) {
      toast.success('Broadcast sent')
      setBroadcast('')
    } else toast.error(res.error ?? 'Could not broadcast')
  }

  return (
    <>
      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconUsers size={15} /> Online players
          </span>
        </div>
        {!running && <div className="hint">Start the server to see and moderate players.</div>}
        {running && players === null && <div className="skeleton" style={{ height: 80 }} />}
        {running && players !== null && players.length === 0 && <div className="hint">Nobody online right now.</div>}
        {running &&
          (players ?? []).map((p) => (
            <div key={p.userId ?? p.name} className="row" style={{ gap: 10, padding: '7px 0', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{p.name}</div>
                <div className="small faint">
                  {p.level != null ? `Level ${p.level}` : 'Level ?'}
                  {p.ping != null ? ` · ${Math.round(p.ping)} ms` : ''}
                  {p.userId ? ` · ${p.userId}` : ''}
                </div>
              </div>
              <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                <button className="ghost small" disabled={busyId === p.userId} onClick={() => void moderate('kick', p)}>
                  Kick
                </button>
                <button className="danger small" disabled={busyId === p.userId} onClick={() => void moderate('ban', p)}>
                  Ban
                </button>
              </div>
            </div>
          ))}
        {running && (
          <div className="field" style={{ marginTop: 8 }}>
            <label>Broadcast to everyone</label>
            <div className="row" style={{ gap: 6 }}>
              <input
                placeholder="Server maintenance in 10 minutes…"
                value={broadcast}
                onChange={(e) => setBroadcast(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void announce()
                }}
              />
              <button className="ghost" disabled={!broadcast.trim()} onClick={() => void announce()}>
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconX size={15} /> Unban a player
          </span>
        </div>
        <div className="field">
          <label>Platform id (steam_xxxxxxxx)</label>
          <div className="row" style={{ gap: 6 }}>
            <input
              placeholder="steam_76561198…"
              value={unbanId}
              onChange={(e) => setUnbanId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unban()
              }}
            />
            <button className="ghost" disabled={!running || !unbanId.trim()} onClick={() => void unban()}>
              Unban
            </button>
          </div>
          <div className="hint">
            Ban ids appear in the console when you ban someone (and in the player rows above before they're gone).
          </div>
        </div>
      </div>
    </>
  )
}
