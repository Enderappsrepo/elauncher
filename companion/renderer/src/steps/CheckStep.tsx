import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@web/ui'
import type { CompanionServer, GameCandidate, OutsideLink } from '../../../shared/types'
import type { CompanionLoadOrder, CompanionPrepared, CompanionProgress } from '../../../preload/api'
import { unfinishedUpload } from '../flow'
import { LOAD_ORDER_SOURCE, api, bytes, message } from '../format'
import { Notice, StepTitle } from '../ui'

/** One Check's result; approvedLinks: the outside links of this very scan the player ticked (a new scan drops them). */
export type PreparedView = CompanionPrepared & { gameId: string; approvedLinks?: OutsideLink[] }

const SHOWN_SKIPPED = 40
/** Where outside links point, by drive and the first two folders: one personal folder stands out among thousands
 * of mod-manager links, and every place the player approves is on screen. */
export function linkPlaces(links: OutsideLink[]): { place: string; count: number }[] {
  const places = new Map<string, { place: string; count: number }>()
  for (const link of links) {
    const parts = link.target.split(/[\\/]+/).filter(Boolean)
    const place = parts.length > 3 ? parts.slice(0, 3).join('\\') + '\\…' : link.target
    const key = place.toLowerCase()
    const hit = places.get(key)
    if (hit) hit.count++
    else places.set(key, { place, count: 1 })
  }
  return [...places.values()].sort((a, b) => b.count - a.count || (a.place < b.place ? -1 : 1))
}

export function uploadLabel(server: CompanionServer, progress: CompanionProgress): string {
  if ((progress.issue === 'load-order' || progress.issue === 'edit-leaves-out') && progress.serverId === server.serverId) return 'Finish setup'
  if (server.phase === 'uploading' || server.phase === 'committing') return 'Resume upload'
  if (server.phase === 'ready') return 'Upload replacement files'
  return 'Upload game files'
}

export function CheckStep({
  server,
  game,
  prepared,
  progress,
  busy,
  editFirst,
  onPrepared,
  onLoadOrder,
  onUpload,
  onStop,
  onDiscard,
  onChooseGame
}: {
  server: CompanionServer
  game: GameCandidate | null
  prepared: PreparedView | null
  progress: CompanionProgress
  busy: boolean
  editFirst: boolean
  onPrepared: (prepared: PreparedView) => void
  onLoadOrder: (loadOrder: CompanionLoadOrder) => void
  /** approvedLinks: the outside links this Check listed, when the player ticked the box for them; else [] */
  onUpload: (approvedLinks: OutsideLink[]) => void
  onStop: () => Promise<void>
  onDiscard: () => Promise<void>
  onChooseGame: () => void
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(editFirst)
  const [draft, setDraft] = useState(prepared?.loadOrder.text ?? '')
  const [draftError, setDraftError] = useState('')
  const [checking, setChecking] = useState(false)
  const [serverBusy, setServerBusy] = useState('')
  const [serverError, setServerError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [outsideOk, setOutsideOk] = useState(false)
  const alive = useRef(true)
  const scanning = useRef(false)
  const editor = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function scan(gameId: string): Promise<void> {
    if (scanning.current) return
    scanning.current = true
    setLoading(true)
    setError('')
    try {
      const result = await api.prepare(gameId)
      if (!alive.current) return
      // main says whether this is the player's kept edit (loadOrder.edited) or the game's own order
      onPrepared({ ...result, gameId })
      setDraft(result.loadOrder.text)
      setOutsideOk(false) // a fresh scan asks again
    } catch (err) {
      if (alive.current) setError(message(err))
    } finally {
      scanning.current = false
      if (alive.current) setLoading(false)
    }
  }

  const stale = !!game && prepared?.gameId !== game.id
  useEffect(() => {
    if (stale && game && !busy) void scan(game.id)
  }, [stale, game, busy])

  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])

  async function checkLoadOrder(text: string | null): Promise<void> {
    setChecking(true)
    setDraftError('')
    try {
      const next = text === null ? await api.useGameLoadOrder() : await api.setLoadOrder(text)
      if (!alive.current) return
      onLoadOrder(next)
      setDraft(next.text)
      setEditing(false)
    } catch (err) {
      if (alive.current) setDraftError(message(err))
    } finally {
      if (alive.current) setChecking(false)
    }
  }

  async function serverAction(label: string, run: () => Promise<void>): Promise<void> {
    setServerBusy(label)
    setServerError('')
    try {
      await run()
      if (alive.current) setConfirmDiscard(false)
    } catch (err) {
      if (alive.current) setServerError(message(err))
    } finally {
      if (alive.current) setServerBusy('')
    }
  }

  if (!game) {
    return (
      <section className="page">
        <StepTitle>Check your files</StepTitle>
        <Notice tone="warn">Choose your Fallout: New Vegas install first.</Notice>
        <div className="actions">
          <Button variant="primary" onClick={onChooseGame}>
            Choose your game
          </Button>
        </div>
      </section>
    )
  }

  const view = stale ? null : prepared
  const stopped = server.state === 'stopped'
  const archived = server.state === 'archived'
  const outside = view?.scan.outsideLinks ?? []
  const blocked =
    !view || view.scan.problems.length > 0 || !stopped || busy || loading || !!serverBusy || editing || (outside.length > 0 && !outsideOk)
  const waiting = unfinishedUpload(server, progress.lock)
  const unfinished = waiting !== null
  const fromPluginsTxt = view?.loadOrder.source === 'timestamps' ? 'Use the game’s order again' : 'Use plugins.txt again'

  return (
    <section className="page">
      <StepTitle>Check your files</StepTitle>
      <p className="lede">
        This is what will be uploaded from <span className="path">{game.data}</span>
        {game.mo2 && <> together with the mods in your Mod Organizer 2 profile <b>{game.mo2.profile}</b></>}.
      </p>

      {progress.state === 'idle' && progress.message && progress.serverId === server.serverId && <Notice>{progress.message}</Notice>}
      {loading && <Spinner label="Reading your game files… Large mod lists take a minute." />}
      {error && <Notice tone="error">{error}</Notice>}

      {view && (
        <>
          <div className="stats">
            <div className="surface stat">
              <b>{view.scan.files.toLocaleString('en-US')}</b>
              <span>files to upload</span>
            </div>
            <div className="surface stat">
              <b>{bytes(view.scan.totalBytes)}</b>
              <span>in total (up to 64 GB, 16 GB per file)</span>
            </div>
            <div className="surface stat">
              <b>{view.loadOrder.plugins.length}</b>
              <span>plugins in the load order</span>
            </div>
          </div>

          {view.scan.problems.length > 0 && (
            <div className="formerr stack" role="alert">
              <b>Fix these before uploading:</b>
              <ul className="plain">
                {view.scan.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {outside.length > 0 && (
            <div className="formwarn stack" role="status">
              <b>Some files come from folders outside your game{game.mo2 ? ' and Mod Organizer 2' : ''}.</b>
              <span>
                These links in Data point somewhere else on your PC. Everything under them would be uploaded to the machine that hosts your
                server. Check that they hold only game files.
              </span>
              <span>They point to {linkPlaces(outside).length === 1 ? 'this place' : 'these places'}:</span>
              <ul className="filelist" aria-label="Places the outside links point to">
                {linkPlaces(outside).map((group) => (
                  <li key={group.place}>
                    {group.place} ({group.count.toLocaleString('en-US')} {group.count === 1 ? 'link' : 'links'})
                  </li>
                ))}
              </ul>
              <span>Every link ({outside.length.toLocaleString('en-US')}):</span>
              <ul className="filelist" aria-label="Links to folders outside the game">
                {outside.map((link) => (
                  <li key={`${link.rel}>${link.target}`}>
                    Data/{link.rel} → {link.target}
                  </li>
                ))}
              </ul>
              <label className="checkline">
                <input type="checkbox" checked={outsideOk} disabled={busy} onChange={(e) => setOutsideOk(e.target.checked)} />
                <span>Upload these files from outside the game folder too</span>
              </label>
            </div>
          )}

          {view.scan.skippedExecutables.length > 0 && (
            <details className="surface pad">
              <summary>
                {view.scan.skippedExecutables.length} executable files are left out. DLL/native plugins (such as NVSE plugins) need host
                assistance.
              </summary>
              <p className="dim small">
                The server only accepts game data and assets. If your group needs these plugins, ask your host to install them.
              </p>
              <ul className="filelist">
                {view.scan.skippedExecutables.slice(0, SHOWN_SKIPPED).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {view.scan.skippedExecutables.length > SHOWN_SKIPPED && (
                  <li className="dim">and {view.scan.skippedExecutables.length - SHOWN_SKIPPED} more</li>
                )}
              </ul>
            </details>
          )}

          <h2>Load order</h2>
          {view.loadOrder.edited ? (
            <div className="formnote stack" role="status">
              <span>
                <b>Using your edited load order</b>, checked against your files. It is sent instead of your game’s own order until this upload
                finishes.
              </span>
              <div className="actions">
                <Button size="sm" disabled={checking || editing} onClick={() => void checkLoadOrder(null)}>
                  {fromPluginsTxt}
                </Button>
              </div>
            </div>
          ) : (
            <p className="dim small">{LOAD_ORDER_SOURCE[view.loadOrder.source]} Players must load the same plugins in the same order.</p>
          )}
          {view.loadOrder.warnings.length > 0 && (
            <div className="formwarn" role="status">
              <ul className="plain">
                {view.loadOrder.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {editing ? (
            <div className="stack">
              <div className="field">
                <label htmlFor="load-order">Plugin load order, one filename per line, starting with FalloutNV.esm</label>
                <textarea
                  id="load-order"
                  ref={editor}
                  className="input textarea"
                  rows={10}
                  value={draft}
                  spellCheck={false}
                  disabled={checking}
                  aria-invalid={!!draftError}
                  aria-describedby={draftError ? 'load-order-error' : undefined}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </div>
              {draftError && (
                <div id="load-order-error" className="formerr" role="alert">
                  {draftError}
                </div>
              )}
              <div className="actions">
                <Button variant="primary" disabled={checking} onClick={() => void checkLoadOrder(draft)}>
                  {checking ? 'Checking…' : 'Check load order'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={checking}
                  onClick={() => {
                    setDraft(view.loadOrder.text)
                    setDraftError('')
                    setEditing(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <ol className="plugins" aria-label="Load order">
                {view.loadOrder.plugins.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ol>
              <div className="actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setDraft(view.loadOrder.text)
                    setEditing(true)
                  }}
                >
                  Edit load order
                </Button>
                {view.loadOrder.timestampOrder && (
                  <Button size="sm" variant="ghost" disabled={checking} onClick={() => void checkLoadOrder(`${view.loadOrder.timestampOrder!.join('\r\n')}\r\n`)}>
                    Use the order of plugin file dates instead
                  </Button>
                )}
              </div>
              {draftError && <Notice tone="error">{draftError}</Notice>}
            </>
          )}
        </>
      )}

      {(!stopped || server.phase === 'ready' || unfinished) && <h2>Your server</h2>}
      {archived && <Notice tone="warn">{server.name} is archived. Ask your host to restore it before uploading game files.</Notice>}
      {!stopped && !archived && (
        <div className="formwarn stack" role="status">
          <span>
            <b>{server.name}</b> is {server.state}. Stop it before uploading; anyone playing on it is disconnected.
          </span>
          <div className="actions">
            <Button size="sm" disabled={!!serverBusy || !server.hostOnline} onClick={() => void serverAction('Stopping the server…', onStop)}>
              Stop server
            </Button>
          </div>
        </div>
      )}
      {server.phase === 'ready' && (
        <p className="dim small">
          This server already has game files. They stay in place until the new upload is checked, then the new files replace them.
        </p>
      )}
      {unfinished && (
        <div className="stack">
          <p className="dim small">
            {waiting === 'unreadable'
              ? 'Your unfinished upload is still on the server, but its host cannot report how far it got (its saved progress may be damaged). If resuming fails, discard it and start again.'
              : 'An unfinished upload is waiting on the server. If these are the same files, the companion resumes it and sends only the missing pieces.'}
          </p>
          {confirmDiscard ? (
            <div className="formwarn stack" role="alert">
              <span>Discard the unfinished upload? Game files installed before it are kept.</span>
              <div className="actions">
                <Button size="sm" variant="danger" disabled={!!serverBusy || !stopped} onClick={() => void serverAction('Discarding the upload…', onDiscard)}>
                  Discard upload
                </Button>
                <Button size="sm" disabled={!!serverBusy} onClick={() => setConfirmDiscard(false)}>
                  Keep upload
                </Button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <Button size="sm" variant="ghost" disabled={!!serverBusy || busy || !stopped} onClick={() => setConfirmDiscard(true)}>
                Discard unfinished upload
              </Button>
            </div>
          )}
        </div>
      )}
      {serverBusy && <Spinner label={serverBusy} />}
      {serverError && <Notice tone="error">{serverError}</Notice>}

      <p className="dim small">
        {editing
          ? 'Check the load order before uploading.'
          : outside.length > 0 && !outsideOk
            ? 'Tick “Upload these files from outside the game folder too” above, or remove those links and check again, before uploading.'
            : 'Uploads travel through your server’s host, so large folders can take hours. Keep the companion open; you can pause and resume.'}
      </p>
      <div className="actions">
        <Button variant="primary" disabled={blocked} onClick={() => onUpload(outsideOk ? outside : [])}>
          {busy ? 'Upload running…' : uploadLabel(server, progress)}
        </Button>
        <Button variant="ghost" disabled={loading || busy} onClick={() => void scan(game.id)}>
          Check again
        </Button>
      </div>
    </section>
  )
}
