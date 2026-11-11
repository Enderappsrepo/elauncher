import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@web/ui'
import type { CompanionServer, GameCandidate, OutsideLink } from '../../shared/types'
import { SIGNED_OUT_MESSAGE, type CompanionLoadOrder, type CompanionProgress, type PendingUpload } from '../../preload/api'
import { approvedFor, blockedReason, chosenServer, doneServer } from './flow'
import { SIGNED_OUT_EVENT, api, message } from './format'
import { Notice } from './ui'
import { CheckStep, type PreparedView } from './steps/CheckStep'
import { DoneStep } from './steps/DoneStep'
import { GameStep, bestGame, type GamesView } from './steps/GameStep'
import { ServerStep, type ServersView } from './steps/ServerStep'
import { OfflineStart, SignIn, type Account } from './steps/SignIn'
import { UploadStep } from './steps/UploadStep'

type Step = 'signin' | 'server' | 'game' | 'check' | 'upload' | 'done'

const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: 'signin', label: 'Sign in' },
  { id: 'server', label: 'Choose your server' },
  { id: 'game', label: 'Your game' },
  { id: 'check', label: 'Check' },
  { id: 'upload', label: 'Upload' },
  { id: 'done', label: 'Done' }
]

const IDLE: CompanionProgress = { state: 'idle', sentBytes: 0, totalBytes: 0 }
const NO_SERVERS: ServersView = { list: [], loading: false, error: '' }
const NO_GAMES: GamesView = { list: [], loading: false, error: '' }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A row read without asking the host carries no phase or edit rights; keep the ones already known. */
const merged = (current: CompanionServer, next: CompanionServer): CompanionServer => ({
  ...current,
  ...next,
  phase: next.phase ?? current.phase,
  canEdit: next.canEdit ?? current.canEdit
})

function Check(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function App(): React.JSX.Element {
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [version, setVersion] = useState('')
  const [step, setStep] = useState<Step>('signin')
  const [servers, setServers] = useState<ServersView>(NO_SERVERS)
  const [server, setServer] = useState<CompanionServer | null>(null)
  const [games, setGames] = useState<GamesView>(NO_GAMES)
  const [game, setGame] = useState<GameCandidate | null>(null)
  const [prepared, setPrepared] = useState<PreparedView | null>(null)
  const [progress, setProgress] = useState<CompanionProgress>(IDLE)
  const [pending, setPending] = useState<PendingUpload | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [editFirst, setEditFirst] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [signInNotice, setSignInNotice] = useState('')
  /** session() failed when the companion started (offline): the stored sign-in is kept and can be tried again */
  const [startError, setStartError] = useState('')
  const gamesAsked = useRef(false)
  const serversNow = useRef(servers)
  serversNow.current = servers

  const busy = progress.running === true
  const lock = progress.lock ?? null

  /** Nothing of one account's servers, games or upload stays on screen for the next. */
  const forgetAccount = useCallback((notice: string) => {
    setAccount(null)
    setServers(NO_SERVERS)
    setServer(null)
    setGames(NO_GAMES)
    setGame(null)
    setPrepared(null)
    setPending(null)
    setProgress(IDLE)
    setUploadError('')
    setEditFirst(false)
    gamesAsked.current = false
    setSignInNotice(notice)
    setStep('signin')
  }, [])

  /** The stored sign-in; offline, it is kept and the window offers to try again rather than the password form. */
  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const found = await api.session()
      setStartError('')
      setAccount(found)
      if (found) setStep('server')
    } catch (err) {
      setStartError(message(err))
    }
  }, [])

  useEffect(() => {
    void api.version().then(setVersion).catch(() => {})
    void checkSession()
    const off = api.onProgress(setProgress)
    void api.progressNow().then(setProgress).catch(() => {})
    return off
  }, [checkSession])

  // offline at start: try the kept sign-in again as soon as Windows reports a connection
  useEffect(() => {
    if (account !== undefined || !startError) return
    const again = (): void => void checkSession()
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [account, startError, checkSession])

  // main refused a call because the sign-in expired (or was revoked from the web panel)
  useEffect(() => {
    const expired = (): void => forgetAccount(SIGNED_OUT_MESSAGE)
    window.addEventListener(SIGNED_OUT_EVENT, expired)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, expired)
  }, [forgetAccount])
  useEffect(() => {
    if (progress.issue === 'signed-out' && progress.state === 'error') forgetAccount(SIGNED_OUT_MESSAGE)
  }, [progress.issue, progress.state, forgetAccount])

  const mergeServer = useCallback((next: CompanionServer) => {
    setServer((cur) => (cur && cur.serverId === next.serverId ? merged(cur, next) : cur))
    setServers((s) => ({ ...s, list: s.list.map((x) => (x.serverId === next.serverId ? merged(x, next) : x)) }))
  }, [])

  const refreshServers = useCallback(async (): Promise<void> => {
    setServers((s) => ({ ...s, loading: true, error: '' }))
    try {
      const list = await api.servers()
      setServers({ list, loading: false, error: '' })
      const usable = list.filter((s) => !blockedReason(s))
      setServer((cur) => (cur ? (list.find((s) => s.serverId === cur.serverId) ?? null) : usable.length === 1 ? usable[0] : null))
    } catch (err) {
      setServers((s) => ({ ...s, loading: false, error: message(err) }))
    }
  }, [])

  const loadGames = useCallback(async (): Promise<void> => {
    gamesAsked.current = true
    setGames((g) => ({ ...g, loading: true, error: '' }))
    try {
      const found = await api.findGames()
      setGames((g) => ({ list: [...found, ...g.list.filter((x) => x.source === 'manual' && !found.some((f) => f.id === x.id))], loading: false, error: '' }))
      setGame((cur) => (cur && (cur.source === 'manual' || found.some((g) => g.id === cur.id)) ? cur : bestGame(found)))
    } catch (err) {
      setGames((g) => ({ ...g, loading: false, error: message(err) }))
    }
  }, [])

  useEffect(() => {
    if (!account) return
    void refreshServers()
    void api.pendingUpload().then(setPending).catch(() => {})
    // this account's own upload state (main never shows one account's upload to another)
    void api.progressNow().then(setProgress).catch(() => {})
  }, [account, refreshServers])

  useEffect(() => {
    if (step === 'game' && !gamesAsked.current) void loadGames()
  }, [step, loadGames])

  // the host's phase follows the upload; the full list is only re-asked when it matters
  useEffect(() => {
    if (!progress.serverId) return
    const phase = progress.state === 'uploading' ? 'uploading' : progress.state === 'ready' ? 'ready' : null
    if (phase) {
      setServer((cur) => (cur && cur.serverId === progress.serverId ? { ...cur, phase } : cur))
      setServers((s) => ({ ...s, list: s.list.map((x) => (x.serverId === progress.serverId ? { ...x, phase } : x)) }))
    }
    if (progress.state === 'ready') {
      // Done is about the server this upload went to, whatever was selected before
      const serverId = progress.serverId
      const uploaded = serversNow.current.list.find((x) => x.serverId === serverId)
      if (uploaded) setServer({ ...uploaded, phase: 'ready' })
      else void api.serverState(serverId).then((row) => row && setServer({ ...row, phase: 'ready' })).catch(() => {})
      // the next upload starts from a fresh check (and the game's own order: the edit belonged to this one)
      setPrepared(null)
      setStep((s) => (s === 'upload' ? 'done' : s))
    }
  }, [progress.state, progress.serverId])

  /** Poll the server's row until it reaches a state, updating the cards on the way. */
  async function follow(serverId: string, reached: (s: CompanionServer) => boolean, ms = 120_000): Promise<CompanionServer | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      await sleep(2500)
      const next = await api.serverState(serverId)
      if (next) mergeServer(next)
      if (next && reached(next)) return next
    }
    return null
  }

  async function stopServer(serverId: string): Promise<void> {
    await api.stop(serverId)
    if (!(await follow(serverId, (s) => s.state === 'stopped'))) {
      throw new Error('The server has not stopped yet. Give it a moment, then try again.')
    }
  }

  async function startServer(serverId: string): Promise<void> {
    await api.start(serverId)
    await follow(serverId, (s) => s.state === 'running' || s.state === 'error')
  }

  async function discard(serverId: string): Promise<void> {
    await api.discard(serverId)
    setPending(null)
    void refreshServers()
  }

  async function forgetUpload(): Promise<void> {
    await api.forgetUpload()
    setPending(null)
    setUploadError('')
    void refreshServers()
  }

  /**
   * approvedLinks: only the outside links of the current Check the player ticked (approvedFor). Main scans
   * again and refuses any link outside the game that is in neither that set nor this job's earlier consent.
   */
  function runUpload(serverId: string, gameId: string, approvedLinks: OutsideLink[]): void {
    setUploadError('')
    setEditFirst(false)
    setPending(null)
    setStep('upload')
    api.upload(serverId, gameId, { approvedLinks }).catch((err: unknown) => setUploadError(message(err)))
  }

  async function resume(saved: PendingUpload): Promise<void> {
    const known = servers.list.find((s) => s.serverId === saved.serverId) ?? (await api.serverState(saved.serverId).catch(() => null))
    if (known) setServer(known)
    runUpload(saved.serverId, saved.gameId, approvedFor(prepared, saved.gameId))
    // so "Check" can show this game's files and load order if the player needs to fix something
    gamesAsked.current = true
    void api
      .findGames()
      .then((found) => {
        setGames({ list: found, loading: false, error: '' })
        setGame(found.find((g) => g.id === saved.gameId) ?? null)
      })
      .catch(() => {})
  }

  async function signOut(): Promise<void> {
    setAccountError('')
    try {
      await api.signOut()
    } catch (err) {
      setAccountError(message(err))
      return
    }
    forgetAccount('')
  }

  // while an upload job holds a server, every step acts on that one
  const chosen = chosenServer(servers.list, server, lock)
  const finished = doneServer(chosen, progress)
  const uploadServer = servers.list.find((s) => s.serverId === progress.serverId) ?? chosen
  const can: Record<Step, boolean> = {
    signin: !account,
    server: !!account,
    game: !!account && !!chosen,
    check: !!account && !!chosen && !!game,
    upload: !!account && (busy || progress.state !== 'idle'),
    done: !!account && !!finished
  }
  const shown: Step = can[step] ? step : account ? 'server' : 'signin'
  const index = STEPS.findIndex((s) => s.id === shown)

  function render(): React.JSX.Element {
    if (account === undefined) {
      if (!startError) return <Spinner label="Starting…" />
      return (
        <OfflineStart
          notice={startError}
          onRetry={checkSession}
          onSignIn={() => {
            setStartError('')
            setAccount(null)
          }}
        />
      )
    }
    switch (shown) {
      case 'signin':
        return (
          <SignIn
            notice={signInNotice}
            onSignedIn={(signedIn) => {
              setSignInNotice('')
              setAccount(signedIn)
              setStep('server')
            }}
          />
        )
      case 'server':
        return (
          <ServerStep
            servers={servers}
            selected={chosen}
            pending={busy ? null : pending}
            lock={lock}
            busy={busy}
            onSelect={setServer}
            onRefresh={() => void refreshServers()}
            onContinue={() => setStep('game')}
            onResume={(saved) => void resume(saved)}
            onGoToUpload={() => setStep('upload')}
            onForget={forgetUpload}
          />
        )
      case 'game':
        return (
          <GameStep
            games={games}
            selected={game}
            onSelect={setGame}
            onAdd={(added) => {
              setGames((g) => ({ ...g, list: [...g.list.filter((x) => x.id !== added.id), added] }))
              setGame(added)
            }}
            onContinue={() => setStep('check')}
          />
        )
      case 'check':
        return (
          <CheckStep
            server={chosen!}
            game={game}
            prepared={prepared}
            progress={progress}
            busy={busy}
            editFirst={editFirst}
            onPrepared={setPrepared}
            onLoadOrder={(loadOrder: CompanionLoadOrder) => setPrepared((p) => (p ? { ...p, loadOrder } : p))}
            onUpload={(approvedLinks) => {
              if (!game) return
              // kept with this scan only: the next Check (or any new scan) starts without consent
              setPrepared((p) => (p && p.gameId === game.id ? { ...p, approvedLinks } : p))
              runUpload(chosen!.serverId, game.id, approvedLinks)
            }}
            onStop={() => stopServer(chosen!.serverId)}
            onDiscard={() => discard(chosen!.serverId)}
            onChooseGame={() => setStep('game')}
          />
        )
      case 'upload':
        return (
          <UploadStep
            server={uploadServer}
            progress={progress}
            actionError={uploadError}
            onPause={() => void api.pause()}
            onResume={() => {
              const serverId = progress.serverId ?? chosen?.serverId
              const gameId = progress.gameId ?? game?.id
              if (serverId && gameId) runUpload(serverId, gameId, approvedFor(prepared, gameId))
            }}
            onRetryNow={() => void api.retryNow()}
            onStop={() => stopServer(progress.serverId ?? chosen!.serverId)}
            onDiscard={async () => {
              await discard(progress.serverId ?? chosen!.serverId)
              setStep(game ? 'check' : 'server')
            }}
            onDiscardAndRestart={async () => {
              const serverId = progress.serverId ?? chosen?.serverId
              const gameId = progress.gameId ?? game?.id
              if (!serverId) return
              await discard(serverId)
              if (gameId) runUpload(serverId, gameId, approvedFor(prepared, gameId))
              else setStep('server')
            }}
            onForget={async () => {
              await forgetUpload()
              setStep('server')
            }}
            onEditLoadOrder={() => {
              // plugins.txt changed since that Check: scan again so the warnings shown are today's
              if (progress.issue === 'edit-leaves-out') setPrepared(null)
              setEditFirst(true)
              setStep(game ? 'check' : 'game')
            }}
            onBackToCheck={() => {
              // the files or links must be looked at again: a fresh scan (which also drops any earlier consent)
              if (progress.issue === 'scan' || progress.issue === 'links') setPrepared(null)
              setStep(game ? 'check' : 'game')
            }}
            onBackToServers={() => setStep('server')}
          />
        )
      case 'done':
        return (
          <DoneStep
            server={finished!}
            notice={progress.state === 'ready' && progress.serverId === finished!.serverId && progress.warning ? progress.message : undefined}
            warning={progress.state === 'ready' && progress.serverId === finished!.serverId ? progress.warning : undefined}
            onStart={() => startServer(finished!.serverId)}
            onUploadAgain={() => setStep('check')}
          />
        )
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          ELauncher NVMP Companion {version && <small>v{version}</small>}
        </span>
        <span className="spacer" />
        {account && (
          <>
            <span className="dim small" title="Signed in">
              {account.email}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </>
        )}
      </header>
      <div className="layout">
        <nav className="steps" aria-label="Setup steps">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`step${i < index ? ' done' : ''}`}
                  aria-current={shown === s.id ? 'step' : undefined}
                  disabled={!can[s.id]}
                  onClick={() => setStep(s.id)}
                >
                  <span className="num" aria-hidden>
                    {i < index ? <Check /> : i + 1}
                  </span>
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
          {busy && shown !== 'upload' && (
            <button type="button" className="step-progress" onClick={() => setStep('upload')}>
              {progress.state === 'retrying' ? 'Upload retrying…' : `Uploading · ${progress.totalBytes ? Math.floor((progress.sentBytes * 100) / progress.totalBytes) : 0}%`}
            </button>
          )}
        </nav>
        <main className="content" id="main">
          {accountError && <Notice tone="error">{accountError}</Notice>}
          {render()}
        </main>
      </div>
    </div>
  )
}
