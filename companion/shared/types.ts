// ELauncher NVMP Companion: the contract between game detection (companion/main/detect.ts, loadOrder.ts,
// dataSet.ts), the upload controller (companion/main/upload.ts) and the window (companion/renderer).
// Pure types: importable from main, preload and renderer.

/** Where an install was found. */
export type GameSource = 'steam' | 'steam-pcr' | 'gog' | 'epic' | 'xbox' | 'bethesda-registry' | 'mo2' | 'manual'

/** A Mod Organizer 2 setup that runs this install (its mods are virtual: not in the real Data folder). */
export interface Mo2Setup {
  instanceDir: string                 // folder holding ModOrganizer.ini
  profile: string                     // the selected profile's name
  profileDir: string                  // .../profiles/<profile>
  modsDir: string                     // .../mods (or the ini's mod_directory)
  overwriteDir: string                // .../overwrite (or the ini's overwrite_directory)
}

/** One Fallout: New Vegas install the companion can upload from. */
export interface GameCandidate {
  id: string                          // stable key: source + lower-cased real root (+ MO2 profile)
  root: string                        // folder with FalloutNV.exe
  data: string                        // root/Data (real on-disk casing)
  source: GameSource
  label: string                       // e.g. "Steam - D:\SteamLibrary\steamapps\common\Fallout New Vegas"
  hasNvmpLauncher: boolean            // nvmp_launcher.exe next to FalloutNV.exe: the copy NV:MP actually runs
  supported: boolean                  // false for editions NV:MP/xNVSE do not support (Game Pass, Epic without patch)
  warnings: string[]                  // shown to the player before upload
  mo2?: Mo2Setup                      // set when the files to upload are an MO2 profile's merged view
}

/** One file to upload: its real path on disk, and its path under Data with forward slashes. */
export interface DataEntry {
  abs: string
  rel: string                         // e.g. "Meshes/foo.nif" (NOT prefixed with "Data/")
  size: number
  modified: number                    // Math.floor(stat.mtimeMs): what the manifest sends
  fileId?: string                     // "dev:ino" at scan time: the reader refuses another file at this path
}

/** A link in Data (or a mod) whose files live outside the game, MO2 mods and overwrite. */
export interface OutsideLink {
  rel: string                         // the link's path under Data, e.g. "Textures/shared"
  target: string                      // the real folder or file it points to
}

/** What would be uploaded, before any network call. */
export interface DataSetScan {
  entries: DataEntry[]                // files that pass nvmpAssetPath, in no particular order
  totalBytes: number
  skippedExecutables: string[]        // "Data/..." paths the host refuses (DLL/ASI/EXE...): need host assistance
  problems: string[]                  // anything that stops the upload (limits, case collisions, bad names...)
  outsideLinks?: OutsideLink[]        // links in Data (or a mod) whose files live outside the game, MO2 mods
                                      // and overwrite: listed, and the player approves exactly these
}

/** The load order to send with nvmpFinish. */
export interface LoadOrderResult {
  plugins: string[]                   // FalloutNV.esm first, exact on-disk case of the scanned files
  text: string                        // plugins joined with "\r\n" plus a trailing "\r\n"
  source: 'plugins.txt' | 'mo2-profile' | 'timestamps'
  warnings: string[]                  // e.g. plugins.txt names a missing plugin; order disagrees with timestamps
  timestampOrder?: string[]           // the engine's own order (masters first, then mtime), when it differs
}

/** NV:MP servers the signed-in account can set up. */
export interface CompanionServer {
  serverId: string
  ownerId: string                     // the HOST's user id (rented servers are shared to the customer)
  name: string
  state: string                       // 'stopped' | 'running' | 'starting' | ...
  hostOnline: boolean                 // !isStale(row)
  phase?: 'waiting' | 'uploading' | 'committing' | 'ready' | 'unknown'
  canEdit?: boolean                   // info.canShare: host, admin or the renting customer
}

/** Upload progress pushed from main to the window. */
export interface UploadProgress {
  state: 'idle' | 'scanning' | 'starting' | 'uploading' | 'paused' | 'finishing' | 'ready' | 'error'
  sentBytes: number
  totalBytes: number
  file?: string                       // current "Data/..." path
  message?: string
  bytesPerSecond?: number
}

/** The API the preload exposes as window.companion. */
export interface CompanionApi {
  version(): Promise<string>
  session(): Promise<{ email: string; userId: string } | null>
  signIn(email: string, password: string): Promise<{ email: string; userId: string }>
  signOut(): Promise<void>
  servers(): Promise<CompanionServer[]>
  findGames(): Promise<GameCandidate[]>
  chooseFolder(): Promise<GameCandidate | null>        // a manual pick, validated like the found ones
  prepare(gameId: string): Promise<{ scan: Omit<DataSetScan, 'entries'> & { files: number }; loadOrder: LoadOrderResult }>
  setLoadOrder(text: string): Promise<LoadOrderResult> // the player's edit, re-validated against the scan
  upload(serverId: string, gameId: string, opts?: { approvedLinks?: OutsideLink[] }): Promise<void>
                                      // stops nothing by itself; refuses a running server. approvedLinks: the
                                      // outside links the window showed and the player ticked. Main scans again
                                      // and refuses (issue 'links') any outside link that is neither in that set
                                      // nor already agreed for this upload job.
  pause(): Promise<void>
  discard(serverId: string): Promise<void>
  start(serverId: string): Promise<void>
  stop(serverId: string): Promise<void>
  onProgress(cb: (p: UploadProgress) => void): () => void
  openExternal(url: string): Promise<void>
}
