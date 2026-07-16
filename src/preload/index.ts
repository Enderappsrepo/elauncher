import { contextBridge, ipcRenderer } from 'electron'
import type {
  Account,
  AccountsState,
  CloudPack,
  CloudPackDetails,
  CloudProfile,
  CloudUpdateMap,
  CloudUser,
  ContentKind,
  CopySettingsRequest,
  CreateInstanceOptions,
  GameLogEvent,
  GameOptions,
  GameSession,
  GameStateEvent,
  GraphicsPreset,
  IdentifyResult,
  Instance,
  InstalledMod,
  InstalledPack,
  InstanceRunState,
  JarModInfo,
  LauncherNewsItem,
  MigrateRequest,
  MigrationCandidate,
  MinecraftVersionInfo,
  ModInstallRequest,
  ModListResult,
  ModLoader,
  ModSearchQuery,
  ModSearchResult,
  ModSource,
  ModUpdateInfo,
  NewsItem,
  OperationResult,
  OptimizationPlan,
  PackLink,
  PackTaskEvent,
  ProgressEvent,
  PublishNewsRequest,
  PublishPackRequest,
  PublishSessionRequest,
  SavedSkin,
  CreateServerOptions,
  LocalServer,
  LocalServerState,
  ManagedServer,
  PlayerListEntry,
  PalworldModerationAction,
  PalworldPlayerDetail,
  SavedServerEntry,
  ServerAutomation,
  ServerEntry,
  ServerFileEntry,
  ServerLogEvent,
  ServerMod,
  ServerPingResult,
  ServerShare,
  ServerStateEvent,
  ServerTaskEvent,
  Settings,
  SkinInfo,
  SkinSearchResult,
  UpdaterStatus,
  WorldInfo
} from '@shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  auth: {
    login: (): Promise<Account> => ipcRenderer.invoke('auth:login'),
    logout: (uuid: string): Promise<AccountsState> => ipcRenderer.invoke('auth:logout', uuid),
    getState: (): Promise<AccountsState> => ipcRenderer.invoke('auth:getState'),
    setActive: (uuid: string): Promise<AccountsState> => ipcRenderer.invoke('auth:setActive', uuid)
  },
  versions: {
    minecraft: (): Promise<MinecraftVersionInfo[]> => ipcRenderer.invoke('versions:minecraft'),
    loader: (loader: ModLoader, mcVersion: string): Promise<string[]> =>
      ipcRenderer.invoke('versions:loader', loader, mcVersion)
  },
  instances: {
    list: (): Promise<Instance[]> => ipcRenderer.invoke('instances:list'),
    create: (opts: CreateInstanceOptions): Promise<Instance> =>
      ipcRenderer.invoke('instances:create', opts),
    update: (instance: Instance): Promise<Instance> =>
      ipcRenderer.invoke('instances:update', instance),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('instances:remove', id),
    duplicate: (id: string): Promise<Instance> => ipcRenderer.invoke('instances:duplicate', id),
    openFolder: (id: string): Promise<void> => ipcRenderer.invoke('instances:openFolder', id),
    copySettings: (req: CopySettingsRequest): Promise<{ ok: boolean; error?: string; copied: string[] }> =>
      ipcRenderer.invoke('instances:copySettings', req),
    getIconData: (id: string): Promise<string | null> => ipcRenderer.invoke('instances:getIconData', id),
    pickIcon: (id: string): Promise<Instance | null> => ipcRenderer.invoke('instances:pickIcon', id),
    setIcon: (id: string, icon: string | undefined): Promise<Instance> =>
      ipcRenderer.invoke('instances:setIcon', id, icon)
  },
  game: {
    launch: (instanceId: string, joinServer?: string): Promise<OperationResult> =>
      ipcRenderer.invoke('game:launch', instanceId, joinServer),
    kill: (instanceId: string): Promise<void> => ipcRenderer.invoke('game:kill', instanceId),
    getStates: (): Promise<Record<string, InstanceRunState>> => ipcRenderer.invoke('game:getStates'),
    getLogs: (instanceId: string): Promise<string[]> => ipcRenderer.invoke('game:getLogs', instanceId),
    onProgress: (cb: (e: ProgressEvent) => void): (() => void) => on('game:progress', cb),
    onLog: (cb: (e: GameLogEvent) => void): (() => void) => on('game:log', cb),
    onState: (cb: (e: GameStateEvent) => void): (() => void) => on('game:state', cb)
  },
  mods: {
    search: (query: ModSearchQuery): Promise<ModSearchResult> =>
      ipcRenderer.invoke('mods:search', query),
    install: (req: ModInstallRequest): Promise<OperationResult> =>
      ipcRenderer.invoke('mods:install', req),
    listInstalled: (instanceId: string): Promise<InstalledMod[]> =>
      ipcRenderer.invoke('mods:listInstalled', instanceId),
    jarInfo: (instanceId: string): Promise<Record<string, JarModInfo>> =>
      ipcRenderer.invoke('mods:jarInfo', instanceId),
    identify: (instanceId: string): Promise<IdentifyResult> =>
      ipcRenderer.invoke('mods:identify', instanceId),
    toggle: (instanceId: string, fileName: string): Promise<ModListResult> =>
      ipcRenderer.invoke('mods:toggle', instanceId, fileName),
    remove: (instanceId: string, fileName: string): Promise<ModListResult> =>
      ipcRenderer.invoke('mods:remove', instanceId, fileName),
    checkUpdates: (instanceId: string): Promise<ModUpdateInfo[]> =>
      ipcRenderer.invoke('mods:checkUpdates', instanceId),
    applyUpdate: (instanceId: string, update: ModUpdateInfo): Promise<OperationResult> =>
      ipcRenderer.invoke('mods:applyUpdate', instanceId, update)
  },
  packs: {
    exportInstance: (instanceId: string): Promise<OperationResult> =>
      ipcRenderer.invoke('packs:export', instanceId),
    importPack: (): Promise<Instance | null> => ipcRenderer.invoke('packs:import'),
    importPackFromUrl: (url: string): Promise<Instance> => ipcRenderer.invoke('packs:importUrl', url),
    installModpack: (source: ModSource, projectId: string): Promise<Instance> =>
      ipcRenderer.invoke('packs:installModpack', source, projectId),
    updatePack: (instanceId: string): Promise<{ ok: boolean; error?: string; version?: string; upToDate?: boolean }> =>
      ipcRenderer.invoke('packs:update', instanceId),
    getPackLink: (instanceId: string): Promise<PackLink | null> =>
      ipcRenderer.invoke('packs:getLink', instanceId),
    onProgress: (cb: (e: PackTaskEvent) => void): (() => void) => on('packs:progress', cb)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (settings: Settings): Promise<Settings> => ipcRenderer.invoke('settings:set', settings)
  },
  cloud: {
    available: (): Promise<boolean> => ipcRenderer.invoke('cloud:available'),
    getUser: (): Promise<CloudUser | null> => ipcRenderer.invoke('cloud:getUser'),
    signUp: (
      email: string,
      password: string,
      username: string
    ): Promise<{ user: CloudUser | null; needsConfirmation: boolean }> =>
      ipcRenderer.invoke('cloud:signUp', email, password, username),
    signIn: (email: string, password: string): Promise<CloudUser> =>
      ipcRenderer.invoke('cloud:signIn', email, password),
    signOut: (): Promise<void> => ipcRenderer.invoke('cloud:signOut'),
    listPacks: (): Promise<CloudPack[]> => ipcRenderer.invoke('cloud:listPacks'),
    publish: (req: PublishPackRequest): Promise<{ ok: boolean; error?: string; packId?: string; version?: string }> =>
      ipcRenderer.invoke('cloud:publish', req),
    onPublishProgress: (cb: (e: ProgressEvent) => void): (() => void) => on('cloud:publishProgress', cb),
    install: (packId: string): Promise<Instance> => ipcRenderer.invoke('cloud:install', packId),
    checkUpdates: (): Promise<CloudUpdateMap> => ipcRenderer.invoke('cloud:checkUpdates'),
    sessions: {
      list: (): Promise<GameSession[]> => ipcRenderer.invoke('cloud:sessions:list'),
      publish: (req: PublishSessionRequest): Promise<{ ok: boolean; error?: string; session?: GameSession }> =>
        ipcRenderer.invoke('cloud:sessions:publish', req),
      heartbeat: (): Promise<void> => ipcRenderer.invoke('cloud:sessions:heartbeat'),
      end: (): Promise<void> => ipcRenderer.invoke('cloud:sessions:end')
    },
    admin: {
      listProfiles: (): Promise<CloudProfile[]> => ipcRenderer.invoke('cloud:admin:listProfiles'),
      setAdmin: (userId: string, isAdmin: boolean): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:setAdmin', userId, isAdmin),
      listPacks: (): Promise<CloudPackDetails[]> => ipcRenderer.invoke('cloud:admin:listPacks'),
      updatePack: (packId: string, name: string, description: string): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:updatePack', packId, name, description),
      deleteVersion: (versionId: string): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:deleteVersion', versionId),
      deletePack: (packId: string): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:deletePack', packId),
      listNews: (): Promise<LauncherNewsItem[]> => ipcRenderer.invoke('cloud:admin:listNews'),
      publishNews: (req: PublishNewsRequest): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:publishNews', req),
      deleteNews: (id: string): Promise<OperationResult> =>
        ipcRenderer.invoke('cloud:admin:deleteNews', id)
    }
  },
  migrate: {
    scan: (): Promise<MigrationCandidate[]> => ipcRenderer.invoke('migrate:scan'),
    import: (req: MigrateRequest): Promise<Instance> => ipcRenderer.invoke('migrate:import', req)
  },
  content: {
    install: (req: ModInstallRequest, kind: ContentKind): Promise<OperationResult> =>
      ipcRenderer.invoke('content:install', req, kind),
    list: (instanceId: string, kind: ContentKind): Promise<InstalledPack[]> =>
      ipcRenderer.invoke('content:list', instanceId, kind),
    toggle: (instanceId: string, kind: ContentKind, fileName: string): Promise<InstalledPack[]> =>
      ipcRenderer.invoke('content:toggle', instanceId, kind, fileName),
    remove: (instanceId: string, kind: ContentKind, fileName: string): Promise<InstalledPack[]> =>
      ipcRenderer.invoke('content:remove', instanceId, kind, fileName)
  },
  gameOptions: {
    get: (instanceId: string): Promise<GameOptions> => ipcRenderer.invoke('gameOptions:get', instanceId),
    set: (instanceId: string, updates: Record<string, string>): Promise<GameOptions> =>
      ipcRenderer.invoke('gameOptions:set', instanceId, updates)
  },
  optimize: {
    getPlan: (instanceId: string): Promise<OptimizationPlan> => ipcRenderer.invoke('optimize:getPlan', instanceId),
    apply: (
      instanceId: string,
      projectIds: string[]
    ): Promise<{ ok: boolean; error?: string; installed?: number; failed?: number; blocked?: number }> =>
      ipcRenderer.invoke('optimize:apply', instanceId, projectIds),
    applyPreset: (instanceId: string, preset: GraphicsPreset): Promise<OperationResult> =>
      ipcRenderer.invoke('optimize:applyPreset', instanceId, preset)
  },
  worlds: {
    list: (instanceId: string): Promise<WorldInfo[]> => ipcRenderer.invoke('worlds:list', instanceId),
    backup: (instanceId: string, folderName: string): Promise<{ ok: boolean; error?: string; saved: boolean }> =>
      ipcRenderer.invoke('worlds:backup', instanceId, folderName),
    remove: (instanceId: string, folderName: string): Promise<void> =>
      ipcRenderer.invoke('worlds:delete', instanceId, folderName),
    openFolder: (instanceId: string, folderName: string): Promise<void> =>
      ipcRenderer.invoke('worlds:openFolder', instanceId, folderName)
  },
  servers: {
    list: (instanceId: string): Promise<ServerEntry[]> => ipcRenderer.invoke('servers:list', instanceId),
    save: (instanceId: string, servers: ServerEntry[]): Promise<{ ok: boolean; error?: string; servers: ServerEntry[] }> =>
      ipcRenderer.invoke('servers:save', instanceId, servers)
  },
  skins: {
    getInfo: (force?: boolean): Promise<SkinInfo> => ipcRenderer.invoke('skins:getInfo', force),
    listSaved: (): Promise<SavedSkin[]> => ipcRenderer.invoke('skins:listSaved'),
    import: (): Promise<SavedSkin | null> => ipcRenderer.invoke('skins:import'),
    saveCurrent: (name: string): Promise<SavedSkin> => ipcRenderer.invoke('skins:saveCurrent', name),
    apply: (skinId: string, variant: 'classic' | 'slim'): Promise<OperationResult> =>
      ipcRenderer.invoke('skins:apply', skinId, variant),
    rename: (skinId: string, name: string, variant: 'classic' | 'slim'): Promise<SavedSkin[]> =>
      ipcRenderer.invoke('skins:rename', skinId, name, variant),
    remove: (skinId: string): Promise<SavedSkin[]> => ipcRenderer.invoke('skins:remove', skinId),
    search: (name: string): Promise<{ ok: boolean; error?: string; result?: SkinSearchResult }> =>
      ipcRenderer.invoke('skins:search', name),
    applyUrl: (url: string, variant: 'classic' | 'slim'): Promise<OperationResult> =>
      ipcRenderer.invoke('skins:applyUrl', url, variant),
    saveUrl: (name: string, url: string, variant: 'classic' | 'slim'): Promise<SavedSkin> =>
      ipcRenderer.invoke('skins:saveUrl', name, url, variant)
  },
  news: {
    get: (): Promise<NewsItem[]> => ipcRenderer.invoke('news:get')
  },
  app: {
    /** repaint the native window caption buttons to match the current theme */
    setTitleBarTheme: (overlay: { color: string; symbolColor: string }): Promise<void> =>
      ipcRenderer.invoke('app:setTitleBarTheme', overlay),
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  updates: {
    getState: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updates:getState'),
    check: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updates:check'),
    /** restart into the freshly downloaded version (installed builds only) */
    install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
    /** portable builds: open the latest-release download page instead */
    openLatest: (): Promise<void> => ipcRenderer.invoke('updates:openLatest'),
    onStatus: (cb: (s: UpdaterStatus) => void): (() => void) => on('updates:status', cb)
  },
  host: {
    enableE4mc: (instanceId: string): Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean }> =>
      ipcRenderer.invoke('host:enableE4mc', instanceId),
    startTunnel: (): Promise<{ ok: boolean; error?: string; address?: string }> =>
      ipcRenderer.invoke('host:startTunnel'),
    stopTunnel: (): Promise<void> => ipcRenderer.invoke('host:stopTunnel')
  },
  server: {
    list: (): Promise<LocalServer[]> => ipcRenderer.invoke('server:list'),
    create: (opts: CreateServerOptions): Promise<{ ok: boolean; error?: string; server?: LocalServer }> =>
      ipcRenderer.invoke('server:create', opts),
    remove: (id: string): Promise<{ ok: boolean; error?: string; servers: LocalServer[] }> =>
      ipcRenderer.invoke('server:remove', id),
    start: (id: string): Promise<OperationResult> => ipcRenderer.invoke('server:start', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('server:stop', id),
    command: (id: string, command: string): Promise<OperationResult> =>
      ipcRenderer.invoke('server:command', id, command),
    getStates: (): Promise<Record<string, { state: LocalServerState; players: string[]; tunnelAddress: string | null }>> =>
      ipcRenderer.invoke('server:getStates'),
    getLogs: (id: string): Promise<string[]> => ipcRenderer.invoke('server:getLogs', id),
    getProperties: (id: string): Promise<Record<string, string>> => ipcRenderer.invoke('server:getProperties', id),
    setProperties: (id: string, updates: Record<string, string>): Promise<Record<string, string>> =>
      ipcRenderer.invoke('server:setProperties', id, updates),
    updateSettings: (id: string, name: string, memoryMax: number): Promise<LocalServer[]> =>
      ipcRenderer.invoke('server:updateSettings', id, name, memoryMax),
    openFolder: (id: string): Promise<void> => ipcRenderer.invoke('server:openFolder', id),
    tunnelStart: (port: number): Promise<{ ok: boolean; error?: string; address?: string; warning?: string }> =>
      ipcRenderer.invoke('server:tunnelStart', port),
    tunnelStop: (port: number): Promise<void> => ipcRenderer.invoke('server:tunnelStop', port),
    shareInfo: (): Promise<{ publicIp: string | null; tailscaleIp: string | null }> =>
      ipcRenderer.invoke('server:shareInfo'),
    setCommunity: (id: string, enabled: boolean): Promise<LocalServer[]> =>
      ipcRenderer.invoke('server:setCommunity', id, enabled),
    setAutomation: (id: string, automation: ServerAutomation): Promise<LocalServer[]> =>
      ipcRenderer.invoke('server:setAutomation', id, automation),
    pal: {
      players: (id: string): Promise<{ ok: boolean; error?: string; players: PalworldPlayerDetail[] }> =>
        ipcRenderer.invoke('server:pal:players', id),
      moderate: (
        id: string,
        action: PalworldModerationAction,
        target: string,
        message?: string
      ): Promise<OperationResult> => ipcRenderer.invoke('server:pal:moderate', id, action, target, message)
    },
    listMods: (id: string): Promise<ServerMod[]> => ipcRenderer.invoke('server:mods:list', id),
    installMod: (id: string, projectId: string): Promise<OperationResult> =>
      ipcRenderer.invoke('server:mods:install', id, projectId),
    removeMod: (id: string, fileName: string): Promise<ServerMod[]> =>
      ipcRenderer.invoke('server:mods:remove', id, fileName),
    exportPack: (id: string): Promise<OperationResult> => ipcRenderer.invoke('server:exportPack', id),
    files: {
      list: (id: string, rel: string): Promise<ServerFileEntry[]> => ipcRenderer.invoke('server:files:list', id, rel),
      read: (id: string, rel: string): Promise<{ ok: boolean; error?: string; content?: string }> =>
        ipcRenderer.invoke('server:files:read', id, rel),
      write: (id: string, rel: string, content: string): Promise<OperationResult> =>
        ipcRenderer.invoke('server:files:write', id, rel, content),
      remove: (id: string, rel: string): Promise<OperationResult> => ipcRenderer.invoke('server:files:delete', id, rel)
    },
    players: {
      list: (id: string, kind: 'whitelist' | 'ops' | 'banned-players'): Promise<PlayerListEntry[]> =>
        ipcRenderer.invoke('server:players:list', id, kind),
      whitelistAdd: (id: string, name: string): Promise<{ ok: boolean; error?: string; players: PlayerListEntry[] }> =>
        ipcRenderer.invoke('server:players:whitelistAdd', id, name),
      whitelistRemove: (id: string, name: string): Promise<PlayerListEntry[]> =>
        ipcRenderer.invoke('server:players:whitelistRemove', id, name)
    },
    onLog: (cb: (e: ServerLogEvent) => void): (() => void) => on('server:log', cb),
    onState: (cb: (e: ServerStateEvent) => void): (() => void) => on('server:state', cb),
    onTask: (cb: (e: ServerTaskEvent) => void): (() => void) => on('server:task', cb)
  },
  remote: {
    listShares: (serverId: string): Promise<ServerShare[]> => ipcRenderer.invoke('remote:listShares', serverId),
    grant: (
      serverId: string,
      serverName: string,
      username: string
    ): Promise<{ ok: boolean; error?: string; shares: ServerShare[] }> =>
      ipcRenderer.invoke('remote:grant', serverId, serverName, username),
    revoke: (shareId: string): Promise<OperationResult> => ipcRenderer.invoke('remote:revoke', shareId),
    listManaged: (): Promise<ManagedServer[]> => ipcRenderer.invoke('remote:listManaged'),
    sendCommand: (serverId: string, action: 'start' | 'stop' | 'command', payload?: string): Promise<OperationResult> =>
      ipcRenderer.invoke('remote:sendCommand', serverId, action, payload)
  },
  browser: {
    list: (): Promise<SavedServerEntry[]> => ipcRenderer.invoke('browser:list'),
    add: (name: string, address: string): Promise<{ ok: boolean; error?: string; servers: SavedServerEntry[] }> =>
      ipcRenderer.invoke('browser:add', name, address),
    remove: (id: string): Promise<SavedServerEntry[]> => ipcRenderer.invoke('browser:remove', id),
    ping: (address: string): Promise<ServerPingResult> => ipcRenderer.invoke('browser:ping', address)
  }
}

export type ElauncherApi = typeof api

contextBridge.exposeInMainWorld('elauncher', api)
