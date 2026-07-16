// Smoke test for the SteamCMD manager: download steamcmd from Valve's CDN,
// then anonymously install a tiny app (1007 = Steamworks SDK Redist) the same
// way src/main/services/steamcmd.ts installs the Palworld server (2394010).
// Usage: node scripts/smoke-steamcmd.mjs
import { spawn } from 'child_process'
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'

const STEAMCMD_ZIP_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
const TEST_APP = 1007 // Steamworks SDK Redist — small, anonymous-installable

const root = mkdtempSync(join(tmpdir(), 'elauncher-steamcmd-'))
const cmdDir = join(root, 'steamcmd')
const appDir = join(root, 'app')
mkdirSync(cmdDir, { recursive: true })
console.log('workdir:', root)

// 1. download + extract steamcmd (mirrors ensureSteamCmd)
const zipPath = join(cmdDir, 'steamcmd.zip')
const res = await fetch(STEAMCMD_ZIP_URL)
if (!res.ok) throw new Error(`steamcmd download failed: ${res.status}`)
await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))
new AdmZip(zipPath).extractAllTo(cmdDir, true)
const exe = join(cmdDir, 'steamcmd.exe')
if (!existsSync(exe)) throw new Error('zip did not contain steamcmd.exe')
console.log('steamcmd.exe extracted')

// 2. anonymous app install with progress parsing (mirrors installSteamApp)
const PROGRESS_RE = /Update state \(0x\d+\) (\w+), progress: ([\d.]+)/
const SUCCESS_RE = /Success! App '(\d+)' fully installed/
await new Promise((resolve, reject) => {
  const proc = spawn(exe, ['+force_install_dir', appDir, '+login', 'anonymous', '+app_update', String(TEST_APP), 'validate', '+quit'], {
    cwd: cmdDir,
    windowsHide: true
  })
  let sawSuccess = false
  let lastPhase = ''
  let buf = ''
  const onChunk = (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.search(/[\r\n]/)) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      const m = line.match(PROGRESS_RE)
      if (m && m[1] !== lastPhase) {
        lastPhase = m[1]
        console.log(`steam phase: ${m[1]} (${m[2]}%)`)
      }
      if (SUCCESS_RE.test(line)) sawSuccess = true
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)
  proc.on('error', reject)
  proc.on('exit', (code) => {
    console.log(`steamcmd exited code=${code}, success line seen=${sawSuccess}`)
    if (sawSuccess || code === 0) resolve()
    else reject(new Error(`steamcmd failed (code ${code})`))
  })
})
if (!existsSync(appDir)) throw new Error('app dir missing after install')
console.log('anonymous app install OK')

rmSync(root, { recursive: true, force: true })
console.log('steamcmd smoke test passed')
