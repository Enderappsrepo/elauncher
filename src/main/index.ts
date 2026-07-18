import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { ensureDataDirs } from './paths'
import { registerIpc } from './ipc'
import { initUpdater } from './services/updater'
import { getUser, signIn } from './services/cloud'
import { HEADLESS } from './services/headless'

/**
 * Headless host mode — run the launcher's host services (cloud relay,
 * provisioner, server management) with no window, so a Linux/VPS box can host
 * and be managed entirely from the web/phone panel. Toggle with the env var
 * ELAUNCHER_HEADLESS=1 (or --headless); sign in via ELAUNCHER_EMAIL /
 * ELAUNCHER_PASSWORD the first time (the session then persists).
 * The flag itself lives in services/headless.ts, which also mirrors server
 * lifecycle/alerts to stdout so journalctl shows what the box is doing.
 */

async function startHeadless(): Promise<void> {
  console.log('[ELauncher] headless host starting…')
  try {
    let user = await getUser()
    if (!user) {
      const email = process.env.ELAUNCHER_EMAIL
      const password = process.env.ELAUNCHER_PASSWORD
      if (email && password) user = await signIn(email, password)
    }
    if (user) {
      console.log(`[ELauncher] signed in as ${user.username}${user.isAdmin ? ' (admin)' : ''} — hosting active.`)
      // a VPS has a direct public IP — auto-fill publicHost so join addresses show
      // in the panel without any manual config (the user can override with a domain)
      try {
        const { getSettings, setSettings } = await import('./services/settings')
        const current = getSettings()
        if (!current.publicHost) {
          const ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) })).text()).trim()
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
            setSettings({ ...current, publicHost: ip })
            console.log(`[ELauncher] public address set to ${ip} — servers will show <ip>:<port>.`)
          }
        }
      } catch {
        // no public IP detected — servers still run; set publicHost manually to show the address
      }
    } else {
      console.warn(
        '[ELauncher] not signed in. Set ELAUNCHER_EMAIL and ELAUNCHER_PASSWORD (once), then restart. Status and controls run through the cloud panel.'
      )
    }
  } catch (e) {
    console.error('[ELauncher] headless sign-in failed:', e instanceof Error ? e.message : e)
  }
}

/** Window icon for dev + unpackaged runs; the packaged exe icon comes from electron-builder. */
function windowIcon(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    title: 'ELauncher',
    icon: windowIcon(),
    // frameless window; native caption buttons float over the app's drag strip
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b0e',
      symbolColor: '#9d9fb0',
      height: 42
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureDataDirs()
  registerIpc()

  if (HEADLESS) {
    void startHeadless()
    return
  }

  createWindow()
  initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // headless has no windows and must keep running; on Windows/macOS the GUI quits normally
  if (!HEADLESS && process.platform !== 'darwin') app.quit()
})
