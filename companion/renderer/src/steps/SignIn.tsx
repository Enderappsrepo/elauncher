import { useState, type FormEvent } from 'react'
import { Button } from '@web/ui'
import { OFFLINE_MESSAGE, PANEL_URL } from '../../../preload/api'
import { api, message } from '../format'
import { ExternalLink, Notice, StepTitle } from '../ui'

export interface Account {
  email: string
  userId: string
}

/** notice: why the player is here again (an expired sign-in, or no connection when the companion started). */
export function SignIn({ notice, onSignedIn }: { notice?: string; onSignedIn: (account: Account) => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onSignedIn(await api.signIn(email, password))
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="page narrow" onSubmit={(e) => void submit(e)} noValidate>
      <StepTitle>Sign in</StepTitle>
      <p className="lede">Use the eLauncher account you rented your NV:MP server with.</p>
      {notice && !error && <Notice tone="warn">{notice}</Notice>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          required
        />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="primary" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="dim">
        No account yet? <ExternalLink href={PANEL_URL}>Create an account on the eLauncher site</ExternalLink>, then sign in here.
      </p>
    </form>
  )
}

/**
 * The companion started while the eLauncher cloud could not be reached. The stored sign-in is kept, so the
 * player tries it again (nothing to type) instead of facing the password form; the form stays one click away.
 */
export function OfflineStart({
  notice,
  onRetry,
  onSignIn
}: {
  notice: string
  /** runs session() again: it resolves with the window moving on, or rejects to stay here */
  onRetry: () => Promise<void>
  onSignIn: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  async function retry(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page narrow">
      <StepTitle>{notice === OFFLINE_MESSAGE ? 'Cannot reach the eLauncher cloud' : 'Could not check your sign-in'}</StepTitle>
      <p className="lede">You stay signed in on this PC. Once your connection is back, try again: there is no need to type your password.</p>
      <Notice tone="warn">{notice}</Notice>
      <div className="actions">
        <Button variant="primary" disabled={busy} onClick={() => void retry()}>
          {busy ? 'Trying again…' : 'Try again'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onSignIn}>
          Sign in with your password instead
        </Button>
      </div>
    </section>
  )
}
