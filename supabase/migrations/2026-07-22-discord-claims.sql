-- ELauncher migration — Discord guild claims, and the two columns the bot's
-- message flow needs. Idempotent. Run AFTER 2026-07-22-discord-bot.sql.
--
-- Linking a guild to a server has to prove authority over the *guild*, not just
-- knowledge of its id: guild ids are public (every invite embed leaks one), and
-- discord_links.guild_id is a primary key, so whoever writes the row first owns
-- the guild's /apply flow. Without proof, anyone could point someone else's
-- community at their own server — and the bot would assign roles in a guild the
-- link owner has no standing in.
--
-- The proof is a claim code: /setup — which Discord only offers to members with
-- Manage Server — mints a short-lived code, and pasting that code into the
-- panel is what creates (or takes over) the link. Re-running /setup always
-- works, so a squatted guild is recovered by the same door it was lost through.

create table if not exists public.discord_claims (
  code text primary key,
  -- snowflakes are text everywhere, for the same reason as discord_links:
  -- as bigint they exceed JS's safe integer range and silently corrupt
  guild_id text not null,
  guild_name text not null default '',
  -- the Discord user who ran /setup, for the audit trail only
  created_by text not null default '',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists discord_claims_guild_idx on public.discord_claims (guild_id);

-- RLS on, no policies: only the service key (the bot and the redeem route)
-- touches claims. A client that could read them could link guilds it never held
-- Manage Server in, which is the entire thing the table exists to prevent.
alter table public.discord_claims enable row level security;

-- the guild's name at claim time, so the panel can say which Discord is linked
-- instead of showing a 19-digit id
alter table public.discord_links add column if not exists guild_name text not null default '';

-- the bot's post in the review channel, so a decision made anywhere — Discord
-- button or panel — can edit that message rather than leaving stale buttons
alter table public.server_applications add column if not exists review_message_id text not null default '';

notify pgrst, 'reload schema';
