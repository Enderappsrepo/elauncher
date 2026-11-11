import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@web/ui'
import type { CompanionServer } from '../../../shared/types'
import type { CompanionProgress, CompanionState } from '../../../preload/api'
import { canResume, retryLine, spokenLine, type SpokenMemory } from '../flow'
import { bytes, eta, message, speed } from '../format'
import { Notice, StepTitle } from '../ui'

const TITLE: Record<CompanionState, string> = {
  idle: 'Upload',
  scanning: 'Getting ready',
  starting: 'Getting ready',
  uploading: 'Uploading your game files',
  pausing: 'Pausing the upload',
  paused: 'Upload paused',
  retrying: 'Waiting for the connection',
  finishing: 'Checking your files',
  ready: 'Upload complete',
  error: 'Upload stopped'
}

/** Re-renders once a second while a retry is counting down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function UploadStep({
  server,
  progress,
  actionError,
  onPause,
  onResume,
  onRetryNow,
  onStop,
  onDiscard,
  onDiscardAndRestart,
  onForget,
  onEditLoadOrder,
  onBackToCheck,
  onBackToServers
}: {
  server: CompanionServer | null
  progress: CompanionProgress
  actionError: string
  onPause: () => void
  onResume: () => void
  onRetryNow: () => void
  onStop: () => Promise<void>
  onDiscard: () => Promise<void>
  onDiscardAndRestart: () => Promise<void>
  onForget: () => Promise<void>
  onEditLoadOrder: () => void
  onBackToCheck: () => void
  onBackToServers: () => void
}): React.JSX.Element {
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const { state, issue } = progress
  const running = state === 'starting' || state === 'scanning' || state === 'uploading' || state === 'finishing' || state === 'pausing'
  const pausable = state === 'uploading' || state === 'starting' || state === 'scanning' || state === 'retrying'
  const percent = progress.totalBytes ? Math.min(100, Math.floor((progress.sentBytes * 100) / progress.totalBytes)) : 0
  const left = eta(progress.totalBytes - progress.sentBytes, progress.bytesPerSecond)
  const now = useNow(state === 'retrying')
  // the one live region: state changes ('Connection lost, retrying', 'Reconnected') and 5 % steps only
  const memory = useRef<SpokenMemory>({ retrying: false })
  const spoken = spokenLine(progress, memory.current)
  memory.current = spoken.memory

  async function act(label: string, run: () => Promise<void>): Promise<void> {
    setWorking(label)
    setError('')
    try {
      await run()
      setConfirmDiscard(false)
    } catch (err) {
      setError(message(err))
    } finally {
      setWorking('')
    }
  }

  return (
    <section className="page">
      <StepTitle>{TITLE[state]}</StepTitle>
      {server && <p className="lede">To {server.name}</p>}
      {/* the only live region: state changes and 5 % steps, never every progress tick or countdown second */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {spoken.line}
      </p>

      {progress.totalBytes > 0 && state !== 'scanning' && (
        <div className="surface pad stack">
          <div className="row">
            <span className="big">{percent}%</span>
            <span className="spacer" />
            <span className="dim">
              {bytes(progress.sentBytes)} of {bytes(progress.totalBytes)}
            </span>
          </div>
          <progress className="meter" value={percent} max={100} aria-label="Game files uploaded" />
          {state === 'uploading' && (
            <span className="dim">
              {progress.bytesPerSecond !== undefined ? speed(progress.bytesPerSecond) : 'Measuring speed…'}
              {left && ` · ${left}`}
            </span>
          )}
          {state === 'uploading' && progress.file && <span className="path">{progress.file}</span>}
        </div>
      )}

      {running && progress.message && <Spinner label={progress.message} />}
      {state === 'retrying' && (
        // not a live region: the countdown changes every second; the sr-only line above says what happened
        <div className="formwarn stack">
          <span>{retryLine(progress, now)}</span>
          <span className="dim">
            {progress.retryReason === 'host'
              ? 'The upload continues by itself once the host’s launcher answers again. Pieces already sent are kept.'
              : 'Check your internet connection. The upload continues by itself once it is back. Pieces already sent are kept.'}
          </span>
        </div>
      )}
      {progress.warning && state !== 'error' && <Notice tone="warn">{progress.warning}</Notice>}
      {state === 'paused' && progress.message && <Notice>{progress.message}</Notice>}
      {(state === 'ready' || state === 'idle') && progress.message && <Notice>{progress.message}</Notice>}
      {state === 'error' && progress.message && <Notice tone="error">{progress.message}</Notice>}
      {actionError && state !== 'error' && <Notice tone="error">{actionError}</Notice>}

      {(state === 'uploading' || state === 'starting' || state === 'scanning' || state === 'retrying') && (
        <Notice>
          Keep the companion open; your PC stays awake while it uploads. If the companion closes, the upload resumes next time from where it
          stopped.
        </Notice>
      )}

      <div className="actions">
        {state === 'retrying' && (
          <Button variant="primary" onClick={onRetryNow}>
            Retry now
          </Button>
        )}
        {pausable && <Button onClick={onPause}>Pause</Button>}
        {(state === 'paused' || state === 'pausing') && (
          <Button variant="primary" disabled={!canResume(progress)} onClick={onResume}>
            Resume upload
          </Button>
        )}
        {state === 'error' && issue === 'not-stopped' && (
          <>
            <Button variant="primary" disabled={!!working} onClick={() => void act('Stopping the server…', onStop)}>
              Stop server
            </Button>
            <Button disabled={!!working} onClick={onResume}>
              Try again
            </Button>
          </>
        )}
        {state === 'error' && issue === 'selection-differs' && !confirmDiscard && (
          <Button variant="danger" onClick={() => setConfirmDiscard(true)}>
            Discard and start again
          </Button>
        )}
        {state === 'error' && issue === 'changed' && (
          <Button variant="primary" onClick={onResume}>
            Upload again
          </Button>
        )}
        {state === 'error' && issue === 'load-order' && (
          <Button variant="primary" onClick={onEditLoadOrder}>
            Edit load order
          </Button>
        )}
        {state === 'error' && issue === 'edit-leaves-out' && (
          <>
            <Button variant="primary" onClick={onResume}>
              Finish with my edit
            </Button>
            <Button onClick={onEditLoadOrder}>Edit load order</Button>
          </>
        )}
        {state === 'error' && (issue === 'scan' || issue === 'links') && (
          <Button variant="primary" onClick={onBackToCheck}>
            Back to your files
          </Button>
        )}
        {state === 'error' && issue === 'no-access' && (
          <Button variant="primary" onClick={onBackToServers}>
            Choose another server
          </Button>
        )}
        {state === 'error' && issue === 'server-gone' && (
          <Button variant="primary" disabled={!!working} onClick={() => void act('Forgetting the upload…', onForget)}>
            Forget this upload
          </Button>
        )}
        {state === 'error' && (issue === 'host-offline' || issue === 'connection' || issue === 'incomplete' || issue === 'other' || !issue) && (
          <Button variant="primary" onClick={onResume}>
            Resume upload
          </Button>
        )}
        {state === 'idle' && (
          <Button variant="primary" onClick={onBackToCheck}>
            Back to your files
          </Button>
        )}
      </div>

      {confirmDiscard && (
        <div className="formwarn stack" role="alert">
          <span>
            Discard the unfinished upload on the server and start again? Pieces already sent are deleted and every file is sent again. Game
            files installed before it are kept.
          </span>
          <div className="actions">
            <Button size="sm" variant="danger" disabled={!!working} onClick={() => void act('Discarding the upload…', onDiscardAndRestart)}>
              Discard and start again
            </Button>
            <Button size="sm" variant="ghost" disabled={!!working} onClick={() => void act('Discarding the upload…', onDiscard)}>
              Only discard
            </Button>
            <Button size="sm" disabled={!!working} onClick={() => setConfirmDiscard(false)}>
              Keep upload
            </Button>
          </div>
        </div>
      )}
      {working && <Spinner label={working} />}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  )
}
