import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@web/lib/supabase'
import './App.css'

type Phase = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'signedIn'; session: Session }

/**
 * Panel shell. Owns exactly one thing — whether we have a cloud session — and
 * hands off to the signed-in app once we do.
 *
 * Resolving the session before first paint is deliberate: the old panel rendered
 * its signed-out state first and then swapped, so every launch on a warm session
 * flashed a sign-in form for a frame. A held frame reads as faster than a
 * corrected one.
 */
export function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setPhase(data.session ? { kind: 'signedIn', session: data.session } : { kind: 'signedOut' })
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return
      setPhase(session ? { kind: 'signedIn', session } : { kind: 'signedOut' })
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden />
          <span className="wordmark">ELauncher</span>
          <span className="chip">Remote</span>
        </div>
      </header>

      <main className="stage">
        {phase.kind === 'loading' && <div className="settle" aria-live="polite" />}
        {phase.kind === 'signedOut' && <SignedOut />}
        {phase.kind === 'signedIn' && <SignedIn email={phase.session.user.email ?? ''} />}
      </main>
    </div>
  )
}

function SignedOut(): React.JSX.Element {
  return (
    <section className="card rise">
      <h1>Sign in</h1>
      <p className="dim">Manage every server you run, from anywhere.</p>
    </section>
  )
}

function SignedIn({ email }: { email: string }): React.JSX.Element {
  return (
    <section className="card rise">
      <h1>Signed in</h1>
      <p className="dim">{email}</p>
    </section>
  )
}
