import type { ExtraPort, PortPreset } from '@shared/types'
import { STEAM_GAMES, isSteamGame } from './steamgames'
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

/** The service a port is reserved for, if it's one ELauncher refuses to map — for
 *  a caller that wants to say why rather than hand `validateRules` a whole list. */
export function blockedPortReason(port: number): string | undefined {
  return BLOCKED.get(port)
}

/** Which protocol a game's own port speaks. Undefined game = a record that predates the column = minecraft. */
export function mainPortProtocol(game: string | undefined): 'UDP' | 'TCP' {
  if (game === 'palworld') return 'UDP'
  if (isSteamGame(game)) return STEAM_GAMES[game].protocol
  return 'TCP'
}

/**
 * The neighbor ports a game needs reachable beyond `port` itself — the reason
 * STEAM_GAMES allocates servers a portStep apart. A Valheim server with only
 * 2456 open never shows in Steam's server list; an ARK without its query port
 * looks online to the panel and unjoinable to everyone else. These open and
 * close together with the game port, everywhere it does.
 *
 * Admin neighbors (RCON, telnet, the REST API) are deliberately absent: they
 * are localhost channels the launcher itself uses, and exposing them is a
 * choice a person makes in the panel — with the caution on screen — not one
 * the launcher makes for them.
 */
export function companionPorts(game: string | undefined, port: number): ExtraPort[] {
  switch (game) {
    case 'valheim':
      // 2457-equivalent: Steam's query channel — the server list and most joins
      return [{ port: port + 1, protocol: 'UDP', label: 'Steam query port' }]
    case 'sdtd':
      // the wiki's "26900 TCP + 26900-26902 UDP"; +3 is telnet and stays shut
      return [
        { port, protocol: 'TCP', label: 'Server list handshake' },
        { port: port + 1, protocol: 'UDP', label: 'Steam networking' },
        { port: port + 2, protocol: 'UDP', label: 'Steam networking (channel 2)' }
      ]
    case 'zomboid':
      return [{ port: port + 1, protocol: 'UDP', label: 'Direct-connection channel' }]
    case 'ark':
      return [
        { port: port + 1, protocol: 'UDP', label: 'Raw UDP socket' },
        { port: port + 2, protocol: 'UDP', label: 'Steam query — server browser' }
      ]
    default:
      // minecraft, palworld, tmodloader and ASA are one-port games; palworld's
      // +1 (REST) and the ARKs' +3 (RCON) are admin channels, offered as
      // presets with their caution instead
      return []
  }
}

/**
 * Legitimate to open, but they hand out admin control rather than gameplay.
 * Shipped to the panel so the caution shows while the port is still a draft
 * row, rather than after it has already been mapped. Keyed by this server's
 * actual port numbers — a Palworld allocated 8213 has its REST API on 8214.
 */
export function portCautions(game: string | undefined, port: number): Record<string, string> {
  switch (game) {
    case 'palworld':
      return {
        [port + 1]:
          'This is the Palworld REST API port — it takes admin calls. Set a strong AdminPassword before opening it.'
      }
    case 'ark':
    case 'arksa':
      return {
        [port + 3]:
          'This is the RCON port — anyone with the admin password gets the full server console. Share it with admins only.'
      }
    case 'sdtd':
      return {
        [port + 3]:
          'This is the telnet console port — anyone who guesses the password gets the full server console. It does not need to be open for players.'
      }
    case 'zomboid':
      return {
        [port + 2]:
          "This is Zomboid's RCON port. ELauncher already uses it on this machine, and players never need it."
      }
    default:
      return {
        25575:
          'This is the RCON port — anyone who guesses the RCON password gets the full server console. Set a long password before opening it.'
      }
  }
}

/** Minecraft's mods known to need a port of their own, offered as one-tap presets. */
const MINECRAFT_PRESETS: PortPreset[] = [
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

/**
 * One-tap suggestions for the panel's Add-a-port list, by game. Minecraft gets
 * its port-hungry mods; the other games get the optional service they actually
 * have (an admin API, a web dashboard) — showing a Valheim owner "Dynmap" was
 * how this list used to read like it belonged to a different game.
 */
export function portPresets(game: string | undefined, port: number): PortPreset[] {
  switch (game) {
    case 'palworld':
      return [
        {
          label: 'REST API',
          port: port + 1,
          protocol: 'TCP',
          note: 'Palworld’s admin API, for external admin tools. Needs a strong AdminPassword set first.'
        }
      ]
    case 'ark':
    case 'arksa':
      return [
        {
          label: 'RCON (remote admin tools)',
          port: port + 3,
          protocol: 'TCP',
          note: 'Lets admin tools like Beacon manage this server from elsewhere. Guarded only by the admin password.'
        }
      ]
    case 'sdtd':
      return [
        {
          label: 'Web dashboard',
          port: 8080,
          protocol: 'TCP',
          note: 'The game’s built-in browser dashboard. Turn on WebDashboardEnabled in Settings first.'
        }
      ]
    case 'valheim':
    case 'zomboid':
    case 'tmodloader':
      // their mods ride the game port; nothing here would be honest
      return []
    default:
      return MINECRAFT_PRESETS
  }
}

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

/**
 * Record something outside the router that keeps a port shut — a firewall rule
 * that would not take. On a public-IP host there is no mapping step to fail, so
 * without this the port would report open on the strength of a mapping that
 * never had to do anything.
 */
export function noteFailure(port: number, protocol: 'UDP' | 'TCP', reason: string): void {
  failures.set(portKey(port, protocol), reason)
}

/** Live exposure of one port: reachable or not, with whichever caveat applies. */
export function statusOf(
  port: number,
  protocol: 'UDP' | 'TCP'
): { open: boolean; warning?: string; error?: string } {
  const error = failures.get(portKey(port, protocol))
  // a failure outranks a mapping: a firewall that is still blocking means the
  // port is shut whatever the mapping layer thinks it accomplished
  if (error) return { open: false, error }
  const mapping = getMapping(port, protocol)
  return mapping ? { open: true, warning: mapping.warning } : { open: false }
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
