import { useCallback, useEffect, useState } from 'react'
import type { WorldInfo } from '@shared/types'
import { useToast } from '../toast'
import { formatBytes, timeAgo } from '../fmt'
import { IconArchive, IconFolder, IconGlobe, IconTrash } from '../icons'

export default function WorldsTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const toast = useToast()
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.elauncher.worlds.list(instanceId).then(setWorlds).catch(console.error)
  }, [instanceId])

  useEffect(() => refresh(), [refresh])

  const backup = async (world: WorldInfo): Promise<void> => {
    setBusy(world.folderName)
    const result = await window.elauncher.worlds.backup(instanceId, world.folderName)
    setBusy(null)
    if (result.ok && result.saved) toast.success(`Backed up "${world.name}"`)
    else if (!result.ok) toast.error(result.error ?? 'Backup failed')
  }

  const remove = async (world: WorldInfo): Promise<void> => {
    if (!confirm(`Delete world "${world.name}" permanently? Consider backing it up first — this cannot be undone.`)) return
    await window.elauncher.worlds.remove(instanceId, world.folderName)
    toast.success(`Deleted "${world.name}"`)
    refresh()
  }

  if (worlds === null) {
    return (
      <div className="mod-list">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 78 }} />
        ))}
      </div>
    )
  }

  if (worlds.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconGlobe size={28} />
        </div>
        <h2>No worlds yet</h2>
        <p>Singleplayer worlds you create in this instance will show up here for backup and management.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="muted small" style={{ marginBottom: 14 }}>
        {worlds.length} world{worlds.length === 1 ? '' : 's'} ·{' '}
        {formatBytes(worlds.reduce((sum, w) => sum + w.sizeBytes, 0))} total
      </div>
      <div className="mod-list">
        {worlds.map((world) => (
          <div className="world-row" key={world.folderName}>
            {world.icon ? (
              <img className="world-icon" src={world.icon} alt="" />
            ) : (
              <div className="world-icon-placeholder">
                <IconGlobe size={22} />
              </div>
            )}
            <div className="info" style={{ flex: 1, minWidth: 0 }}>
              <h4 style={{ fontSize: 14, fontWeight: 650 }}>{world.name}</h4>
              <div className="meta" style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
                {world.gameMode && (
                  <span style={{ textTransform: 'capitalize' }}>
                    {world.hardcore ? 'hardcore' : world.gameMode}
                  </span>
                )}
                {world.versionName && <span>{world.versionName}</span>}
                <span>{formatBytes(world.sizeBytes)}</span>
                <span>Played {timeAgo(world.lastPlayed)}</span>
                {world.cheats && <span>cheats on</span>}
              </div>
            </div>
            <button
              className="ghost"
              disabled={busy === world.folderName}
              title="Save a zip backup of this world"
              onClick={() => void backup(world)}
            >
              <IconArchive size={14} /> {busy === world.folderName ? 'Backing up…' : 'Backup'}
            </button>
            <button
              className="icon-btn"
              title="Open world folder"
              onClick={() => void window.elauncher.worlds.openFolder(instanceId, world.folderName)}
            >
              <IconFolder size={15} />
            </button>
            <button className="icon-btn" title="Delete world" onClick={() => void remove(world)}>
              <IconTrash size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
