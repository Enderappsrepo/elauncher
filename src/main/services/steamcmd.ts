import { spawn } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import { downloadToFile } from './mods'

/**
 * Minimal SteamCMD manager. SteamCMD is Valve's official command-line Steam
 * client; it distributes free dedicated servers (Palworld, Valheim, …) with
 * anonymous login. Downloaded from Valve's own CDN (pinned URL) — a
 * universally known, high-prevalence tool, so no Defender false positives.
 * Cross-platform: a .zip with steamcmd.exe on Windows, a .tar.gz with
 * steamcmd.sh on Linux.
 */
const IS_WIN = process.platform === 'win32'
const STEAMCMD_URL = IS_WIN
  ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
  : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'

export const steamcmdDir = join(app.getPath('userData'), 'steamcmd')
const steamcmdExe = join(steamcmdDir, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh')

/** The 32-bit dynamic loader steamcmd's binary needs — absent on fresh 64-bit Linux installs. */
const LINUX_32BIT_LOADER = '/lib/ld-linux.so.2'

function runQuiet(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } })
    proc.on('error', () => resolve(-1))
    proc.on('exit', (code) => resolve(code ?? -1))
  })
}

/**
 * steamcmd ships a 32-bit binary, so on a fresh 64-bit box steamcmd.sh dies
 * with a bare exit 127 ("command not found"). The documented VPS setup runs
 * as root, so install lib32gcc-s1 (which pulls in the loader) ourselves;
 * anywhere we can't, fail with the exact command to run.
 */
async function ensureLinux32BitRuntime(onProgress?: (phase: string, progress: number) => void): Promise<void> {
  if (existsSync(LINUX_32BIT_LOADER)) return
  const install = ['-o', 'DPkg::Lock::Timeout=120', '-y', 'install', 'lib32gcc-s1']
  if (process.getuid?.() === 0) {
    onProgress?.('Installing 32-bit libraries for SteamCMD', -1)
    if ((await runQuiet('apt-get', install)) !== 0) {
      // stale or empty package lists on a fresh box — refresh once and retry
      await runQuiet('apt-get', ['-o', 'DPkg::Lock::Timeout=120', 'update'])
      await runQuiet('apt-get', install)
    }
  }
  if (!existsSync(LINUX_32BIT_LOADER)) {
    throw new Error(
      'This Linux host is missing the 32-bit libraries SteamCMD needs. Run "sudo apt-get install -y lib32gcc-s1" on it, then retry.'
    )
  }
}

/**
 * 64-bit Steam game servers (Palworld's PalServer included) dlopen
 * ~/.steam/sdk64/steamclient.so at boot; steamcmd downloads that lib but
 * never places it. Same link-up LinuxGSM performs — best-effort, servers
 * only degrade without it.
 */
function placeSteamClientLib(): void {
  try {
    const source = join(steamcmdDir, 'linux64', 'steamclient.so')
    const target = join(homedir(), '.steam', 'sdk64', 'steamclient.so')
    if (!existsSync(source) || existsSync(target)) return
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  } catch {
    // cosmetic-path failure only — the server reports S_API warnings but runs
  }
}

async function ensureSteamCmd(onProgress?: (phase: string, progress: number) => void): Promise<string> {
  if (process.platform === 'darwin') {
    throw new Error('Hosting SteamCMD dedicated servers is supported on Windows and Linux, not macOS.')
  }
  if (!IS_WIN) await ensureLinux32BitRuntime(onProgress)
  if (existsSync(steamcmdExe)) return steamcmdExe
  mkdirSync(steamcmdDir, { recursive: true })
  onProgress?.('Downloading SteamCMD', -1)
  const archive = join(steamcmdDir, IS_WIN ? 'steamcmd.zip' : 'steamcmd.tar.gz')
  await downloadToFile(STEAMCMD_URL, archive, (received, total) => {
    if (total > 0) onProgress?.('Downloading SteamCMD', received / total)
  })
  if (IS_WIN) {
    new AdmZip(archive).extractAllTo(steamcmdDir, true)
  } else {
    // extract the tarball with the system tar (present on every Linux box)
    await new Promise<void>((resolve, reject) => {
      const t = spawn('tar', ['-xzf', archive, '-C', steamcmdDir])
      t.on('error', reject)
      t.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code})`))))
    })
  }
  rmSync(archive, { force: true })
  if (!existsSync(steamcmdExe)) throw new Error('SteamCMD download did not contain the expected launcher.')
  if (!IS_WIN) {
    try {
      chmodSync(steamcmdExe, 0o755)
    } catch {
      // best-effort; steamcmd.sh is usually already executable
    }
  }
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
      else if (!IS_WIN && code === 127)
        reject(
          new Error(
            'SteamCMD exited with code 127 — the host is missing 32-bit libraries. Run "sudo apt-get install -y lib32gcc-s1" on it, then retry.'
          )
        )
      else reject(new Error(`SteamCMD exited with code ${code}. Check your connection and disk space, then retry.`))
    })
  })
  if (!IS_WIN) placeSteamClientLib()
}
