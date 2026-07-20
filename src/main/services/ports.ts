import type { ExtraPort, PortPreset } from '@shared/types'
import { closePort, getMapping, openPort } from './upnp'

/**
 * Policy for the extra router ports mods need — proximity voice chat, web maps,
 * Bedrock crossplay. The game's own port is handled by the share flow; these are
 * the ones a mod adds on top, and they have to survive a launcher restart, so
 * they live on the server record and are re-opened whenever it starts.
 *
 * Deliberately free of any server.ts import: server.ts owns the records and
 * calls in here, so keeping the arrows one-way avoids a require cycle.
 */

/** Enough for a voice mod, a map mod and crossplay with room to spare, without letting the panel fill a router's mapping table. */
export const MAX_EXTRA_PORTS = 8

/**
 * Ports that stay closed however insistently a mod's install page asks.
 * UPnP maps to this machine only (upnp.ts pins NewInternalClient to the local
 * NIC), so the risk isn't reaching other LAN hosts — it's handing the internet a
 * remote-admin or database service running on the host itself. Everything below
 * 1024 is refused wholesale; these are the ones above it that would be as bad.
 */
const BLOCKED = new Map<number, string>([
  [1433, 'Microsoft SQL Server'],
  [2375, 'the Docker daemon'],
  [2376, 'the Docker daemon'],
  [3306, 'MySQL'],
  [3389, 'Windows Remote Desktop'],
  [5432, 'PostgreSQL'],
  [5900, 'VNC remote desktop'],
  [5984, 'CouchDB'],
  [6379, 'Redis'],
  [9200, 'Elasticsearch'],
  [10250, 'the Kubernetes kubelet'],
  [11211, 'memcached'],
  [27017, 'MongoDB']
])

/**
 * Legitimate to open, but they hand out admin control rather than gameplay.
 * Shipped to the panel so the caution shows while the port is still a draft
 * row, rather than after it has already been mapped.
 */
export const PORT_CAUTIONS: Record<string, string> = {
  25575: 'This is the RCON port — anyone who guesses the RCON password gets the full server console. Set a long password before opening it.',
  8212: 'This is the Palworld REST API port — it takes admin calls. Set a strong AdminPassword before opening it.'
}

/** Mods known to need a port of their own, offered as one-tap presets. */
export const PORT_PRESETS: PortPreset[] = [
  {
    label: 'Simple Voice Chat',
    port: 24454,
    protocol: 'UDP',
    note: 'Proximity voice chat. Runs on its own UDP port — the game port alone will not carry the audio.'
  },
  {
    label: 'Plasmo Voice',
    port: 60606,
    protocol: 'UDP',
    note: 'Proximity voice chat, the Plasmo alternative to Simple Voice Chat.'
  },
  {
    label: 'Geyser (Bedrock crossplay)',
    port: 19132,
    protocol: 'UDP',
    note: 'Lets Bedrock and phone players join this Java server.'
  },
  {
    label: 'Dynmap',
    port: 8123,
    protocol: 'TCP',
    note: 'Live web map of the world, opened in a browser.'
  },
  {
    label: 'BlueMap',
    port: 8100,
    protocol: 'TCP',
    note: 'Live 3D web map of the world, opened in a browser.'
  },
  {
    label: 'squaremap',
    port: 8080,
    protocol: 'TCP',
    note: 'Lightweight top-down web map, opened in a browser.'
  }
]

export const portKey = (port: number, protocol: string): string => `${protocol}:${port}`

/**
 * Clean and check a submitted rule list. `taken` maps `PROTOCOL:port` to a
 * phrase naming whatever already claims it on this machine, so two servers
 * can't both map 8123 and silently fight over it. Throws with a message meant
 * to be read by the person who typed the port in — the panel shows it verbatim.
 */
export function validateRules(raw: unknown, taken: Map<string, string>): ExtraPort[] {
  if (!Array.isArray(raw)) throw new Error('Expected a list of ports.')
  if (raw.length > MAX_EXTRA_PORTS) {
    throw new Error(`A server can have at most ${MAX_EXTRA_PORTS} extra ports. Remove one before adding another.`)
  }
  const rules: ExtraPort[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const source = (entry ?? {}) as Record<string, unknown>
    const port = Number(source.port)
    const protocol = source.protocol === 'UDP' ? 'UDP' : 'TCP'
    const label = String(source.label ?? '').trim().slice(0, 60) || `Port ${port}`
    if (!Number.isInteger(port)) throw new Error('Enter a whole number for the port.')
    if (port < 1024 || port > 65535) {
      throw new Error(
        `Port ${port} is out of range. Pick something between 1024 and 65535 — ports below 1024 belong to system services and are never what a mod asks for.`
      )
    }
    const blocked = BLOCKED.get(port)
    if (blocked) {
      throw new Error(
        `Port ${port} is ${blocked}, not a game port. Opening it would expose that service to the internet, so ELauncher will not map it. If a mod genuinely wants this port, change the port in the mod's own config instead.`
      )
    }
    const key = portKey(port, protocol)
    if (seen.has(key)) throw new Error(`${protocol} port ${port} is listed twice.`)
    const owner = taken.get(key)
    if (owner) throw new Error(`${protocol} port ${port} is already taken — ${owner}. Pick a different port.`)
    seen.add(key)
    rules.push({ port, protocol, label })
  }
  return rules
}

/**
 * Why a port's last open attempt failed. Only failures live here — a mapping
 * that exists carries its own CGNAT/lease warning, which is read back off it.
 */
const failures = new Map<string, string>()

/** Live exposure of one port: mapped or not, with whichever caveat applies. */
export function statusOf(
  port: number,
  protocol: 'UDP' | 'TCP'
): { open: boolean; warning?: string; error?: string } {
  const mapping = getMapping(port, protocol)
  if (mapping) return { open: true, warning: mapping.warning }
  return { open: false, error: failures.get(portKey(port, protocol)) }
}

/**
 * Map every rule, remembering why any of them failed. Never rejects: one port a
 * router dislikes must not abort a server start or lose the other mappings, so
 * failures are recorded for the panel rather than thrown.
 */
export async function openRules(rules: ExtraPort[], serverName: string): Promise<void> {
  await Promise.all(
    rules.map(async (rule) => {
      const key = portKey(rule.port, rule.protocol)
      try {
        await openPort(rule.port, rule.protocol, `ELauncher ${serverName} — ${rule.label}`)
        failures.delete(key)
      } catch (e) {
        failures.set(key, e instanceof Error ? e.message : String(e))
      }
    })
  )
}

/** Release every rule's mapping. Best-effort, same as the game port's teardown. */
export async function closeRules(rules: ExtraPort[]): Promise<void> {
  await Promise.all(
    rules.map(async (rule) => {
      failures.delete(portKey(rule.port, rule.protocol))
      await closePort(rule.port, rule.protocol).catch(() => {})
    })
  )
}
