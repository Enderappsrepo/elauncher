import { app, ipcMain, BrowserWindow } from 'electron'
import type { ContentKind, CopySettingsRequest, CreateInstanceOptions, CreateServerOptions, GraphicsPreset, Instance, MigrateRequest, ModInstallRequest, ModLoader, ModSearchQuery, ModSource, ModUpdateInfo, PalworldModerationAction, PublishNewsRequest, PublishPackRequest, PublishSessionRequest, ServerAutomation, ServerEntry, Settings } from '@shared/types'
import * as auth from './services/auth'
import * as instances from './services/instances'
import * as versions from './services/versions'
import * as game from './services/game'
import * as mods from './services/mods'
import * as packs from './services/packs'
import * as settings from './services/settings'
import * as cloud from './services/cloud'
import * as migrate from './services/migrate'
import * as gameOptions from './services/gameOptions'
import * as optimize from './services/optimize'
import * as hosting from './services/hosting'
import * as hostingOrders from './services/hostingOrders'
import * as specs from './services/specs'
import * as upnp from './services/upnp'
import * as server from './services/server'
import * as serverBrowser from './services/serverBrowser'
import * as remote from './services/remote'
import * as worlds from './services/worlds'
import * as servers from './services/servers'
import * as skins from './services/skins'
import * as news from './services/news'
import * as updater from './services/updater'

export function registerIpc(): void {
  // host side of remote server management: heartbeats + queued-command execution
  remote.startRemoteHost()

  // bring up servers flagged "start with the launcher"
  server.autoStartConfiguredServers()

  // publish host specs/report so the phone dashboard can show them
  specs.startHostReportPublisher()

  // hosting business: provision/suspend customer servers from approved orders
  hostingOrders.startHostingProvisioner()

  ipcMain.handle('host:report', () => specs.getHostReport())

  // repaint the native caption buttons when the renderer switches theme (Windows overlay)
  ipcMain.handle('app:setTitleBarTheme', (e, overlay: { color: string; symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    try {
      win?.setTitleBarOverlay?.({ ...overlay, height: 42 })
    } catch {
      // not a frameless/overlay window (non-Windows) — safe to ignore
    }
  })

  ipcMain.handle('auth:login', () => auth.login())
  ipcMain.handle('auth:logout', (_e, uuid: string) => auth.logout(uuid))
  ipcMain.handle('auth:getState', () => auth.getAccountsState())
  ipcMain.handle('auth:setActive', (_e, uuid: string) => auth.setActive(uuid))

  ipcMain.handle('versions:minecraft', () => versions.getMinecraftVersions())
  ipcMain.handle('versions:loader', (_e, loader: ModLoader, mcVersion: string) =>
    versions.getLoaderVersions(loader, mcVersion)
  )

  ipcMain.handle('instances:list', () => instances.listInstances())
  ipcMain.handle('instances:create', (_e, opts: CreateInstanceOptions) => instances.createInstance(opts))
  ipcMain.handle('instances:update', (_e, instance: Instance) => instances.updateInstance(instance))
  ipcMain.handle('instances:remove', (_e, id: string) => instances.removeInstance(id))
  ipcMain.handle('instances:duplicate', (_e, id: string) => instances.duplicateInstance(id))
  ipcMain.handle('instances:openFolder', (_e, id: string) => instances.openInstanceFolder(id))
  ipcMain.handle('instances:copySettings', (_e, req: CopySettingsRequest) => {
    try {
      return { ok: true, copied: instances.copySettings(req) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), copied: [] }
    }
  })

  ipcMain.handle('game:launch', async (_e, instanceId: string, joinServer?: string) => {
    try {
      await game.launchInstance(instanceId, joinServer)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('game:kill', (_e, instanceId: string) => game.killGame(instanceId))
  ipcMain.handle('game:getStates', () => game.getRunStates())
  ipcMain.handle('game:getLogs', (_e, instanceId: string) => game.getLogs(instanceId))

  ipcMain.handle('mods:search', (_e, query: ModSearchQuery) => mods.searchMods(query))
  ipcMain.handle('mods:install', async (_e, req: ModInstallRequest) => {
    try {
      await mods.installMod(req)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('mods:listInstalled', (_e, instanceId: string) => mods.listInstalledMods(instanceId))
  ipcMain.handle('mods:jarInfo', (_e, instanceId: string) => mods.getJarInfoMap(instanceId))
  ipcMain.handle('mods:identify', async (_e, instanceId: string) => {
    try {
      return await mods.identifyMods(instanceId)
    } catch {
      return { identified: 0, mods: mods.listInstalledMods(instanceId) }
    }
  })
  ipcMain.handle('mods:toggle', (_e, instanceId: string, fileName: string) => {
    try {
      return { ok: true, mods: mods.toggleMod(instanceId, fileName) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), mods: mods.listInstalledMods(instanceId) }
    }
  })
  ipcMain.handle('mods:remove', (_e, instanceId: string, fileName: string) => {
    try {
      return { ok: true, mods: mods.removeMod(instanceId, fileName) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), mods: mods.listInstalledMods(instanceId) }
    }
  })
  ipcMain.handle('mods:checkUpdates', (_e, instanceId: string) => mods.checkModUpdates(instanceId))
  ipcMain.handle('mods:applyUpdate', async (_e, instanceId: string, update: ModUpdateInfo) => {
    try {
      await mods.applyModUpdate(instanceId, update)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('packs:export', async (_e, instanceId: string) => {
    try {
      return await packs.exportInstance(instanceId)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('packs:import', () => packs.importPack())
  ipcMain.handle('packs:importUrl', (_e, url: string) => packs.importPackFromUrl(url))
  ipcMain.handle('packs:installModpack', (_e, source: ModSource, projectId: string) =>
    packs.installModpack(source, projectId)
  )
  ipcMain.handle('packs:update', (_e, instanceId: string) => {
    // cloud-linked packs update from the cloud library, others from their url/file
    const link = packs.getPackLink(instanceId)
    if (link?.cloudPackId) return cloud.updateFromCloud(instanceId)
    return packs.updatePack(instanceId)
  })
  ipcMain.handle('packs:getLink', (_e, instanceId: string) => packs.getPackLink(instanceId))

  ipcMain.handle('settings:get', () => settings.getSettings())
  ipcMain.handle('settings:set', (_e, s: Settings) => settings.setSettings(s))

  ipcMain.handle('cloud:available', () => cloud.cloudAvailable())
  ipcMain.handle('cloud:getUser', () => cloud.getUser())
  ipcMain.handle('cloud:signUp', (_e, email: string, password: string, username: string) =>
    cloud.signUp(email, password, username)
  )
  ipcMain.handle('cloud:signIn', (_e, email: string, password: string) => cloud.signIn(email, password))
  ipcMain.handle('cloud:signOut', () => cloud.signOut())
  ipcMain.handle('cloud:listPacks', () => cloud.listPacks())
  ipcMain.handle('cloud:publish', async (_e, req: PublishPackRequest) => {
    try {
      return { ok: true, ...(await cloud.publishPack(req)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:install', (_e, packId: string) => cloud.installCloudPack(packId))
  ipcMain.handle('cloud:checkUpdates', async () => {
    try {
      return await cloud.checkCloudUpdates()
    } catch {
      return {}
    }
  })

  // ---- play together: live sessions + hosting ----
  ipcMain.handle('cloud:sessions:list', async () => {
    try {
      return await cloud.listSessions()
    } catch {
      return []
    }
  })
  ipcMain.handle('cloud:sessions:publish', async (_e, req: PublishSessionRequest) => {
    try {
      return { ok: true, session: await cloud.publishSession(req) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:sessions:heartbeat', () => cloud.heartbeatSession())
  ipcMain.handle('cloud:sessions:end', () => cloud.endSession())

  ipcMain.handle('host:enableE4mc', async (_e, instanceId: string) => {
    try {
      return { ok: true, ...(await hosting.enableE4mc(instanceId)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('host:startTunnel', async () => {
    try {
      return { ok: true, ...(await hosting.startTunnel()) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('host:stopTunnel', () => hosting.stopTunnel())

  // ---- local dedicated servers ----
  ipcMain.handle('server:list', () => server.listLocalServers())
  ipcMain.handle('server:create', async (_e, opts: CreateServerOptions) => {
    try {
      const created = await server.createServer(opts)
      return created ? { ok: true, server: created } : { ok: false, error: 'cancelled' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:remove', (_e, id: string) => {
    try {
      const servers = server.removeServer(id)
      void remote.forgetServer(id) // drop cloud status/shares so other devices lose the ghost
      return { ok: true, servers }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), servers: server.listLocalServers() }
    }
  })
  ipcMain.handle('server:start', async (_e, id: string) => {
    try {
      await server.startServer(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:stop', (_e, id: string) => server.stopServer(id))
  ipcMain.handle('server:command', (_e, id: string, command: string) => {
    try {
      server.sendServerCommand(id, command)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:getStates', () => server.getServerStates())
  ipcMain.handle('server:getLogs', (_e, id: string) => server.getServerLogs(id))
  ipcMain.handle('server:getProperties', (_e, id: string) => server.getServerProperties(id))
  ipcMain.handle('server:setProperties', (_e, id: string, updates: Record<string, string>) =>
    server.setServerProperties(id, updates)
  )
  ipcMain.handle('server:updateSettings', (_e, id: string, name: string, memoryMax: number, syncGameName?: boolean) =>
    server.updateServerSettings(id, name, memoryMax, syncGameName)
  )
  ipcMain.handle('server:openFolder', (_e, id: string) => server.openServerFolder(id))
  ipcMain.handle('server:tunnelStart', async (_e, port: number) => {
    try {
      const record = server.listLocalServers().find((s) => s.port === port)
      // UDP games can't ride the TCP bore relay — open the port on the router instead
      if (record?.game === 'palworld') {
        const mapping = await upnp.openPort(port, 'UDP', `ELauncher ${record.name}`)
        server.announceServerByPort(port)
        return { ok: true, address: `${mapping.externalIp}:${port}`, warning: mapping.warning }
      }
      const res = await hosting.startTunnel(port)
      server.announceServerByPort(port)
      return { ok: true, ...res }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:shareInfo', () => hosting.getShareInfo())
  ipcMain.handle('server:setCommunity', (_e, id: string, enabled: boolean) => server.setCommunityServer(id, enabled))
  ipcMain.handle('server:setAutomation', (_e, id: string, automation: ServerAutomation) =>
    server.setServerAutomation(id, automation)
  )
  ipcMain.handle('server:pal:players', async (_e, id: string) => {
    try {
      return { ok: true, players: await server.getPalworldPlayerDetails(id) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), players: [] }
    }
  })
  ipcMain.handle(
    'server:pal:moderate',
    async (_e, id: string, action: PalworldModerationAction, target: string, message?: string) => {
      try {
        await server.palworldModerate(id, action, target, message)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
  ipcMain.handle('server:tunnelStop', async (_e, port: number) => {
    const record = server.listLocalServers().find((s) => s.port === port)
    if (record?.game === 'palworld') {
      await upnp.closePort(port, 'UDP')
      server.announceServerByPort(port)
      return
    }
    hosting.stopTunnel(port)
  })
  ipcMain.handle('server:mods:list', (_e, id: string) => server.listServerMods(id))
  ipcMain.handle('server:mods:install', async (_e, id: string, projectId: string) => {
    try {
      await server.installServerMod(id, projectId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:mods:remove', (_e, id: string, fileName: string) => server.removeServerMod(id, fileName))
  ipcMain.handle('server:exportPack', async (_e, id: string) => {
    try {
      return await server.exportServerPack(id)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---- server file manager ----
  ipcMain.handle('server:files:list', (_e, id: string, rel: string) => server.listServerFiles(id, rel))
  ipcMain.handle('server:files:read', (_e, id: string, rel: string) => {
    try {
      return { ok: true, ...server.readServerFile(id, rel) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:files:write', (_e, id: string, rel: string, content: string) => {
    try {
      server.writeServerFile(id, rel, content)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('server:files:delete', (_e, id: string, rel: string) => {
    try {
      server.deleteServerPath(id, rel)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---- server player lists ----
  ipcMain.handle('server:players:list', (_e, id: string, kind: server.PlayerFileKind) =>
    server.readPlayerList(id, kind)
  )
  ipcMain.handle('server:players:whitelistAdd', async (_e, id: string, name: string) => {
    try {
      return { ok: true, players: await server.whitelistAdd(id, name) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), players: server.readPlayerList(id, 'whitelist') }
    }
  })
  ipcMain.handle('server:players:whitelistRemove', (_e, id: string, name: string) => server.whitelistRemove(id, name))

  // ---- remote management (cloud relay) ----
  ipcMain.handle('remote:listShares', async (_e, serverId: string) => {
    try {
      return await remote.listShares(serverId)
    } catch {
      return []
    }
  })
  ipcMain.handle('remote:grant', async (_e, serverId: string, serverName: string, username: string) => {
    try {
      return { ok: true, shares: await remote.grantAccess(serverId, serverName, username) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), shares: [] }
    }
  })
  ipcMain.handle('remote:revoke', async (_e, shareId: string) => {
    try {
      await remote.revokeAccess(shareId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('remote:listManaged', async () => {
    try {
      return await remote.listManagedServers()
    } catch {
      return []
    }
  })
  ipcMain.handle('remote:sendCommand', async (_e, serverId: string, action: 'start' | 'stop' | 'command', payload?: string) => {
    try {
      await remote.sendRemoteCommand(serverId, action, payload ?? '')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---- server browser (saved servers + live status pings) ----
  ipcMain.handle('browser:list', () => serverBrowser.listSavedServers())
  ipcMain.handle('browser:add', (_e, name: string, address: string) => {
    try {
      return { ok: true, servers: serverBrowser.addSavedServer(name, address) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), servers: serverBrowser.listSavedServers() }
    }
  })
  ipcMain.handle('browser:remove', (_e, id: string) => serverBrowser.removeSavedServer(id))
  ipcMain.handle('browser:ping', (_e, address: string) => serverBrowser.pingServer(address))

  ipcMain.handle('cloud:admin:listProfiles', () => cloud.listProfiles())
  ipcMain.handle('cloud:admin:setAdmin', async (_e, userId: string, isAdmin: boolean) => {
    try {
      await cloud.setAdmin(userId, isAdmin)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:admin:listPacks', () => cloud.listPacksDetailed())
  ipcMain.handle('cloud:admin:updatePack', async (_e, packId: string, name: string, description: string) => {
    try {
      await cloud.updatePackDetails(packId, name, description)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:admin:deleteVersion', async (_e, versionId: string) => {
    try {
      await cloud.deletePackVersion(versionId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:admin:deletePack', async (_e, packId: string) => {
    try {
      await cloud.deletePack(packId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:admin:listNews', () => cloud.listLauncherNews())
  ipcMain.handle('cloud:admin:publishNews', async (_e, req: PublishNewsRequest) => {
    try {
      await cloud.publishNews(req)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('cloud:admin:deleteNews', async (_e, id: string) => {
    try {
      await cloud.deleteNews(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('migrate:scan', () => migrate.scanLaunchers())
  ipcMain.handle('migrate:import', (_e, req: MigrateRequest) => migrate.migrate(req))

  ipcMain.handle('instances:getIconData', (_e, id: string) => instances.getIconData(id))
  ipcMain.handle('instances:pickIcon', (_e, id: string) => instances.pickIcon(id))
  ipcMain.handle('instances:setIcon', (_e, id: string, icon: string | undefined) => instances.setIcon(id, icon))

  ipcMain.handle('content:install', async (_e, req: ModInstallRequest, kind: ContentKind) => {
    try {
      await mods.installPack(req, kind)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('content:list', (_e, instanceId: string, kind: ContentKind) => mods.listPacks(instanceId, kind))
  ipcMain.handle('content:toggle', (_e, instanceId: string, kind: ContentKind, fileName: string) =>
    mods.togglePack(instanceId, kind, fileName)
  )
  ipcMain.handle('content:remove', (_e, instanceId: string, kind: ContentKind, fileName: string) =>
    mods.removePack(instanceId, kind, fileName)
  )

  ipcMain.handle('gameOptions:get', (_e, instanceId: string) => gameOptions.getGameOptions(instanceId))
  ipcMain.handle('gameOptions:set', (_e, instanceId: string, updates: Record<string, string>) =>
    gameOptions.setGameOptions(instanceId, updates)
  )

  ipcMain.handle('optimize:getPlan', (_e, instanceId: string) => optimize.getOptimizationPlan(instanceId))
  ipcMain.handle('optimize:apply', async (_e, instanceId: string, projectIds: string[]) => {
    try {
      return { ok: true, ...(await optimize.applyOptimization(instanceId, projectIds)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('optimize:applyPreset', (_e, instanceId: string, preset: GraphicsPreset) => {
    try {
      optimize.applyGraphicsPreset(instanceId, preset)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worlds:list', (_e, instanceId: string) => worlds.listWorlds(instanceId))
  ipcMain.handle('worlds:backup', async (_e, instanceId: string, folderName: string) => {
    try {
      return { ok: true, saved: await worlds.backupWorld(instanceId, folderName) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), saved: false }
    }
  })
  ipcMain.handle('worlds:delete', (_e, instanceId: string, folderName: string) =>
    worlds.deleteWorld(instanceId, folderName)
  )
  ipcMain.handle('worlds:openFolder', (_e, instanceId: string, folderName: string) =>
    worlds.openWorldFolder(instanceId, folderName)
  )

  ipcMain.handle('servers:list', (_e, instanceId: string) => servers.listServers(instanceId))
  ipcMain.handle('servers:save', async (_e, instanceId: string, list: ServerEntry[]) => {
    try {
      return { ok: true, servers: await servers.saveServers(instanceId, list) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), servers: [] }
    }
  })

  ipcMain.handle('skins:getInfo', (_e, force?: boolean) => skins.getSkinInfo(force))
  ipcMain.handle('skins:listSaved', () => skins.listSavedSkins())
  ipcMain.handle('skins:import', () => skins.importSkin())
  ipcMain.handle('skins:saveCurrent', (_e, name: string) => skins.saveCurrentSkin(name))
  ipcMain.handle('skins:apply', async (_e, skinId: string, variant: 'classic' | 'slim') => {
    try {
      await skins.applySkin(skinId, variant)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('skins:rename', (_e, skinId: string, name: string, variant: 'classic' | 'slim') =>
    skins.renameSavedSkin(skinId, name, variant)
  )
  ipcMain.handle('skins:remove', (_e, skinId: string) => skins.removeSavedSkin(skinId))
  ipcMain.handle('skins:search', async (_e, name: string) => {
    try {
      return { ok: true, result: await skins.searchSkin(name) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('skins:applyUrl', async (_e, url: string, variant: 'classic' | 'slim') => {
    try {
      await skins.applySkinFromUrl(url, variant)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('skins:saveUrl', (_e, name: string, url: string, variant: 'classic' | 'slim') =>
    skins.saveSkinFromUrl(name, url, variant)
  )

  ipcMain.handle('news:get', async () => {
    try {
      return await news.getNews()
    } catch {
      return []
    }
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('updates:getState', () => updater.getUpdaterStatus())
  ipcMain.handle('updates:check', () => updater.checkForUpdates())
  ipcMain.handle('updates:install', () => updater.quitAndInstall())
  ipcMain.handle('updates:openLatest', () => updater.openLatestRelease())
}
