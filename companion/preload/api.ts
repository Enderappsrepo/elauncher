import type { CompanionApi, CompanionServer, DataSetScan, LoadOrderResult, UploadProgress } from '../shared/types'

/**
 * What window.companion offers beyond the shared CompanionApi contract. Pure types and constants. Every
 * CompanionApi call is kept as it is; only the progress it pushes is wider: CompanionProgress adds the
 * 'pausing' and 'retrying' states to UploadProgress['state'], so onProgress is redeclared.
 */

/** Why an upload stopped, so the window can offer the matching next step. */
export type UploadIssue =
  | 'host-offline'      // the host launcher is not answering (after the automatic retries)
  | 'connection'        // this PC cannot reach the eLauncher cloud (after the automatic retries)
  | 'no-access'         // not the host, an admin or the renting customer
  | 'not-stopped'       // offer Stop server
  | 'scan'              // the local files cannot be uploaded as they are
  | 'links'             // links to folders outside the game the player has not approved: back to Check
  | 'changed'           // a file changed while it was read: offer Upload again (which scans again)
  | 'selection-differs' // offer Discard and start again (also: the host's saved progress is damaged)
  | 'load-order'        // offer Edit load order, then finish again without re-sending files
  | 'edit-leaves-out'   // every file is sent, but the player's edit leaves out plugins the game now switches
                        // on and they were not shown that yet: offer Finish with the edit, or Edit load order
  | 'incomplete'        // offer Resume
  | 'server-gone'       // the job's server is no longer on this account: offer Forget this upload
  | 'signed-out'        // the sign-in expired: back to Sign in
  | 'other'

/**
 * 'pausing': Pause was pressed and pieces already on their way are still landing (up to a minute);
 * resuming waits for it. 'retrying': the connection or the host dropped; the upload tries again at retryAt.
 */
export type CompanionState = UploadProgress['state'] | 'pausing' | 'retrying'

export interface CompanionProgress extends Omit<UploadProgress, 'state'> {
  state: CompanionState
  serverId?: string
  gameId?: string
  issue?: UploadIssue
  /** the job is still running, including a pause that waits for pieces in flight */
  running?: boolean
  /** while 'retrying': when the next attempt starts (ms since the epoch), and what failed */
  retryAt?: number
  retryReason?: 'connection' | 'host'
  /**
   * The server an upload job holds: the running upload's, or the saved unfinished one's. Another server
   * cannot be chosen until it finishes, is discarded or is forgotten. canDiscard: the saved job knows the
   * host's upload session, so it can be discarded even when the host cannot report its progress.
   */
  lock?:{ serverId: string; serverName: string; canDiscard?: boolean } | null
  /**
   * Something the player should know that does not stop the upload: while uploading, an edited load order
   * that leaves out plugins the game now switches on; with 'ready', a finish that was not quite what was
   * asked (a newer load order could not be applied to a setup the host had already finished).
   */
  warning?: string
}

/** A saved upload the companion can resume after a restart (only ever the signed-in account's). */
export interface PendingUpload {
  serverId: string
  serverName: string
  gameId: string
  gameRoot: string
  startedAt: number
}

/** The load order main will send, and whether it is the player's own edit rather than the game's order. */
export interface CompanionLoadOrder extends LoadOrderResult {
  edited?: boolean
  /** with edited: plugins the game itself switches on that the edit leaves out (also named in warnings) */
  leftOut?: string[]
}

export interface CompanionPrepared {
  scan: Omit<DataSetScan, 'entries'> & { files: number }
  loadOrder: CompanionLoadOrder
}

export interface CompanionApp extends Omit<CompanionApi, 'onProgress'> {
  prepare(gameId: string): Promise<CompanionPrepared>
  setLoadOrder(text: string): Promise<CompanionLoadOrder>
  /** drop the player's edit for the checked game (and its saved job) and read plugins.txt again */
  useGameLoadOrder(): Promise<CompanionLoadOrder>
  /** the latest progress; onProgress only delivers changes */
  progressNow(): Promise<CompanionProgress>
  pendingUpload(): Promise<PendingUpload | null>
  /** stop offering to resume the saved upload; nothing on the server changes */
  forgetUpload(): Promise<void>
  /** while 'retrying': try again now instead of waiting */
  retryNow(): Promise<void>
  /** one server's row without asking its host anything: cheap enough to poll */
  serverState(serverId: string): Promise<CompanionServer | null>
  onProgress(cb: (p: CompanionProgress) => void): () => void
}

export const PANEL_URL = 'https://enderappsrepo.github.io/elauncher/manage/'

/** Main's refusal when the stored sign-in is gone or revoked; the window goes back to Sign in on it. */
export const SIGNED_OUT_MESSAGE = 'Your sign-in expired. Sign in again.'

/** Every "no internet / cloud unreachable" failure reads the same. */
export const OFFLINE_MESSAGE = 'Cannot reach the eLauncher cloud. Check your internet connection.'
