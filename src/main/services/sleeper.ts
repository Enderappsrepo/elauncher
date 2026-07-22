import { createServer, type Server, type Socket } from 'net'
import { createSocket, type Socket as UdpSocket } from 'dgram'

/**
 * The stand-in that holds a sleeping server's port.
 *
 * A server nobody is playing on still costs its whole memory footprint, which on
 * one box is the difference between hosting a couple of ARK servers and hosting
 * twenty. Sleeping stops the game and leaves this in its place: a few hundred
 * bytes that answer the door and start the real server when someone knocks.
 *
 * For Minecraft that means speaking enough of the protocol to stay *visible* —
 * the server keeps appearing in the multiplayer list with a live message rather
 * than greyed out as unreachable, which is the difference between "asleep" and
 * "broken" from a player's side. Every other game gets the simple treatment: any
 * packet at all is somebody trying to connect, so wake up.
 *
 * Written natively rather than shelling out to a helper, same as the tunnel.
 */

// ---------- minecraft wire format ----------
// Packets are [VarInt length][VarInt id][payload]; strings are [VarInt len][utf8].

/** VarInt: 7 bits per byte, high bit means "another byte follows". */
export function encodeVarInt(value: number): Buffer {
  const out: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return Buffer.from(out)
}

/** Reads a VarInt, or null when the buffer doesn't hold a whole one yet. */
export function decodeVarInt(buf: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0
  let shift = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null // incomplete — wait for more bytes
    const byte = buf[offset + i]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: value >>> 0, size: i + 1 }
    shift += 7
  }
  return null // more than 5 bytes is malformed, not merely incomplete
}

export function encodeString(text: string): Buffer {
  const body = Buffer.from(text, 'utf-8')
  return Buffer.concat([encodeVarInt(body.length), body])
}

/** Wrap a packet id and payload in the outer length prefix. */
export function framePacket(packetId: number, payload: Buffer): Buffer {
  const inner = Buffer.concat([encodeVarInt(packetId), payload])
  return Buffer.concat([encodeVarInt(inner.length), inner])
}

export interface Handshake {
  protocolVersion: number
  /** 1 = the client is listing servers, 2 = it is actually joining */
  nextState: number
}

/**
 * Parse a handshake (packet 0x00 in the initial state). Returns null while the
 * packet is still arriving — TCP splits writes wherever it likes.
 */
export function parseHandshake(buf: Buffer): Handshake | null {
  const len = decodeVarInt(buf, 0)
  if (!len) return null
  const start = len.size
  if (buf.length < start + len.value) return null // frame not complete yet
  const id = decodeVarInt(buf, start)
  if (!id || id.value !== 0x00) return null
  let at = start + id.size
  const proto = decodeVarInt(buf, at)
  if (!proto) return null
  at += proto.size
  const addrLen = decodeVarInt(buf, at)
  if (!addrLen) return null
  at += addrLen.size + addrLen.value + 2 // skip host string and the 2-byte port
  const next = decodeVarInt(buf, at)
  if (!next) return null
  return { protocolVersion: proto.value, nextState: next.value }
}

/**
 * The server-list entry a sleeping server shows.
 *
 * `protocol` echoes whatever the client asked with, deliberately: reply with a
 * fixed number and every client on a different version renders the row as
 * incompatible, in red, which reads as a broken server rather than a resting one.
 */
export function buildStatusResponse(protocolVersion: number, motd: string, versionLabel: string): Buffer {
  const json = JSON.stringify({
    version: { name: versionLabel, protocol: protocolVersion },
    players: { max: 0, online: 0, sample: [] },
    description: { text: motd }
  })
  return framePacket(0x00, encodeString(json))
}

/** The message a player sees if they connect while it is still waking. */
export function buildLoginDisconnect(message: string): Buffer {
  return framePacket(0x00, encodeString(JSON.stringify({ text: message })))
}

// ---------- the listener ----------

export interface SleeperOptions {
  port: number
  /** minecraft gets the protocol treatment; everything else wakes on any packet */
  game: 'minecraft' | 'other'
  protocol: 'TCP' | 'UDP'
  /** shown in the multiplayer list while asleep */
  motd: string
  /** called at most once, when someone tries to connect */
  onWake: () => void
  onLog?: (line: string) => void
}

export interface SleeperHandle {
  stop: () => Promise<void>
  /** false once something has knocked and the wake has been triggered */
  readonly listening: boolean
}

/**
 * Hold `port` until somebody knocks. The wake fires once — a client that retries
 * during startup must not queue a second start.
 */
export function startSleeper(opts: SleeperOptions): SleeperHandle {
  let woken = false
  let closed = false
  let tcp: Server | null = null
  let udp: UdpSocket | null = null

  const wake = (): void => {
    if (woken || closed) return
    woken = true
    opts.onLog?.('[ELauncher] Someone tried to connect — waking the server')
    opts.onWake()
  }

  if (opts.protocol === 'TCP' && opts.game === 'minecraft') {
    tcp = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0)
      let state: 'handshake' | 'status' = 'handshake'
      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        if (state === 'handshake') {
          const hs = parseHandshake(buf)
          if (!hs) return // still arriving
          if (hs.nextState === 2) {
            // a real join attempt: say why nothing happened, then start up
            sock.end(buildLoginDisconnect(opts.motd))
            wake()
            return
          }
          state = 'status'
          // the status request that follows carries no fields worth reading
          sock.write(buildStatusResponse(hs.protocolVersion, opts.motd, 'Sleeping'))
          buf = Buffer.alloc(0)
          return
        }
        // ping: the client sends 8 opaque bytes and wants them back verbatim to
        // measure latency. Echoing the whole frame is exactly what it expects.
        if (buf.length > 0) {
          sock.write(buf)
          buf = Buffer.alloc(0)
        }
      })
      // a listing client that vanishes mid-handshake is normal, not an error
      sock.on('error', () => sock.destroy())
      sock.setTimeout(10_000, () => sock.destroy())
    })
    tcp.on('error', (e) => opts.onLog?.(`[ELauncher] Sleep listener error: ${e.message}`))
    tcp.listen(opts.port)
  } else if (opts.protocol === 'TCP') {
    // non-minecraft TCP (tModLoader): no cheap handshake worth faking, so a
    // connection at all is the signal
    tcp = createServer((sock: Socket) => {
      sock.on('error', () => sock.destroy())
      sock.destroy()
      wake()
    })
    tcp.on('error', (e) => opts.onLog?.(`[ELauncher] Sleep listener error: ${e.message}`))
    tcp.listen(opts.port)
  } else {
    udp = createSocket({ type: 'udp4', reuseAddr: true })
    udp.on('message', () => wake())
    udp.on('error', (e) => opts.onLog?.(`[ELauncher] Sleep listener error: ${e.message}`))
    udp.bind(opts.port)
  }

  return {
    get listening() {
      return !woken && !closed
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve()
        closed = true
        let pending = (tcp ? 1 : 0) + (udp ? 1 : 0)
        if (pending === 0) return resolve()
        const done = (): void => {
          if (--pending <= 0) resolve()
        }
        // the port must be free before the game rebinds it, so this resolves on
        // close rather than firing and forgetting
        tcp?.close(done)
        udp?.close(done)
      })
  }
}
