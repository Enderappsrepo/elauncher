import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CompanionApp, CompanionProgress } from './api'

/** Electron prefixes rejections with "Error invoking remote method '…': Error: "; players should not see that. */
function clean(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, ''))
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(`companion:${channel}`, ...args).catch((error: unknown) => {
    throw clean(error)
  }) as Promise<T>
}

const api: CompanionApp = {
  version: () => call('version'),
  session: () => call('session'),
  signIn: (email, password) => call('signIn', email, password),
  signOut: () => call('signOut'),
  servers: () => call('servers'),
  serverState: (serverId) => call('serverState', serverId),
  findGames: () => call('findGames'),
  chooseFolder: () => call('chooseFolder'),
  prepare: (gameId) => call('prepare', gameId),
  setLoadOrder: (text) => call('setLoadOrder', text),
  useGameLoadOrder: () => call('useGameLoadOrder'),
  // only the approved links cross, as plain strings: main scans again and decides everything else
  upload: (serverId, gameId, opts) => {
    const links: unknown = opts?.approvedLinks
    const approvedLinks = (Array.isArray(links) ? (links as Array<{ rel?: unknown; target?: unknown } | null>) : []).map((link) => ({
      rel: String(link?.rel ?? ''),
      target: String(link?.target ?? '')
    }))
    return call('upload', serverId, gameId, { approvedLinks })
  },
  pause: () => call('pause'),
  discard: (serverId) => call('discard', serverId),
  start: (serverId) => call('start', serverId),
  stop: (serverId) => call('stop', serverId),
  progressNow: () => call('progressNow'),
  pendingUpload: () => call('pendingUpload'),
  forgetUpload: () => call('forgetUpload'),
  retryNow: () => call('retryNow'),
  onProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, progress: CompanionProgress): void => cb(progress)
    ipcRenderer.on('companion:progress', listener)
    return () => ipcRenderer.removeListener('companion:progress', listener)
  },
  openExternal: (url) => call('openExternal', url)
}

contextBridge.exposeInMainWorld('companion', api)
