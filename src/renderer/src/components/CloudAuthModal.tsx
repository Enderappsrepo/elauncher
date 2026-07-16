import { useEffect, useState } from 'react'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { IconAlert } from '../icons'

interface Props {
  onClose: () => void
}

export default function CloudAuthModal({ onClose }: Props): React.JSX.Element {
  const { refreshCloud } = useAppState()
  const toast = useToast()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signup') {
        const result = await window.elauncher.cloud.signUp(
          email.trim(),
          password,
          username.trim() || email.trim().split('@')[0]
        )
        if (result.needsConfirmation) {
          toast.success('Account created. Check your email to confirm, then sign in.')
          setMode('signin')
          setBusy(false)
          return
        }
        toast.success(`Welcome, ${result.user?.username}!`)
      } else {
        const user = await window.elauncher.cloud.signIn(email.trim(), password)
        toast.success(`Signed in as ${user.username}`)
      }
      await refreshCloud()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const canSubmit = email.trim().includes('@') && password.length >= 6 && !busy

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'signin' ? 'Sign in to ELauncher' : 'Create an ELauncher account'}</h2>
        <p className="muted small" style={{ margin: '-6px 0 4px' }}>
          Your ELauncher account gives you access to the shared modpack library. It is separate from your
          Microsoft account.
        </p>
        <div className="segmented">
          <button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>
        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        {mode === 'signup' && (
          <div className="field">
            <label>Username</label>
            <input
              value={username}
              placeholder="Shown to other players"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            placeholder="you@example.com"
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            placeholder="At least 6 characters"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && void submit()}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  )
}
