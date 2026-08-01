import { useEffect, useState } from 'react'
import type { UpdaterStatus } from '@shared/types'
import { formatBytes } from './fmt'
import { IconDownload, IconRefresh, IconSparkles } from './icons'

/** Live launcher-update status: seeds from the main process, then follows pushed events. */
export function useUpdater(): UpdaterStatus | null {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  useEffect(() => {
    window.elauncher.updates.getState().then(setStatus).catch(console.error)
    return window.elauncher.updates.onStatus(setStatus)
  }, [])
  return status
}

export function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.elauncher.app.getVersion().then(setVersion).catch(console.error)
  }, [])
  return version
}

/**
 * Sidebar card that appears once a launcher update exists: shows download
 * progress, then a restart button (or a download link for the portable build).
 */
export function UpdateCard(): React.JSX.Element | null {
  const status = useUpdater()
  if (!status) return null

  if (status.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, status.percent ?? 0))
    return (
      <div className="update-card">
        <div className="update-head">
          <IconSparkles size={15} />
          <span>Update {status.version ? `v${status.version}` : ''}</span>
          <span className="update-pct">{Math.round(pct)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="update-sub">
          Downloading{status.bytesPerSecond ? ` · ${formatBytes(status.bytesPerSecond)}/s` : '…'}
        </div>
      </div>
    )
  }

  if (status.state === 'ready') {
    return (
      <div className="update-card">
        <div className="update-head">
          <IconSparkles size={15} />
          <span>v{status.version} is ready</span>
        </div>
        <button className="update-btn" onClick={() => void window.elauncher.updates.install()}>
          <IconRefresh size={14} /> Restart to update
        </button>
      </div>
    )
  }

  // portable exe and unsigned mac builds can't replace themselves — hand over the download
  if (status.state === 'available' && (status.portable || status.manual)) {
    return (
      <div className="update-card">
        <div className="update-head">
          <IconSparkles size={15} />
          <span>v{status.version} is out</span>
        </div>
        <button className="update-btn" onClick={() => void window.elauncher.updates.openLatest()}>
          <IconDownload size={14} /> Get the update
        </button>
      </div>
    )
  }

  return null
}
