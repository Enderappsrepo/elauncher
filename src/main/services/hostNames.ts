import { hostNamesFile } from '../paths'
import { readJson, writeJson } from '../store'
import { getSettings } from './settings'

/**
 * Per-server hostname pool. The user lists hostnames they control (free
 * duckdns.org names, or anything they've pointed at this connection) in
 * Settings; each hosted server claims one so customers see a unique address
 * (emberpeak.duckdns.org:port) instead of the shared raw IP. Assignments are
 * sticky across restarts and suspensions — a customer's address never changes
 * under them — and are released only when the server is deleted.
 */

type Assignments = Record<string, string>

const DUCKDNS_SUFFIX = '.duckdns.org'
/** re-push duckdns records this often even without changes, as cheap insurance */
const DUCKDNS_REFRESH_MS = 6 * 3_600_000

function loadAssignments(): Assignments {
  return readJson<Assignments>(hostNamesFile, {})
}

/** The hostname pool from settings, normalized. */
export function hostPool(): string[] {
  return (getSettings().hostPool ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The hostname a server was assigned, if any (and still present in the pool). */
export function getAssignedHost(serverId: string): string | null {
  const host = loadAssignments()[serverId]
  return host && hostPool().includes(host) ? host : null
}

/** Every pool hostname currently assigned to a server. */
export function listAssignedHosts(): string[] {
  const pool = hostPool()
  return Object.values(loadAssignments()).filter((host) => pool.includes(host))
}

let duckdnsDirty = false

/**
 * Claim a free pool hostname for a server (idempotent — an existing assignment
 * is returned as-is). Returns null when no pool is configured or all names are
 * taken; the caller decides whether that's worth an alert.
 */
export function assignHost(serverId: string): string | null {
  const existing = getAssignedHost(serverId)
  if (existing) return existing
  const pool = hostPool()
  if (pool.length === 0) return null
  const assignments = loadAssignments()
  const taken = new Set(Object.values(assignments))
  const free = pool.find((host) => !taken.has(host))
  if (!free) return null
  assignments[serverId] = free
  writeJson(hostNamesFile, assignments)
  if (free.endsWith(DUCKDNS_SUFFIX)) duckdnsDirty = true
  return free
}

/** Free a server's hostname for reuse (called when the server is deleted). */
export function releaseHost(serverId: string): void {
  const assignments = loadAssignments()
  if (!(serverId in assignments)) return
  delete assignments[serverId]
  writeJson(hostNamesFile, assignments)
}

let duckdnsPushedAt = 0

/**
 * Point every duckdns.org pool name at this connection via the DuckDNS update
 * API (one call covers all names; blank ip = the caller's egress IP, which is
 * exactly this connection). Throttled unless a new name was just assigned or
 * the caller knows the IP changed. Returns an error description, or null.
 */
export async function updateDuckDns(force = false): Promise<string | null> {
  const token = getSettings().duckdnsToken
  if (!token) return null
  const names = hostPool()
    .filter((host) => host.endsWith(DUCKDNS_SUFFIX))
    .map((host) => host.slice(0, -DUCKDNS_SUFFIX.length))
  if (names.length === 0) return null
  if (!force && !duckdnsDirty && Date.now() - duckdnsPushedAt < DUCKDNS_REFRESH_MS) return null
  try {
    const res = await fetch(
      `https://www.duckdns.org/update?domains=${encodeURIComponent(names.join(','))}&token=${encodeURIComponent(token)}&ip=`,
      { signal: AbortSignal.timeout(10_000) }
    )
    const body = (await res.text()).trim()
    if (!res.ok || body !== 'OK') {
      return `DuckDNS rejected the update for ${names.join(', ')} — check the token and that the names exist in your account`
    }
    duckdnsDirty = false
    duckdnsPushedAt = Date.now()
    return null
  } catch (e) {
    return `DuckDNS update failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
