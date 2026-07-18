import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient } from './cloud'
import { notifyPhones } from './notifications'
import { getMinecraftVersions } from './versions'
import {
  createServer,
  listLocalServers,
  setServerAutomation,
  setServerProperties,
  startServer,
  stopServer
} from './server'

/**
 * Hosting provisioner — the business half of the relay. Runs only when the
 * signed-in account is an admin. Watches hosting_orders and:
 *  - 'active' without a server: creates one from the plan, configures players/
 *    memory, arms automation, starts it, and shares it with the customer;
 *  - 'active' past paid_until: stops the server, revokes the share, and marks
 *    the order past_due (world files are kept for reactivation);
 *  - keeps shares in place for healthy active orders (heals re-approvals).
 */

const POLL_MS = 15_000

interface PlanRow {
  id: string
  name: string
  game: 'minecraft' | 'palworld'
  max_players: number
  memory_mb: number
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
  config: { loader?: string; version?: string; modpack?: string } | null
}

let running = false
const provisioning = new Set<string>()

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
  await note(plan.game === 'palworld' ? 'Setting up your server — downloading (~8 GB, a few minutes)…' : 'Setting up your server…')

  const name = order.server_name.trim() || plan.name
  const server =
    plan.game === 'palworld'
      ? await createServer({ name, acceptEula: true, source: { type: 'palworld', maxPlayers: plan.max_players } })
      : await createServer({ name, memoryMax: plan.memory_mb, acceptEula: true, source: await minecraftSource(order.config) })
  if (!server) throw new Error('server creation was cancelled')

  if (plan.game === 'minecraft') {
    setServerProperties(server.id, { 'max-players': String(plan.max_players) })
  }
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
    .update({ server_id: server.id, note: '', updated_at: new Date().toISOString() })
    .eq('id', order.id)
  await startServer(server.id).catch(() => {
    // surfaced through the server's own state events
  })
  notifyPhones('Hosting', `${plan.name} provisioned for order ${order.reference}`, 'hosting')
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
    const localIds = new Set(listLocalServers().map((s) => s.id))

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
          if (localIds.has(order.server_id)) stopServer(order.server_id)
          await supabase
            .from('server_shares')
            .delete()
            .eq('server_id', order.server_id)
            .eq('grantee_id', order.user_id)
          await supabase
            .from('hosting_orders')
            .update({ status: 'past_due', updated_at: new Date().toISOString() })
            .eq('id', order.id)
          notifyPhones('Hosting', `Order ${order.reference} is past due — server suspended`, 'hosting')
        } else if (localIds.has(order.server_id)) {
          // heal the share for healthy orders (covers re-approvals after past_due)
          await supabase
            .from('server_shares')
            .upsert(
              { owner_id: me, server_id: order.server_id, server_name: order.server_name, grantee_id: order.user_id },
              { onConflict: 'server_id,grantee_id' }
            )
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
