import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CloudPack } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatBytes, timeAgo, tileGradient } from '../fmt'
import { IconAlert, IconBox, IconCloud, IconDownload, IconRefresh } from '../icons'
import CloudAuthModal from '../components/CloudAuthModal'

export default function ModpacksPage(): React.JSX.Element {
  const { cloudAvailable, cloudUser, refreshInstances, refreshCloud, packTasks } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()
  const [packs, setPacks] = useState<CloudPack[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [showAuth, setShowAuth] = useState(false)

  const load = useCallback(() => {
    if (!cloudUser) return
    setError(null)
    window.elauncher.cloud
      .listPacks()
      .then(setPacks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [cloudUser])

  useEffect(() => load(), [load])

  const install = async (pack: CloudPack): Promise<void> => {
    setInstalling(pack.id)
    try {
      const instance = await window.elauncher.cloud.install(pack.id)
      await refreshInstances()
      await refreshCloud()
      toast.success(`Installed "${pack.name}"`)
      navigate(`/instances/${instance.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(null)
    }
  }

  if (!cloudAvailable) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconCloud size={28} />
        </div>
        <h2>Cloud not set up</h2>
        <p>
          The shared modpack library needs a one-time setup by the launcher owner. See the Cloud setup
          section of the README.
        </p>
      </div>
    )
  }

  if (!cloudUser) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconCloud size={28} />
        </div>
        <h2>Sign in to see the modpack library</h2>
        <p>One account gives you one-click installs and updates for every shared pack.</p>
        <button className="primary" onClick={() => setShowAuth(true)}>
          Sign in or create account
        </button>
        {showAuth && <CloudAuthModal onClose={() => setShowAuth(false)} />}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Modpacks</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Shared packs published for this launcher. Install or update with one click.
          </p>
        </div>
        <button className="ghost" onClick={() => load()}>
          <IconRefresh size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {packs === null && !error ? (
        <div className="instance-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 180 }} />
          ))}
        </div>
      ) : packs && packs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <IconBox size={28} />
          </div>
          <h2>No modpacks published yet</h2>
          <p>
            {cloudUser.isAdmin
              ? 'Publish one from any instance: open the instance, then Menu > Publish to cloud.'
              : 'Ask an admin to publish the first pack.'}
          </p>
        </div>
      ) : (
        <div className="instance-grid">
          {packs?.map((pack) => {
            const task = packTasks[pack.id]
            return (
              <div key={pack.id} className="instance-card" style={{ cursor: 'default' }}>
                <div className="card-banner" style={{ background: tileGradient(pack.id) }}>
                  <div className="banner-chips">
                    {pack.latestVersion && <span className="chip on-banner">v{pack.latestVersion.version}</span>}
                  </div>
                </div>
                <div className="card-body">
                  <div className="tile" style={{ background: tileGradient(pack.id) }}>
                    {pack.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3>{pack.name}</h3>
                    <div className="row small faint" style={{ gap: 6, marginTop: 3 }}>
                      <span>{pack.minecraftVersion}</span>
                      <span>·</span>
                      <span>
                        Updated {timeAgo(new Date(pack.updatedAt).getTime())}
                        {pack.latestVersion ? ` · ${formatBytes(pack.latestVersion.fileSize)}` : ''}
                      </span>
                    </div>
                    {pack.description && (
                      <p className="muted small" style={{ margin: '6px 0 0' }}>
                        {pack.description}
                      </p>
                    )}
                  </div>
                  {task ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      <div className="row small muted" style={{ justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {task.phase}
                        </span>
                        {task.progress >= 0 && <span>{Math.round(task.progress * 100)}%</span>}
                      </div>
                      <div className="progress-track">
                        <div
                          className={`progress-fill${task.progress < 0 ? ' indeterminate' : ''}`}
                          style={{ width: task.progress >= 0 ? `${Math.round(task.progress * 100)}%` : undefined }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className={`chip loader-${pack.loader}`}>{pack.loader}</span>
                      <button
                        className="primary"
                        style={{ padding: '7px 14px' }}
                        disabled={installing !== null || !pack.latestVersion}
                        onClick={() => void install(pack)}
                      >
                        <IconDownload size={13} /> {installing === pack.id ? 'Installing…' : 'Install'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
