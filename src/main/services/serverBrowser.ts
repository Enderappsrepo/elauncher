import net from 'net'
import { promises as dns } from 'dns'
import { randomUUID } from 'crypto'
import type { SavedServerEntry, ServerPingResult } from '@shared/types'
import { serverBrowserFile } from '../paths'
import { readJson, writeJson } from '../store'

// ---------- saved-server address book ----------

/** Well-known public servers so the browser isn't empty on first open. */
const SEEDS: Omit<SavedServerEntry, 'id' | 'addedAt'>[] = [
  { name: 'Hypixel', address: 'mc.hypixel.net' },
  { name: 'CubeCraft', address: 'play.cubecraft.net' },
  { name: 'Wynncraft', address: 'play.wynncraft.com' }
]

function load(): SavedServerEntry[] {
  const existing = readJson<SavedServerEntry[] | null>(serverBrowserFile, null)
  if (existing) return existing
  const seeded = SEEDS.map((s, i) => ({ ...s, id: randomUUID(), addedAt: Date.now() - i }))
  writeJson(serverBrowserFile, seeded)
  return seeded
}

export function listSavedServers(): SavedServerEntry[] {
  return load().sort((a, b) => b.addedAt - a.addedAt)
}

export function addSavedServer(name: string, address: string): SavedServerEntry[] {
  const trimmed = address.trim()
  if (!trimmed) throw new Error('Enter the server address.')
  const entries = load().filter((e) => e.address !== trimmed)
  entries.push({ id: randomUUID(), name: name.trim() || trimmed, address: trimmed, addedAt: Date.now() })
  writeJson(serverBrowserFile, entries)
  return listSavedServers()
}

export function removeSavedServer(id: string): SavedServerEntry[] {
  writeJson(serverBrowserFile, load().filter((e) => e.id !== id))
  return listSavedServers()
}

// ---------- native Server List Ping (the protocol the in-game list uses) ----------

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v)
      return Buffer.from(bytes)
    }
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
}

/** Reads a varint from buf at offset. Returns null when more bytes are needed. */
function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0
  let size = 0
  for (;;) {
    if (offset + size >= buf.length) return null
    const byte = buf[offset + size]
    value |= (byte & 0x7f) << (7 * size)
    size++
    if ((byte & 0x80) === 0) return { value, size }
    if (size > 5) throw new Error('varint too long')
  }
}

function packet(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload])
  return Buffer.concat([writeVarInt(body.length), body])
}

/** MOTD components can be plain strings or nested chat objects; flatten to text. */
function flattenMotd(desc: unknown): string {
  if (typeof desc === 'string') return desc
  if (desc && typeof desc === 'object') {
    const d = desc as { text?: string; extra?: unknown[] }
    const extra = Array.isArray(d.extra) ? d.extra.map(flattenMotd).join('') : ''
    return `${d.text ?? ''}${extra}`
  }
  return ''
}

/** Minecraft clients resolve _minecraft._tcp SRV records before connecting; do the same. */
async function resolveTarget(address: string): Promise<{ host: string; port: number }> {
  const [rawHost, rawPort] = address.split(':')
  if (rawPort) return { host: rawHost, port: Number(rawPort) || 25565 }
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${rawHost}`)
    if (records[0]) return { host: records[0].name, port: records[0].port }
  } catch {
    // no SRV record — connect directly
  }
  return { host: rawHost, port: 25565 }
}

/** Status-ping a server: MOTD, player counts, version, and round-trip latency. */
export async function pingServer(address: string, timeoutMs = 4000): Promise<ServerPingResult> {
  try {
    const { host, port } = await resolveTarget(address)
    return await new Promise<ServerPingResult>((resolvePing) => {
      const sock = net.connect({ host, port, timeout: timeoutMs })
      let buf = Buffer.alloc(0)
      let started = 0
      let settled = false
      const finish = (result: ServerPingResult): void => {
        if (settled) return
        settled = true
        sock.destroy()
        resolvePing(result)
      }

      sock.on('connect', () => {
        // handshake (state 1 = status), then an empty status request
        const hostBuf = Buffer.from(host, 'utf8')
        const portBuf = Buffer.alloc(2)
        portBuf.writeUInt16BE(port)
        const handshake = Buffer.concat([
          writeVarInt(-1 >>> 0), // protocol -1: "just tell me your status"
          writeVarInt(hostBuf.length),
          hostBuf,
          portBuf,
          writeVarInt(1)
        ])
        started = Date.now()
        sock.write(Buffer.concat([packet(0x00, handshake), packet(0x00, Buffer.alloc(0))]))
      })

      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        try {
          const len = readVarInt(buf, 0)
          if (!len) return
          if (buf.length < len.size + len.value) return // whole packet not here yet
          const packetId = readVarInt(buf, len.size)
          if (!packetId) return
          const strLen = readVarInt(buf, len.size + packetId.size)
          if (!strLen) return
          const start = len.size + packetId.size + strLen.size
          const json = buf.subarray(start, start + strLen.value).toString('utf8')
          const status = JSON.parse(json) as {
            version?: { name?: string }
            players?: { online?: number; max?: number }
            description?: unknown
          }
          finish({
            online: true,
            latencyMs: Date.now() - started,
            motd: flattenMotd(status.description).replace(/§./g, '').trim(),
            players: { online: status.players?.online ?? 0, max: status.players?.max ?? 0 },
            version: status.version?.name
          })
        } catch (e) {
          finish({ online: false, error: e instanceof Error ? e.message : String(e) })
        }
      })

      sock.on('timeout', () => finish({ online: false, error: 'Timed out' }))
      sock.on('error', (e) => finish({ online: false, error: e.message }))
      sock.on('close', () => finish({ online: false, error: 'Connection closed' }))
    })
  } catch (e) {
    return { online: false, error: e instanceof Error ? e.message : String(e) }
  }
}
