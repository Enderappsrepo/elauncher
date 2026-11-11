import type { GameSource, LoadOrderResult } from '../../shared/types'
import type { CompanionApp } from '../../preload/api'
import { isSignedOut } from './flow'

/** Fired on window whenever main refuses a call because the sign-in expired; App goes back to Sign in. */
export const SIGNED_OUT_EVENT = 'companion-signed-out'

/** Every window.companion member, checked by the compiler against CompanionApp (no enumeration of the bridge object). */
const MEMBERS = {
  version: 1, session: 1, signIn: 1, signOut: 1, servers: 1, serverState: 1, findGames: 1, chooseFolder: 1, prepare: 1,
  setLoadOrder: 1, useGameLoadOrder: 1, upload: 1, pause: 1, discard: 1, start: 1, stop: 1, progressNow: 1, pendingUpload: 1,
  forgetUpload: 1, retryNow: 1, onProgress: 1, openExternal: 1
} satisfies Record<keyof CompanionApp, 1>

/** window.companion, with every refusal for an expired sign-in also announced as SIGNED_OUT_EVENT. */
function watched(raw: CompanionApp): CompanionApp {
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(MEMBERS) as Array<keyof CompanionApp>) {
    const value: unknown = raw?.[name]
    out[name] =
      typeof value !== 'function'
        ? value
        : (...args: unknown[]) => {
            const result: unknown = (value as (...a: unknown[]) => unknown)(...args)
            if (!result || typeof (result as Promise<unknown>).then !== 'function') return result
            return Promise.resolve(result).catch((error: unknown) => {
              if (isSignedOut(error)) window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
              throw error
            })
          }
  }
  return out as unknown as CompanionApp
}

export const api = watched(window.companion)

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(0, Math.round(n / 1024))} KB`
}

export const speed = (bytesPerSecond: number): string => `${(bytesPerSecond / 1024 ** 2).toFixed(2)} MB/s`

export function eta(remaining: number, bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1 || remaining <= 0) return ''
  const minutes = Math.ceil(remaining / bytesPerSecond / 60)
  if (minutes <= 1) return 'less than a minute left'
  if (minutes < 60) return `about ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  return `about ${hours} h ${minutes % 60} min left`
}

export const SOURCE_LABEL: Record<GameSource, string> = {
  steam: 'Steam',
  'steam-pcr': 'Steam (PCR edition)',
  gog: 'GOG',
  epic: 'Epic Games',
  xbox: 'Xbox app / Game Pass',
  'bethesda-registry': 'Windows registry',
  mo2: 'Mod Organizer 2',
  manual: 'Folder you chose'
}

export const LOAD_ORDER_SOURCE: Record<LoadOrderResult['source'], string> = {
  'plugins.txt': 'Read from your game’s plugins.txt: the plugins you have switched on, in the order listed.',
  'mo2-profile': 'Read from your Mod Organizer 2 profile.',
  timestamps: 'No plugins.txt was found, so this list starts from the base game and DLC in file-date order. Add the other plugins your group uses.'
}
