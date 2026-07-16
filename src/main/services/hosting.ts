import dgram from 'dgram'
import net from 'net'
import os from 'os'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getInstance } from './instances'
import { installMod, modrinthFetch, readModsMeta } from './mods'

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

// ---------- alternative share paths (manual forward / tailscale) ----------

let publicIpCache: { ip: string | null; at: number } = { ip: null, at: 0 }

/**
 * Addresses for sharing a server that the launcher can't provide itself:
 * the WAN IP (useful once the user forwards the port manually) and a
 * Tailscale IP when the machine is on a tailnet (zero router setup).
 */
export async function getShareInfo(): Promise<{ publicIp: string | null; tailscaleIp: string | null }> {
  let publicIp = publicIpCache.at > Date.now() - 600_000 ? publicIpCache.ip : null
  if (!publicIp) {
    try {
      const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })
      publicIp = res.ok ? (await res.text()).trim() : null
    } catch {
      publicIp = null
    }
    if (publicIp) publicIpCache = { ip: publicIp, at: Date.now() }
  }

  // Tailscale assigns addresses from the CGNAT range 100.64.0.0/10
  let tailscaleIp: string | null = null
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const [a, b] = info.address.split('.').map(Number)
      if (a === 100 && b >= 64 && b <= 127) tailscaleIp = info.address
    }
  }
  return { publicIp, tailscaleIp }
}

// ---------- vanilla tunnel: native bore.pub client ----------
//
// The bore protocol (github.com/ekzhang/bore) is spoken directly over TCP:
// null-delimited JSON frames on the control port. Earlier builds downloaded
// the bore.exe helper instead, but unsigned tunnel binaries trip Defender's
// ML signatures (Trojan:Win32/KepavII!rfn false positive) — the exe got
// quarantined with a scary "Severe threat" popup and the feature broke.
// Native sockets mean no download, nothing for AV to flag, and no
// Windows-only restriction.

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

// Sweep the helper exe off installs that downloaded it, so it stops tripping scans.
try {
  rmSync(join(app.getPath('userData'), 'bin'), { recursive: true, force: true })
} catch {
  // locked or already quarantined — nothing to clean
}

const BORE_HOST = 'bore.pub'
const BORE_CONTROL_PORT = 7835
const HELLO_TIMEOUT_MS = 20_000
/** The relay heartbeats twice a second; a long silence means the link is dead. */
const CONTROL_IDLE_TIMEOUT_MS = 30_000

interface Tunnel {
  control: net.Socket
  conns: Set<net.Socket>
  address: string
}

/** Live tunnels keyed by the local port they expose (LAN world or dedicated server). */
const tunnels = new Map<number, Tunnel>()

/** Callbacks fired when a tunnel goes away — stopped on purpose or dropped by the relay. */
const tunnelClosedListeners: ((port: number) => void)[] = []

export function onTunnelClosed(listener: (port: number) => void): void {
  tunnelClosedListeners.push(listener)
}

/** Forget a tunnel, tear its sockets down, and notify listeners exactly once. */
function dropTunnel(port: number, tunnel: Tunnel): void {
  if (tunnels.get(port) === tunnel) {
    tunnels.delete(port)
    for (const listener of tunnelClosedListeners) listener(port)
  }
  tunnel.control.destroy()
  for (const conn of tunnel.conns) conn.destroy()
}

type BoreServerMessage =
  | 'Heartbeat'
  | { Hello: number }
  | { Connection: string }
  | { Challenge: string }
  | { Error: string }

function sendFrame(sock: net.Socket, msg: unknown): void {
  sock.write(JSON.stringify(msg) + '\0')
}

function onFrames(sock: net.Socket, handler: (msg: BoreServerMessage) => void): void {
  let buf = Buffer.alloc(0)
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    let end: number
    while ((end = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, end).toString('utf8')
      buf = buf.subarray(end + 1)
      if (!frame) continue
      try {
        handler(JSON.parse(frame) as BoreServerMessage)
      } catch {
        // malformed frame — skip it
      }
    }
  })
}

/** Answer a Connection(uuid) offer: claim the visitor on a data socket and pipe raw bytes. */
function acceptVisitor(uuid: string, localPort: number, conns: Set<net.Socket>): void {
  const remote = net.connect(BORE_CONTROL_PORT, BORE_HOST)
  const local = net.connect(localPort, '127.0.0.1')
  conns.add(remote)
  conns.add(local)
  const drop = (): void => {
    conns.delete(remote)
    conns.delete(local)
    remote.destroy()
    local.destroy()
  }
  remote.on('error', drop)
  local.on('error', drop)
  remote.on('close', drop)
  local.on('close', drop)
  remote.setKeepAlive(true, 15_000)
  remote.on('connect', () => {
    sendFrame(remote, { Accept: uuid })
    // everything after the Accept frame is the player's raw traffic, both ways
    remote.pipe(local)
    local.pipe(remote)
  })
}

export function getTunnelAddress(port?: number): string | null {
  if (port !== undefined) return tunnels.get(port)?.address ?? null
  const first = tunnels.values().next()
  return first.done ? null : first.value.address
}

/**
 * Expose a local port publicly through the free bore.pub relay and return the
 * shareable `bore.pub:<port>` address. When no port is given, the open LAN
 * world is auto-detected from Minecraft's multicast broadcast.
 */
export async function startTunnel(port?: number): Promise<{ address: string }> {
  const local = port ?? (await detectLanPort())
  const existing = tunnels.get(local)
  if (existing) return { address: existing.address }

  const control = net.connect(BORE_CONTROL_PORT, BORE_HOST)
  control.setKeepAlive(true, 15_000)
  control.setTimeout(CONTROL_IDLE_TIMEOUT_MS)
  control.on('timeout', () => control.destroy())
  const conns = new Set<net.Socket>()

  const address = await new Promise<string>((resolve, reject) => {
    let up = false
    const timer = setTimeout(() => {
      control.destroy()
      reject(new Error('The tunnel did not come up in time. The bore.pub relay may be busy — try again.'))
    }, HELLO_TIMEOUT_MS)

    control.on('connect', () => sendFrame(control, { Hello: 0 }))
    onFrames(control, (msg) => {
      if (typeof msg !== 'object' || msg === null) return // heartbeat keepalive
      if ('Hello' in msg) {
        up = true
        clearTimeout(timer)
        resolve(`${BORE_HOST}:${msg.Hello}`)
      } else if ('Connection' in msg) {
        acceptVisitor(msg.Connection, local, conns)
      } else if (!up) {
        clearTimeout(timer)
        control.destroy()
        const detail = 'Error' in msg ? msg.Error : 'it requires authentication'
        reject(new Error(`The bore.pub relay refused the tunnel: ${detail}`))
      }
    })
    control.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Could not reach the tunnel relay: ${e.message}`))
    })
    control.on('close', () => {
      clearTimeout(timer)
      reject(new Error('The tunnel relay closed the connection.'))
    })
  })

  const tunnel: Tunnel = { control, conns, address }
  tunnels.set(local, tunnel)
  control.on('close', () => dropTunnel(local, tunnel))
  return { address }
}

/** Stop one tunnel by local port, or every tunnel when no port is given. */
export function stopTunnel(port?: number): void {
  if (port !== undefined) {
    const tunnel = tunnels.get(port)
    if (tunnel) dropTunnel(port, tunnel)
    return
  }
  for (const [p, tunnel] of [...tunnels]) dropTunnel(p, tunnel)
}
