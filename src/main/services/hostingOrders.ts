import { resolve4 } from 'dns/promises'
import type { LocalServer } from '@shared/types'
import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient } from './cloud'
import { getShareInfo, startTunnel, stopTunnel } from './hosting'
import { assignHost, hostPool, listAssignedHosts, updateDuckDns } from './hostNames'
import { notifyPhones } from './notifications'
import { getSettings } from './settings'
import { closePort, openPort, refreshExternalIp } from './upnp'
import { getMinecraftVersions } from './versions'
import {
  announceServerByPort,
  createServer,
  getServerPublicAddress,
  listLocalServers,
  setServerAutomation,
  setServerLimits,
  setServerProperties,
  startServer,
  stopServer
} from './server'

/**
 * Hosting provisioner — the business half of the relay. Runs only when the
 * signed-in account is an admin. Watches hosting_orders and:
 *  - 'active' without a server: creates one from the plan, configures players/
 *    memory, arms automation, starts it, exposes it publicly, and shares it
 *    with the customer (the join address lands in the order note);
 *  - 'active' with a server: keeps the share and the public address alive
 *    (heals re-approvals, crash restarts, launcher restarts, IP rotations);
 *  - 'active' past paid_until: stops the server, closes its public path,
 *    revokes the share, and marks the order past_due (world files are kept
 *    for reactivation).
 */

const POLL_MS = 15_000

interface PlanRow {
  id: string
  name: string
  game: 'minecraft' | 'palworld' | 'valheim' | 'sdtd'
  max_players: number
  memory_mb: number
  /** optional CPU core cap (column may not exist on older clouds) */
  cpu_cores?: number | null
}

/** The resource caps a plan buys — stamped onto the server record and enforced at start. */
function planLimits(plan: PlanRow): { memoryMb?: number; maxPlayers?: number; cpuCores?: number } {
  return {
    ...(plan.memory_mb > 0 ? { memoryMb: plan.memory_mb } : {}),
    ...(plan.max_players > 0 ? { maxPlayers: plan.max_players } : {}),
    ...(plan.cpu_cores && plan.cpu_cores > 0 ? { cpuCores: plan.cpu_cores } : {})
  }
}

interface OrderRow {
  id: string
  user_id: string
  plan_id: string
  server_name: string
  reference: string
  status: string
  server_id: string | null
  paid_until: string | null
  note: string
  config: { loader?: string; version?: string; modpack?: string } | null
}

let running = false
const provisioning = new Set<string>()

// UPnP failures back off so a dead router doesn't stall every tick on rediscovery
let upnpRetryAt = 0
let lastUpnpError = 'the router has not accepted a port mapping yet'
/** last exposure error pushed to phones per order, so a persistent failure alerts once */
const exposureAlerts = new Map<string, string>()

/**
 * Make a hosted server publicly reachable and return its join address.
 * Router mapping first (UDP for palworld, TCP for minecraft — direct and
 * stable); minecraft falls back to the bore relay when the router can't map.
 * Safe to call every tick: live mappings return instantly and self-renew.
 */
let poolAlerted = false

async function ensureExposed(server: LocalServer): Promise<string> {
  const game = server.game ?? 'minecraft'
  const protocol: 'UDP' | 'TCP' = game === 'minecraft' ? 'TCP' : 'UDP'
  const existing = getServerPublicAddress(server.id)
  // claim a unique customer-facing hostname while any are free in the pool
  if (assignHost(server.id)) {
    poolAlerted = false
  } else if (hostPool().length > 0 && !poolAlerted) {
    poolAlerted = true
    notifyPhones(
      'Hosting',
      'Hostname pool is full — every name is assigned, so new servers fall back to the shared address. Add names in Settings.',
      'hosting'
    )
  }
  if (Date.now() >= upnpRetryAt) {
    try {
      const mapping = await openPort(server.port, protocol, `ELauncher hosted ${server.name}`)
      const address = getServerPublicAddress(server.id) ?? `${mapping.externalIp}:${server.port}`
      if (address !== existing) {
        if (game === 'minecraft') stopTunnel(server.port) // direct beats the relay
        announceServerByPort(server.port)
      }
      return address
    } catch (e) {
      upnpRetryAt = Date.now() + 300_000
      lastUpnpError = e instanceof Error ? e.message : String(e)
      if (game !== 'minecraft') throw e // UDP can't ride the TCP relay — no fallback
    }
  } else if (existing) {
    return existing
  } else if (game !== 'minecraft') {
    throw new Error(lastUpnpError)
  }
  const { address } = await startTunnel(server.port)
  announceServerByPort(server.port)
  return address
}

/** Tear down the public path for a suspended server (mapping and/or relay). */
function suspendExposure(server: LocalServer): void {
  stopTunnel(server.port)
  void closePort(server.port, (server.game ?? 'minecraft') === 'minecraft' ? 'TCP' : 'UDP')
}

let dnsCheckAt = 0
let lastDnsAlert = ''
let lastDuckDnsAlert = ''

/**
 * Verify hourly that every hostname we publish — the global custom host and
 * each server's assigned pool name — still resolves to this connection's IP;
 * a lapsed DDNS or forgotten record would silently strand customers. Alerts
 * once per distinct mismatch set.
 */
async function checkPublicHostDns(): Promise<void> {
  const hosts = [...new Set([getSettings().publicHost, ...listAssignedHosts()])].filter((h): h is string => Boolean(h))
  if (hosts.length === 0 || Date.now() < dnsCheckAt) return
  dnsCheckAt = Date.now() + 3_600_000
  try {
    const { publicIp } = await getShareInfo()
    if (!publicIp) return
    const wrong: string[] = []
    for (const host of hosts) {
      const records = await resolve4(host).catch(() => [] as string[])
      if (!records.includes(publicIp)) wrong.push(`${host} → ${records[0] ?? 'nothing'}`)
    }
    if (wrong.length === 0) {
      lastDnsAlert = ''
      return
    }
    const alert = `${wrong.join(', ')} (your public IP is ${publicIp})`
    if (alert !== lastDnsAlert) {
      lastDnsAlert = alert
      notifyPhones('Hosting', `Address problem: ${alert}. Customers may not be able to connect — fix the DNS records.`, 'hosting')
    }
  } catch {
    // resolver hiccup — next hourly pass retries
  }
}

/** Build the Minecraft content source from the customer's order config. */
async function minecraftSource(
  config: OrderRow['config']
): Promise<{ type: 'fresh'; kind: 'vanilla' | 'paper' | 'fabric' | 'neoforge' | 'forge'; minecraftVersion: string } | { type: 'modrinthPack'; projectId: string }> {
  if (config?.modpack) return { type: 'modrinthPack', projectId: config.modpack }
  const kind = (['vanilla', 'paper', 'fabric', 'neoforge', 'forge'].includes(config?.loader ?? '')
    ? config!.loader
    : 'paper') as 'vanilla' | 'paper' | 'fabric' | 'neoforge' | 'forge'
  return { type: 'fresh', kind, minecraftVersion: config?.version || (await latestMinecraftRelease()) }
}

async function provision(order: OrderRow, plan: PlanRow, me: string): Promise<void> {
  const supabase = getClient()
  const note = async (text: string): Promise<void> => {
    await supabase.from('hosting_orders').update({ note: text, updated_at: new Date().toISOString() }).eq('id', order.id)
  }

  // tell the customer it's happening before the (possibly long) download starts
  await note(plan.game === 'minecraft' ? 'Setting up your server…' : 'Setting up your server — downloading the game (this can take a few minutes)…')

  const name = order.server_name.trim() || plan.name
  const server =
    plan.game === 'palworld'
      ? await createServer({ name, acceptEula: true, source: { type: 'palworld', maxPlayers: plan.max_players } })
      : plan.game === 'valheim' || plan.game === 'sdtd'
        ? await createServer({ name, acceptEula: true, source: { type: 'steamgame', game: plan.game, maxPlayers: plan.max_players } })
        : await createServer({ name, memoryMax: plan.memory_mb, acceptEula: true, source: await minecraftSource(order.config) })
  if (!server) throw new Error('server creation was cancelled')

  if (plan.game === 'minecraft') {
    setServerProperties(server.id, { 'max-players': String(plan.max_players) })
  }
  // plan caps ride on the record: enforced at every start, guarded over the relay
  setServerLimits(server.id, planLimits(plan))
  // hosted servers take care of themselves
  setServerAutomation(server.id, {
    restartMode: 'off',
    restartOnCrash: true,
    autoStart: true,
    backupIntervalHours: 12,
    backupKeep: 5
  })
  await supabase
    .from('server_shares')
    .upsert(
      { owner_id: me, server_id: server.id, server_name: server.name, grantee_id: order.user_id },
      { onConflict: 'server_id,grantee_id' }
    )
  await supabase
    .from('hosting_orders')
    .update({ server_id: server.id, note: 'Starting your server…', updated_at: new Date().toISOString() })
    .eq('id', order.id)
  await startServer(server.id).catch(() => {
    // surfaced through the server's own state events
  })
  let address: string | null = null
  try {
    address = await ensureExposed(server)
    await note(`Ready — join at ${address}`)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await note(`Server is running, but it has no public address yet — ${message}`.slice(0, 300))
  }
  notifyPhones(
    'Hosting',
    `${plan.name} provisioned for order ${order.reference}${address ? ` — ${address}` : ' (no public address yet)'}`,
    'hosting'
  )
}

async function latestMinecraftRelease(): Promise<string> {
  const versions = await getMinecraftVersions()
  const release = versions.find((v) => v.type === 'release')?.id
  if (!release) throw new Error('could not resolve the latest Minecraft release')
  return release
}

async function tick(): Promise<void> {
  if (running || !isCloudConfigured()) return
  running = true
  try {
    const supabase = getClient()
    const me = (await supabase.auth.getSession()).data.session?.user.id
    if (!me) return
    const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', me).maybeSingle()
    if (!(profile as { is_admin?: boolean } | null)?.is_admin) return

    const [{ data: planData }, { data: orderData }] = await Promise.all([
      supabase.from('hosting_plans').select('*'),
      supabase.from('hosting_orders').select('*').eq('status', 'active')
    ])
    const plans = new Map(((planData as PlanRow[] | null) ?? []).map((p) => [p.id, p]))
    const orders = (orderData as OrderRow[] | null) ?? []
    if (orders.length === 0) return
    const localById = new Map(listLocalServers().map((s) => [s.id, s]))

    // keep published addresses honest across ISP address rotations
    const ipChanged = await refreshExternalIp()
    if (ipChanged) {
      for (const order of orders) {
        const record = order.server_id ? localById.get(order.server_id) : undefined
        if (record) announceServerByPort(record.port)
      }
    }
    // push duckdns records before the drift check so a fresh name resolves correctly
    const duckdnsError = await updateDuckDns(ipChanged)
    if (duckdnsError && duckdnsError !== lastDuckDnsAlert) {
      lastDuckDnsAlert = duckdnsError
      notifyPhones('Hosting', duckdnsError, 'hosting')
    } else if (!duckdnsError) {
      lastDuckDnsAlert = ''
    }
    await checkPublicHostDns()

    for (const order of orders) {
      const plan = plans.get(order.plan_id)
      if (!plan) continue
      try {
        if (!order.server_id) {
          if (provisioning.has(order.id)) continue // a slow download from a prior tick is still running
          provisioning.add(order.id)
          notifyPhones('Hosting', `Provisioning ${plan.name} for order ${order.reference}…`, 'hosting')
          try {
            await provision(order, plan, me)
          } finally {
            provisioning.delete(order.id)
          }
        } else if (order.paid_until && new Date(order.paid_until).getTime() < Date.now()) {
          const record = localById.get(order.server_id)
          if (record) {
            stopServer(order.server_id)
            suspendExposure(record)
          }
          exposureAlerts.delete(order.id)
          await supabase
            .from('server_shares')
            .delete()
            .eq('server_id', order.server_id)
            .eq('grantee_id', order.user_id)
          await supabase
            .from('hosting_orders')
            .update({ status: 'past_due', note: 'Suspended — payment past due', updated_at: new Date().toISOString() })
            .eq('id', order.id)
          notifyPhones('Hosting', `Order ${order.reference} is past due — server suspended`, 'hosting')
        } else if (localById.has(order.server_id)) {
          // keep the record's plan caps honest (plan changes, upgrades, old servers
          // provisioned before limits existed) — applied on the next start
          const record = localById.get(order.server_id)!
          const wanted = planLimits(plan)
          if (JSON.stringify(record.limits ?? {}) !== JSON.stringify(wanted)) {
            setServerLimits(order.server_id, wanted)
          }
          // heal the share for healthy orders (covers re-approvals after past_due)
          await supabase
            .from('server_shares')
            .upsert(
              { owner_id: me, server_id: order.server_id, server_name: order.server_name, grantee_id: order.user_id },
              { onConflict: 'server_id,grantee_id' }
            )
          // keep the public path alive (launcher restarts, crash restarts, lease expiry,
          // reactivations) and the customer-visible address current
          try {
            const address = await ensureExposed(localById.get(order.server_id)!)
            exposureAlerts.delete(order.id)
            if (!order.note.includes(address)) {
              await supabase
                .from('hosting_orders')
                .update({ note: `Ready — join at ${address}`, updated_at: new Date().toISOString() })
                .eq('id', order.id)
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            if (exposureAlerts.get(order.id) !== message) {
              exposureAlerts.set(order.id, message)
              notifyPhones('Hosting', `Order ${order.reference} has no public address — ${message}`, 'hosting')
            }
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await supabase
          .from('hosting_orders')
          .update({ note: `provisioning failed: ${message}`.slice(0, 300), updated_at: new Date().toISOString() })
          .eq('id', order.id)
        notifyPhones('Hosting', `Order ${order.reference} failed: ${message}`, 'hosting')
      }
    }
  } catch {
    // cloud unreachable or tables not migrated — next tick retries
  } finally {
    running = false
  }
}

export function startHostingProvisioner(): void {
  setTimeout(() => void tick(), 6_000)
  setInterval(() => void tick(), POLL_MS)
}
