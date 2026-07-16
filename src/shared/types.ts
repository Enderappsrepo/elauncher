export type ModLoader = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

export type ModSource = 'modrinth' | 'curseforge'

export interface Account {
  uuid: string
  name: string
  /** base64 png of the face, if available */
  avatar?: string
}

export interface AccountsState {
  accounts: Account[]
  activeUuid: string | null
}

export interface Instance {
  id: string
  name: string
  /**
   * cover art: "cover:<id>" for a curated gradient cover, or "file:<name>" for a
   * custom image stored in the instance folder. Undefined = auto gradient.
   */
  icon?: string
  minecraftVersion: string
  loader: ModLoader
  /** loader version, e.g. fabric loader 0.16.9. Empty for vanilla */
  loaderVersion?: string
  /** MiB. 0 = use global default */
  memoryMax: number
  extraJvmArgs?: string
  javaPathOverride?: string
  createdAt: number
  lastPlayedAt?: number
  /** accumulated play time in milliseconds */
  totalPlayMs?: number
}

export interface CreateInstanceOptions {
  name: string
  minecraftVersion: string
  loader: ModLoader
  loaderVersion?: string
}

export interface Settings {
  defaultMemoryMax: number
  javaPath?: string
  curseforgeApiKey?: string
  /** tuned garbage-collector flags + pre-allocated heap. Default on */
  optimizedJvmFlags?: boolean
  /** which collector the optimized flags use. auto = ZGC on Java 21+, else G1. Default auto */
  jvmGc?: 'auto' | 'g1' | 'zgc'
  /** size memory from system RAM and the pack's loader when an instance doesn't set its own. Default on */
  autoMemory?: boolean
  /** run the game process at above-normal priority. Default off */
  highProcessPriority?: boolean
}

export interface MinecraftVersionInfo {
  id: string
  type: 'release' | 'snapshot' | string
  releaseTime: string
}

export type InstanceRunState = 'idle' | 'installing' | 'running'

export interface ProgressEvent {
  instanceId: string
  /** short phase label, e.g. "Downloading assets" */
  phase: string
  /** 0..1, or -1 when indeterminate */
  progress: number
}

export interface GameLogEvent {
  instanceId: string
  line: string
}

/** Progress of a modpack install/import task that isn't tied to an existing instance yet. */
export interface PackTaskEvent {
  /** cloud pack id, or 'import' for file/url imports */
  taskId: string
  phase: string
  /** 0..1, or -1 when indeterminate */
  progress: number
  /** true when the task finished (success or failure) */
  done?: boolean
}

export interface GameStateEvent {
  instanceId: string
  state: InstanceRunState
  /** set when state is idle and the game exited abnormally */
  crashed?: boolean
  exitCode?: number | null
  error?: string
}

export interface ModSearchHit {
  source: ModSource
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  iconUrl?: string
  pageUrl: string
}

export interface ModSearchResult {
  hits: ModSearchHit[]
  totalHits: number
}

export interface ModSearchQuery {
  query: string
  mcVersion?: string
  loader?: ModLoader
  source: ModSource
  offset?: number
  limit?: number
  /** what kind of content to search. Defaults to 'mod' */
  projectType?: 'mod' | 'shader' | 'resourcepack' | 'modpack'
}

export interface InstalledMod {
  fileName: string
  /** file name without the .disabled suffix */
  displayName: string
  enabled: boolean
  sizeBytes: number
  /** metadata if this mod was installed through the launcher */
  source?: ModSource
  projectId?: string
  versionId?: string
  versionNumber?: string
  title?: string
  iconUrl?: string
}

export interface ModUpdateInfo {
  fileName: string
  projectId: string
  source: ModSource
  currentVersionId: string
  newVersionId: string
  newVersionNumber: string
}

/** name/version/icon parsed straight out of a mod jar (for mods added outside the launcher) */
export interface JarModInfo {
  name?: string
  version?: string
  /** icon embedded in the jar, as a png data url */
  iconDataUrl?: string
}

/** result of a mod toggle/remove: whether it worked, plus the refreshed list either way */
export interface ModListResult {
  ok: boolean
  error?: string
  mods: InstalledMod[]
}

/** result of asking Modrinth to identify unknown jars by hash */
export interface IdentifyResult {
  /** how many previously-unknown mods were matched and adopted into launcher metadata */
  identified: number
  mods: InstalledMod[]
}

export interface ModInstallRequest {
  instanceId: string
  source: ModSource
  projectId: string
  /** specific version; when omitted, latest compatible version is used */
  versionId?: string
}

export interface OperationResult {
  ok: boolean
  error?: string
}

/** Info about the modpack an instance was created from (stored in instance meta). */
export interface PackLink {
  name: string
  /** versionId string from the pack index, e.g. "1.2.0" */
  versionId: string
  /** download url when imported from a link; undefined when imported from a local file */
  url?: string
  /** set when installed from the cloud modpack library */
  cloudPackId?: string
  importedAt: number
}

// ---------- cloud (Supabase) ----------

export interface CloudUser {
  id: string
  email: string
  username: string
  isAdmin: boolean
}

export interface CloudPackVersion {
  id: string
  version: string
  fileSize: number
  changelog: string
  createdAt: string
}

export interface CloudPack {
  id: string
  name: string
  description: string
  minecraftVersion: string
  loader: string
  updatedAt: string
  latestVersion: CloudPackVersion | null
}

export interface PublishPackRequest {
  instanceId: string
  /** when set, publishes a new version of this existing pack instead of creating one */
  packId?: string
  name: string
  description: string
  version: string
  changelog: string
}

/** instanceId -> newer version available in the cloud */
export type CloudUpdateMap = Record<string, { packId: string; version: string }>

export interface CloudProfile {
  id: string
  username: string
  isAdmin: boolean
  createdAt: string
}

export interface CloudPackDetails extends CloudPack {
  versions: CloudPackVersion[]
}

// ---------- play together (live sessions) ----------

/** A friend's live "play together" session, published to the shared cloud. */
export interface GameSession {
  id: string
  hostId: string
  hostName: string
  /** world / session display name */
  name: string
  /** join address (e4mc.link host, or bore.pub:port for the vanilla tunnel) */
  address: string
  minecraftVersion?: string
  loader?: string
  /** optional linked cloud modpack so friends can install the matching pack */
  cloudPackId?: string
  createdAt: string
  /** true when this session is hosted by the signed-in user */
  isMine: boolean
}

export interface PublishSessionRequest {
  name: string
  address: string
  minecraftVersion?: string
  loader?: string
  cloudPackId?: string
}

// ---------- migration from other launchers ----------

export type SourceLauncher = 'curseforge' | 'modrinth' | 'vanilla'

export interface MigrationCandidate {
  /** absolute path of the source instance folder; also the id */
  path: string
  launcher: SourceLauncher
  name: string
  minecraftVersion?: string
  loader: ModLoader
  loaderVersion?: string
  hasWorlds: boolean
  modCount: number
}

export interface MigrateRequest {
  path: string
  mods: boolean
  configs: boolean
  options: boolean
  servers: boolean
  resourcePacks: boolean
  worlds: boolean
}

export interface CopySettingsRequest {
  fromId: string
  toId: string
  options: boolean
  servers: boolean
  configs: boolean
  resourcePacks: boolean
}

// ---------- content packs (shaders / resource packs) ----------

export type ContentKind = 'shader' | 'resourcepack'

export interface InstalledPack {
  fileName: string
  /** file name without the .disabled suffix */
  displayName: string
  enabled: boolean
  sizeBytes: number
  title?: string
  iconUrl?: string
  source?: ModSource
  projectId?: string
  versionNumber?: string
}

// ---------- performance / optimize ----------

export type PerfCategory = 'core' | 'extra' | 'shaders'

export type PerfModStatus = 'installed' | 'available' | 'incompatible' | 'conflict'

export interface PerfMod {
  slug: string
  /** canonical Modrinth project id, resolved from the slug (undefined when lookup failed) */
  projectId?: string
  name: string
  /** one-line description of what the mod does */
  blurb: string
  category: PerfCategory
  status: PerfModStatus
  iconUrl?: string
  /** when status is 'conflict', the name of the installed mod this one refuses to run alongside */
  conflictsWith?: string
}

export interface OptimizeResult {
  installed: number
  failed: number
  /** requested mods that were skipped because they clash with an already-installed mod */
  blocked?: number
}

/** Two or more already-installed mods that can't run together (e.g. Sodium + Embeddium). */
export interface ModConflict {
  /** display names of the clashing mods */
  mods: string[]
  /** plain-language explanation and how to resolve it */
  reason: string
}

export interface OptimizationPlan {
  /** false for vanilla instances — performance mods need a mod loader */
  loaderSupported: boolean
  mods: PerfMod[]
  /** clashes detected among the mods already installed, surfaced as a recovery warning */
  conflicts: ModConflict[]
}

export type GraphicsPreset = 'performance' | 'balanced' | 'quality'

// ---------- game options (options.txt) ----------

export interface GameOptions {
  /** true when options.txt exists on disk */
  exists: boolean
  /** raw key -> value entries, in file order */
  entries: Record<string, string>
}

// ---------- worlds ----------

export interface WorldInfo {
  /** folder name inside saves/, also the id */
  folderName: string
  name: string
  /** epoch ms */
  lastPlayed?: number
  gameMode?: 'survival' | 'creative' | 'adventure' | 'spectator'
  hardcore?: boolean
  cheats?: boolean
  versionName?: string
  sizeBytes: number
  /** world icon as data url, when the world has one */
  icon?: string
}

// ---------- servers ----------

export interface ServerEntry {
  name: string
  ip: string
  /** base64 png favicon, preserved on save */
  icon?: string
}

// ---------- skins ----------

export interface SkinInfo {
  /** current skin texture url on Mojang's CDN */
  url?: string
  /** skin png as data url (CORS-safe for the 3D viewer) */
  dataUrl?: string
  variant: 'classic' | 'slim'
  capes: { id: string; alias: string; url: string; active: boolean }[]
}

export interface SavedSkin {
  id: string
  name: string
  variant: 'classic' | 'slim'
  /** png data url for preview */
  dataUrl: string
  addedAt: number
}

/** A skin found by browsing/searching another player, ready to preview or apply. */
export interface SkinSearchResult {
  username: string
  uuid: string
  /** skin texture url on Mojang's CDN */
  url: string
  /** png data url for the CORS-safe 3D preview */
  dataUrl: string
  variant: 'classic' | 'slim'
}

// ---------- news ----------

export interface NewsLinkedPack {
  id: string
  name: string
  description: string
  minecraftVersion: string
  loader: string
  latestVersion: string | null
}

export interface NewsItem {
  id: string
  title: string
  tag?: string
  date: string
  /** short preview shown on cards; falls back to a body slice */
  excerpt?: string
  text: string
  readMoreUrl?: string
  imageUrl?: string
  category: 'news' | 'patch-notes' | 'launcher'
  authorName?: string
  linkedPacks?: NewsLinkedPack[]
}

/** Admin-authored article stored in the launcher cloud. */
export interface LauncherNewsItem {
  id: string
  title: string
  body: string
  excerpt: string
  imageUrl?: string
  linkUrl?: string
  linkedPackIds: string[]
  authorName: string
  createdAt: string
}

export interface PublishNewsRequest {
  /** set to edit an existing article */
  id?: string
  title: string
  body: string
  excerpt?: string
  imageUrl?: string
  linkUrl?: string
  linkedPackIds?: string[]
}

/* ---- launcher self-update ---- */

export type UpdaterState =
  | 'dev' // running unpackaged — updater disabled
  | 'idle'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdaterStatus {
  state: UpdaterState
  /** version of the running app */
  currentVersion: string
  /** version offered by the update feed, when one is known */
  version?: string
  /** release notes for the offered version (plain text, trimmed) */
  notes?: string
  /** download progress 0–100 while downloading */
  percent?: number
  /** download speed in bytes/sec while downloading */
  bytesPerSecond?: number
  error?: string
  /** portable builds can't self-install; the UI offers the download page instead */
  portable?: boolean
}
