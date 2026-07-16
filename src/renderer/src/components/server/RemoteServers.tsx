import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagedServer } from '@shared/types'
import { useAppState } from '../../state'
import { useToast } from '../../toast'
import { IconCopy, IconGlobe, IconPlay, IconStop, IconUsers } from '../../icons'

const POLL_MS = 8000

/** One shared server, expandable into a live remote console. */
function ManagedRow({ server }: { server: ManagedServer }): React.JSX.Element {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [cmd, setCmd] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight })
  }, [open, server.console])

  const send = async (action: 'start' | 'stop' | 'command', payload?: string): Promise<void> => {
    setBusy(action)
    try {
      const res = await window.elauncher.remote.sendCommand(server.serverId, action, payload)
      if (res.ok) {
        toast.success(
          action === 'command'
            ? 'Command sent'
            : `${action === 'start' ? 'Start' : 'Stop'} request sent to ${server.isMine ? 'your launcher at home' : `${server.ownerName}'s launcher`}`
        )
        if (action === 'command') setCmd('')
      } else toast.error(res.error ?? 'Could not reach the server')
    } finally {
      setBusy(null)
    }
  }

  const running = server.state === 'running' || server.state === 'starting'

  return (
    <div className="managed-server">
      <button className="managed-head" onClick={() => setOpen((o) => !o)}>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="server-item-name">{server.name}</span>
            {server.state === 'running' ? (
              <span className="chip running">
                <span className="dot pulse" /> Online
              </span>
            ) : (
              <span className="chip on-banner">{server.state}</span>
            )}
          </div>
          <div className="small faint" style={{ marginTop: 2 }}>
            {server.isMine ? 'Your PC at home' : `${server.ownerName}'s PC`}
            {server.players.length > 0 && ` · ${server.players.length} online`}
            {server.address && ` · ${server.address}`}
          </div>
        </div>
        <span className="faint small">{open ? 'hide' : 'manage'}</span>
      </button>

      {open && (
        <div className="managed-body">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {running ? (
              <button className="danger small" disabled={busy !== null} onClick={() => void send('stop')}>
                <IconStop size={13} /> Stop
              </button>
            ) : (
              <button className="play small" disabled={busy !== null} onClick={() => void send('start')}>
                <IconPlay size={13} /> Start
              </button>
            )}
            {server.address && (
              <button
                className="ghost small"
                onClick={() => {
                  void navigator.clipboard.writeText(server.address!)
                  toast.success('Address copied')
                }}
              >
                <IconCopy size={13} /> {server.address}
              </button>
            )}
            {server.players.length > 0 && (
              <span className="small faint">
                <IconUsers size={12} /> {server.players.join(', ')}
              </span>
            )}
          </div>
          <div className="log-view managed-console" ref={consoleRef}>
            {server.console ? (
              server.console.split('\n').map((line, i) => (
                <div key={i} className="log-line">
                  {line}
                </div>
              ))
            ) : (
              <span className="faint">No console output yet — it appears while the server runs.</span>
            )}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              if (cmd.trim()) void send('command', cmd.trim())
            }}
          >
            <input
              placeholder={running ? 'Send a command… (say hi, whitelist add Steve)' : 'Start the server to send commands'}
              style={{ flex: 1, fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 12.5 }}
              disabled={!running}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
            />
            <button className="ghost" type="submit" disabled={!running || !cmd.trim() || busy !== null}>
              Send
            </button>
          </form>
          <div className="hint">
            {server.isMine
              ? 'Runs on your PC at home through the cloud relay — the launcher there must be open. Updates every few seconds.'
              : `Runs on ${server.ownerName}'s PC through the cloud relay — their launcher must be open. Updates every few seconds.`}
          </div>
        </div>
      )}
    </div>
  )
}

/** Remote servers: your own hosted on another device, plus ones friends shared with you. */
export default function RemoteServers(): React.JSX.Element | null {
  const { cloudUser } = useAppState()
  const [managed, setManaged] = useState<ManagedServer[] | null>(null)

  const refresh = useCallback(() => {
    if (!cloudUser) {
      setManaged([])
      return
    }
    Promise.all([window.elauncher.remote.listManaged(), window.elauncher.server.list()])
      .then(([remote, local]) => {
        // your own servers hosted on THIS device are already in the list above
        const localIds = new Set(local.map((s) => s.id))
        setManaged(remote.filter((m) => !localIds.has(m.serverId)))
      })
      .catch(() => setManaged([]))
  }, [cloudUser])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  if (!cloudUser || !managed || managed.length === 0) return null

  return (
    <div style={{ marginTop: 28 }}>
      <div className="home-section" style={{ margin: '0 0 14px' }}>
        <h2>
          <IconGlobe size={16} /> Remote servers
        </h2>
        <span className="small faint">{managed.length} server{managed.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {managed.map((server) => (
          <ManagedRow key={server.serverId} server={server} />
        ))}
      </div>
    </div>
  )
}
