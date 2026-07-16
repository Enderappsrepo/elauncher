import dgram from 'dgram'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import { getInstance } from './instances'
import { downloadToFile, installMod, modrinthFetch, readModsMeta } from './mods'

const E4MC_SLUG = 'e4mc'

/**
 * Ensure the e4mc mod is installed in a (modded) instance. Once running, the
 * player picks "Open to LAN" and e4mc exposes a public *.e4mc.link address with
 * no port-forwarding, account, or dedicated server.
 */
export async function enableE4mc(instanceId: string): Promise<{ alreadyInstalled: boolean }> {
  const instance = getInstance(instanceId)
  if (instance.loader === 'vanilla') {
    throw new Error('e4mc needs a mod loader. Use the built-in tunnel for vanilla, or add Fabric/Forge/NeoForge.')
  }
  const project = (await modrinthFetch(`/project/${E4MC_SLUG}`)) as { id: string }
  const meta = readModsMeta(instanceId)
  const already = Object.values(meta).some(
    (m) => m.source === 'modrinth' && (m.projectId === project.id || m.projectId === E4MC_SLUG)
  )
  if (!already) await installMod({ instanceId, source: 'modrinth', projectId: project.id })
  return { alreadyInstalled: already }
}

// ---------- vanilla tunnel (bore) ----------

const LAN_MULTICAST = '224.0.2.60'
const LAN_PORT = 4445

/** Listen for Minecraft's "Open to LAN" broadcast (UDP multicast) and return the world's LAN port. */
export function detectLanPort(timeoutMs = 120_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        // already closed
      }
      fn()
    }
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              'No "Open to LAN" world was detected. In-game: press Esc → Open to LAN → Start LAN World, then try again.'
            )
          )
        ),
      timeoutMs
    )
    sock.on('error', (e) => finish(() => reject(e)))
    sock.on('message', (msg) => {
      const m = msg.toString('utf8').match(/\[AD\](\d{1,5})\[\/AD\]/)
      if (m) finish(() => resolve(Number(m[1])))
    })
    sock.bind(LAN_PORT, () => {
      try {
        sock.addMembership(LAN_MULTICAST)
      } catch {
        // membership is best-effort; messages still arrive on many systems
      }
    })
  })
}

const boreDir = join(app.getPath('userData'), 'bin')
const borePath = join(boreDir, 'bore.exe')

/** Download the open-source `bore` tunnel client once (official GitHub release) into the app data dir. */
async function ensureBore(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('The built-in tunnel is currently Windows-only. On other systems, use the e4mc (modded) option.')
  }
  if (existsSync(borePath)) return borePath
  mkdirSync(boreDir, { recursive: true })
  const rel = (await (
    await fetch('https://api.github.com/repos/ekzhang/bore/releases/latest', {
      headers: { 'User-Agent': 'ELauncher', Accept: 'application/vnd.github+json' }
    })
  ).json()) as { assets: { name: string; browser_download_url: string }[] }
  const asset = rel.assets.find((a) => a.name.includes('x86_64-pc-windows-msvc') && a.name.endsWith('.zip'))
  if (!asset) throw new Error('Could not find a Windows build of the tunnel helper.')
  const dl = join(boreDir, asset.name)
  await downloadToFile(asset.browser_download_url, dl)
  const entry = new AdmZip(dl).getEntries().find((e) => /bore\.exe$/i.test(e.entryName))
  if (!entry) throw new Error('Tunnel helper archive did not contain bore.exe.')
  writeFileSync(borePath, entry.getData())
  rmSync(dl, { force: true })
  return borePath
}

let tunnel: { proc: ChildProcess; address: string } | null = null

export function getTunnelAddress(): string | null {
  return tunnel?.address ?? null
}

/**
 * Detect the open LAN world, then expose it publicly through the free bore.pub
 * relay and return the shareable `bore.pub:<port>` address.
 */
export async function startTunnel(): Promise<{ address: string }> {
  if (tunnel) return { address: tunnel.address }
  const port = await detectLanPort()
  const bore = await ensureBore()
  const proc = spawn(bore, ['local', String(port), '--to', 'bore.pub'], { windowsHide: true })

  const address = await new Promise<string>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('The tunnel did not come up in time. The bore.pub relay may be busy — try again.'))
    }, 25_000)
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString()
      const m = buf.match(/bore\.pub:(\d{2,5})/) ?? buf.match(/remote_port\D*(\d{2,5})/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0].startsWith('bore.pub') ? m[0] : `bore.pub:${m[1]}`)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Tunnel process exited (code ${code}).`))
    })
  })

  tunnel = { proc, address }
  proc.on('exit', () => {
    if (tunnel?.proc === proc) tunnel = null
  })
  return { address }
}

export function stopTunnel(): void {
  tunnel?.proc.kill()
  tunnel = null
}
