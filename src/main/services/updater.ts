import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '@shared/types'

/** Where releases live — the site's download button and the updater both read from here. */
export const RELEASES_URL = 'https://github.com/Enderappsrepo/elauncher/releases/latest'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // re-check every 4 hours while the app stays open

/** The portable exe runs from wherever the user dropped it — it can't be swapped in place. */
const isPortable = (): boolean => Boolean(process.env.PORTABLE_EXECUTABLE_DIR)

let status: UpdaterStatus = {
  state: app.isPackaged ? 'idle' : 'dev',
  currentVersion: app.getVersion(),
  portable: isPortable()
}

function setStatus(patch: Partial<UpdaterStatus>): void {
  status = { ...status, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updates:status', status)
  }
}

/** Release notes arrive as a string (GitHub body) or per-version list — flatten to short plain text. */
function plainNotes(notes: string | { note?: string | null }[] | null | undefined): string | undefined {
  const raw = typeof notes === 'string' ? notes : notes?.map((n) => n.note ?? '').join('\n')
  const text = raw
    ?.replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .trim()
  if (!text) return undefined
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

export function getUpdaterStatus(): UpdaterStatus {
  return status
}

export async function checkForUpdates(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return status
  if (status.state === 'downloading' || status.state === 'ready') return status
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // the error event handler already captured it in `status`
  }
  return status
}

export function quitAndInstall(): void {
  if (status.state !== 'ready') return
  // let the renderer finish the current frame before the app tears down
  setImmediate(() => autoUpdater.quitAndInstall())
}

export function openLatestRelease(): void {
  void shell.openExternal(RELEASES_URL)
}

export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = !isPortable()
  autoUpdater.autoInstallOnAppQuit = !isPortable()

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'uptodate' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version, notes: plainNotes(info.releaseNotes) })
  )
  autoUpdater.on('download-progress', (p) =>
    setStatus({ state: 'downloading', percent: p.percent, bytesPerSecond: p.bytesPerSecond })
  )
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (e) =>
    setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) })
  )

  // first check shortly after launch so startup stays snappy, then periodically
  setTimeout(() => void checkForUpdates(), 8_000)
  setInterval(() => {
    if (status.state === 'idle' || status.state === 'uptodate' || status.state === 'error') {
      void checkForUpdates()
    }
  }, CHECK_INTERVAL_MS)
}
