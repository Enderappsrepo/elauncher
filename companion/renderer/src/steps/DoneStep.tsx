import { useState } from 'react'
import { Button, Spinner, StatusPill, type RunState } from '@web/ui'
import type { CompanionServer } from '../../../shared/types'
import { PANEL_URL } from '../../../preload/api'
import { message } from '../format'
import { ExternalLink, Notice, StepTitle } from '../ui'

const RUN_STATES: readonly string[] = ['running', 'stopped', 'starting', 'stopping', 'error', 'archived']

export function DoneStep({
  server,
  notice,
  warning,
  onStart,
  onUploadAgain
}: {
  server: CompanionServer
  /** how this upload ended, when it is not the plain "validated" (e.g. the host had finished it earlier) */
  notice?: string
  /** what did not go as asked: a newer load order a finished setup could not take */
  warning?: string
  onStart: () => Promise<void>
  onUploadAgain: () => void
}): React.JSX.Element {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  async function start(): Promise<void> {
    setStarting(true)
    setError('')
    try {
      await onStart()
    } catch (err) {
      setError(message(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="page">
      <StepTitle>Your server is set up</StepTitle>
      <p className="lede">
        Game files are ready on <b>{server.name}</b>.
      </p>
      {notice && <Notice>{notice}</Notice>}
      {warning && <Notice tone="warn">{warning}</Notice>}

      <div className="surface pad stack">
        <div className="row">
          <span className="choice-title">{server.name}</span>
          {RUN_STATES.includes(server.state) && <StatusPill state={server.state as RunState} />}
        </div>
        {server.state === 'stopped' && (
          <div className="actions">
            <Button variant="primary" disabled={starting || !server.hostOnline} onClick={() => void start()}>
              {starting ? 'Starting…' : 'Start server'}
            </Button>
          </div>
        )}
        {starting && <Spinner label="Asking the host to start your server…" />}
        {server.state === 'starting' && <Spinner label="Your server is starting. This can take a minute." />}
        {server.state === 'running' && <Notice>Your server is running.</Notice>}
        {server.state === 'error' && (
          <Notice tone="error">The server stopped with an error. Check its console in the web panel.</Notice>
        )}
        {!server.hostOnline && <Notice tone="warn">The machine hosting this server is offline right now.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>

      <div className="stack">
        <p>
          Players join with the NV:MP launcher’s <b>Connect via IP</b> option, using your server’s address and port. You find both in the{' '}
          <ExternalLink href={PANEL_URL}>web panel</ExternalLink>.
        </p>
        <p className="dim">Every player must use matching DLCs, mods and load order, and the same NV:MP version as the server.</p>
        <p className="dim">To change mods later, stop the server and upload again. Your current files stay until the new ones are checked.</p>
      </div>

      <div className="actions">
        <Button variant="ghost" onClick={onUploadAgain}>
          Upload different files
        </Button>
      </div>
    </section>
  )
}
