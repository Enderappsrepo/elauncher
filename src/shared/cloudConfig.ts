/**
 * Supabase project credentials for the ELauncher cloud (accounts + modpack library).
 *
 * Fill these in after creating your project — see the "Cloud setup" section of the README.
 * The anon key is safe to ship inside the app: all access control is enforced by
 * Row Level Security policies in supabase/schema.sql.
 */
export const SUPABASE_URL = 'https://noodzwrbsibogeoukvye.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_DgVhX7zDLdO2ghE14jcrTw_o3yLxwrs'

export function isCloudConfigured(): boolean {
  return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20
}
