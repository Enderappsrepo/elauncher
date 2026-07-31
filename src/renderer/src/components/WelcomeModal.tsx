import { useEffect, useState } from 'react'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { IconAlert, IconBox, IconUser, IconWifi } from '../icons'
import logoUrl from '../assets/icon.png'

interface Props {
  onClose: () => void
}

/** Microsoft's four-square brand mark, sized to sit inside the sign-in chip. */
function MicrosoftMark(): React.JSX.Element {
  return (
    <svg className="ms-mark" viewBox="0 0 21 21" width="18" height="18" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

const FEATURES: { icon: React.JSX.Element; title: string; desc: string }[] = [
  { icon: <IconBox size={17} />, title: 'Instances & modpacks', desc: 'Install and manage your whole library in one place.' },
  { icon: <IconUser size={17} />, title: 'Custom skins', desc: 'Preview and apply skins in a couple of clicks.' },
  { icon: <IconWifi size={17} />, title: 'Play together', desc: 'Host or hop into servers with your friends.' }
]

/**
 * First-run onboarding. Minecraft: Java Edition sign-in runs through Microsoft,
 * so before anything else works we welcome the user and hand them a single,
 * obvious way in. Shown once (until dismissed or signed in) — see App.tsx.
 */
export default function WelcomeModal({ onClose }: Props): React.JSX.Element {
  const { login } = useAppState()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await login()
      toast.success('Signed in')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal onboard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboard-hero">
          <div className="onboard-logo">
            <img src={logoUrl} alt="" draggable={false} />
          </div>
          <h2>
            Welcome to <span className="brand-accent">ELauncher</span>
          </h2>
          <p className="muted">
            Sign in with your Microsoft account to play Minecraft: Java Edition, sync your instances,
            and jump into servers with friends.
          </p>
        </div>

        <ul className="onboard-features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="of-ic">{f.icon}</span>
              <div>
                <div className="of-title">{f.title}</div>
                <div className="of-desc">{f.desc}</div>
              </div>
            </li>
          ))}
        </ul>

        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="onboard-actions">
          <button className="ms-signin" disabled={busy} onClick={() => void signIn()}>
            <span className="ms-chip">
              <MicrosoftMark />
            </span>
            {busy ? 'Opening Microsoft sign-in…' : 'Sign in with Microsoft'}
          </button>

          <button className="ghost onboard-skip" disabled={busy} onClick={onClose}>
            Maybe later
          </button>
        </div>

        <p className="onboard-foot">
          Microsoft handles sign-in in a secure window — we never see your password. Don&apos;t own the
          game yet?{' '}
          <a
            href="https://www.minecraft.net/store/minecraft-java-bedrock-edition-pc"
            target="_blank"
            rel="noreferrer"
          >
            Get Java Edition
          </a>
          .
        </p>
      </div>
    </div>
  )
}
