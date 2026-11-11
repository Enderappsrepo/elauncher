import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { PANEL_URL, type CompanionProgress } from '../preload/api'
import type { OutsideLink } from '../shared/types'
import { getClient, isSignedOutError, requireAccount, session, signIn, signOut } from './cloud'
import { findFalloutNV } from './detect'
import { accountJobs } from './jobStore'
import { makeAsk, queueCommand } from './relay'
import { getServer, listServers } from './servers'
import { UploadController } from './upload'

const TITLE = 'ELauncher NVMP Companion'
// --bg from src/shared/tokens.css, so the window never flashes white before the page paints
const BACKGROUND = '#0a0a0f'

/** `--smoke`: print findFalloutNV() as JSON and exit, with no window and no cloud. */
async function smoke(): Promise<void> {
  let code = 0
  try {
    process.stdout.write(`${JSON.stringify(await findFalloutNV(), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    code = 1
  }
  process.stdout.write('', () => app.exit(code))
}

let window: BrowserWindow | null = null
let blocker: number | null = null
let closing = false

const controller = new UploadController({
  server: (serverId) => getServer(getClient(), serverId),
  userId: async () => (await requireAccount()).userId,
  ask: async (server) => makeAsk(server, (await requireAccount()).userId, getClient()),
  command: async (server, action) => {
    const { userId } = await requireAccount()
    await queueCommand(getClient(), server.serverId, server.ownerId || userId, userId, action)
  },
  emit: (progress: CompanionProgress) => {
    if (window && !window.isDestroyed()) window.webContents.send('companion:progress', progress)
  },
  keepAwake: (on) => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  },
  jobs: accountJobs()
})

function windowIcon(): string | undefined {
  return [join(app.getAppPath(), 'build', 'icon.png'), join(process.resourcesPath ?? '', 'icon.png')].find((p) => existsSync(p))
}

/** Only the eLauncher site and its GitHub repository open in the player's browser. */
const PANEL_ORIGIN = new URL(PANEL_URL).origin
const isOurLink = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
    return parsed.origin === PANEL_ORIGIN || (parsed.host === 'github.com' && parsed.pathname.toLowerCase().startsWith('/enderappsrepo/'))
  } catch {
    return false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: BACKGROUND,
    title: TITLE,
    icon: windowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  window = win
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
  win.on('ready-to-show', () => win.show())
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.on('close', (e) => {
    if (closing || !controller.busy) return
    e.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'question',
        title: TITLE,
        message: 'Your upload is still running.',
        detail: 'The upload pauses and resumes next time you open the companion. Pieces already sent are kept on your server.',
        buttons: ['Keep uploading', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(({ response }) => {
        if (response !== 1) return
        closing = true
        void controller.pause()
        win.close()
      })
  })
  win.on('closed', () => {
    if (window === win) window = null
  })

  // the dev server only for `npm run companion:dev`; a packaged build always loads its own files
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * Every handler answers only our own window. A sign-in found gone or revoked on the way signs the
 * companion out locally: the window goes back to Sign in and keeps nothing of that account's upload.
 */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(`companion:${channel}`, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!window || event.sender !== window.webContents) throw new Error('Unknown sender.')
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (error) {
      if (isSignedOutError(error)) controller.setAccount(null)
      throw error
    }
  })
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}.`)
  return value
}

/** The outside links the player approved, as plain {rel, target} strings; anything else is dropped. */
function approvedLinks(opts: unknown): OutsideLink[] {
  const list = opts && typeof opts === 'object' ? (opts as { approvedLinks?: unknown }).approvedLinks : undefined
  if (!Array.isArray(list)) return []
  return list
    .filter((l): l is OutsideLink => !!l && typeof l === 'object' && typeof (l as OutsideLink).rel === 'string' && typeof (l as OutsideLink).target === 'string')
    .map(({ rel, target }) => ({ rel, target }))
}

function registerIpc(): void {
  handle('version', () => app.getVersion())
  handle('session', async () => {
    // offline: session() throws and the account stays as it was
    const account = await session()
    controller.setAccount(account?.userId ?? null)
    return account
  })
  handle('signIn', async (email: unknown, password: unknown) => {
    // the last account's upload may still be settling: nothing of it is shown to, or saved for, the next one
    await controller.beforeSignIn()
    const account = await signIn(String(email ?? ''), String(password ?? ''))
    controller.setAccount(account.userId)
    return account
  })
  handle('signOut', async () => {
    if (controller.busy) throw new Error('Pause the upload before signing out.')
    try {
      await signOut()
    } finally {
      controller.setAccount(null)
    }
  })
  handle('servers', async () => {
    const { userId } = await requireAccount()
    return listServers(getClient(), userId, (server) => makeAsk(server, userId, getClient()))
  })
  handle('serverState', async (serverId: unknown) => {
    await requireAccount()
    return getServer(getClient(), text(serverId, 'server'))
  })
  handle('findGames', () => controller.findGames())
  handle('chooseFolder', async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, {
      title: 'Choose your Fallout: New Vegas folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    const folder = picked.canceled ? undefined : picked.filePaths[0]
    if (!folder) return null
    const game = await controller.gameFromFolder(folder)
    if (!game) throw new Error('No Fallout: New Vegas found there. Choose the folder that contains FalloutNV.exe.')
    return game
  })
  handle('prepare', (gameId: unknown) => controller.prepare(text(gameId, 'game')))
  handle('setLoadOrder', (value: unknown) => controller.setLoadOrder(typeof value === 'string' ? value : ''))
  handle('useGameLoadOrder', () => controller.useGameLoadOrder())
  handle('upload', (serverId: unknown, gameId: unknown, opts: unknown) =>
    controller.upload(text(serverId, 'server'), text(gameId, 'game'), { approvedLinks: approvedLinks(opts) })
  )
  handle('pause', () => controller.pause())
  handle('retryNow', () => controller.retryNow())
  handle('forgetUpload', () => controller.forget())
  // each checks the sign-in first (controller: deps.userId), so a lost one reads as signed out, not as a gone server
  handle('discard', (serverId: unknown) => controller.discard(text(serverId, 'server')))
  handle('start', (serverId: unknown) => controller.command(text(serverId, 'server'), 'start'))
  handle('stop', (serverId: unknown) => controller.command(text(serverId, 'server'), 'stop'))
  handle('progressNow', () => controller.snapshot())
  handle('pendingUpload', () => controller.pending())
  handle('openExternal', async (url: unknown) => {
    if (typeof url !== 'string' || !isOurLink(url)) throw new Error('Only eLauncher web links can be opened.')
    await shell.openExternal(url)
  })
}

if (process.argv.includes('--smoke')) {
  app.disableHardwareAcceleration()
  void app.whenReady().then(smoke)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.elauncher.nvmp-companion')
  app.on('second-instance', () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  void app.whenReady().then(() => {
    registerIpc()
    createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
