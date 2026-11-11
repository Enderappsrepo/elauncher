import { stat } from 'fs/promises'
import type { NvmpSetupStatus } from '@shared/nvmpUpload'
import { selectNvmpFiles, transferNvmpFiles, type NvmpSelection } from '@web/panel/nvmpTransfer'
import type { CompanionServer, DataEntry, DataSetScan, GameCandidate, LoadOrderResult, OutsideLink } from '../shared/types'
import {
  OFFLINE_MESSAGE,
  SIGNED_OUT_MESSAGE,
  type CompanionLoadOrder,
  type CompanionPrepared,
  type CompanionProgress,
  type PendingUpload,
  type UploadIssue
} from '../preload/api'
import { scanDataSet, toUploadFiles } from './dataSet'
import { candidateFromFolder, findFalloutNV } from './detect'
import { changedFilePath, isChangedFileError } from './fileReader'
import { normaliseLoadOrder, readLoadOrder } from './loadOrder'
import type { UploadJob } from './jobStore'
import { DENIED_CODE, isNetworkError, isSignedOutError, type Ask } from './relay'

/**
 * The web panel's setup sequence (web/src/panel/tabs/NvmpSetup.tsx) lifted out of React and run
 * in main, where it keeps going while the window is minimised: check the server, scan the game,
 * nvmpBegin (an identical manifest resumes), transfer the missing chunks, nvmpFinish. A lost
 * connection or a silent host is retried on its own; a finish the host carried out but whose answer
 * was lost is recognised by its session instead of being uploaded again.
 */

export interface UploadDeps {
  /** a fresh server_status row: state, hostOnline, ownerId */
  server(serverId: string): Promise<CompanionServer | null>
  /** the signed-in account; rejects with SIGNED_OUT_MESSAGE when the sign-in is gone */
  userId(): Promise<string>
  ask(server: CompanionServer): Promise<Ask>
  command(server: CompanionServer, action: 'start' | 'stop'): Promise<void>
  emit(progress: CompanionProgress): void
  keepAwake(on: boolean): void
  /** saved jobs, one per account (jobStore.ts accountJobs) */
  jobs: { load(userId: string): UploadJob | null; save(job: UploadJob): void; clear(userId: string): void }
  /** automatic retries after a lost connection or a silent host (tests shorten them) */
  retry?: { delaysMs?: number[]; forMs?: number }
}

export type Prepared = CompanionPrepared

export interface UploadOptions {
  /** the links outside the game the window showed and the player ticked: exactly these, nothing found later */
  approvedLinks?: OutsideLink[]
}

const MAX_LOAD_ORDER_BYTES = 65536
/** 5, 15, 30 and 60 s, then every 60 s, for up to 30 minutes without any progress */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000]
const RETRY_FOR_MS = 30 * 60_000

export class UploadError extends Error {
  constructor(readonly issue: UploadIssue, message: string) {
    super(message)
  }
}

const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const codeOf = (error: unknown): unknown => (error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined)
const HOST_SILENT = /^No answer from the machine hosting|host for this server is offline/
const ARCHIVED = 'This server is archived. Ask your host to restore it before changing its game files.'
const NO_ACCESS = 'Only the renting customer or the host can upload game files to this server.'
/** The host's own upload state is beyond resuming: only a discard (which never reads it) gets past it. */
const UNRESUMABLE = /^Upload progress is damaged|^A retried chunk contains different data|^Upload file is missing or incomplete/
/** A file another program holds open (the game, a mod manager, an antivirus scan) or may not be read now. */
const LOCKED_CODES: ReadonlySet<unknown> = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Host and relay messages, sorted into the next step the player can take. */
function classify(error: unknown): UploadError {
  if (error instanceof UploadError) return error
  if (isSignedOutError(error)) return new UploadError('signed-out', SIGNED_OUT_MESSAGE)
  if (isNetworkError(error)) {
    return new UploadError('connection', `${OFFLINE_MESSAGE} Pieces already sent are kept; resume when you are back online.`)
  }
  const text = textOf(error)
  if (/^Stop the server before/.test(text)) return new UploadError('not-stopped', text)
  if (/^Only the host, an admin, or the renting customer/.test(text) || /access was revoked/.test(text)) {
    return new UploadError('no-access', NO_ACCESS)
  }
  // remote.ts refuses everything but restore for an archived server (info and nvmpStatus too)
  if (/server is archived/i.test(text)) return new UploadError('no-access', ARCHIVED)
  if (UNRESUMABLE.test(text)) {
    return new UploadError(
      'selection-differs',
      'The unfinished upload on your server cannot be resumed: the progress it saved is damaged (for example the host shut down while writing it). Discard it and start again. Game files installed before it are kept.'
    )
  }
  if (HOST_SILENT.test(text)) {
    return new UploadError('host-offline', 'The machine hosting this server is not answering. Your progress is saved; resume when it is back online.')
  }
  return new UploadError('other', text)
}

/** What an automatic retry can fix: this PC's connection, or a host that went quiet. */
function retryReason(error: unknown): 'connection' | 'host' | null {
  if (error instanceof UploadError) return null
  if (isSignedOutError(error)) return null
  if (isNetworkError(error)) return 'connection'
  if (HOST_SILENT.test(textOf(error))) return 'host'
  return null
}

/** Backoff for one run: it starts over whenever an attempt got pieces through. */
export class RetryClock {
  private attempt = 0
  private since = 0
  private sentAtLastFailure = -1

  constructor(private readonly delays: number[], private readonly forMs: number) {}

  /** ms to wait before trying again, or null after trying for too long without any progress */
  next(sent: number): number | null {
    const now = Date.now()
    if (sent > this.sentAtLastFailure) {
      this.attempt = 0
      this.since = now
    }
    this.sentAtLastFailure = Math.max(sent, this.sentAtLastFailure)
    if (now - this.since >= this.forMs) return null
    const wait = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 60_000
    this.attempt++
    return wait
  }
}

/** Bytes per second over the last stretch of the upload, not since the start. */
class Rate {
  private samples: Array<[number, number]> = []
  reset(bytes: number): void {
    this.samples = [[Date.now(), bytes]]
  }
  add(bytes: number): number | undefined {
    const now = Date.now()
    this.samples.push([now, bytes])
    while (this.samples.length > 2 && now - this.samples[0][0] > 20_000) this.samples.shift()
    const [t0, b0] = this.samples[0]
    const seconds = (now - t0) / 1000
    return seconds >= 2 ? Math.max(0, (bytes - b0) / seconds) : undefined
  }
}

const linkKey = (link: OutsideLink): string => `${link.rel} -> ${link.target}`
const isDenied = (error: unknown): boolean => codeOf(error) === DENIED_CODE

const summary = (scan: DataSetScan): Prepared['scan'] => ({
  files: scan.entries.length,
  totalBytes: scan.totalBytes,
  skippedExecutables: scan.skippedExecutables,
  problems: scan.problems,
  outsideLinks: scan.outsideLinks ?? []
})

const sameRoot = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

const names = (list: string[]): string =>
  list.length <= 5 ? list.join(', ') : `${list.slice(0, 5).join(', ')} and ${list.length - 5} more`

/** "Your plugins.txt switches on X, which your edited load order leaves out…" */
function leftOutWarning(left: string[], source: LoadOrderResult['source']): string {
  const where = source === 'mo2-profile' ? 'Your Mod Organizer 2 profile' : 'Your plugins.txt'
  return `${where} switches on ${names(left)}, which your edited load order leaves out. Add ${left.length === 1 ? 'it' : 'them'} to your edit, or use plugins.txt again.`
}

/** The player's edit, with a warning for every plugin the game itself would load that the edit leaves out. */
function asEdit(mine: LoadOrderResult, gameOrder: LoadOrderResult): CompanionLoadOrder {
  const listed = new Set(mine.plugins.map((p) => p.toLowerCase()))
  const left = gameOrder.source === 'timestamps' ? [] : gameOrder.plugins.filter((p) => !listed.has(p.toLowerCase()))
  if (!left.length) return { ...mine, edited: true }
  return { ...mine, warnings: [leftOutWarning(left, gameOrder.source), ...mine.warnings], edited: true, leftOut: left }
}

/** Two load-order texts name the same plugins in the same order (line endings, BOM and case aside). */
function sameOrder(a: string, b: string | undefined): boolean {
  const lines = (text: string): string =>
    (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean).join('\n')
  return lines(a) === lines(b ?? '')
}

/** "Data/Mod.esp could not be read (another program has it open). …close them, then <next>" */
function cannotRead(path: string, error: unknown, next: string): UploadError {
  const code = codeOf(error)
  const why = code === 'EBUSY' ? 'another program has it open' : code === 'EPERM' || code === 'EACCES' ? 'Windows refused access to it' : textOf(error)
  return new UploadError('incomplete', `${path} could not be read (${why}). If the game or your mod manager has it open, close them, then ${next}`)
}

/** Has the file changed (size, modified time, or gone) since the scan? */
async function differs(entry: DataEntry): Promise<boolean> {
  try {
    const st = await stat(entry.abs)
    return !st.isFile() || st.size !== entry.size || Math.floor(st.mtimeMs) !== entry.modified
  } catch {
    return true
  }
}

/**
 * The selection with every read watched: the first file that cannot be read stops all transfer workers
 * at once (through onFail) instead of letting the others send the rest of the upload first.
 */
function watchReads(selection: NvmpSelection, onFail: (path: string, error: unknown) => void): NvmpSelection {
  const watchBlob = (blob: Blob, path: string): Blob =>
    new Proxy(blob, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === 'arrayBuffer' || prop === 'text' || prop === 'bytes') {
          return (...args: unknown[]) =>
            (value as (...a: unknown[]) => Promise<unknown>).apply(target, args).catch((error: unknown) => {
              onFail(path, error)
              throw error
            })
        }
        return (value as (...a: unknown[]) => unknown).bind(target)
      }
    })
  const files = new Map<string, File>()
  for (const [path, file] of selection.files) {
    files.set(
      path,
      new Proxy(file, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target)
          if (typeof value !== 'function') return value
          if (prop === 'slice') {
            return (...args: unknown[]) => {
              try {
                return watchBlob((value as (...a: unknown[]) => Blob).apply(target, args), path)
              } catch (error) {
                onFail(path, error)
                throw error
              }
            }
          }
          return (value as (...a: unknown[]) => unknown).bind(target)
        }
      })
    )
  }
  return { ...selection, files }
}

interface Current {
  game: GameCandidate
  scan: DataSetScan
  loadOrder: CompanionLoadOrder
  /** the game's own order (plugins.txt, the MO2 profile, or file dates) when this was checked */
  gameOrder: LoadOrderResult
  /** a saved edit that no longer fits the files: kept, never silently replaced; the finish asks for a fix */
  invalidEdit?: string
}

interface RunContext {
  ask: Ask
  server: CompanionServer
  current: Current
  selection: NvmpSelection
  allowedLinks?: string[]
  stop: AbortController
  /** the session this run sent nvmpFinish for: ready with it means done, even with no saved job */
  finishing?: string
  /** set when the host turned out to have finished already (its answer to an earlier finish was lost) */
  earlier?: NvmpSetupStatus
}

export class UploadController {
  private readonly games = new Map<string, GameCandidate>()
  /** where a discarded job's game was, so "Discard and start again" after a restart finds a chosen folder again */
  private readonly discardedGames = new Map<string, UploadJob>()
  /** the player's load-order edit per game, until the upload it belongs to finishes */
  private readonly edits = new Map<string, string>()
  /** per game, the plugins the window was shown as "left out by your edit" (lower case) */
  private readonly toldLeftOut = new Map<string, Set<string>>()
  private current: Current | null = null
  private running: Promise<void> | null = null
  private abort: AbortController | null = null
  private progress: CompanionProgress = { state: 'idle', sentBytes: 0, totalBytes: 0 }
  private readonly rate = new Rate()
  private lastEmit = 0
  /** whose upload state this is: another account never sees or resumes it */
  private account: string | null = null
  /** the account the running job belongs to, once its run has checked the sign-in */
  private runAccount: string | null | undefined = undefined
  private runServerName = ''
  /** each account's saved job, as loaded or last saved */
  private readonly jobs = new Map<string, UploadJob | null>()
  private wake: (() => void) | null = null

  constructor(private readonly deps: UploadDeps) {}

  /** True from the first check until the job pauses, fails or finishes. */
  get busy(): boolean {
    return this.running !== null
  }

  /** A job is running but was told to stop (paused, or its account signed out) and is settling. */
  get stopping(): boolean {
    return this.running !== null && this.abort?.signal.aborted === true
  }

  /** Resolves once no job is running any more. */
  async settled(): Promise<void> {
    while (this.running) await this.running.catch(() => {})
  }

  /**
   * Before another sign-in takes over: a run whose account was signed out is still settling (pieces in
   * flight land for up to a minute), so wait for it, and nothing of it reaches the next account. A run that
   * was not told to stop belongs to the signed-in account: pause it first.
   */
  async beforeSignIn(): Promise<void> {
    if (this.busy && !this.stopping) throw new Error('Pause the upload before signing in again.')
    await this.settled()
  }

  /** The running job belongs to the signed-in account (or has not checked whose it is yet). */
  private ownRun(): boolean {
    return this.runAccount === undefined || this.runAccount === this.account
  }

  snapshot(): CompanionProgress {
    // the last account's run is still settling (its sign-in was lost): the next account sees none of it
    if (this.running && !this.ownRun()) return { state: 'idle', sentBytes: 0, totalBytes: 0, running: false, lock: this.lock() }
    return { ...this.progress, running: this.running !== null, lock: this.lock() }
  }

  // ---------- the saved job, only ever the signed-in account's ----------

  private jobOf(userId: string | null | undefined): UploadJob | null {
    if (!userId) return null
    if (!this.jobs.has(userId)) this.jobs.set(userId, this.deps.jobs.load(userId))
    const job = this.jobs.get(userId) ?? null
    return job && job.userId === userId ? job : null
  }

  /** The signed-in account's saved job. */
  private job(): UploadJob | null {
    return this.jobOf(this.account)
  }

  /** Inside a run: the saved job of the account that started it, even while a sign-out is landing. */
  private runJob(): UploadJob | null {
    return this.jobOf(this.runAccount)
  }

  private saveJob(job: UploadJob): void {
    if (!job.userId) return
    this.deps.jobs.save(job)
    this.jobs.set(job.userId, job)
  }

  private clearJob(userId: string | null | undefined): void {
    if (!userId || !this.jobOf(userId)) return
    this.deps.jobs.clear(userId)
    this.jobs.set(userId, null)
  }

  /** The server an upload job holds: the running one's, else the saved unfinished one's. */
  private lock(): CompanionProgress['lock'] {
    const job = this.job()
    if (this.running && this.progress.serverId && this.ownRun()) {
      const serverId = this.progress.serverId
      return { serverId, serverName: job?.serverId === serverId ? job.serverName : this.runServerName || 'your server' }
    }
    if (!job) return null
    return job.session ? { serverId: job.serverId, serverName: job.serverName, canDiscard: true } : { serverId: job.serverId, serverName: job.serverName }
  }

  pending(): PendingUpload | null {
    const job = this.job()
    return job && { serverId: job.serverId, serverName: job.serverName, gameId: job.gameId, gameRoot: job.gameRoot, startedAt: job.startedAt }
  }

  /** Sign-in, sign-out or an expired sign-in: nothing of one account's upload is shown to the next. */
  setAccount(userId: string | null): void {
    if (userId === this.account) return
    this.account = userId
    // a running job stops; upload() resets once it has settled
    if (this.running) this.abort?.abort()
    else this.reset()
  }

  private reset(): void {
    this.current = null
    this.edits.clear()
    this.toldLeftOut.clear()
    this.discardedGames.clear()
    this.progress = { state: 'idle', sentBytes: 0, totalBytes: 0 }
    this.deps.emit(this.snapshot())
  }

  /** Stop offering the saved upload (its server is gone, or the player gave up on it). The server keeps any pieces. */
  forget(): void {
    if (this.running) throw new Error('Pause the upload before forgetting it.')
    this.clearJob(this.account)
    this.progress = { state: 'idle', sentBytes: 0, totalBytes: 0 }
    this.set({})
  }

  /** While waiting to retry: go now. */
  retryNow(): void {
    this.wake?.()
  }

  private set(next: Partial<CompanionProgress>, force = true): void {
    this.progress = { ...this.progress, ...next }
    const now = Date.now()
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.deps.emit(this.snapshot())
  }

  private remember(games: GameCandidate[]): GameCandidate[] {
    for (const game of games) this.games.set(game.id, game)
    return games
  }

  async findGames(): Promise<GameCandidate[]> {
    return this.remember(await findFalloutNV())
  }

  async gameFromFolder(folder: string): Promise<GameCandidate | null> {
    const game = await candidateFromFolder(folder)
    if (game) this.remember([game])
    return game
  }

  /** After a restart only the saved job knows where a manually chosen folder was. */
  private async resolveGame(gameId: string, saved: UploadJob | null): Promise<GameCandidate> {
    const known = this.games.get(gameId)
    if (known) return known
    const found = (await this.findGames()).find((g) => g.id === gameId)
    if (found) return found
    const job = saved?.gameId === gameId ? saved : (this.discardedGames.get(gameId) ?? null)
    if (job) {
      const again = await this.gameFromFolder(job.mo2Instance ?? job.gameRoot)
      if (again && sameRoot(again.root, job.gameRoot) && again.mo2?.profile === job.mo2Profile) return again
    }
    throw new UploadError('scan', 'That game folder is no longer available. Choose your Fallout: New Vegas folder again.')
  }

  /** What the window shows of a load order: its "left out by your edit" plugins count as told. */
  private shown(gameId: string, loadOrder: CompanionLoadOrder): CompanionLoadOrder {
    if (loadOrder.leftOut?.length) {
      const told = this.toldLeftOut.get(gameId) ?? new Set<string>()
      for (const plugin of loadOrder.leftOut) told.add(plugin.toLowerCase())
      this.toldLeftOut.set(gameId, told)
    }
    return loadOrder
  }

  /** Plugins the edit leaves out that the player has not been shown yet. */
  private untold(gameId: string, loadOrder: CompanionLoadOrder): string[] {
    const told = this.toldLeftOut.get(gameId)
    return (loadOrder.leftOut ?? []).filter((plugin) => !told?.has(plugin.toLowerCase()))
  }

  /**
   * The game's own order, or the player's edit (flagged `edited`) while one is kept for this game: in
   * memory, or in the saved job after a restart. An edit that no longer fits the files is never silently
   * replaced: on the Check step it is dropped with a warning the player sees; during an upload it is kept
   * and the finish asks for a fix.
   */
  private async loadOrderFor(game: GameCandidate, scan: DataSetScan, during: 'check' | 'upload', job: UploadJob | null): Promise<Current> {
    const gameOrder = await readLoadOrder(game, scan)
    const saved = job?.gameId === game.id ? job.loadOrderText : undefined
    const edit = this.edits.get(game.id) ?? saved
    if (!edit) return { game, scan, gameOrder, loadOrder: { ...gameOrder, edited: false } }
    try {
      const mine = normaliseLoadOrder(edit, scan)
      this.edits.set(game.id, edit) // after a restart only the job had it; the next job save keeps it
      return { game, scan, gameOrder, loadOrder: asEdit(mine, gameOrder) }
    } catch (error) {
      const problem = textOf(error)
      if (during === 'upload') {
        this.edits.set(game.id, edit)
        return { game, scan, gameOrder, loadOrder: { ...gameOrder, edited: false }, invalidEdit: problem }
      }
      this.edits.delete(game.id)
      if (saved && job) this.saveJob({ ...job, loadOrderText: undefined })
      const warning = `Your edited load order no longer fits these files, so the game's order is shown again: ${problem.split('\n')[0]}`
      return { game, scan, gameOrder, loadOrder: { ...gameOrder, edited: false, warnings: [warning, ...gameOrder.warnings] } }
    }
  }

  async prepare(gameId: string): Promise<Prepared> {
    // the last account's run may still be settling after its sign-in was lost
    if (this.stopping && !this.ownRun()) await this.settled()
    if (this.busy) throw new Error('Pause the upload before checking another game folder.')
    const job = this.job()
    const game = await this.resolveGame(gameId, job)
    const scan = await scanDataSet(game)
    this.current = await this.loadOrderFor(game, scan, 'check', job)
    return { scan: summary(scan), loadOrder: this.shown(game.id, this.current.loadOrder) }
  }

  /** Validated against the files that will actually be sent; also allowed mid-upload, before the finish. */
  setLoadOrder(text: string): CompanionLoadOrder {
    const current = this.current
    if (!current) throw new Error('Check your game files first.')
    if (Buffer.byteLength(text, 'utf8') > MAX_LOAD_ORDER_BYTES) throw new Error('The load order is too large.')
    current.loadOrder = asEdit(normaliseLoadOrder(text, current.scan), current.gameOrder)
    current.invalidEdit = undefined
    this.edits.set(current.game.id, text)
    const job = this.job()
    if (job?.gameId === current.game.id) this.saveJob({ ...job, loadOrderText: text })
    return this.shown(current.game.id, current.loadOrder)
  }

  /** Drop the player's edit (here and in the saved job) and read the game's own order again. */
  async useGameLoadOrder(): Promise<CompanionLoadOrder> {
    const current = this.current
    if (!current) throw new Error('Check your game files first.')
    this.edits.delete(current.game.id)
    const job = this.job()
    if (job?.gameId === current.game.id && job.loadOrderText) this.saveJob({ ...job, loadOrderText: undefined })
    current.gameOrder = await readLoadOrder(current.game, current.scan)
    current.loadOrder = { ...current.gameOrder, edited: false }
    current.invalidEdit = undefined
    return current.loadOrder
  }

  async upload(serverId: string, gameId: string, opts: UploadOptions = {}): Promise<void> {
    // Resume pressed while a pause is still settling: let it settle, then go again.
    if (this.running && this.abort?.signal.aborted) await this.running.catch(() => {})
    if (this.running) {
      // a second Resume click for the same upload joins the one already going
      if (this.ownRun() && this.progress.serverId === serverId && this.progress.gameId === gameId) return this.running
      throw new Error('An upload is already running.')
    }
    const held = this.job()
    if (held && held.serverId !== serverId) {
      throw new Error(`Your upload to ${held.serverName} is not finished. Resume, discard or forget it before uploading to another server.`)
    }
    const approved = new Set((opts.approvedLinks ?? []).map(linkKey))
    this.runAccount = undefined
    const job = this.run(serverId, gameId, approved)
    this.running = job
    this.deps.emit(this.snapshot())
    try {
      await job
    } finally {
      this.running = null
      this.abort = null
      this.wake = null
      this.deps.keepAwake(false)
      // signed out (or another account signed in) while it ran: show that account nothing of it
      if (this.runAccount !== undefined && this.runAccount !== this.account) this.reset()
      else this.deps.emit(this.snapshot())
    }
  }

  async pause(): Promise<void> {
    if (!this.running || !this.abort || this.abort.signal.aborted) return
    this.abort.abort()
    const sending = this.progress.state === 'uploading' || this.progress.state === 'finishing'
    this.set({
      state: 'pausing',
      bytesPerSecond: undefined,
      retryAt: undefined,
      retryReason: undefined,
      message: sending ? 'Finishing the pieces already on their way (up to a minute)…' : 'Pausing…'
    })
  }

  private paused(): void {
    const kept = this.runJob() ? ' Finished pieces are saved on your server; resume any time.' : ' Resume any time.'
    this.set({ state: 'paused', file: undefined, bytesPerSecond: undefined, retryAt: undefined, retryReason: undefined, message: `Paused.${kept}` })
  }

  /**
   * The upload is finished on the server. `earlier`: the host had finished it before (the answer to that
   * finish was lost) with a load order other than the one the player has now; the edit is kept for the next
   * upload and the player is told, never "validated" as if their newer order had been applied.
   */
  private done(gameId: string, earlier?: { message: string; warning: string }): void {
    this.clearJob(this.runAccount)
    if (!earlier) {
      this.edits.delete(gameId) // the edit belonged to this upload; the next one starts from the game's order
      this.toldLeftOut.delete(gameId)
    }
    this.set({
      state: 'ready',
      issue: undefined,
      file: undefined,
      bytesPerSecond: undefined,
      retryAt: undefined,
      retryReason: undefined,
      message: earlier?.message ?? 'Game files validated. You can start your server now.',
      warning: earlier?.warning
    })
  }

  /**
   * The host had already finished this upload: its answer to the finish was lost (relay timeout, or the
   * window closed while finishing). Nothing is sent again, and the saved job is cleared so later uploads to
   * this server run normally. The host keeps a finished setup as it is, so a load order the player chose
   * after that finish cannot be applied by finishing again: they are told, and their edit is kept.
   */
  private finishedEarlier(status: NvmpSetupStatus, gameId: string): void {
    const job = this.runJob()
    const current = this.current?.game.id === gameId ? this.current : null
    const edit = this.edits.get(gameId) ?? job?.loadOrderText ?? ''
    const changed = current
      ? !sameOrder(current.loadOrder.text, status.loadOrder)
      : job?.finishedEdit !== undefined && edit !== job.finishedEdit
    if (!changed) return this.done(gameId)
    const onServer = (status.loadOrder ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    this.done(gameId, {
      message: 'Your server already has these game files: it finished this upload earlier, but its answer was lost on the way.',
      warning:
        `It uses the load order it was finished with${onServer.length ? ` (${names(onServer)})` : ''}, not the one you have now. ` +
        'A finished setup cannot take a new load order, so to use yours, upload again: every file is sent again.'
    })
  }

  private async run(serverId: string, gameId: string, approved: ReadonlySet<string>): Promise<void> {
    const stop = new AbortController()
    this.abort = stop
    this.runServerName = ''
    this.progress = { state: 'starting', sentBytes: 0, totalBytes: 0, serverId, gameId, message: 'Checking your server…' }
    this.set({})
    try {
      const userId = await this.deps.userId()
      if (userId !== this.account) {
        this.account = userId
        this.edits.clear()
        this.toldLeftOut.clear()
        this.current = null
      }
      this.runAccount = userId
      const server = await this.requireServer(serverId)
      this.runServerName = server.name
      // the host refuses every request but restore for an archived server, info included
      if (server.state === 'archived') throw new UploadError('no-access', ARCHIVED)
      const ask = await this.deps.ask(server)
      const info = await ask<{ canShare?: boolean }>('info')
      if (!info?.canShare) throw new UploadError('no-access', NO_ACCESS)
      // The host finished this upload but its answer never arrived (relay timeout, or the window closed
      // while finishing): it is done, nothing is sent again.
      const status = await ask<NvmpSetupStatus>('nvmpStatus', {})
      if (this.ourFinishedUpload(status, serverId)) return this.finishedEarlier(status, gameId)
      if (server.state !== 'stopped') throw new UploadError('not-stopped', 'Stop the server before uploading or replacing its game files.')
      if (stop.signal.aborted) return this.paused()

      this.set({ state: 'scanning', message: 'Reading your game files…' })
      const job = this.runJob()
      const game = await this.resolveGame(gameId, job)
      const scan = await scanDataSet(game)
      if (stop.signal.aborted) return this.paused()
      if (scan.problems.length) throw new UploadError('scan', scan.problems.join('\n'))
      const allowedLinks = this.consent(scan, serverId, game.id, approved)
      // setLoadOrder edits this object, so a fix made mid-upload is what the finish sends
      const current = await this.loadOrderFor(game, scan, 'upload', job)
      this.current = current
      const untold = this.untold(game.id, current.loadOrder)
      this.set({
        totalBytes: scan.totalBytes,
        message: `Fingerprinting ${scan.entries.length.toLocaleString('en-US')} files…`,
        // shown while the files go up; the finish waits for the player's choice (advance())
        warning: untold.length
          ? `${leftOutWarning(current.loadOrder.leftOut ?? untold, current.gameOrder.source)} Your files are sent first; the companion asks you before finishing.`
          : undefined
      })
      const selection = await this.select(scan)
      if (stop.signal.aborted) return this.paused()

      const context: RunContext = { ask, server, current, selection, allowedLinks, stop }
      const clock = new RetryClock(this.deps.retry?.delaysMs ?? RETRY_DELAYS_MS, this.deps.retry?.forMs ?? RETRY_FOR_MS)
      this.deps.keepAwake(true)
      for (;;) {
        try {
          if ((await this.advance(context)) === 'paused') return this.paused()
          if (context.earlier) return this.finishedEarlier(context.earlier, game.id)
          return this.done(game.id)
        } catch (error) {
          const reason = retryReason(error)
          if (reason && stop.signal.aborted) return this.paused()
          const wait = reason ? clock.next(this.progress.sentBytes) : null
          if (wait === null) throw error
          await this.waitToRetry(wait, reason!, stop.signal)
          if (stop.signal.aborted) return this.paused()
        }
      }
    } catch (error) {
      const known = await this.explain(error)
      this.set({ state: 'error', file: undefined, bytesPerSecond: undefined, retryAt: undefined, retryReason: undefined, issue: known.issue, message: known.message })
      throw known
    } finally {
      this.deps.keepAwake(false)
    }
  }

  /** The host is ready with the very session this account's saved job started. */
  private ourFinishedUpload(status: NvmpSetupStatus, serverId: string): boolean {
    const job = this.runJob()
    return !!job?.session && job.serverId === serverId && status?.phase === 'ready' && status.session === job.session
  }

  /** The job as this run has it: what a restart needs to resume, recognise a lost finish, or discard. */
  private record({ server, current, allowedLinks }: RunContext, session: string | undefined): void {
    const { game } = current
    const previous = this.runJob()
    this.saveJob({
      serverId: server.serverId,
      serverName: server.name,
      gameId: game.id,
      gameRoot: game.root,
      mo2Profile: game.mo2?.profile,
      mo2Instance: game.mo2?.instanceDir,
      startedAt: previous?.serverId === server.serverId && previous.gameId === game.id ? previous.startedAt : Date.now(),
      loadOrderText: this.edits.get(game.id),
      userId: this.runAccount ?? undefined, // whoever started this run, even if a sign-out is landing
      session,
      allowedLinks
    })
  }

  /** One attempt from the host's current state to a finished upload; the caller retries it after a lost connection. */
  private async advance(context: RunContext): Promise<'paused' | 'ready'> {
    const { ask, server, current, selection, stop } = context
    this.set({ state: 'starting', message: 'Starting the upload on your server…', retryAt: undefined, retryReason: undefined })
    let status = await ask<NvmpSetupStatus>('nvmpStatus', {})
    // ready with the session this run finished, or this account's job started: a finish whose answer was lost
    const finishedBefore = status?.phase === 'ready' && !!status.session && status.session === context.finishing
    if (finishedBefore || this.ourFinishedUpload(status, server.serverId)) {
      context.earlier = status
      return 'ready'
    }
    if (status.phase === 'committing') {
      // an interrupted commit holds complete files: finishing again is the way forward, and this job owns it now
      this.record(context, status.session)
    } else {
      // an identical manifest resumes the same session and returns its bitmaps afresh
      status = await this.begin(ask, selection)
      this.record(context, status.session)
      if (stop.signal.aborted) return 'paused'
      this.rate.reset(status.receivedBytes)
      this.set({ state: 'uploading', sentBytes: status.receivedBytes, totalBytes: status.totalBytes, message: undefined, bytesPerSecond: undefined })
      await this.transfer(ask, selection, status, current.scan, stop.signal)
      if (stop.signal.aborted) return 'paused'
      const after = await ask<NvmpSetupStatus>('nvmpStatus', {})
      if (!after.totalFiles || after.completedFiles !== after.totalFiles) {
        throw new UploadError('incomplete', 'Some pieces have not arrived yet. Resume the upload to send the missing ones.')
      }
      status = { ...after, session: after.session ?? status.session }
    }

    if (current.invalidEdit) {
      throw new UploadError(
        'load-order',
        `Your edited load order no longer fits your files: ${current.invalidEdit}\nEdit the load order or use plugins.txt again, then finish: the files do not need to be sent again.`
      )
    }
    // plugins the game switches on now that the edit leaves out, never shown to the player: ask before finishing
    const untold = this.untold(current.game.id, current.loadOrder)
    if (untold.length) {
      this.shown(current.game.id, current.loadOrder)
      throw new UploadError(
        'edit-leaves-out',
        `${leftOutWarning(current.loadOrder.leftOut ?? untold, current.gameOrder.source)}\n` +
          'Every file is on your server; only the finish waits. Finish with your edited load order as it is, or edit it first: nothing is sent again.'
      )
    }
    this.set({ state: 'finishing', file: undefined, bytesPerSecond: undefined, sentBytes: status.totalBytes, totalBytes: status.totalBytes, message: 'Checking your game files on the server…', warning: undefined })
    context.finishing = status.session
    const job = this.runJob()
    if (job) this.saveJob({ ...job, finishedEdit: this.edits.get(current.game.id) ?? '' })
    await this.finish(ask, status.session, current.loadOrder.text)
    return 'ready'
  }

  private async transfer(ask: Ask, selection: NvmpSelection, status: NvmpSetupStatus, scan: DataSetScan, paused: AbortSignal): Promise<void> {
    const halt = new AbortController()
    const onPause = (): void => halt.abort()
    paused.addEventListener('abort', onPause)
    const failed: { read?: { path: string; error: unknown } } = {}
    const watched = watchReads(selection, (path, error) => {
      failed.read ??= { path, error }
      halt.abort() // every worker stops now, not after sending everything else
    })
    try {
      await transferNvmpFiles(ask, watched, status, halt.signal, (bytes, path) => {
        // pieces already in flight when paused still land; count them without leaving "pausing"
        this.set(paused.aborted ? { sentBytes: bytes } : { sentBytes: bytes, file: path || undefined, bytesPerSecond: this.rate.add(bytes) }, false)
      })
    } catch (error) {
      if (!failed.read) {
        // retried, or explained by run() (a refused row is a lost sign-in or a lost share, not a missing piece)
        if (retryReason(error) || isDenied(error) || isSignedOutError(error)) throw error
        const known = classify(error)
        throw known.issue === 'other' ? new UploadError('incomplete', `${known.message} Finished pieces are saved; resume to send the missing ones.`) : known
      }
    } finally {
      paused.removeEventListener('abort', onPause)
    }
    if (failed.read) throw await this.unreadable(failed.read, scan)
  }

  /** A Data file could not be read mid-upload: changed (the upload cannot resume as it is) or merely in use. */
  private async unreadable({ path, error }: { path: string; error: unknown }, scan: DataSetScan): Promise<UploadError> {
    const entry = scan.entries.find((e) => `Data/${e.rel}` === path)
    if (isChangedFileError(error) || (entry && (await differs(entry)))) {
      return new UploadError(
        'changed',
        `${changedFilePath(error) ?? path} changed while it was being uploaded, so the upload stopped. Close your mod manager and the game, then click Upload again: ` +
          'your files are checked again, and if they still match this upload, pieces already sent are not sent twice.'
      )
    }
    return cannotRead(path, error, 'resume: pieces already sent are kept.')
  }

  /** Fingerprints every file (its first and last 64 KiB) before anything is sent. */
  private async select(scan: DataSetScan): Promise<NvmpSelection> {
    try {
      return await selectNvmpFiles(await toUploadFiles(scan.entries))
    } catch (error) {
      const path = changedFilePath(error) ?? /^(Data\/.+) changed after the scan/.exec(textOf(error))?.[1]
      if (path) {
        throw new UploadError('changed', `${path} changed while the companion was reading it. Close your mod manager and the game, then click Upload again.`)
      }
      // held open by the game or a mod manager: the same advice as a locked file mid-upload
      if (LOCKED_CODES.has(codeOf(error))) {
        const abs = (error as { path?: unknown }).path
        const entry = typeof abs === 'string' ? scan.entries.find((e) => e.abs.toLowerCase() === abs.toLowerCase()) : undefined
        throw cannotRead(entry ? `Data/${entry.rel}` : typeof abs === 'string' ? abs : 'A game file', error, 'try again.')
      }
      throw new UploadError('scan', textOf(error))
    }
  }

  /**
   * Links to folders outside the game are uploaded only with the player's say-so for exactly those links:
   * the ones the window showed and the player ticked now, or the ones agreed for this job before. A link
   * found since (a new junction to a personal folder) is refused, and only the new ones are listed.
   */
  private consent(scan: DataSetScan, serverId: string, gameId: string, approved: ReadonlySet<string>): string[] | undefined {
    const links = scan.outsideLinks ?? []
    if (!links.length) return undefined
    const job = this.runJob()
    const agreed = new Set(job?.serverId === serverId && job.gameId === gameId ? (job.allowedLinks ?? []) : [])
    const unapproved = links.filter((link) => !approved.has(linkKey(link)) && !agreed.has(linkKey(link)))
    if (!unapproved.length) return links.map(linkKey)
    const shown = unapproved.slice(0, 10).map((l) => `Data/${l.rel} → ${l.target}`)
    if (unapproved.length > 10) shown.push(`...and ${unapproved.length - 10} more.`)
    const some = approved.size > 0 || agreed.size > 0
    throw new UploadError(
      'links',
      [
        some
          ? 'Since you agreed to upload files from outside your game, these links to other folders have appeared:'
          : 'Some files come from folders outside your game and mods, through these links:',
        ...shown,
        'Go back to your files, check these links, and tick "Upload these files from outside the game folder too" if they belong to the game.'
      ].join('\n')
    )
  }

  private waitToRetry(ms: number, reason: 'connection' | 'host', signal: AbortSignal): Promise<void> {
    this.set({
      state: 'retrying',
      retryAt: Date.now() + ms,
      retryReason: reason,
      file: undefined,
      bytesPerSecond: undefined,
      message: reason === 'connection' ? 'Connection lost.' : 'The machine hosting this server is not answering.'
    })
    return new Promise<void>((resolve) => {
      const go = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', go)
        if (this.wake === go) this.wake = null
        resolve()
      }
      const timer = setTimeout(go, ms)
      signal.addEventListener('abort', go)
      this.wake = go
    })
  }

  /** classify(), plus the one check that needs the account: a refused row means signed out or unshared. */
  private async explain(error: unknown): Promise<UploadError> {
    if (isDenied(error)) {
      try {
        await this.deps.userId()
      } catch (again) {
        if (isSignedOutError(again)) return new UploadError('signed-out', SIGNED_OUT_MESSAGE)
      }
      return new UploadError('no-access', 'This server is no longer shared with your account. Choose another server, or ask the host.')
    }
    return classify(error)
  }

  private async begin(ask: Ask, selection: NvmpSelection): Promise<NvmpSetupStatus> {
    try {
      return await ask<NvmpSetupStatus>('nvmpBegin', { files: selection.manifest })
    } catch (error) {
      if (/^This selection differs/.test(textOf(error))) {
        throw new UploadError(
          'selection-differs',
          'Your game files changed since this upload started (a file was added, removed or modified), so it cannot resume. Discard the unfinished upload and start again.'
        )
      }
      if (/^Finish or discard the interrupted setup/.test(textOf(error))) {
        throw new UploadError('selection-differs', 'Your server has an interrupted setup. Discard the unfinished upload and start again.')
      }
      throw error
    }
  }

  private async finish(ask: Ask, session: string | undefined, loadOrder: string): Promise<void> {
    let status: NvmpSetupStatus
    try {
      status = await ask<NvmpSetupStatus>('nvmpFinish', { session, loadOrder })
    } catch (error) {
      const text = textOf(error)
      // readNvmpPlugins (src/main/services/nvmp.ts) refuses the order but keeps every uploaded file
      if (/load order|NV:MP plugin|NV:MP Data is missing/i.test(text)) {
        throw new UploadError('load-order', `${text} Fix the load order and finish again — the files do not need to be sent again.`)
      }
      throw error
    }
    if (status?.phase !== 'ready') throw new UploadError('incomplete', 'The server did not confirm the setup. Resume to try finishing again.')
  }

  private async requireServer(serverId: string): Promise<CompanionServer> {
    const server = await this.deps.server(serverId)
    if (!server) {
      throw new UploadError(
        'server-gone',
        'This server is no longer on your account (the rental ended, or the host removed it or stopped sharing it). Forget this upload, or refresh the server list.'
      )
    }
    if (!server.hostOnline) {
      throw new UploadError('host-offline', 'The machine hosting this server is offline right now. Try again when it is back online.')
    }
    return server
  }

  async discard(serverId: string): Promise<void> {
    if (this.busy) throw new Error('Pause the upload before discarding it.')
    // signed out: say so (the server row is hidden from a signed-out request, which would read as "gone")
    const userId = await this.deps.userId()
    const server = await this.requireServer(serverId)
    if (server.state === 'archived') throw new Error(ARCHIVED.replace('before changing its game files', 'first'))
    if (server.state !== 'stopped') throw new Error('Stop the server before discarding its unfinished upload.')
    const ask = await this.deps.ask(server)
    const job = this.jobOf(userId)?.serverId === serverId ? this.jobOf(userId) : null
    let session: string | undefined
    try {
      const status = await ask<NvmpSetupStatus>('nvmpStatus', {})
      session = status.phase !== 'ready' ? status.session : undefined
    } catch (error) {
      // the host answered, but cannot read its progress (e.g. a bitmap cut short by a crash): nvmpDiscard
      // never reads it, so the session this upload saved is enough to clean up
      if (!job?.session || retryReason(error)) throw error
      session = job.session
    }
    if (session) {
      try {
        await ask('nvmpDiscard', { session })
      } catch (error) {
        // already gone (for example discarded from the web panel): that is what was asked for
        if (!/^No matching unfinished upload/.test(textOf(error))) throw error
      }
    }
    if (job) {
      this.discardedGames.set(job.gameId, job)
      this.clearJob(userId)
    }
    this.progress = { state: 'idle', sentBytes: 0, totalBytes: 0, serverId, message: 'Unfinished upload removed. Any game files installed before it were kept.' }
    this.set({})
  }

  async command(serverId: string, action: 'start' | 'stop'): Promise<void> {
    // signed out: say so, rather than "this server is no longer on your account"
    await this.deps.userId()
    const server = await this.requireServer(serverId)
    if (server.state === 'archived') throw new Error(ARCHIVED.replace(' before changing its game files', ''))
    if (action === 'start') {
      if (this.busy) throw new Error('Wait for the upload to finish before starting the server.')
      if (server.state === 'running' || server.state === 'starting') return
      const ask = await this.deps.ask(server)
      const { phase } = await ask<{ phase: string }>('nvmpStatus', { phaseOnly: true })
      if (phase !== 'ready') throw new Error('Finish setting up the game files before starting the server.')
    } else if (server.state === 'stopped') {
      return
    }
    await this.deps.command(server, action)
  }
}
