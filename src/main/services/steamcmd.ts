import { spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import { downloadToFile } from './mods'

/**
 * Minimal SteamCMD manager. SteamCMD is Valve's official command-line Steam
 * client; it distributes free dedicated servers (Palworld, Valheim, …) with
 * anonymous login. The zip comes from Valve's own CDN (pinned URL, not a
 * "latest release" of some repo) and the exe is a universally known,
 * high-prevalence binary — unlike the old bore.exe helper, it does not trip
 * Defender's reputation heuristics.
 */
const STEAMCMD_ZIP_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'

const steamcmdDir = join(app.getPath('userData'), 'steamcmd')
const steamcmdExe = join(steamcmdDir, 'steamcmd.exe')

async function ensureSteamCmd(onProgress?: (phase: string, progress: number) => void): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Hosting non-Minecraft dedicated servers is currently Windows-only.')
  }
  if (existsSync(steamcmdExe)) return steamcmdExe
  mkdirSync(steamcmdDir, { recursive: true })
  onProgress?.('Downloading SteamCMD', -1)
  const zipPath = join(steamcmdDir, 'steamcmd.zip')
  await downloadToFile(STEAMCMD_ZIP_URL, zipPath, (received, total) => {
    if (total > 0) onProgress?.('Downloading SteamCMD', received / total)
  })
  new AdmZip(zipPath).extractAllTo(steamcmdDir, true)
  rmSync(zipPath, { force: true })
  if (!existsSync(steamcmdExe)) throw new Error('SteamCMD download did not contain steamcmd.exe.')
  return steamcmdExe
}

/** "Update state (0x61) downloading, progress: 42.42 (3524224934 / 8306160323)" */
const PROGRESS_RE = /Update state \(0x\d+\) (\w+), progress: ([\d.]+)/
const SUCCESS_RE = /Success! App '(\d+)' fully installed/

/**
 * Install or update a Steam app into `dir` via anonymous login.
 * Emits phase/progress callbacks parsed from SteamCMD's own output.
 */
export async function installSteamApp(
  appId: number,
  dir: string,
  onProgress?: (phase: string, progress: number) => void,
  log?: (line: string) => void
): Promise<void> {
  const exe = await ensureSteamCmd(onProgress)
  mkdirSync(dir, { recursive: true })
  onProgress?.('Preparing SteamCMD', -1)

  await new Promise<void>((resolve, reject) => {
    // note: +force_install_dir must come before +login (steamcmd requirement)
    const proc = spawn(
      exe,
      ['+force_install_dir', dir, '+login', 'anonymous', '+app_update', String(appId), 'validate', '+quit'],
      { cwd: steamcmdDir, windowsHide: true }
    )
    let sawSuccess = false
    let buf = ''

    // steamcmd goes quiet for stretches (self-update, disk verify, allocation) —
    // keep the UI alive with the elapsed time instead of a frozen phase label
    let lastPhase = 'Preparing SteamCMD'
    let lastReport = Date.now()
    const report = (phase: string, progress: number): void => {
      lastPhase = phase
      lastReport = Date.now()
      onProgress?.(phase, progress)
    }
    const heartbeat = setInterval(() => {
      const idle = Math.round((Date.now() - lastReport) / 1000)
      if (idle >= 8) onProgress?.(`${lastPhase} — still working, ${idle}s`, -1)
    }, 4000)

    const onLine = (line: string): void => {
      log?.(line)
      const update = line.match(PROGRESS_RE)
      if (update) {
        const phase = update[1] === 'downloading' ? 'Downloading server files' : `Steam: ${update[1]}`
        report(phase, Math.min(Number(update[2]) / 100, 1))
        return
      }
      // self-update output: "[  0%] Downloading update..." / "[----] Verifying installation..."
      const setup = line.match(/^\[(?:\s*(\d+)%|[-\s]+)\]\s*(.+)/)
      if (setup) {
        report(`Steam setup: ${setup[2].replace(/\.+$/, '')}`, setup[1] ? Number(setup[1]) / 100 : -1)
      }
    }
    const onChunk = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      let idx: number
      // steamcmd rewrites progress lines with \r, so split on both
      while ((idx = buf.search(/[\r\n]/)) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        onLine(line)
        if (SUCCESS_RE.test(line)) sawSuccess = true
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)
    proc.on('error', (e) => {
      clearInterval(heartbeat)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearInterval(heartbeat)
      // steamcmd exit codes are unreliable; trust its own success line first
      if (sawSuccess || code === 0) resolve()
      else reject(new Error(`SteamCMD exited with code ${code}. Check your connection and disk space, then retry.`))
    })
  })
}
