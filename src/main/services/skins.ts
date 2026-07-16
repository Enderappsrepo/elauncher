import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { dialog } from 'electron'
import type { SavedSkin, SkinInfo, SkinSearchResult } from '@shared/types'
import { skinsDir } from '../paths'
import { readJson, writeJson } from '../store'
import { getAccountsState, getActiveSession } from './auth'

const PROFILE_API = 'https://api.minecraftservices.com/minecraft/profile'

const libraryFile = join(skinsDir, 'skins.json')

interface StoredSkin {
  id: string
  name: string
  variant: 'classic' | 'slim'
  fileName: string
  addedAt: number
}

function loadLibrary(): StoredSkin[] {
  return readJson<StoredSkin[]>(libraryFile, [])
}

function saveLibrary(skins: StoredSkin[]): void {
  writeJson(libraryFile, skins)
}

function toSaved(s: StoredSkin): SavedSkin {
  const file = join(skinsDir, s.fileName)
  const dataUrl = existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : ''
  return { id: s.id, name: s.name, variant: s.variant, dataUrl, addedAt: s.addedAt }
}

interface ProfileResponse {
  skins?: { id: string; state: string; url: string; variant?: string }[]
  capes?: { id: string; state: string; url: string; alias?: string }[]
}

/** Short-lived cache so opening the Skins page repeatedly doesn't hammer (rate-limited) Mojang auth. */
let infoCache: { uuid: string; info: SkinInfo; fetchedAt: number } | null = null
const INFO_CACHE_TTL_MS = 60_000

async function getSession(): Promise<{ name: string; uuid: string; accessToken: string }> {
  try {
    return await getActiveSession()
  } catch (e) {
    // msmc throws plain objects with a Response for auth failures
    const status = (e as { response?: { status?: number } })?.response?.status
    const text = e instanceof Error ? e.message : String((e as { ts?: string })?.ts ?? e)
    if (status === 429 || text.includes('429') || text.includes('Too Many Requests')) {
      throw new Error('Microsoft is rate-limiting sign-in attempts right now. Wait a minute and try again.')
    }
    throw e instanceof Error ? e : new Error(text)
  }
}

/** Fetches the active account's current skin + capes from Mojang. */
export async function getSkinInfo(force = false): Promise<SkinInfo> {
  // serve from cache before touching Microsoft auth — token refreshes are rate-limited
  const activeUuid = getAccountsState().activeUuid
  if (!force && infoCache && infoCache.uuid === activeUuid && Date.now() - infoCache.fetchedAt < INFO_CACHE_TTL_MS) {
    return infoCache.info
  }
  const session = await getSession()
  const res = await fetch(PROFILE_API, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })
  if (!res.ok) throw new Error(`Could not load your Minecraft profile (${res.status}): ${await res.text()}`)
  const profile = (await res.json()) as ProfileResponse

  const active = profile.skins?.find((s) => s.state === 'ACTIVE') ?? profile.skins?.[0]
  const info: SkinInfo = {
    url: active?.url,
    variant: active?.variant?.toLowerCase() === 'slim' ? 'slim' : 'classic',
    capes: (profile.capes ?? []).map((c) => ({
      id: c.id,
      alias: c.alias ?? 'Cape',
      url: c.url,
      active: c.state === 'ACTIVE'
    }))
  }
  // fetch the texture server-side so the 3D viewer isn't blocked by CORS
  if (active?.url) {
    try {
      const tex = await fetch(active.url)
      if (tex.ok) {
        info.dataUrl = `data:image/png;base64,${Buffer.from(await tex.arrayBuffer()).toString('base64')}`
      }
    } catch {
      // preview falls back to nothing; upload still works
    }
  }
  infoCache = { uuid: session.uuid, info, fetchedAt: Date.now() }
  return info
}

async function uploadSkinBuffer(png: Buffer, variant: 'classic' | 'slim'): Promise<void> {
  const session = await getSession()
  const form = new FormData()
  form.append('variant', variant)
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'skin.png')
  const res = await fetch(`${PROFILE_API}/skins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
    body: form
  })
  if (!res.ok) throw new Error(`Skin upload failed (${res.status}): ${await res.text()}`)
}

/** Uploads a skin from the local library to the active Minecraft account. */
export async function applySkin(skinId: string, variant: 'classic' | 'slim'): Promise<void> {
  const stored = loadLibrary().find((s) => s.id === skinId)
  if (!stored) throw new Error('Skin not found in library')
  const file = join(skinsDir, stored.fileName)
  if (!existsSync(file)) throw new Error('Skin file is missing on disk')
  await uploadSkinBuffer(readFileSync(file), variant)
}

export function listSavedSkins(): SavedSkin[] {
  return loadLibrary()
    .map(toSaved)
    .filter((s) => s.dataUrl)
    .sort((a, b) => b.addedAt - a.addedAt)
}

/** Opens a file dialog and imports a skin png into the local library. Returns null when cancelled. */
export async function importSkin(): Promise<SavedSkin | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a skin file',
    properties: ['openFile'],
    filters: [{ name: 'Skin PNG', extensions: ['png'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const source = result.filePaths[0]
  const id = randomUUID()
  const fileName = `${id}.png`
  copyFileSync(source, join(skinsDir, fileName))
  const stored: StoredSkin = {
    id,
    name: basename(source, '.png'),
    variant: 'classic',
    fileName,
    addedAt: Date.now()
  }
  const library = loadLibrary()
  library.push(stored)
  saveLibrary(library)
  return toSaved(stored)
}

/** Saves the account's current skin into the local library. */
export async function saveCurrentSkin(name: string): Promise<SavedSkin> {
  const info = await getSkinInfo()
  if (!info.url) throw new Error('Your account has no custom skin to save')
  const res = await fetch(info.url)
  if (!res.ok) throw new Error(`Could not download the current skin (${res.status})`)
  const id = randomUUID()
  const fileName = `${id}.png`
  writeFileSync(join(skinsDir, fileName), Buffer.from(await res.arrayBuffer()))
  const stored: StoredSkin = { id, name: name.trim() || 'My skin', variant: info.variant, fileName, addedAt: Date.now() }
  const library = loadLibrary()
  library.push(stored)
  saveLibrary(library)
  return toSaved(stored)
}

// ---------- skin browser: find another player's skin ----------

const ASHCON = 'https://api.ashcon.app/mojang/v2/user'

interface AshconUser {
  uuid: string
  username: string
  textures: { slim: boolean; skin: { url: string; data?: string } }
}

async function fetchSkinBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download the skin (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** Mojang fallback: username → uuid → profile texture, used when ashcon is unavailable. */
async function searchSkinViaMojang(name: string): Promise<SkinSearchResult> {
  const profRes = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`)
  if (profRes.status === 404 || profRes.status === 204) throw new Error(`No Minecraft player named "${name}".`)
  if (!profRes.ok) throw new Error(`Could not look up "${name}" (${profRes.status}).`)
  const { id, name: username } = (await profRes.json()) as { id: string; name: string }
  const sesRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`)
  if (!sesRes.ok) throw new Error(`Could not load ${username}'s profile (${sesRes.status}).`)
  const session = (await sesRes.json()) as { properties: { name: string; value: string }[] }
  const prop = session.properties.find((p) => p.name === 'textures')
  const decoded = prop
    ? (JSON.parse(Buffer.from(prop.value, 'base64').toString('utf-8')) as {
        textures: { SKIN?: { url: string; metadata?: { model?: string } } }
      })
    : { textures: {} }
  const skin = decoded.textures.SKIN
  if (!skin) throw new Error(`${username} is using the default skin.`)
  return {
    username,
    uuid: id,
    url: skin.url,
    dataUrl: `data:image/png;base64,${(await fetchSkinBuffer(skin.url)).toString('base64')}`,
    variant: skin.metadata?.model === 'slim' ? 'slim' : 'classic'
  }
}

/** Look up any player's current skin by name, ready to preview or apply. */
export async function searchSkin(name: string): Promise<SkinSearchResult> {
  const query = name.trim()
  if (!query) throw new Error('Enter a player name to search.')
  // primary: ashcon returns uuid, slim flag and base64 skin data in one CORS-free call
  try {
    const res = await fetch(`${ASHCON}/${encodeURIComponent(query)}`)
    if (res.ok) {
      const user = (await res.json()) as AshconUser
      const url = user.textures.skin.url
      const dataUrl = user.textures.skin.data
        ? `data:image/png;base64,${user.textures.skin.data}`
        : `data:image/png;base64,${(await fetchSkinBuffer(url)).toString('base64')}`
      return { username: user.username, uuid: user.uuid, url, dataUrl, variant: user.textures.slim ? 'slim' : 'classic' }
    }
    if (res.status === 404) throw new Error(`No Minecraft player named "${query}".`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('No Minecraft player')) throw e
    // network / ashcon outage — try Mojang directly
  }
  return searchSkinViaMojang(query)
}

/** Apply a browsed skin (by texture url) straight to the active account. */
export async function applySkinFromUrl(url: string, variant: 'classic' | 'slim'): Promise<void> {
  await uploadSkinBuffer(await fetchSkinBuffer(url), variant)
}

/** Save a browsed skin (by texture url) into the local library. */
export async function saveSkinFromUrl(name: string, url: string, variant: 'classic' | 'slim'): Promise<SavedSkin> {
  const png = await fetchSkinBuffer(url)
  const id = randomUUID()
  const fileName = `${id}.png`
  writeFileSync(join(skinsDir, fileName), png)
  const stored: StoredSkin = { id, name: name.trim() || 'Skin', variant, fileName, addedAt: Date.now() }
  const library = loadLibrary()
  library.push(stored)
  saveLibrary(library)
  return toSaved(stored)
}

export function renameSavedSkin(skinId: string, name: string, variant: 'classic' | 'slim'): SavedSkin[] {
  const library = loadLibrary()
  const skin = library.find((s) => s.id === skinId)
  if (skin) {
    skin.name = name.trim() || skin.name
    skin.variant = variant
    saveLibrary(library)
  }
  return listSavedSkins()
}

export function removeSavedSkin(skinId: string): SavedSkin[] {
  const library = loadLibrary()
  const skin = library.find((s) => s.id === skinId)
  if (skin) {
    rmSync(join(skinsDir, skin.fileName), { force: true })
    saveLibrary(library.filter((s) => s.id !== skinId))
  }
  return listSavedSkins()
}
