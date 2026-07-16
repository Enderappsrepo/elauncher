import { safeStorage } from 'electron'
import { Auth, Minecraft } from 'msmc'
import type { Account, AccountsState } from '@shared/types'
import { accountsFile } from '../paths'
import { readJson, writeJson } from '../store'

interface StoredAccount {
  uuid: string
  name: string
  /** msmc refresh token, encrypted with safeStorage when available (base64), else plain */
  refreshToken: string
  encrypted: boolean
}

interface StoredState {
  accounts: StoredAccount[]
  activeUuid: string | null
}

/** In-memory session tokens per account uuid, refreshed on demand. */
const sessions = new Map<string, Minecraft>()

function loadState(): StoredState {
  return readJson<StoredState>(accountsFile, { accounts: [], activeUuid: null })
}

function saveState(state: StoredState): void {
  writeJson(accountsFile, state)
}

function encrypt(token: string): { value: string; encrypted: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(token).toString('base64'), encrypted: true }
  }
  return { value: token, encrypted: false }
}

function decrypt(stored: StoredAccount): string {
  if (stored.encrypted) {
    return safeStorage.decryptString(Buffer.from(stored.refreshToken, 'base64'))
  }
  return stored.refreshToken
}

function toPublic(state: StoredState): AccountsState {
  return {
    accounts: state.accounts.map((a) => ({ uuid: a.uuid, name: a.name })),
    activeUuid: state.activeUuid
  }
}

export function getAccountsState(): AccountsState {
  return toPublic(loadState())
}

export async function login(): Promise<Account> {
  const authManager = new Auth('select_account')
  const xbox = await authManager.launch('electron')
  const mc = await xbox.getMinecraft()
  if (!mc.profile || mc.isDemo()) {
    throw new Error(
      'This Microsoft account does not own Minecraft: Java Edition. Please buy the game or log in with a different account.'
    )
  }
  const refreshToken = xbox.save()
  const enc = encrypt(refreshToken)

  const state = loadState()
  const stored: StoredAccount = {
    uuid: mc.profile.id,
    name: mc.profile.name,
    refreshToken: enc.value,
    encrypted: enc.encrypted
  }
  const idx = state.accounts.findIndex((a) => a.uuid === stored.uuid)
  if (idx >= 0) state.accounts[idx] = stored
  else state.accounts.push(stored)
  state.activeUuid = stored.uuid
  saveState(state)
  sessions.set(stored.uuid, mc)
  return { uuid: stored.uuid, name: stored.name }
}

export function logout(uuid: string): AccountsState {
  const state = loadState()
  state.accounts = state.accounts.filter((a) => a.uuid !== uuid)
  if (state.activeUuid === uuid) {
    state.activeUuid = state.accounts[0]?.uuid ?? null
  }
  saveState(state)
  sessions.delete(uuid)
  return toPublic(state)
}

export function setActive(uuid: string): AccountsState {
  const state = loadState()
  if (state.accounts.some((a) => a.uuid === uuid)) {
    state.activeUuid = uuid
    saveState(state)
  }
  return toPublic(state)
}

/**
 * Get a valid (refreshed) Minecraft session for the active account.
 * Throws when there is no account or the refresh fails.
 */
export async function getActiveSession(): Promise<{ name: string; uuid: string; accessToken: string }> {
  const state = loadState()
  if (!state.activeUuid) throw new Error('Not logged in. Please sign in with your Microsoft account first.')
  const stored = state.accounts.find((a) => a.uuid === state.activeUuid)
  if (!stored) throw new Error('Active account not found. Please sign in again.')

  let mc = sessions.get(stored.uuid)
  if (!mc || !mc.validate()) {
    const authManager = new Auth('select_account')
    let xbox
    try {
      xbox = await authManager.refresh(decrypt(stored))
    } catch (e) {
      throw new Error(
        `Your Microsoft login has expired and could not be refreshed. Please sign in again. (${e instanceof Error ? e.message : e})`
      )
    }
    mc = await xbox.getMinecraft()
    if (!mc.profile) throw new Error('This account no longer owns Minecraft.')
    // persist rotated refresh token
    const enc = encrypt(xbox.save())
    stored.refreshToken = enc.value
    stored.encrypted = enc.encrypted
    stored.name = mc.profile.name
    saveState(state)
    sessions.set(stored.uuid, mc)
  }

  return { name: mc.profile!.name, uuid: mc.profile!.id, accessToken: mc.mcToken }
}
