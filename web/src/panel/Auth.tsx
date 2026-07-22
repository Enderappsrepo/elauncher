import { useState } from 'react'
import { supabase } from '@web/lib/supabase'
import { Button } from '@web/ui'

/**
 * The front door.
 *
 * A real <form> rather than a button with a click handler, which is what the old
 * panel had: it makes Enter submit from any field for free, and it lets password
 * managers recognise the thing as a login and offer to fill and save it. The
 * autocomplete hints matter for the same reason — this panel gets opened on a
 * phone, where nobody wants to type a password by hand.
 *
 * Sign-up carries a username because public.profiles is populated from
 * user_metadata on the auth trigger; an account created without one lands with a
 * blank name everywhere it is shown.
 */
export function Auth(): React.JSX.Element {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const signup = mode === 'up'

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError('')
    setNote('')
    if (signup && !username.trim()) {
      setError('Pick a username first.')
      return
    }
    setBusy(true)
    try {
      if (signup) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim() } }
        })
        if (error) setError(error.message)
        // no session back means the project has email confirmation switched on
        else if (!data.session) setNote('Almost there — confirm the email we just sent, then sign in.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) setError(error.message)
      }
      // the success path is handled by onAuthStateChange in App, so there is one
      // route into the signed-in state whichever way the session arrives
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the cloud.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="surface surface-lift rise auth stack" onSubmit={submit}>
      <div>
        <h1>{signup ? 'Create an account' : 'Sign in'}</h1>
        <p className="dim">Every server you run, from anywhere.</p>
      </div>

      {signup && (
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="How you show up in game"
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete={signup ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={signup ? 'At least 6 characters' : ''}
        />
      </div>

      {error && (
        <p className="formerr" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="formnote" role="status">
          {note}
        </p>
      )}

      <Button type="submit" variant="primary" block disabled={busy}>
        {busy ? 'One moment…' : signup ? 'Create account' : 'Sign in'}
      </Button>

      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setMode(signup ? 'in' : 'up')
          setError('')
          setNote('')
        }}
      >
        {signup ? 'Have an account? Sign in' : 'New here? Create an account'}
      </Button>
    </form>
  )
}
