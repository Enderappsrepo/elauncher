import { useCallback, useEffect, useState } from 'react'
import type { LocalServer, ServerShare } from '@shared/types'
import { useAppState } from '../../state'
import { useToast } from '../../toast'
import { IconPlus, IconShield, IconTrash, IconUsers } from '../../icons'

/** Grant other launcher users remote-management access to this server. */
export default function AccessTab({ server }: { server: LocalServer }): React.JSX.Element {
  const { cloudAvailable, cloudUser } = useAppState()
  const toast = useToast()
  const [shares, setShares] = useState<ServerShare[] | null>(null)
  const [username, setUsername] = useState('')
  const [granting, setGranting] = useState(false)

  const refresh = useCallback(() => {
    if (!cloudUser) return
    window.elauncher.remote.listShares(server.id).then(setShares).catch(console.error)
  }, [server.id, cloudUser])

  useEffect(() => refresh(), [refresh])

  const grant = async (): Promise<void> => {
    if (!username.trim()) return
    setGranting(true)
    try {
      const res = await window.elauncher.remote.grant(server.id, server.name, username)
      if (res.ok) {
        setShares(res.shares)
        toast.success(`${username.trim()} can now manage this server from their launcher`)
        setUsername('')
      } else toast.error(res.error ?? 'Could not grant access')
    } finally {
      setGranting(false)
    }
  }

  const revoke = async (share: ServerShare): Promise<void> => {
    const res = await window.elauncher.remote.revoke(share.id)
    if (res.ok) {
      toast.success(`Revoked ${share.granteeName}'s access`)
      refresh()
    } else toast.error(res.error ?? 'Could not revoke access')
  }

  if (!cloudUser) {
    return (
      <div className="empty-state" style={{ padding: '48px 20px' }}>
        <div className="empty-icon">
          <IconShield size={28} />
        </div>
        <h2>Sign in to share access</h2>
        <p>
          {cloudAvailable
            ? 'Sign in to your ELauncher account (sidebar) to let trusted friends manage this server from their own launcher.'
            : 'Remote management needs the ELauncher cloud (Supabase) set up — see the README.'}
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640 }}>
      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconShield size={15} /> Remote managers
          </span>
        </div>
        <p className="perf-lead">
          People you add here see this server in their own launcher's Server tab and in the web panel — live console,
          players, settings, files, and start/stop — relayed through your ELauncher cloud. Only you can archive or
          delete it, and you can revoke them anytime.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void grant()
          }}
        >
          <input
            placeholder="Their ELauncher username…"
            style={{ flex: 1 }}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button className="primary" type="submit" disabled={granting || !username.trim()}>
            <IconPlus size={14} /> {granting ? 'Granting…' : 'Grant access'}
          </button>
        </form>
        {shares === null ? (
          <div className="skeleton" style={{ height: 54 }} />
        ) : shares.length === 0 ? (
          <div className="hint">Nobody has access yet.</div>
        ) : (
          <div className="pick-list">
            {shares.map((share) => (
              <div key={share.id} className="pick-row static">
                <span className="pick-icon">
                  <IconUsers size={14} />
                </span>
                <span className="pick-name">{share.granteeName}</span>
                <span className="pick-meta">can start/stop & use the console</span>
                <button className="icon-btn" title="Revoke access" onClick={() => void revoke(share)}>
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="hint">
          Commands are executed by <b>your</b> launcher, so it must be running (the server lives on this PC). If the
          Access tab errors, make sure the latest schema block from supabase/schema.sql has been run.
        </div>
      </div>
    </div>
  )
}
