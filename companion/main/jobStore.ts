import { createHash } from 'crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** An upload the companion started and has not finished: enough to offer "Resume upload" after a restart. */
export interface UploadJob {
  serverId: string
  serverName: string
  gameId: string
  gameRoot: string
  mo2Profile?: string
  /** an MO2 setup is found again from its instance folder, not the game folder */
  mo2Instance?: string
  startedAt: number
  /** the player's edited load order, re-validated against a fresh scan on resume */
  loadOrderText?: string
  /** the account that started it: another account signed in on this PC never sees or resumes it */
  userId?: string
  /** the host's upload session: lets a resume recognise an upload the host already finished, and discard without nvmpStatus */
  session?: string
  /** "rel -> target" of the links outside the game the player agreed to upload from */
  allowedLinks?: string[]
  /**
   * The player's edit ('' for the game's own order) when nvmpFinish was last sent: a finish the host carried
   * out but whose answer was lost is only taken as done while the edit is still this one.
   */
  finishedEdit?: string
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/** Written beside and renamed over, so a crash mid-write never leaves half a file. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** Before jobs were kept per account there was this one file; its owner takes it over on first load. */
export const LEGACY_JOB_FILE = 'upload-job.json'

/** A user id as a file name: Supabase ids are UUIDs; anything else is hashed. */
const fileKey = (userId: string): string =>
  /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : createHash('sha256').update(userId).digest('hex').slice(0, 32)

/** One account's job file: another account's upload on this PC never overwrites it. */
export function jobFile(userId: string, dir = app.getPath('userData')): string {
  return join(dir, `upload-job-${fileKey(userId)}.json`)
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function loadJob(file: string): UploadJob | null {
  const raw = readJsonFile<Partial<UploadJob> | null>(file, null)
  if (!raw || !isText(raw.serverId) || !isText(raw.gameId) || !isText(raw.gameRoot) || typeof raw.startedAt !== 'number') return null
  return {
    serverId: raw.serverId,
    serverName: isText(raw.serverName) ? raw.serverName : 'your server',
    gameId: raw.gameId,
    gameRoot: raw.gameRoot,
    mo2Profile: isText(raw.mo2Profile) ? raw.mo2Profile : undefined,
    mo2Instance: isText(raw.mo2Instance) ? raw.mo2Instance : undefined,
    startedAt: raw.startedAt,
    loadOrderText: isText(raw.loadOrderText) ? raw.loadOrderText : undefined,
    userId: isText(raw.userId) ? raw.userId : undefined,
    session: isText(raw.session) ? raw.session : undefined,
    allowedLinks: Array.isArray(raw.allowedLinks) && raw.allowedLinks.every(isText) ? [...raw.allowedLinks] : undefined,
    finishedEdit: typeof raw.finishedEdit === 'string' ? raw.finishedEdit : undefined
  }
}

export function saveJob(job: UploadJob, file: string): void {
  writeJsonFile(file, job)
}

export function clearJob(file: string): void {
  rmSync(file, { force: true })
}

/** The saved jobs, one per account: what the upload controller loads, saves and clears. */
export interface JobStore {
  load(userId: string): UploadJob | null
  /** job.userId says whose it is; a job without one is not saved */
  save(job: UploadJob): void
  clear(userId: string): void
}

/**
 * Jobs kept in `dir` (the companion's userData), one file per account. The single upload-job.json of
 * earlier versions is moved to its owner's file the first time that account loads its job; a legacy job
 * of another account is left for that account, and one without an account is never used.
 */
export function accountJobs(dir: () => string = () => app.getPath('userData')): JobStore {
  return {
    load(userId) {
      const own = loadJob(jobFile(userId, dir()))
      if (own) return own.userId === userId ? own : null
      const legacyFile = join(dir(), LEGACY_JOB_FILE)
      const legacy = loadJob(legacyFile)
      if (!legacy || legacy.userId !== userId) return null
      saveJob(legacy, jobFile(userId, dir()))
      clearJob(legacyFile)
      return legacy
    },
    save(job) {
      if (job.userId) saveJob(job, jobFile(job.userId, dir()))
    },
    clear(userId) {
      clearJob(jobFile(userId, dir()))
    }
  }
}
