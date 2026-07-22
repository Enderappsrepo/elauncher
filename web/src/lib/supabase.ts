import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@shared/cloudConfig'

/**
 * The panel's cloud client.
 *
 * The old single-file panel pulled supabase-js from jsDelivr and repeated the
 * project credentials inline. Both are gone: the package is bundled (so an
 * installed PWA no longer needs a third-party CDN to be reachable before it can
 * sign in) and the credentials come from the same module the desktop app reads.
 *
 * The anon key is public by design — every rule that matters is a row-level
 * security policy in supabase/schema.sql.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
})
