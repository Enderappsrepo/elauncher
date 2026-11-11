import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { SUPABASE_ANON_KEY, SUPABASE_URL, isCloudConfigured } from '@shared/cloudConfig'
import { OFFLINE_MESSAGE } from '../preload/api'
import { clockedFetch } from './cloudClock'
import { readJsonFile, writeJsonFile } from './jobStore'
import { isNetworkError, offlineError, primeSenderName, resetSenderName, signedOutError } from './relay'

export { isSignedOutError } from './relay'

export interface Account {
  email: string
  userId: string
}

// The same encrypted-at-rest pattern as the launcher (src/main/services/cloud.ts), in the
// companion's own userData: safeStorage keys are per app, so the two cannot share a session.
type SessionStore = Record<string, { value: string; encrypted: boolean }>

const sessionFile = (): string => join(app.getPath('userData'), 'cloud-session.json')

const sessionStorage = {
  getItem(key: string): string | null {
    const entry = readJsonFile<SessionStore>(sessionFile(), {})[key]
    if (!entry) return null
    try {
      return entry.encrypted ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    const store = readJsonFile<SessionStore>(sessionFile(), {})
    store[key] = safeStorage.isEncryptionAvailable()
      ? { value: safeStorage.encryptString(value).toString('base64'), encrypted: true }
      : { value, encrypted: false }
    writeJsonFile(sessionFile(), store)
  },
  removeItem(key: string): void {
    const store = readJsonFile<SessionStore>(sessionFile(), {})
    delete store[key]
    writeJsonFile(sessionFile(), store)
  }
}

let client: SupabaseClient | null = null

export function getClient(): SupabaseClient {
  if (!isCloudConfigured()) throw new Error('This build of the companion has no cloud configured.')
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    // every answer also tells the companion the cloud's time, so host heartbeats are judged by it
    global: { fetch: clockedFetch }
  })
  return client
}

/**
 * Every stored key (session, refresh token, PKCE verifier) gone from disk. The client stays: with
 * persistSession it reads the session from this storage each time, so it is signed out at once, and its
 * auto-refresh timer finds nothing to refresh rather than picking up the next account's tokens twice.
 */
function wipeStoredSession(): void {
  writeJsonFile(sessionFile(), {})
}

/** auth-js wordings, as the player should read them. */
export function authErrorText(error: { message?: unknown; name?: unknown; status?: unknown }): string {
  if (isNetworkError(error)) return OFFLINE_MESSAGE
  const text = typeof error.message === 'string' ? error.message : ''
  if (text === 'Invalid login credentials') return 'That email and password do not match an eLauncher account.'
  if (/email not confirmed/i.test(text)) return 'Confirm your email first: open the message eLauncher sent you, then sign in here.'
  return text || 'Signing in failed. Try again.'
}

/**
 * The stored session, refreshed if it has to be. A refresh this PC could not send (offline) is not a
 * sign-out: the session stays on disk and the call fails with OFFLINE_MESSAGE instead.
 */
export async function session(): Promise<Account | null> {
  let result: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>
  try {
    result = await getClient().auth.getSession()
  } catch (error) {
    if (isNetworkError(error)) throw offlineError(error)
    throw error
  }
  const { data, error } = result
  if (error && isNetworkError(error)) throw offlineError(error)
  const user = data.session?.user
  if (!user) return null
  void primeSenderName(getClient(), user.id).catch(() => {})
  return { email: user.email ?? '', userId: user.id }
}

/**
 * The signed-in account, or a refusal for anything that needs one. A session that is gone or was
 * revoked (for example by a global sign-out in the web panel) signs the companion out locally too.
 */
export async function requireAccount(): Promise<Account> {
  const account = await session()
  if (account) return account
  wipeStoredSession()
  resetSenderName()
  throw signedOutError()
}

export async function signIn(email: string, password: string): Promise<Account> {
  const trimmed = email.trim()
  if (!trimmed || !password) throw new Error('Enter your email and password.')
  let result: Awaited<ReturnType<SupabaseClient['auth']['signInWithPassword']>>
  try {
    result = await getClient().auth.signInWithPassword({ email: trimmed, password })
  } catch (error) {
    throw new Error(authErrorText(error as { message?: unknown }))
  }
  const { data, error } = result
  if (error) throw new Error(authErrorText(error))
  if (!data.user) throw new Error('Signed in, but the account could not be loaded. Try again.')
  resetSenderName()
  void primeSenderName(getClient(), data.user.id).catch(() => {})
  return { email: data.user.email ?? trimmed, userId: data.user.id }
}

/**
 * Local scope: signing out here must not sign the player out of the panel or launcher. Whatever the
 * cloud answers (auth-js keeps the session when it cannot reach it, e.g. offline with an expired token),
 * the stored tokens are removed, so nobody who opens the companion next is signed in as this account.
 * The server-side revocation is best-effort and only reported as a warning.
 */
export async function signOut(): Promise<void> {
  let failure: unknown = null
  try {
    const { error } = await getClient().auth.signOut({ scope: 'local' })
    failure = error
  } catch (error) {
    failure = error
  } finally {
    wipeStoredSession()
    resetSenderName()
  }
  if (failure) {
    const text = failure instanceof Error ? failure.message : String((failure as { message?: unknown }).message ?? failure)
    console.warn(`Signed out on this PC; the eLauncher cloud was not told (${text}).`)
  }
}
