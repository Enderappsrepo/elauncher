import { useEffect, useRef, useState } from 'react'
import { Button, Skeleton } from '@web/ui'
import type { TabProps } from './types'
import './Access.css'

/**
 * Access tab: who else can open this panel.
 *
 * The grants belong to the host account, not to whoever is looking at them, so
 * every change goes over the relay rather than straight at the table. That is
 * what lets someone renting a server invite their own friends to it without ever
 * holding write access to the host's grants — and it is why the host is the one
 * that decides which of the rows below may be revoked.
 */

/** `shares`, and the same shape `share` and `unshare` hand back. */
interface AccessView {
  /** the host account's username */
  owner: string
  people: { id: string; name: string; customer: boolean }[]
}

function Face({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="avatar access-face" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

function Person({
  name,
  meta,
  children
}: {
  name: string
  meta: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="access-person">
      <Face name={name} />
      <span className="access-who">
        <b>{name}</b>
        <i>{meta}</i>
      </span>
      {children}
    </div>
  )
}

export function Access({ row, userId, ask }: TabProps): React.JSX.Element {
  const [view, setView] = useState<AccessView | null>(null)
  const [loadFailed, setLoadFailed] = useState('')

  const [name, setName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteFailed, setInviteFailed] = useState('')
  const [note, setNote] = useState('')

  /** the share whose Remove button has been pressed once */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeFailed, setRevokeFailed] = useState('')

  // The shell is free to rebuild `ask` on every render; the load below must not
  // re-fire when it does.
  const askRef = useRef(ask)
  askRef.current = ask

  useEffect(() => {
    let alive = true
    setView(null)
    setLoadFailed('')
    setNote('')
    setConfirming(null)
    askRef
      .current<AccessView>('shares')
      .then((res) => {
        if (alive) setView(res)
      })
      .catch((e: unknown) => {
        if (alive) setLoadFailed(e instanceof Error ? e.message : 'Could not read who has access.')
      })
    return () => {
      alive = false
    }
  }, [row.server_id])

  async function invite(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const username = name.trim()
    if (!username || inviting) return
    setInviting(true)
    setInviteFailed('')
    setNote('')
    try {
      // the host answers with the whole list, so there is nothing to reconcile
      setView(await ask<AccessView>('share', { username }))
      setName('')
      setNote(`${username} can now manage this server.`)
    } catch (err) {
      setInviteFailed(err instanceof Error ? err.message : 'Could not invite them.')
    } finally {
      setInviting(false)
    }
  }

  async function revoke(shareId: string, who: string): Promise<void> {
    setRevoking(shareId)
    setRevokeFailed('')
    setNote('')
    try {
      setView(await ask<AccessView>('unshare', { shareId }))
      setConfirming(null)
      setNote(`${who} no longer has access.`)
    } catch (e) {
      setRevokeFailed(e instanceof Error ? e.message : 'Could not remove them.')
    } finally {
      setRevoking(null)
    }
  }

  if (loadFailed) {
    return (
      <p className="formerr" role="alert">
        {loadFailed}
      </p>
    )
  }

  if (!view) {
    return (
      <div className="stack">
        <Skeleton height={196} />
        <Skeleton height={172} />
      </div>
    )
  }

  const hosting = row.owner_id === userId

  return (
    <div className="stack">
      <section className="surface pad stack access-group">
        <h2>Who can manage this server</h2>

        <Person
          name={view.owner}
          meta={hosting ? 'You host this server — full control' : 'Hosts this server — full control'}
        >
          <span className="chip">Host</span>
        </Person>

        {view.people.map((p) => (
          <Person
            key={p.id}
            name={p.name}
            meta={
              p.customer
                ? 'This server belongs to them — can invite others'
                : 'Invited — same panel, minus archive and delete'
            }
          >
            {p.customer ? (
              // the host refuses this one unless the asker is the owner or an
              // admin, so it is a label rather than a button that would fail
              <span className="chip">Owner</span>
            ) : confirming === p.id ? (
              <span className="access-confirm">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={revoking === p.id}
                  onClick={() => void revoke(p.id, p.name)}
                >
                  {revoking === p.id ? 'Removing…' : 'Yes, remove'}
                </Button>
                <Button size="sm" variant="ghost" disabled={revoking === p.id} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirming(p.id)
                  setRevokeFailed('')
                  setNote('')
                }}
              >
                Remove
              </Button>
            )}
          </Person>
        ))}

        {confirming && (
          <p className="formnote">
            {view.people.find((p) => p.id === confirming)?.name ?? 'They'} loses this panel for “{row.name}” —
            console, players, settings, files and start/stop all go. Their ELauncher account and anything they built in
            the game are untouched, and you can invite them again at any time.
          </p>
        )}

        {revokeFailed && (
          <p className="formerr" role="alert">
            {revokeFailed}
          </p>
        )}

        {view.people.length === 0 && <p className="dim">Nobody else has access yet.</p>}
      </section>

      <section className="surface pad stack access-group">
        <h2>Invite someone</h2>
        <form className="stack" onSubmit={(e) => void invite(e)}>
          <div className="field">
            <label htmlFor="ac-name">Their ELauncher username</label>
            <input
              id="ac-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="username"
            />
          </div>
          {inviteFailed && (
            <p className="formerr" role="alert">
              {inviteFailed}
            </p>
          )}
          {note && <p className="formnote">{note}</p>}
          <Button variant="primary" block disabled={inviting || !name.trim()}>
            {inviting ? 'Inviting…' : 'Invite'}
          </Button>
        </form>
        <p className="dim access-fine">
          They need an ELauncher account already — invite them by the username they signed up with. Once added, this
          server shows up in their launcher and in this panel: console, players, settings, files and start/stop.
          Archiving and deleting stay with the host.
        </p>
      </section>
    </div>
  )
}
