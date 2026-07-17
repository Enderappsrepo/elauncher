import webpush from 'web-push'
import { isCloudConfigured } from '@shared/cloudConfig'
import { getClient } from './cloud'

/**
 * Phone notifications over Web Push. The launcher itself is the sender — it
 * sees every server event firsthand, so no extra infrastructure is needed:
 * a per-account VAPID keypair lives in the account's push_config row, and the
 * remote dashboard registers each phone's push subscription. RLS keeps both
 * tables owner-only, so pushes can only ever reach the account's own devices.
 */

const CONTACT = 'mailto:enderappstut@gmail.com'
const SUB_CACHE_MS = 60_000
const DEDUPE_MS = 20_000

interface SubscriptionRow {
  id: string
  endpoint: string
  subscription: webpush.PushSubscription
}

let vapid: { publicKey: string; privateKey: string } | null = null
let vapidOwner: string | null = null
let subsCache: { at: number; rows: SubscriptionRow[] } | null = null
const recent = new Map<string, number>()

async function ensureVapid(me: string): Promise<{ publicKey: string; privateKey: string } | null> {
  if (vapid && vapidOwner === me) return vapid
  const supabase = getClient()
  const read = async (): Promise<{ public_key: string; private_key: string } | null> => {
    const { data } = await supabase.from('push_config').select('public_key, private_key').eq('owner_id', me).maybeSingle()
    return (data as { public_key: string; private_key: string } | null) ?? null
  }
  let row = await read()
  if (!row) {
    const keys = webpush.generateVAPIDKeys()
    const { error } = await supabase
      .from('push_config')
      .insert({ owner_id: me, public_key: keys.publicKey, private_key: keys.privateKey })
    // table missing (migration not run) → notifications stay silently off
    if (error && !/duplicate/i.test(error.message ?? '')) return null
    row = await read() // re-read in case another device won the insert race
    if (!row) return null
  }
  vapid = { publicKey: row.public_key, privateKey: row.private_key }
  vapidOwner = me
  subsCache = null
  return vapid
}

// create the account's keypair soon after boot so phones can subscribe right away
setTimeout(() => {
  void (async () => {
    try {
      if (!isCloudConfigured()) return
      const me = (await getClient().auth.getSession()).data.session?.user.id
      if (me) await ensureVapid(me)
    } catch {
      // offline or signed out — the keypair gets created on the first event instead
    }
  })()
}, 6_000)

/** Fire-and-forget push to every phone the account registered. Never throws. */
export function notifyPhones(title: string, body: string, tag = ''): void {
  void (async () => {
    try {
      if (!isCloudConfigured()) return
      const dedupeKey = `${title}|${body}`
      const last = recent.get(dedupeKey)
      if (last && Date.now() - last < DEDUPE_MS) return
      recent.set(dedupeKey, Date.now())
      if (recent.size > 200) {
        for (const [key, at] of recent) if (Date.now() - at > DEDUPE_MS) recent.delete(key)
      }

      const supabase = getClient()
      const me = (await supabase.auth.getSession()).data.session?.user.id
      if (!me) return
      const keys = await ensureVapid(me)
      if (!keys) return

      if (!subsCache || Date.now() - subsCache.at > SUB_CACHE_MS) {
        const { data } = await supabase.from('push_subscriptions').select('id, endpoint, subscription').eq('owner_id', me)
        subsCache = { at: Date.now(), rows: (data as SubscriptionRow[] | null) ?? [] }
      }
      if (subsCache.rows.length === 0) return

      const payload = JSON.stringify({ title, body, tag })
      await Promise.all(
        subsCache.rows.map(async (row) => {
          try {
            await webpush.sendNotification(row.subscription, payload, {
              vapidDetails: { subject: CONTACT, publicKey: keys.publicKey, privateKey: keys.privateKey },
              TTL: 3600
            })
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode
            if (status === 404 || status === 410) {
              // the phone unsubscribed or the endpoint expired — drop the row
              await supabase.from('push_subscriptions').delete().eq('id', row.id)
              subsCache = null
            }
          }
        })
      )
    } catch {
      // notifications are strictly best-effort
    }
  })()
}
