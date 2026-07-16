import { app, ipcMain, BrowserWindow } from 'electron'
import type { ContentKind, CopySettingsRequest, CreateInstanceOptions, GraphicsPreset, Instance, MigrateRequest, ModInstallRequest, ModLoader, ModSearchQuery, ModSource, ModUpdateInfo, PublishNewsRequest, PublishPackRequest, PublishSessionRequest, ServerEntry, Settings } from '@shared/types'
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
import * as worlds from './services/worlds'
import * as servers from './services/servers'
import * as skins from './services/skins'
import * as news from './services/news'
import * as updater from './services/updater'

export function registerIpc(): void {
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

  ipcMain.handle('game:launch', async (_e, instanceId: string) => {
    try {
      await game.launchInstance(instanceId)
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
