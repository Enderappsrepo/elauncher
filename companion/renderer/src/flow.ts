// The window's decisions that do not need React: which server the steps act on, what blocks a choice,
// and what a screen reader hears. Kept pure so scripts/test-nvmp-companion-app.mjs can check them.
import type { CompanionServer, OutsideLink } from '../../shared/types'
import { SIGNED_OUT_MESSAGE, type CompanionProgress, type CompanionState } from '../../preload/api'

type Lock = CompanionProgress['lock']

/** Why a server cannot be picked, or null when it can. */
export function blockedReason(server: CompanionServer, lock?: Lock): string | null {
  if (server.state === 'archived') return 'This server is archived. Ask your host to restore it.'
  if (!server.hostOnline) return 'The machine hosting this server is offline. Uploads need it online — try again later.'
  if (server.canEdit === false) return 'Only the renting customer or the host can upload game files to this server.'
  if (lock && lock.serverId !== server.serverId) {
    return `Your upload to ${lock.serverName} is not finished. Resume, discard or forget it before choosing another server.`
  }
  return null
}

/** The server every step acts on: the one an upload job holds, else the player's choice. */
export function chosenServer(list: CompanionServer[], selected: CompanionServer | null, lock: Lock): CompanionServer | null {
  if (!lock) return selected
  return list.find((s) => s.serverId === lock.serverId) ?? (selected?.serverId === lock.serverId ? selected : null)
}

/** The server the Done step is about: one whose files this upload just finished, or that already has them. */
export function doneServer(chosen: CompanionServer | null, progress: CompanionProgress): CompanionServer | null {
  if (!chosen) return null
  if (progress.state === 'ready' && progress.serverId === chosen.serverId) return chosen
  return chosen.phase === 'ready' ? chosen : null
}

/**
 * An unfinished upload waits on this server: one its host reports, or one this account's saved job holds
 * while the host cannot report its progress (e.g. damaged by a crash) — that one can still be discarded.
 */
export function unfinishedUpload(server: CompanionServer, lock: Lock): 'reported' | 'unreadable' | null {
  if (server.phase === 'uploading' || server.phase === 'committing') return 'reported'
  if (server.phase === 'unknown' && server.hostOnline && lock?.serverId === server.serverId && lock.canDiscard === true) return 'unreadable'
  return null
}

/**
 * The outside links an upload of `gameId` may use: only those of the current Check the player ticked.
 * A new scan replaces the prepared view (and with it this consent), so a consent never outlives its scan.
 */
export function approvedFor(prepared: { gameId: string; approvedLinks?: OutsideLink[] } | null, gameId: string): OutsideLink[] {
  return prepared && prepared.gameId === gameId ? (prepared.approvedLinks ?? []) : []
}

/** Resume only once a pause has fully settled (pieces in flight landed); until then the button waits. */
export const canResume = (progress: CompanionProgress): boolean => progress.state === 'paused' && progress.running !== true

const SPOKEN: Record<CompanionState, string> = {
  idle: 'Upload',
  scanning: 'Getting ready',
  starting: 'Getting ready',
  uploading: 'Uploading',
  pausing: 'Pausing',
  paused: 'Upload paused',
  retrying: 'Connection lost, retrying',
  finishing: 'Checking your files on the server',
  ready: 'Upload complete',
  error: 'Upload stopped'
}

/**
 * The one line a screen reader hears: the state, and while uploading the percentage in 5 % steps. It
 * changes only on those steps, so a live region holding it is not re-announced on every progress tick.
 */
export function spokenProgress(progress: CompanionProgress): string {
  const label = progress.state === 'retrying' && progress.retryReason === 'host' ? 'The server’s host is not answering, retrying' : SPOKEN[progress.state]
  if (progress.state !== 'uploading' || !progress.totalBytes) return label
  const percent = Math.min(100, (progress.sentBytes * 100) / progress.totalBytes)
  return `${label}: ${Math.floor(percent / 5) * 5}%`
}

/** What the spoken line keeps between renders: a retry under way, and the line that said it got going again. */
export interface SpokenMemory {
  retrying: false | 'connection' | 'host'
  back?: string
}

/**
 * spokenProgress(), plus "Reconnected" once the upload moves again after a retry: the one live region hears
 * the state changes ('Connection lost, retrying', 'Reconnected') and never the countdown. Pure: give it the
 * memory it returned last time.
 */
export function spokenLine(progress: CompanionProgress, memory: SpokenMemory): { line: string; memory: SpokenMemory } {
  const line = spokenProgress(progress)
  if (progress.state === 'retrying') return { line, memory: { retrying: progress.retryReason === 'host' ? 'host' : 'connection' } }
  const again = (reason: 'connection' | 'host'): string => `${reason === 'host' ? 'The host answers again' : 'Reconnected'}. ${line}`
  if (memory.retrying) {
    // still finding out whether the next attempt gets through
    if (progress.state === 'starting' || progress.state === 'scanning') return { line, memory }
    if (progress.state === 'uploading' || progress.state === 'finishing') return { line: again(memory.retrying), memory: { retrying: false, back: `${memory.retrying}|${line}` } }
    return { line, memory: { retrying: false } }
  }
  // the same line as when it got going again: keep saying so until the line itself changes
  for (const reason of ['connection', 'host'] as const) if (memory.back === `${reason}|${line}`) return { line: again(reason), memory }
  return { line, memory: { retrying: false } }
}

/** "Connection lost — retrying in 12 s", counted down from progress.retryAt (never in a live region). */
export function retryLine(progress: CompanionProgress, now: number): string {
  const what = progress.retryReason === 'host' ? 'The machine hosting this server is not answering' : 'Connection lost'
  const seconds = Math.max(0, Math.ceil(((progress.retryAt ?? now) - now) / 1000))
  return seconds > 0 ? `${what} — retrying in ${seconds} s` : `${what} — retrying now…`
}

export const isSignedOut = (error: unknown): boolean => (error instanceof Error ? error.message : String(error)) === SIGNED_OUT_MESSAGE
