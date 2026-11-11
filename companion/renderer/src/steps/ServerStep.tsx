import { useState } from 'react'
import { Button, Spinner, StatusPill, type RunState } from '@web/ui'
import type { CompanionServer } from '../../../shared/types'
import { PANEL_URL, type CompanionProgress, type PendingUpload } from '../../../preload/api'
import { blockedReason } from '../flow'
import { message } from '../format'
import { ExternalLink, Notice, StepTitle } from '../ui'

export { blockedReason } from '../flow'

const RUN_STATES: readonly string[] = ['running', 'stopped', 'starting', 'stopping', 'error', 'archived']

const PHASE: Record<NonNullable<CompanionServer['phase']>, { label: string; tone: string }> = {
  waiting: { label: 'Waiting for your game files', tone: 'busy' },
  uploading: { label: 'Uploading', tone: 'busy' },
  committing: { label: 'Finishing setup', tone: 'busy' },
  ready: { label: 'Ready', tone: 'running' },
  unknown: { label: 'Status unknown', tone: 'stopped' }
}

export interface ServersView {
  list: CompanionServer[]
  loading: boolean
  error: string
}

/** The upload job that holds the server choice, with what the player can do about it. */
function LockNotice({
  lock,
  servers,
  pending,
  busy,
  onResume,
  onGoToUpload,
  onForget
}: {
  lock: NonNullable<CompanionProgress['lock']>
  servers: ServersView
  pending: PendingUpload | null
  busy: boolean
  onResume: (pending: PendingUpload) => void
  onGoToUpload: () => void
  onForget: () => Promise<void>
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const server = servers.list.find((s) => s.serverId === lock.serverId)
  const gone = !server && !servers.loading && !servers.error
  const name = <b>{lock.serverName}</b>

  async function forget(): Promise<void> {
    setWorking(true)
    setError('')
    try {
      await onForget()
    } catch (err) {
      setError(message(err))
    } finally {
      setWorking(false)
    }
  }

  if (busy) {
    return (
      <div className="formwarn stack" role="status">
        <span>An upload to {name} is running. You can choose another server when it finishes.</span>
        <div className="actions">
          <Button size="sm" onClick={onGoToUpload}>
            Go to the upload
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="formwarn stack" role="status">
      <span>
        {gone ? (
          <>Your upload to {name} did not finish, and that server is no longer on this account. Forget the upload to choose another server.</>
        ) : server?.phase === 'ready' ? (
          <>Your server {name} may have finished your upload while the companion was closed. Check it: nothing is sent again if it already has your files.</>
        ) : (
          <>Your upload to {name} stopped before it finished. Resume it to send only the missing pieces, or forget it to choose another server.</>
        )}
      </span>
      {confirm ? (
        <div className="stack">
          <span>
            Forget this upload? The companion stops offering to resume it. Pieces already on the server stay there until the upload is
            discarded from the Check step or by the host.
          </span>
          <div className="actions">
            <Button size="sm" variant="danger" disabled={working} onClick={() => void forget()}>
              Forget this upload
            </Button>
            <Button size="sm" disabled={working} onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {!gone &&
            (pending ? (
              <Button variant="primary" size="sm" onClick={() => onResume(pending)}>
                {server?.phase === 'ready' ? 'Check and finish' : 'Resume upload'}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={onGoToUpload}>
                Go to the upload
              </Button>
            ))}
          <Button variant={gone ? 'primary' : 'ghost'} size="sm" onClick={() => setConfirm(true)}>
            Forget this upload
          </Button>
        </div>
      )}
      {working && <Spinner label="Forgetting the upload…" />}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  )
}

export function ServerStep({
  servers,
  selected,
  pending,
  lock,
  busy,
  onSelect,
  onRefresh,
  onContinue,
  onResume,
  onGoToUpload,
  onForget
}: {
  servers: ServersView
  selected: CompanionServer | null
  pending: PendingUpload | null
  lock: CompanionProgress['lock']
  busy: boolean
  onSelect: (server: CompanionServer) => void
  onRefresh: () => void
  onContinue: () => void
  onResume: (pending: PendingUpload) => void
  onGoToUpload: () => void
  onForget: () => Promise<void>
}): React.JSX.Element {
  const usable = selected && !blockedReason(selected, lock)
  return (
    <section className="page">
      <StepTitle>Choose your server</StepTitle>
      <p className="lede">Pick the NV:MP server that should receive your game files.</p>

      {lock && (
        <LockNotice
          key={lock.serverId}
          lock={lock}
          servers={servers}
          pending={pending?.serverId === lock.serverId ? pending : null}
          busy={busy}
          onResume={onResume}
          onGoToUpload={onGoToUpload}
          onForget={onForget}
        />
      )}

      {servers.error && <Notice tone="error">{servers.error}</Notice>}
      {servers.loading && <Spinner label="Asking each server’s host for its setup status…" />}

      {!servers.loading && !servers.error && servers.list.length === 0 && (
        <div className="surface pad stack">
          <h2>No NV:MP servers on this account yet</h2>
          <p className="dim">
            Rent an NV:MP server on the <ExternalLink href={PANEL_URL}>eLauncher site</ExternalLink>. Once the host sets it up it appears
            here, waiting for your game files.
          </p>
        </div>
      )}

      {servers.list.length > 0 && (
        <ul className="choices" aria-label="Your NV:MP servers">
          {servers.list.map((server) => {
            const reason = blockedReason(server, lock)
            const phase = PHASE[server.phase ?? 'unknown']
            const unchecked = server.hostOnline && server.canEdit === undefined
            return (
              <li key={server.serverId}>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={selected?.serverId === server.serverId}
                  disabled={!!reason}
                  onClick={() => onSelect(server)}
                >
                  <span className="choice-head">
                    <span className="choice-title">{server.name}</span>
                    {RUN_STATES.includes(server.state) && <StatusPill state={server.state as RunState} />}
                    <span className={`pill ${phase.tone}`}>
                      <span className="dot" aria-hidden />
                      {phase.label}
                    </span>
                  </span>
                  {reason && <span className="warntext">{reason}</span>}
                  {!reason && unchecked && <span className="dim small">Could not check this server right now. You can still try.</span>}
                  {!reason && server.state !== 'stopped' && (
                    <span className="dim small">It is {server.state} now. It has to be stopped before its game files can change.</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="actions">
        <Button variant="primary" disabled={!usable} onClick={onContinue}>
          Continue
        </Button>
        <Button variant="ghost" disabled={servers.loading} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </section>
  )
}
