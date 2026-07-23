import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Copy, Link2, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button, EmptyState, Skeleton } from '@web/ui'
import { AnimatePresence, Collapse, motion } from '@web/ui/motion'
import { supabase } from '@web/lib/supabase'
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

      <InviteLinks row={row} userId={userId} />

      <DiscordCard row={row} userId={userId} />
    </div>
  )
}

/* ============================================================
 * Invite links + applications.
 *
 * Different animal from the grants above: a grant hands someone this panel, an
 * invite link hands someone a public page to *apply to join the game*. The
 * links live in cloud tables with owner-scoped RLS (see
 * supabase/migrations/2026-07-22-invites-and-applications.sql), so this talks
 * to Supabase directly rather than over the relay — the host machine is not
 * involved until an approved player actually connects.
 * ============================================================ */

/** The public page an invite code resolves to. The Pages site serves it for
 *  every panel origin (dev, staged, live), so the canonical URL is fixed. */
const INVITE_BASE = 'https://enderappsrepo.github.io/elauncher/i/?c='

interface Question {
  id: string
  label: string
  type: 'text' | 'textarea' | 'select'
  required: boolean
  options?: string[]
}

interface InviteRow {
  code: string
  headline: string
  description: string
  questions: Question[]
  approval_message: string
  enabled: boolean
  expires_at: string | null
  max_uses: number | null
  uses: number
}

interface AppRow {
  id: string
  code: string
  applicant_name: string
  applicant_email: string
  answers: Record<string, string>
  status: 'pending' | 'approved' | 'denied' | 'appealed'
  owner_note: string
  created_at: string
  /* Discord-native applicants (the bot's /apply) — no profile, no email. These
   * columns arrive with 2026-07-22-discord-bot.sql and are simply absent before
   * it has run, so everything reading them tolerates undefined. */
  discord_user_id?: string | null
  discord_username?: string | null
  appeal_text?: string
  appealed_at?: string | null
}

function toInvite(raw: Record<string, unknown>): InviteRow {
  return {
    code: String(raw.code),
    headline: String(raw.headline ?? ''),
    description: String(raw.description ?? ''),
    questions: Array.isArray(raw.questions) ? (raw.questions as Question[]) : [],
    approval_message: String(raw.approval_message ?? ''),
    enabled: raw.enabled !== false,
    expires_at: (raw.expires_at as string | null) ?? null,
    max_uses: raw.max_uses === null || raw.max_uses === undefined ? null : Number(raw.max_uses),
    uses: Number(raw.uses ?? 0)
  }
}

/** Short, readable, unambiguous-when-read-aloud (no 0/o/1/l). */
function makeCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
  return code
}

function blankInvite(): InviteRow {
  return {
    code: makeCode(),
    headline: '',
    description: '',
    questions: [],
    approval_message: '',
    enabled: true,
    expires_at: null,
    max_uses: null,
    uses: 0
  }
}

function InviteLinks({ row, userId }: { row: TabProps['row']; userId: string }): React.JSX.Element {
  const [invites, setInvites] = useState<InviteRow[] | null>(null)
  const [apps, setApps] = useState<AppRow[]>([])
  const [failed, setFailed] = useState('')
  /** the invite being edited — `null` closed, a row (possibly fresh) open */
  const [editing, setEditing] = useState<InviteRow | null>(null)
  const [isNew, setIsNew] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!userId) return
    setFailed('')
    const [inv, app] = await Promise.all([
      supabase
        .from('server_invites')
        .select('*')
        .eq('owner_id', userId)
        .eq('server_id', row.server_id)
        .order('created_at', { ascending: false }),
      supabase
        .from('server_applications')
        .select('*')
        .eq('owner_id', userId)
        .eq('server_id', row.server_id)
        .order('created_at', { ascending: false })
    ])
    if (inv.error) {
      setFailed(
        /does not exist|schema cache|42P01|PGRST205/i.test(inv.error.message)
          ? 'Invite links need one migration — run supabase/migrations/2026-07-22-invites-and-applications.sql once.'
          : inv.error.message
      )
      setInvites([])
      return
    }
    setInvites((inv.data ?? []).map((r) => toInvite(r as Record<string, unknown>)))
    setApps((app.data ?? []) as unknown as AppRow[])
  }, [userId, row.server_id])

  useEffect(() => {
    setInvites(null)
    setEditing(null)
    void load()
  }, [load])

  // Preview mode has no session, so there is nothing to list — say why.
  if (!userId) {
    return (
      <EmptyState icon={<Link2 size={18} />} title="Invite links">
        Sign in to create shareable invite pages for this server — preview mode has no account to
        own them.
      </EmptyState>
    )
  }

  // an appeal is as much "waiting on you" as a fresh application is
  const pending = apps.filter((a) => a.status === 'pending' || a.status === 'appealed')

  return (
    <>
      <section className="surface pad stack access-group">
        <div className="row">
          <h2>Invite links</h2>
          <span className="spacer" />
          {invites !== null && !editing && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(blankInvite())
                setIsNew(true)
              }}
            >
              <Plus size={15} aria-hidden /> New link
            </Button>
          )}
        </div>

        <p className="dim access-fine">
          A link is a public page friends apply through — your questions, your approval, and the
          join address only after a yes. Anyone with the link sees live status; nobody sees the
          address until approved.
        </p>

        {failed && (
          <p className="formerr" role="alert">
            {failed}
          </p>
        )}

        {invites === null ? (
          <Skeleton height={72} />
        ) : editing ? (
          <InviteEditor
            invite={editing}
            isNew={isNew}
            row={row}
            userId={userId}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              void load()
            }}
          />
        ) : invites.length === 0 && !failed ? (
          <EmptyState
            icon={<Link2 size={18} />}
            title="No links yet"
            action={
              <Button
                variant="primary"
                onClick={() => {
                  setEditing(blankInvite())
                  setIsNew(true)
                }}
              >
                Create the first link
              </Button>
            }
          >
            One link is enough for a whole community — set questions once, hand the same URL to
            everyone.
          </EmptyState>
        ) : (
          <div className="stack">
            <AnimatePresence initial={false}>
              {invites.map((inv) => (
                <motion.div
                  key={inv.code}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <InviteItem
                    invite={inv}
                    pendingCount={pending.filter((a) => a.code === inv.code).length}
                    onEdit={() => {
                      setEditing(inv)
                      setIsNew(false)
                    }}
                    onChanged={load}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      {apps.length > 0 && <Applications apps={apps} invites={invites ?? []} onDecided={load} />}
    </>
  )
}

function InviteItem({
  invite,
  pendingCount,
  onEdit,
  onChanged
}: {
  invite: InviteRow
  pendingCount: number
  onEdit: () => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const url = `${INVITE_BASE}${invite.code}`
  const expired = invite.expires_at !== null && new Date(invite.expires_at) < new Date()
  const full = invite.max_uses !== null && invite.uses >= invite.max_uses
  const closed = !invite.enabled || expired || full
  const why = !invite.enabled ? 'paused' : expired ? 'expired' : full ? 'full' : ''

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success('Invite link copied')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error(`Could not copy — the link is ${url}`)
    }
  }

  async function toggle(): Promise<void> {
    setBusy(true)
    const { error } = await supabase
      .from('server_invites')
      .update({ enabled: !invite.enabled })
      .eq('code', invite.code)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success(invite.enabled ? 'Link paused — the page now says so' : 'Link live again')
    await onChanged()
  }

  async function remove(): Promise<void> {
    setBusy(true)
    const { error } = await supabase.from('server_invites').delete().eq('code', invite.code)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success('Link deleted')
    await onChanged()
  }

  return (
    <div className="invite-item">
      <div className="row">
        <span className="mono invite-code">{invite.code}</span>
        {closed ? (
          <span className="pill stopped">
            <span className="dot" aria-hidden />
            {why}
          </span>
        ) : (
          <span className="pill running">
            <span className="dot" aria-hidden />
            live
          </span>
        )}
        {pendingCount > 0 && <span className="chip">{pendingCount} to review</span>}
        <span className="spacer" />
        <button className="iconbtn" aria-label="Copy invite link" onClick={() => void copy()}>
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
        </button>
      </div>
      {invite.headline && <p className="dim invite-headline">{invite.headline}</p>}
      <p className="dim access-fine">
        {invite.uses}
        {invite.max_uses !== null ? ` of ${invite.max_uses}` : ''} used
        {invite.expires_at
          ? ` · ${expired ? 'expired' : 'expires'} ${new Date(invite.expires_at).toLocaleDateString()}`
          : ''}
        {invite.questions.length > 0
          ? ` · ${invite.questions.length} question${invite.questions.length === 1 ? '' : 's'}`
          : ' · no application — sign in and you are through'}
      </p>
      <div className="row">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle()}>
          {invite.enabled ? 'Pause' : 'Resume'}
        </Button>
        <span className="spacer" />
        {confirming ? (
          <span className="access-confirm">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
              Delete link
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden />
          </Button>
        )}
      </div>
      {confirming && (
        <p className="formnote">
          The page at this link stops working and its {invite.uses} application
          {invite.uses === 1 ? '' : 's'} go with it. People already approved keep playing — this
          only closes the door for new ones.
        </p>
      )}
    </div>
  )
}

function InviteEditor({
  invite,
  isNew,
  row,
  userId,
  onClose,
  onSaved
}: {
  invite: InviteRow
  isNew: boolean
  row: TabProps['row']
  userId: string
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [headline, setHeadline] = useState(invite.headline)
  const [description, setDescription] = useState(invite.description)
  const [questions, setQuestions] = useState<Question[]>(invite.questions)
  const [approval, setApproval] = useState(invite.approval_message)
  const [maxUses, setMaxUses] = useState(invite.max_uses === null ? '' : String(invite.max_uses))
  const [expires, setExpires] = useState(invite.expires_at ? invite.expires_at.slice(0, 10) : '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState('')

  function addQuestion(): void {
    setQuestions((qs) => [
      ...qs,
      { id: `q${Date.now().toString(36)}`, label: '', type: 'text', required: true }
    ])
  }

  function patchQuestion(id: string, patch: Partial<Question>): void {
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)))
  }

  async function save(): Promise<void> {
    setSaving(true)
    setFailed('')
    const kept = questions.filter((q) => q.label.trim())
    const payload = {
      code: invite.code,
      server_id: row.server_id,
      owner_id: userId,
      // denormalised so the public card renders without reaching other tables
      server_name: row.name,
      game: row.game ?? 'minecraft',
      headline: headline.trim(),
      description: description.trim(),
      questions: kept,
      approval_message: approval.trim(),
      enabled: invite.enabled,
      max_uses: maxUses.trim() === '' ? null : Math.max(1, Number(maxUses)),
      expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null
    }
    const { error } = await supabase.from('server_invites').upsert(payload, { onConflict: 'code' })
    setSaving(false)
    if (error) {
      setFailed(error.message)
      return
    }
    toast.success(isNew ? 'Invite link created' : 'Invite link saved')
    onSaved()
  }

  return (
    <div className="stack invite-editor">
      <div className="row">
        <span className="mono invite-code">{invite.code}</span>
        <span className="dim access-fine">{isNew ? 'new link' : 'editing'}</span>
        <span className="spacer" />
        <button className="iconbtn" aria-label="Close editor" onClick={onClose}>
          <X size={15} aria-hidden />
        </button>
      </div>

      <div className="field">
        <label htmlFor="inv-headline">Headline on the page</label>
        <input
          id="inv-headline"
          className="input"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder={`Join ${row.name}`}
        />
      </div>

      <div className="field">
        <label htmlFor="inv-desc">Description</label>
        <textarea
          id="inv-desc"
          className="input invite-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What the server is, the rules, who it's for…"
        />
      </div>

      <div className="field">
        <label>Application questions</label>
        <p className="dim access-fine" style={{ marginTop: -2 }}>
          None — the link admits anyone signed in. Add questions and every applicant waits for
          your yes. If this link also feeds a Discord, the bot can only ask the first five —
          Discord forms stop there.
        </p>
        <AnimatePresence initial={false}>
          {questions.map((q) => (
            <motion.div
              key={q.id}
              className="invite-q"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <input
                className="input"
                value={q.label}
                onChange={(e) => patchQuestion(q.id, { label: e.target.value })}
                placeholder="Your in-game name"
                aria-label="Question"
              />
              <select
                className="input invite-qtype"
                value={q.type}
                onChange={(e) => patchQuestion(q.id, { type: e.target.value as Question['type'] })}
                aria-label="Answer type"
              >
                <option value="text">Short</option>
                <option value="textarea">Long</option>
              </select>
              <button
                className="iconbtn"
                aria-label="Remove question"
                onClick={() => setQuestions((qs) => qs.filter((x) => x.id !== q.id))}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        <Button size="sm" variant="ghost" onClick={addQuestion}>
          <Plus size={14} aria-hidden /> Add a question
        </Button>
      </div>

      <div className="field">
        <label htmlFor="inv-approval">Message approved people see</label>
        <textarea
          id="inv-approval"
          className="input invite-textarea"
          value={approval}
          onChange={(e) => setApproval(e.target.value)}
          placeholder="The join address, your Discord invite, how to get whitelisted…"
        />
        <p className="dim access-fine">
          This is where the join address belongs — the public page never shows it, only a yes
          does.
        </p>
      </div>

      <div className="invite-limits">
        <div className="field">
          <label htmlFor="inv-max">Max uses</label>
          <input
            id="inv-max"
            className="input"
            inputMode="numeric"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="unlimited"
          />
        </div>
        <div className="field">
          <label htmlFor="inv-exp">Expires</label>
          <input
            id="inv-exp"
            className="input"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
      </div>

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      <div className="row">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : isNew ? 'Create link' : 'Save changes'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Applications under this server's links. Deciding calls decide_application()
 * (the security-definer function that stamps who and when), then asks the
 * invite-mail function to send the decision — best-effort, because the decision
 * itself must never hinge on a mail provider being up.
 */
function Applications({
  apps,
  invites,
  onDecided
}: {
  apps: AppRow[]
  invites: InviteRow[]
  onDecided: () => Promise<void>
}): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  /** Answers are stored keyed by question id; the reader wants the question. */
  function labelFor(code: string, key: string): string {
    const q = invites.find((i) => i.code === code)?.questions.find((x) => x.id === key)
    return q?.label ?? key
  }

  const pending = apps.filter((a) => a.status === 'pending' || a.status === 'appealed')
  const decided = apps.filter((a) => a.status === 'approved' || a.status === 'denied')

  async function decide(app: AppRow, approve: boolean): Promise<void> {
    setBusyId(app.id)
    try {
      const { data, error } = await supabase.rpc('decide_application', {
        application_id: app.id,
        approve,
        note: ''
      })
      if (error) throw new Error(error.message)
      const res = data as { ok?: boolean; reason?: string } | null
      if (res && res.ok === false) throw new Error(res.reason ?? 'Could not decide.')
      // Telling the applicant: email for web applicants, the bot (DM + role +
      // review-message update) for Discord ones. Best-effort both ways — the
      // decision stood the moment the row updated. The bot does report things
      // worth surfacing, like a role it cannot assign.
      void supabase.functions
        .invoke(app.discord_user_id ? 'discord-bot' : 'invite-mail', {
          body: { kind: 'decided', applicationId: app.id }
        })
        .then(({ data: out }) => {
          for (const note of (out as { notes?: string[] } | null)?.notes ?? []) toast.warning(note)
        })
        .catch(() => {
          /* a courtesy that failed, not a decision that failed */
        })
      toast.success(
        approve
          ? `${app.applicant_name || 'They'} approved — they see your join message now`
          : `${app.applicant_name || 'They'} denied`
      )
      await onDecided()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not decide.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="surface pad stack access-group">
      <div className="row">
        <h2>Applications</h2>
        {pending.length > 0 && <span className="chip">{pending.length} waiting</span>}
      </div>

      {pending.length === 0 && (
        <p className="dim access-fine">
          Nothing waiting. New applications land here the moment someone submits the form on your
          invite page — or runs /apply in a linked Discord.
        </p>
      )}

      <AnimatePresence initial={false}>
        {pending.map((app) => (
          <motion.div
            key={app.id}
            className="invite-app"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="row">
              <span className="avatar access-face" aria-hidden>
                {(app.applicant_name || '?').charAt(0).toUpperCase()}
              </span>
              <span className="access-who">
                <b>{app.applicant_name || app.discord_username || 'Unnamed account'}</b>
                <i>
                  via <span className="mono">{app.code}</span> ·{' '}
                  {new Date(app.created_at).toLocaleDateString()}
                  {app.discord_user_id ? <> · Discord</> : null}
                </i>
              </span>
              {app.status === 'appealed' && (
                <span className="pill busy">
                  <span className="dot" aria-hidden />
                  appeal
                </span>
              )}
            </div>
            {app.status === 'appealed' && app.appeal_text ? (
              <div className="invite-appeal">
                <b>Their appeal</b>
                <p>{app.appeal_text}</p>
              </div>
            ) : null}
            {Object.keys(app.answers).length > 0 && (
              <dl className="invite-answers">
                {Object.entries(app.answers).map(([k, v]) => (
                  <div key={k}>
                    <dt>{labelFor(app.code, k)}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                disabled={busyId === app.id}
                onClick={() => void decide(app, true)}
              >
                {busyId === app.id ? 'Sending…' : 'Approve'}
              </Button>
              <Button size="sm" disabled={busyId === app.id} onClick={() => void decide(app, false)}>
                Deny
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {decided.length > 0 && (
        <>
          <button className="invite-history" onClick={() => setHistoryOpen((o) => !o)} aria-expanded={historyOpen}>
            {historyOpen ? 'Hide' : 'Show'} decided ({decided.length})
          </button>
          <Collapse open={historyOpen}>
            <div className="stack">
              {decided.map((app) => (
                <div key={app.id} className="row invite-decided">
                  <span className="access-who">
                    <b>{app.applicant_name || app.discord_username || 'Unnamed account'}</b>
                    <i>
                      via <span className="mono">{app.code}</span>
                      {app.discord_user_id ? ' · Discord' : ''}
                    </i>
                  </span>
                  <span className={`pill ${app.status === 'approved' ? 'running' : 'stopped'}`}>
                    <span className="dot" aria-hidden />
                    {app.status}
                  </span>
                </div>
              ))}
            </div>
          </Collapse>
        </>
      )}
    </section>
  )
}

/* ============================================================
 * Discord.
 *
 * The bot brings the same application flow inside a guild: /apply asks this
 * server's invite questions as a modal, moderators approve or deny with buttons
 * in a review channel (or here, in the queue above — same rows), and a yes can
 * grant a role. The bot is an HTTP-interactions app living in the discord-bot
 * edge function; there is no process to run, only a link row to configure.
 *
 * Linking proves guild authority with a claim code: /setup — which Discord only
 * shows to members with Manage Server — mints one, and redeeming it here writes
 * the discord_links row owned by this account. Typing a guild id in a box would
 * have let anyone point someone else's community at their own server.
 * ============================================================ */

interface DiscordLinkRow {
  guild_id: string
  server_id: string
  invite_code: string | null
  approved_role_id: string
  review_channel_id: string
  allow_appeals: boolean
  enabled: boolean
  guild_name: string
}

interface GuildInfo {
  botTop: number
  roles: { id: string; name: string; assignable: boolean }[]
  channels: { id: string; name: string }[]
}

/**
 * Call the discord-bot function and turn its {error} bodies into throws the
 * forms can show. supabase-js buries non-2xx bodies inside error.context.
 */
async function callBot<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('discord-bot', { body })
  if (error) {
    let msg = 'The discord-bot function is unreachable — deploy it first (supabase/DEPLOY-DISCORD.md).'
    const ctx = (error as { context?: Response }).context
    if (ctx) {
      try {
        const parsed = (await ctx.json()) as { error?: string }
        if (parsed?.error) msg = parsed.error
      } catch {
        /* keep the generic message */
      }
    }
    throw new Error(msg)
  }
  return data as T
}

/** The OAuth page that adds the bot to a guild the user manages. The number is
 *  Manage Roles + View Channel + Send Messages + Embed Links, nothing more. */
const botInviteUrl = (appId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=268454912`

function DiscordCard({ row, userId }: { row: TabProps['row']; userId: string }): React.JSX.Element {
  const [links, setLinks] = useState<DiscordLinkRow[] | null>(null)
  const [invites, setInvites] = useState<{ code: string; headline: string }[]>([])
  const [failed, setFailed] = useState('')
  const [appId, setAppId] = useState('')

  const [claim, setClaim] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemFailed, setRedeemFailed] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!userId) return
    setFailed('')
    const [lnk, inv] = await Promise.all([
      supabase
        .from('discord_links')
        .select('*')
        .eq('owner_id', userId)
        .eq('server_id', row.server_id)
        .order('created_at', { ascending: true }),
      supabase
        .from('server_invites')
        .select('code, headline')
        .eq('owner_id', userId)
        .eq('server_id', row.server_id)
    ])
    if (lnk.error) {
      setFailed(
        /does not exist|schema cache|42P01|PGRST205/i.test(lnk.error.message)
          ? 'The Discord bot needs two migrations — run 2026-07-22-discord-bot.sql and 2026-07-22-discord-claims.sql once.'
          : lnk.error.message
      )
      setLinks([])
      return
    }
    setLinks((lnk.data ?? []) as DiscordLinkRow[])
    setInvites((inv.data ?? []) as { code: string; headline: string }[])
  }, [userId, row.server_id])

  useEffect(() => {
    setLinks(null)
    void load()
    // best-effort: the app id only exists to build the "add the bot" URL, and
    // a project without the function deployed simply doesn't offer the link
    if (userId)
      callBot<{ appId?: string }>({ kind: 'meta' })
        .then((m) => setAppId(m.appId ?? ''))
        .catch(() => setAppId(''))
  }, [load, userId])

  async function redeem(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const code = claim.trim().toLowerCase()
    if (!code || redeeming) return
    setRedeeming(true)
    setRedeemFailed('')
    try {
      await callBot({ kind: 'redeem', code, serverId: row.server_id })
      setClaim('')
      toast.success('Discord linked — now pick which invite it should ask')
      await load()
    } catch (err) {
      setRedeemFailed(err instanceof Error ? err.message : 'Could not redeem that code.')
    } finally {
      setRedeeming(false)
    }
  }

  if (!userId) {
    return (
      <EmptyState icon={<Bot size={18} />} title="Discord bot">
        Sign in to connect a Discord — preview mode has no account to own the link.
      </EmptyState>
    )
  }

  return (
    <section className="surface pad stack access-group">
      <div className="row">
        <h2>Discord</h2>
        {links !== null && links.length > 0 && <span className="chip">{links.length} linked</span>}
      </div>

      <p className="dim access-fine">
        Link a Discord and members apply without ever leaving it: /apply asks this server’s invite
        questions, decisions happen with buttons in a review channel (or right here), an approval
        can grant a role, and a denied applicant may appeal once.
      </p>

      {failed && (
        <p className="formerr" role="alert">
          {failed}
        </p>
      )}

      {links === null ? (
        <Skeleton height={72} />
      ) : (
        <>
          {links.map((l) => (
            <GuildConfig key={l.guild_id} link={l} invites={invites} onChanged={load} />
          ))}

          <form className="stack" onSubmit={(e) => void redeem(e)}>
            <div className="field">
              <label htmlFor="dc-claim">
                {links.length === 0 ? 'Link your Discord' : 'Link another Discord'}
              </label>
              <div className="dc-redeem">
                <input
                  id="dc-claim"
                  className="input"
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="claim code from /setup"
                />
                <Button variant="primary" disabled={redeeming || !claim.trim()}>
                  {redeeming ? 'Linking…' : 'Link'}
                </Button>
              </div>
            </div>
            {redeemFailed && (
              <p className="formerr" role="alert">
                {redeemFailed}
              </p>
            )}
          </form>

          <p className="dim access-fine">
            {appId ? (
              <>
                Two steps:{' '}
                <a href={botInviteUrl(appId)} target="_blank" rel="noreferrer">
                  add the bot to your Discord
                </a>{' '}
                (you need Manage Server there), then run <span className="mono">/setup</span> in any
                channel — it answers with a claim code to paste above. The code proves the Discord
                is yours to link.
              </>
            ) : (
              <>
                Two steps: add the bot to your Discord, then run <span className="mono">/setup</span>{' '}
                there — it answers with a claim code to paste above. The bot invite link appears here
                once the discord-bot function is deployed (supabase/DEPLOY-DISCORD.md).
              </>
            )}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * One linked guild's settings. Role and channel come from the bot as dropdowns;
 * when the bot cannot read the guild (kicked, or the function missing) the two
 * fields degrade to raw-id inputs rather than locking the owner out.
 */
function GuildConfig({
  link,
  invites,
  onChanged
}: {
  link: DiscordLinkRow
  invites: { code: string; headline: string }[]
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [info, setInfo] = useState<GuildInfo | null>(null)
  const [infoFailed, setInfoFailed] = useState('')

  const [inviteCode, setInviteCode] = useState(link.invite_code ?? '')
  const [roleId, setRoleId] = useState(link.approved_role_id)
  const [channelId, setChannelId] = useState(link.review_channel_id)
  const [appeals, setAppeals] = useState(link.allow_appeals)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    callBot<GuildInfo>({ kind: 'guildinfo', guildId: link.guild_id })
      .then((g) => {
        if (alive) setInfo(g)
      })
      .catch((e: unknown) => {
        if (alive) setInfoFailed(e instanceof Error ? e.message : 'Could not reach the bot.')
      })
    return () => {
      alive = false
    }
  }, [link.guild_id])

  const dirty =
    inviteCode !== (link.invite_code ?? '') ||
    roleId !== link.approved_role_id ||
    channelId !== link.review_channel_id ||
    appeals !== link.allow_appeals
  const chosenRole = info?.roles.find((r) => r.id === roleId)

  async function save(): Promise<void> {
    setSaving(true)
    const { error } = await supabase
      .from('discord_links')
      .update({
        invite_code: inviteCode || null,
        approved_role_id: roleId,
        review_channel_id: channelId,
        allow_appeals: appeals
      })
      .eq('guild_id', link.guild_id)
    setSaving(false)
    if (error) return void toast.error(error.message)
    toast.success('Discord settings saved')
    await onChanged()
  }

  async function toggle(): Promise<void> {
    setBusy(true)
    const { error } = await supabase
      .from('discord_links')
      .update({ enabled: !link.enabled })
      .eq('guild_id', link.guild_id)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success(link.enabled ? 'Bot paused in that Discord' : 'Bot live again')
    await onChanged()
  }

  async function unlink(): Promise<void> {
    setBusy(true)
    const { error } = await supabase.from('discord_links').delete().eq('guild_id', link.guild_id)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success('Discord unlinked')
    await onChanged()
  }

  return (
    <div className="invite-item">
      <div className="row">
        <Bot size={16} aria-hidden />
        <span className="access-who">
          <b>{link.guild_name || 'Unnamed guild'}</b>
          <i className="mono">{link.guild_id}</i>
        </span>
        {link.enabled ? (
          <span className="pill running">
            <span className="dot" aria-hidden />
            live
          </span>
        ) : (
          <span className="pill stopped">
            <span className="dot" aria-hidden />
            paused
          </span>
        )}
      </div>

      {infoFailed && <p className="formnote">{infoFailed} Role and channel take raw ids meanwhile.</p>}

      <div className="field">
        <label htmlFor={`dc-inv-${link.guild_id}`}>Invite link /apply should use</label>
        <select
          id={`dc-inv-${link.guild_id}`}
          className="input"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
        >
          <option value="">— none (applications closed) —</option>
          {invites.map((i) => (
            <option key={i.code} value={i.code}>
              {i.code}
              {i.headline ? ` — ${i.headline}` : ''}
            </option>
          ))}
        </select>
        {!inviteCode && (
          <p className="dim access-fine">
            /apply stays off until an invite link is chosen — its questions are the application
            form, its approval message is what a yes DMs to them.
          </p>
        )}
      </div>

      <div className="invite-limits">
        <div className="field">
          <label htmlFor={`dc-role-${link.guild_id}`}>Role granted on approval</label>
          {info ? (
            <select
              id={`dc-role-${link.guild_id}`}
              className="input"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">— none —</option>
              {info.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.assignable ? '' : ' (above the bot)'}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`dc-role-${link.guild_id}`}
              className="input"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="role id, or empty"
            />
          )}
        </div>
        <div className="field">
          <label htmlFor={`dc-ch-${link.guild_id}`}>Review channel</label>
          {info ? (
            <select
              id={`dc-ch-${link.guild_id}`}
              className="input"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              <option value="">— none (review here only) —</option>
              {info.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`dc-ch-${link.guild_id}`}
              className="input"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="channel id, or empty"
            />
          )}
        </div>
      </div>

      {chosenRole && !chosenRole.assignable && (
        <p className="formerr" role="alert">
          The bot can’t grant “{chosenRole.name}” — in Discord’s Server Settings → Roles, drag the
          bot’s own role above it.
        </p>
      )}

      <label className="dc-check">
        <input type="checkbox" checked={appeals} onChange={(e) => setAppeals(e.target.checked)} />
        <span>Let a denied applicant appeal once</span>
      </label>

      <div className="row">
        <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle()}>
          {link.enabled ? 'Pause' : 'Resume'}
        </Button>
        <span className="spacer" />
        {confirming ? (
          <span className="access-confirm">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void unlink()}>
              Yes, unlink
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Unlink
          </Button>
        )}
      </div>
      {confirming && (
        <p className="formnote">
          The bot stops answering /apply in “{link.guild_name || link.guild_id}” and its buttons go
          dead. Applications already made stay in the queue above, and the bot itself stays in the
          guild until kicked. Re-linking is /setup + a fresh code.
        </p>
      )}
    </div>
  )
}
