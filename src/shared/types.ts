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
  /** hostname published instead of the detected public IP for router-mapped servers (e.g. play.example.com) */
  publicHost?: string
  /** newline-separated hostnames hosted servers claim one-each, so every customer sees a unique address */
  hostPool?: string
  /** DuckDNS account token — keeps .duckdns.org pool names pointed at this connection automatically */
  duckdnsToken?: string
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
  projectType?: 'mod' | 'shader' | 'resourcepack' | 'modpack' | 'plugin'
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

// ---------- local dedicated server hosting ----------

export type ServerKind = 'vanilla' | 'paper' | 'fabric' | 'neoforge' | 'forge'

/** Which game a local dedicated server runs. Absent on old records = minecraft. */
/**
 * Games run by the generic SteamCMD registry. Adding one here makes the
 * compiler demand a matching STEAM_GAMES entry, which is the point: the id used
 * to be spelled out in six places and missing one shipped a game that
 * typechecked but had no spec behind it.
 */
export type SteamServerGame = 'valheim' | 'sdtd'

export type ServerGame = 'minecraft' | 'palworld' | SteamServerGame

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'stopping'

/** A dedicated game server managed by the launcher, running on this PC. */
/** Hosted-plan resource caps, stamped by the provisioner and enforced at every start. */
export interface PlanLimits {
  /** RAM ceiling in MiB — minecraft: hard Xmx cap; palworld: forced memory-guard restart */
  memoryMb?: number
  /** player-slot cap the customer cannot raise */
  maxPlayers?: number
  /** CPU core cap — Linux hosts pin the server's process tree to this many cores */
  cpuCores?: number
}

export interface LocalServer {
  id: string
  name: string
  /** undefined = minecraft (records predate multi-game support) */
  game?: ServerGame
  /** minecraft only; palworld records carry a placeholder */
  kind: ServerKind
  /** minecraft only; empty for other games */
  minecraftVersion: string
  /** loader version for fabric/neoforge/forge servers */
  loaderVersion?: string
  /** set when the server was created from a modpack or an instance */
  packName?: string
  /** main game port (TCP for minecraft, UDP for palworld) */
  port: number
  /** max heap in MiB (minecraft only; 0 for games that size themselves) */
  memoryMax: number
  /** Mojang java runtime component the server runs on. Empty for non-java games */
  javaComponent: string
  /** the game's server terms (Minecraft EULA / Palworld server terms) */
  eulaAccepted: boolean
  /** palworld: list in the official community server browser (-publiclobby) */
  communityServer?: boolean
  /** the caps actually in force = the plan's, with any admin override merged over them */
  limits?: PlanLimits
  /** the plan's own caps, kept so an override can be recomputed when the plan changes */
  limitsPlan?: PlanLimits
  /** admin lift above the plan, per field — survives the provisioner's reconcile */
  limitsOverride?: PlanLimits
  /** scheduled saves/restarts/backups + lifecycle switches */
  automation?: ServerAutomation
  /** extra router ports mods need (voice chat, web maps) — opened with the server */
  extraPorts?: ExtraPort[]
  /** the hosting order this server was built for; lets a host recognise its own
   *  half-finished work instead of building the order a second time */
  orderId?: string
  createdAt: number
}

/** A router port a mod needs beyond the game's own. */
export interface ExtraPort {
  port: number
  protocol: 'UDP' | 'TCP'
  /** what needs it ("Simple Voice Chat") — also the description the router lists */
  label: string
}

/** One port's live exposure, for the panel's Network tab. */
export interface PortStatus extends ExtraPort {
  /** a router mapping (or a directly-public NIC) is live for this port */
  open: boolean
  /** where it's reachable once open, as host:port */
  address?: string
  /** router caveat — CGNAT, or a lease that has to be re-asserted */
  warning?: string
  /** why the last attempt to open it failed */
  error?: string
  /** the game's own port: shown for context, not editable as a mod port */
  main?: boolean
}

/** A mod that's known to need a port, offered as a one-tap preset. */
export interface PortPreset extends ExtraPort {
  note: string
}

/** Everything the Network tab renders from. */
export interface ServerPortsView {
  ports: PortStatus[]
  presets: PortPreset[]
  /** port number -> why opening it deserves a second thought (RCON, admin APIs) */
  cautions: Record<string, string>
  /** the host's own IP is public (a VPS): no router to map, the firewall is the gate */
  direct: boolean
  maxExtra: number
}

/** Per-server automation. Everything is off unless set; timers run while the server is online. */
export interface ServerAutomation {
  /** save the world every N minutes (0/undefined = off) */
  saveIntervalMin?: number
  restartMode?: 'off' | 'interval' | 'daily'
  /** used when restartMode is 'interval' */
  restartEveryHours?: number
  /** "HH:MM" local time, used when restartMode is 'daily' */
  restartDailyAt?: string
  /** minutes of in-game warning before an automated restart (default 5) */
  restartWarningMin?: number
  /** bring the server back up after a crash (guarded against crash loops) */
  restartOnCrash?: boolean
  /** start this server when the launcher starts */
  autoStart?: boolean
  /** copy the world/save folders every N hours (0 = off) */
  backupIntervalHours?: number
  /** how many backups to keep (default 5) */
  backupKeep?: number
  /** warned restart when the server process exceeds this much memory, MiB (0 = off) */
  restartAboveMemoryMB?: number
}

/** Where a new server's content comes from. */
export type ServerSource =
  | { type: 'fresh'; kind: ServerKind; minecraftVersion: string }
  /** Palworld dedicated server, installed via SteamCMD */
  | { type: 'palworld'; serverPassword?: string; maxPlayers?: number; communityServer?: boolean }
  /** Any other SteamCMD dedicated server from the generic registry (valheim, 7 days to die, …) */
  | { type: 'steamgame'; game: SteamServerGame; serverPassword?: string; maxPlayers?: number }
  /** picks a local .mrpack via a file dialog */
  | { type: 'mrpack' }
  /** installs a pack from the cloud modpack library */
  | { type: 'cloudPack'; packId: string }
  /** installs a modpack straight from the Modrinth browser */
  | { type: 'modrinthPack'; projectId: string }
  /** installs a modpack straight from the CurseForge browser (needs the CF API key) */
  | { type: 'curseforgePack'; projectId: string }
  /** mirrors one of your instances (server-safe mods + configs) */
  | { type: 'instance'; instanceId: string }

/** A mod jar living in a local server's mods folder. */
export interface ServerMod {
  fileName: string
  sizeBytes: number
  /** metadata when installed through the launcher's server mod browser */
  projectId?: string
  title?: string
  versionNumber?: string
  iconUrl?: string
}

/** One entry in a server-folder listing (file manager). */
export interface ServerFileEntry {
  name: string
  isDir: boolean
  sizeBytes: number
  modifiedAt: number
  /**
   * Whether the extension says this opens in the text editor. An affordance
   * hint, not a promise — the read still sniffs for NUL bytes and can refuse.
   */
  isText?: boolean
}

/** whitelist.json / ops.json / banned-players.json entry */
export interface PlayerListEntry {
  name: string
  uuid?: string
}

/** Live player row from a Palworld server's REST API. */
export interface PalworldPlayerDetail {
  name: string
  accountName?: string
  playerId?: string
  /** platform id (steam_xxx) — the handle kick/ban act on */
  userId?: string
  level?: number
  ping?: number
}

export type PalworldModerationAction = 'kick' | 'ban' | 'unban' | 'announce'

// ---------- remote server management (cloud relay) ----------

/** A grant letting another launcher user manage one of your servers. */
export interface ServerShare {
  id: string
  serverId: string
  serverName: string
  granteeId: string
  granteeName: string
}

/** Live snapshot of a remote server: shared with you, or your own on another device. */
export interface ManagedServer {
  serverId: string
  ownerName: string
  /** true when this is your own server, hosted by your launcher on another PC */
  isMine?: boolean
  name: string
  state: LocalServerState
  players: string[]
  address?: string
  /** last console lines, newline-joined */
  console: string
  updatedAt: string
}

/**
 * Commands a manager launcher or the web panel can queue for a hosting
 * launcher. `forceStop` skips the graceful save and kills the process tree —
 * the escape hatch when a server ignores `stop`.
 */
export type RemoteCommandAction = 'start' | 'stop' | 'forceStop' | 'command'

// ---------- server browser (saved servers + live status) ----------

export interface SavedServerEntry {
  id: string
  name: string
  address: string
  addedAt: number
}

/** Result of a native Server List Ping against a Minecraft server. */
export interface ServerPingResult {
  online: boolean
  /** flattened MOTD text */
  motd?: string
  players?: { online: number; max: number }
  version?: string
  latencyMs?: number
  error?: string
}

export interface CreateServerOptions {
  name: string
  memoryMax?: number
  /** must be true — writes eula.txt */
  acceptEula: boolean
  source: ServerSource
  /** set by the hosting provisioner — stamps the order onto the record */
  orderId?: string
}

export interface ServerStatus {
  state: LocalServerState
  /** online player names, parsed from the server log */
  players: string[]
  /** public bore address when a tunnel is up for this server */
  tunnelAddress?: string | null
  /** live process working set in MiB (null when not running or not yet sampled) */
  memoryMB?: number | null
  /** live process CPU load as % of the whole machine (null when unknown) */
  cpuPercent?: number | null
  /** epoch ms when the current run started (null when stopped) */
  startedAt?: number | null
  /** game server version, when the server reports one */
  version?: string | null
  /** live performance reading from lag warnings + CPU (minecraft); null when stopped */
  health?: 'smooth' | 'fair' | 'poor' | null
}

export interface ServerStateEvent extends ServerStatus {
  serverId: string
  error?: string
}

export interface ServerLogEvent {
  serverId: string
  line: string
}

/** Progress of a long server task (creating, downloading java), for the Server tab. */
export interface ServerTaskEvent {
  phase: string
  /** 0..1, or -1 when indeterminate */
  progress: number
  done?: boolean
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

// ---------- host performance estimator ----------

export interface HostSpecs {
  cpuModel: string
  threads: number
  speedGHz: number
  ramGB: number
  /** free at scan time — a mood, not a constant */
  freeRamGB: number
  diskType: 'SSD' | 'HDD' | 'Unknown'
}

export type HostVerdict = 'great' | 'good' | 'tight' | 'no'

export interface HostGameEstimate {
  game: string
  verdict: HostVerdict
  /** rough comfortable player band, e.g. "~12–20" */
  players: string
  note: string
}

/** Honest, heuristic estimate of how well this PC hosts game servers. */
export interface HostReport {
  specs: HostSpecs
  games: HostGameEstimate[]
  limitations: string[]
  generatedAt: number
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
