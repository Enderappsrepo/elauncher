import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import AdmZip from 'adm-zip'
import { safeStorage } from 'electron'
import { writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  CloudPack,
  CloudPackDetails,
  CloudPackVersion,
  CloudProfile,
  CloudUpdateMap,
  CloudUser,
  GameSession,
  Instance,
  LauncherNewsItem,
  ProgressEvent,
  PublishNewsRequest,
  PublishPackRequest,
  PublishSessionRequest
} from '@shared/types'
import { SUPABASE_URL, SUPABASE_ANON_KEY, isCloudConfigured } from '@shared/cloudConfig'
import { cloudSessionFile } from '../paths'
import { readJson, writeJson } from '../store'
import { getInstance, listInstances } from './instances'
import { broadcast, emitProgress, setInstallingState } from './game'
import { applyPackUpdate, buildMrpack, emitPackTask, getPackLink, importFromZip } from './packs'

const BUCKET = 'modpacks'

// ---------- session storage (encrypted at rest) ----------

type SessionStore = Record<string, { value: string; encrypted: boolean }>

const sessionStorage = {
  getItem(key: string): string | null {
    const store = readJson<SessionStore>(cloudSessionFile, {})
    const entry = store[key]
    if (!entry) return null
    try {
      return entry.encrypted ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    const store = readJson<SessionStore>(cloudSessionFile, {})
    store[key] = safeStorage.isEncryptionAvailable()
      ? { value: safeStorage.encryptString(value).toString('base64'), encrypted: true }
      : { value, encrypted: false }
    writeJson(cloudSessionFile, store)
  },
  removeItem(key: string): void {
    const store = readJson<SessionStore>(cloudSessionFile, {})
    delete store[key]
    writeJson(cloudSessionFile, store)
  }
}

// ---------- client ----------

let client: SupabaseClient | null = null

export function getClient(): SupabaseClient {
  if (!isCloudConfigured()) {
    throw new Error(
      'The cloud is not set up yet. The launcher owner needs to fill in src/shared/cloudConfig.ts (see README).'
    )
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  }
  return client
}

export function cloudAvailable(): boolean {
  return isCloudConfigured()
}

// ---------- auth ----------

export async function getUser(): Promise<CloudUser | null> {
  if (!isCloudConfigured()) return null
  const supabase = getClient()
  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (!session) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('username, is_admin')
    .eq('id', session.user.id)
    .single()

  return {
    id: session.user.id,
    email: session.user.email ?? '',
    username: profile?.username ?? session.user.email?.split('@')[0] ?? 'user',
    isAdmin: profile?.is_admin ?? false
  }
}

export async function signUp(
  email: string,
  password: string,
  username: string
): Promise<{ user: CloudUser | null; needsConfirmation: boolean }> {
  const supabase = getClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } }
  })
  if (error) throw new Error(error.message)
  // When "Confirm email" is enabled in Supabase, there is no session yet
  if (!data.session) return { user: null, needsConfirmation: true }
  return { user: await getUser(), needsConfirmation: false }
}

export async function signIn(email: string, password: string): Promise<CloudUser> {
  const supabase = getClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  const user = await getUser()
  if (!user) throw new Error('Signed in, but could not load your profile.')
  return user
}

export async function signOut(): Promise<void> {
  if (!isCloudConfigured()) return
  await getClient().auth.signOut()
}

// ---------- pack library ----------

interface VersionRow {
  id: string
  version: string
  storage_path: string
  file_size: number
  chunk_count: number
  changelog: string
  created_at: string
}

interface PackRow {
  id: string
  name: string
  description: string
  minecraft_version: string
  loader: string
  updated_at: string
  modpack_versions: VersionRow[]
}

function latestOf(rows: VersionRow[]): VersionRow | null {
  return rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

function toCloudVersion(row: VersionRow): CloudPackVersion {
  return {
    id: row.id,
    version: row.version,
    fileSize: row.file_size,
    changelog: row.changelog,
    createdAt: row.created_at
  }
}

export async function listPacks(): Promise<CloudPack[]> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('modpacks')
    .select('id, name, description, minecraft_version, loader, updated_at, modpack_versions(*)')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)

  return (data as PackRow[]).map((row) => {
    const latest = latestOf(row.modpack_versions)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      minecraftVersion: row.minecraft_version,
      loader: row.loader,
      updatedAt: row.updated_at,
      latestVersion: latest ? toCloudVersion(latest) : null
    }
  })
}

// ---------- publishing (admins) ----------

/**
 * Supabase's free plan caps each storage object at 50 MB, so packs bigger than
 * that (custom jars that exist nowhere public must travel inside the pack) are
 * split into chunks and reassembled on download. Chunks are kept well below the
 * cap so the publish progress bar advances at a useful rate.
 */
const CHUNK_BYTES = 16 * 1024 * 1024

function chunkPaths(storagePath: string, chunkCount: number): string[] {
  if (chunkCount <= 1) return [storagePath]
  return Array.from({ length: chunkCount }, (_, i) => `${storagePath}.part${i}`)
}

function emitPublishProgress(instanceId: string, phase: string, progress: number): void {
  broadcast('cloud:publishProgress', { instanceId, phase, progress } satisfies ProgressEvent)
}

export async function publishPack(req: PublishPackRequest): Promise<{ packId: string; version: string }> {
  const supabase = getClient()
  const instance = getInstance(req.instanceId)
  const version = req.version.trim()
  if (!version) throw new Error('Please enter a version, e.g. 1.0.0')

  emitPublishProgress(req.instanceId, 'Preparing pack file', -1)
  const zipBuffer = (await buildMrpack(req.instanceId, version, req.name.trim() || instance.name)).toBuffer()

  let packId = req.packId
  const createdNewPack = !packId
  if (!packId) {
    const { data, error } = await supabase
      .from('modpacks')
      .insert({
        name: req.name.trim() || instance.name,
        description: req.description,
        minecraft_version: instance.minecraftVersion,
        loader: instance.loader,
        created_by: (await supabase.auth.getSession()).data.session?.user.id
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    packId = (data as { id: string }).id
  }

  // don't leave orphaned rows/files behind when a later step fails
  const cleanupAfterFailure = async (uploadedPaths: string[]): Promise<void> => {
    if (uploadedPaths.length > 0) await supabase.storage.from(BUCKET).remove(uploadedPaths)
    if (createdNewPack) await supabase.from('modpacks').delete().eq('id', packId)
  }

  const storagePath = `${packId}/${version.replace(/[^a-zA-Z0-9._-]/g, '_')}-${randomUUID().slice(0, 8)}.mrpack`
  const chunkCount = Math.max(1, Math.ceil(zipBuffer.length / CHUNK_BYTES))
  const paths = chunkPaths(storagePath, chunkCount)
  const totalMb = (zipBuffer.length / 1048576).toFixed(1)
  const uploaded: string[] = []
  emitPublishProgress(req.instanceId, `Uploading (0 / ${totalMb} MB)`, 0)
  for (let i = 0; i < paths.length; i++) {
    const chunk = zipBuffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(paths[i], chunk, {
      contentType: 'application/x-modrinth-modpack+zip',
      upsert: true
    })
    if (uploadError) {
      await cleanupAfterFailure(uploaded)
      throw new Error(`Upload failed: ${uploadError.message}`)
    }
    uploaded.push(paths[i])
    const sentBytes = Math.min((i + 1) * CHUNK_BYTES, zipBuffer.length)
    emitPublishProgress(
      req.instanceId,
      `Uploading (${(sentBytes / 1048576).toFixed(1)} / ${totalMb} MB)`,
      sentBytes / zipBuffer.length
    )
  }

  emitPublishProgress(req.instanceId, 'Finishing up', -1)
  const { error: versionError } = await supabase.from('modpack_versions').insert({
    modpack_id: packId,
    version,
    storage_path: storagePath,
    file_size: zipBuffer.length,
    chunk_count: chunkCount,
    changelog: req.changelog
  })
  if (versionError) {
    await cleanupAfterFailure(uploaded)
    if (versionError.code === '23505') throw new Error(`Version "${version}" already exists for this pack.`)
    throw new Error(versionError.message)
  }

  await supabase
    .from('modpacks')
    .update({
      updated_at: new Date().toISOString(),
      minecraft_version: instance.minecraftVersion,
      loader: instance.loader,
      ...(req.packId && req.name.trim() ? { name: req.name.trim() } : {}),
      ...(req.packId && req.description ? { description: req.description } : {})
    })
    .eq('id', packId)

  return { packId, version }
}

// ---------- install / update (everyone) ----------

async function downloadVersionToTemp(
  version: Pick<VersionRow, 'storage_path' | 'chunk_count'>,
  onProgress?: (phase: string, progress: number) => void
): Promise<string> {
  const supabase = getClient()
  const parts: Buffer[] = []
  const paths = chunkPaths(version.storage_path, version.chunk_count ?? 1)
  let i = 0
  for (const path of paths) {
    onProgress?.(
      paths.length > 1 ? `Downloading modpack (part ${i + 1} of ${paths.length})` : 'Downloading modpack',
      paths.length > 1 ? i / paths.length : -1
    )
    const { data, error } = await supabase.storage.from(BUCKET).download(path)
    if (error || !data) throw new Error(`Could not download the modpack: ${error?.message ?? 'unknown error'}`)
    parts.push(Buffer.from(await data.arrayBuffer()))
    i++
  }
  const tmp = join(tmpdir(), `elauncher-cloud-${randomUUID()}.mrpack`)
  writeFileSync(tmp, Buffer.concat(parts))
  return tmp
}

async function getLatestVersion(packId: string): Promise<VersionRow> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('modpack_versions')
    .select('*')
    .eq('modpack_id', packId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const row = (data as VersionRow[])[0]
  if (!row) throw new Error('This modpack has no published versions yet.')
  return row
}

/** Download a cloud pack's latest .mrpack to a temp file (used by the server-from-pack flow). */
export async function downloadCloudPackToTemp(
  packId: string,
  onProgress?: (phase: string, progress: number) => void
): Promise<string> {
  const latest = await getLatestVersion(packId)
  return downloadVersionToTemp(latest, onProgress)
}

export async function installCloudPack(packId: string): Promise<Instance> {
  const report = (phase: string, progress: number): void => emitPackTask(packId, phase, progress)
  try {
    report('Fetching pack info', -1)
    const latest = await getLatestVersion(packId)
    const tmp = await downloadVersionToTemp(latest, report)
    try {
      return await importFromZip(new AdmZip(tmp), { cloudPackId: packId }, report)
    } finally {
      rmSync(tmp, { force: true })
    }
  } finally {
    emitPackTask(packId, 'Done', 1, true)
  }
}

export async function updateFromCloud(
  instanceId: string
): Promise<{ ok: boolean; error?: string; version?: string; upToDate?: boolean }> {
  const link = getPackLink(instanceId)
  if (!link?.cloudPackId) return { ok: false, error: 'This instance is not linked to a cloud modpack.' }

  setInstallingState(instanceId, true)
  let tmp: string | null = null
  try {
    emitProgress(instanceId, 'Checking for modpack updates', -1)
    const latest = await getLatestVersion(link.cloudPackId)
    if (latest.version === link.versionId) {
      return { ok: true, version: latest.version, upToDate: true }
    }
    emitProgress(instanceId, `Downloading modpack ${latest.version}`, -1)
    tmp = await downloadVersionToTemp(latest, (phase, progress) => emitProgress(instanceId, phase, progress))
    const { version } = await applyPackUpdate(instanceId, tmp)
    return { ok: true, version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (tmp) rmSync(tmp, { force: true })
    setInstallingState(instanceId, false)
  }
}

// ---------- launcher news ----------

interface NewsRow {
  id: string
  title: string
  body: string
  excerpt: string | null
  image_url: string | null
  link_url: string | null
  linked_pack_ids: string[] | null
  author_name: string
  created_at: string
}

function toNewsItem(row: NewsRow): LauncherNewsItem {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    excerpt: row.excerpt ?? '',
    imageUrl: row.image_url ?? undefined,
    linkUrl: row.link_url ?? undefined,
    linkedPackIds: row.linked_pack_ids ?? [],
    authorName: row.author_name,
    createdAt: row.created_at
  }
}

/** Readable by everyone (RLS allows anon select), so it works before signing in. */
export async function listLauncherNews(): Promise<LauncherNewsItem[]> {
  if (!isCloudConfigured()) return []
  const supabase = getClient()
  const { data, error } = await supabase
    .from('launcher_news')
    .select('id, title, body, excerpt, image_url, link_url, linked_pack_ids, author_name, created_at')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw new Error(error.message)
  return (data as NewsRow[]).map(toNewsItem)
}

export async function publishNews(req: PublishNewsRequest): Promise<void> {
  const supabase = getClient()
  const title = req.title.trim()
  if (!title) throw new Error('Please give the article a title.')
  const body = req.body.trim()
  const fields = {
    title,
    body,
    // fall back to a trimmed slice of the body so cards always have preview text
    excerpt: req.excerpt?.trim() || body.slice(0, 180),
    image_url: req.imageUrl?.trim() || null,
    link_url: req.linkUrl?.trim() || null,
    linked_pack_ids: req.linkedPackIds ?? []
  }
  if (req.id) {
    const { error } = await supabase
      .from('launcher_news')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', req.id)
    if (error) throw new Error(error.message)
  } else {
    const me = await getUser()
    const { error } = await supabase
      .from('launcher_news')
      .insert({ ...fields, created_by: me?.id, author_name: me?.username ?? '' })
    if (error) throw new Error(error.message)
  }
}

export async function deleteNews(id: string): Promise<void> {
  const supabase = getClient()
  const { error } = await supabase.from('launcher_news').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ---------- admin panel ----------

export async function listProfiles(): Promise<CloudProfile[]> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, is_admin, created_at')
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data as { id: string; username: string; is_admin: boolean; created_at: string }[]).map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: row.created_at
  }))
}

export async function setAdmin(userId: string, isAdmin: boolean): Promise<void> {
  const supabase = getClient()
  const me = (await supabase.auth.getSession()).data.session?.user.id
  if (userId === me && !isAdmin) {
    throw new Error("You can't remove your own admin access.")
  }
  const { error } = await supabase.from('profiles').update({ is_admin: isAdmin }).eq('id', userId)
  if (error) throw new Error(error.message)
}

export async function listPacksDetailed(): Promise<CloudPackDetails[]> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('modpacks')
    .select('id, name, description, minecraft_version, loader, updated_at, modpack_versions(*)')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data as PackRow[]).map((row) => {
    const versions = row.modpack_versions
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      minecraftVersion: row.minecraft_version,
      loader: row.loader,
      updatedAt: row.updated_at,
      latestVersion: versions[0] ? toCloudVersion(versions[0]) : null,
      versions: versions.map(toCloudVersion)
    }
  })
}

export async function updatePackDetails(packId: string, name: string, description: string): Promise<void> {
  const supabase = getClient()
  const { error } = await supabase
    .from('modpacks')
    .update({ name: name.trim(), description })
    .eq('id', packId)
  if (error) throw new Error(error.message)
}

export async function deletePackVersion(versionId: string): Promise<void> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('modpack_versions')
    .select('storage_path, chunk_count')
    .eq('id', versionId)
    .single()
  if (error) throw new Error(error.message)

  const { error: deleteError } = await supabase.from('modpack_versions').delete().eq('id', versionId)
  if (deleteError) throw new Error(deleteError.message)
  // best effort: an orphaned file costs storage but breaks nothing
  const row = data as { storage_path: string; chunk_count: number }
  await supabase.storage.from(BUCKET).remove(chunkPaths(row.storage_path, row.chunk_count ?? 1))
}

export async function deletePack(packId: string): Promise<void> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('modpack_versions')
    .select('storage_path, chunk_count')
    .eq('modpack_id', packId)
  if (error) throw new Error(error.message)

  const { error: deleteError } = await supabase.from('modpacks').delete().eq('id', packId)
  if (deleteError) throw new Error(deleteError.message)

  const paths = (data as { storage_path: string; chunk_count: number }[]).flatMap((row) =>
    chunkPaths(row.storage_path, row.chunk_count ?? 1)
  )
  if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths)
}

/** Check every cloud-linked instance for a newer published version. */
export async function checkCloudUpdates(): Promise<CloudUpdateMap> {
  if (!isCloudConfigured()) return {}
  const supabase = getClient()
  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData.session) return {}

  const linked = listInstances()
    .map((i) => ({ instanceId: i.id, link: getPackLink(i.id) }))
    .filter((x): x is { instanceId: string; link: NonNullable<ReturnType<typeof getPackLink>> } =>
      Boolean(x.link?.cloudPackId)
    )
  if (linked.length === 0) return {}

  const packIds = [...new Set(linked.map((x) => x.link.cloudPackId!))]
  const { data, error } = await supabase
    .from('modpack_versions')
    .select('modpack_id, version, created_at')
    .in('modpack_id', packIds)
  if (error) throw new Error(error.message)

  const latestByPack = new Map<string, { version: string; created_at: string }>()
  for (const row of data as { modpack_id: string; version: string; created_at: string }[]) {
    const current = latestByPack.get(row.modpack_id)
    if (!current || row.created_at > current.created_at) {
      latestByPack.set(row.modpack_id, { version: row.version, created_at: row.created_at })
    }
  }

  const updates: CloudUpdateMap = {}
  for (const { instanceId, link } of linked) {
    const latest = latestByPack.get(link.cloudPackId!)
    if (latest && latest.version !== link.versionId) {
      updates[instanceId] = { packId: link.cloudPackId!, version: latest.version }
    }
  }
  return updates
}

// ---------- play together: live sessions ----------

interface SessionRow {
  host_id: string
  host_name: string
  name: string
  address: string
  minecraft_version: string | null
  loader: string | null
  cloud_pack_id: string | null
  created_at: string
  last_seen: string
}

/** sessions without a heartbeat for this long are treated as ended */
const SESSION_STALE_MS = 2 * 60 * 1000

/** keeps the host's session marked live even if they navigate away from the Play page */
let heartbeatTimer: NodeJS.Timeout | null = null

function toSession(r: SessionRow, meId: string): GameSession {
  return {
    id: r.host_id,
    hostId: r.host_id,
    hostName: r.host_name,
    name: r.name,
    address: r.address,
    minecraftVersion: r.minecraft_version ?? undefined,
    loader: r.loader ?? undefined,
    cloudPackId: r.cloud_pack_id ?? undefined,
    createdAt: r.created_at,
    isMine: r.host_id === meId
  }
}

/** Publish (or refresh) the signed-in user's live session. One session per host. */
export async function publishSession(req: PublishSessionRequest): Promise<GameSession> {
  const supabase = getClient()
  const me = await getUser()
  if (!me) throw new Error('Sign in to your ELauncher account to host a session.')
  if (!req.address.trim()) throw new Error('A join address is required to publish a session.')
  const { data, error } = await supabase
    .from('sessions')
    .upsert(
      {
        host_id: me.id,
        host_name: me.username,
        name: req.name.trim() || `${me.username}'s world`,
        address: req.address.trim(),
        minecraft_version: req.minecraftVersion ?? null,
        loader: req.loader ?? null,
        cloud_pack_id: req.cloudPackId ?? null,
        last_seen: new Date().toISOString()
      },
      { onConflict: 'host_id' }
    )
    .select()
    .single()
  if (error) throw new Error(error.message)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => void heartbeatSession(), 60_000)
  return toSession(data as SessionRow, me.id)
}

/** Keep the current user's session marked live (called on an interval while hosting). */
export async function heartbeatSession(): Promise<void> {
  if (!isCloudConfigured()) return
  const supabase = getClient()
  const meId = (await supabase.auth.getSession()).data.session?.user.id
  if (!meId) return
  await supabase.from('sessions').update({ last_seen: new Date().toISOString() }).eq('host_id', meId)
}

/** Take down the current user's session. */
export async function endSession(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (!isCloudConfigured()) return
  const supabase = getClient()
  const meId = (await supabase.auth.getSession()).data.session?.user.id
  if (!meId) return
  await supabase.from('sessions').delete().eq('host_id', meId)
}

/** Every friend's currently-live session (stale ones filtered out). */
export async function listSessions(): Promise<GameSession[]> {
  if (!isCloudConfigured()) return []
  const supabase = getClient()
  const meId = (await supabase.auth.getSession()).data.session?.user.id
  if (!meId) return []
  const cutoff = new Date(Date.now() - SESSION_STALE_MS).toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .gt('last_seen', cutoff)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data as SessionRow[]).map((r) => toSession(r, meId))
}
