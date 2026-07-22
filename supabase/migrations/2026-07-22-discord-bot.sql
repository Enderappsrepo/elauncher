-- ELauncher migration — Discord bot: guild links, Discord-native applicants, appeals.
-- Idempotent. Run AFTER 2026-07-22-invites-and-applications.sql.
--
-- The bot is an HTTP-interactions app, not a gateway client: Discord POSTs
-- signed payloads to an edge function and it replies. That means no persistent
-- process anywhere, which is the whole reason this is cheap to run.
--
-- The load-bearing change is to who an applicant may be. Until now an
-- application belonged to an ELauncher profile, because it arrived from a page
-- you had to sign into. Someone running /apply in Discord has no such account
-- and should not be made to create one mid-flow, so an application may now be
-- owned by *either* a profile or a Discord user — and exactly one of them.

-- ============================================================
-- guild links
-- ============================================================
create table if not exists public.discord_links (
  -- Discord snowflakes are 64-bit and exceed what JS numbers hold safely, so
  -- every id here is text. Storing them as bigint silently corrupts them.
  guild_id text primary key,
  server_id uuid not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  -- which invite's questions /apply should ask; null = a bare request to join
  invite_code text references public.server_invites (code) on delete set null,
  /* granted on approval. Blank = approve without touching roles, which is the
     safe default: the bot's own role must sit ABOVE this one in the guild's
     role list or Discord refuses the assignment. */
  approved_role_id text not null default '',
  -- where the bot posts applications for review; blank = owner reviews in-panel
  review_channel_id text not null default '',
  -- a denied applicant may argue once; false turns the appeal button off
  allow_appeals boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists discord_links_owner_idx on public.discord_links (owner_id);
create index if not exists discord_links_server_idx on public.discord_links (server_id);

alter table public.discord_links enable row level security;

-- the bot itself reaches this with the service key, never as a user
drop policy if exists "owners manage their discord links" on public.discord_links;
create policy "owners manage their discord links"
  on public.discord_links for all to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- ============================================================
-- applications from Discord
-- ============================================================
alter table public.server_applications add column if not exists discord_user_id text;
alter table public.server_applications add column if not exists discord_username text;
alter table public.server_applications add column if not exists guild_id text;
-- a denied applicant's case for reconsidering
alter table public.server_applications add column if not exists appeal_text text not null default '';
alter table public.server_applications add column if not exists appealed_at timestamptz;

-- an application from Discord has no profile behind it
alter table public.server_applications alter column applicant_id drop not null;

-- 'appealed' is its own state, not a return to pending: it has already been
-- judged once and the owner is being asked to look again
alter table public.server_applications drop constraint if exists server_applications_status_check;
alter table public.server_applications add constraint server_applications_status_check
  check (status in ('pending', 'approved', 'denied', 'appealed'));

/*
 * Exactly one identity per application. Without this a row could arrive with
 * neither (belonging to nobody, undeliverable) or both (two people's decisions
 * landing on one row).
 */
alter table public.server_applications drop constraint if exists server_applications_one_identity;
alter table public.server_applications add constraint server_applications_one_identity
  check ((applicant_id is null) <> (discord_user_id is null));

/*
 * One application per person per link, for both kinds of person. The original
 * table constraint cannot express this: UNIQUE treats every NULL as distinct,
 * so once applicant_id became nullable it stopped constraining Discord rows at
 * all. Two partial indexes say what was actually meant.
 */
alter table public.server_applications drop constraint if exists server_applications_code_applicant_id_key;
create unique index if not exists server_applications_one_per_profile
  on public.server_applications (code, applicant_id) where applicant_id is not null;
create unique index if not exists server_applications_one_per_discord
  on public.server_applications (code, discord_user_id) where discord_user_id is not null;

create index if not exists server_applications_discord_idx
  on public.server_applications (guild_id, status) where discord_user_id is not null;

-- ============================================================
-- appealing
-- ============================================================
/*
 * A denied applicant states their case once. Deliberately not a route back to
 * 'pending': the owner has already decided, and an appeal that looked identical
 * to a fresh application would let someone re-apply forever by another name.
 */
create or replace function public.appeal_application(application_id uuid, reason text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare app public.server_applications%rowtype;
begin
  select * into app from public.server_applications where id = application_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;

  -- only the applicant themselves, and only through the panel; the bot appeals
  -- on a Discord user's behalf with the service key
  if app.applicant_id is not null and app.applicant_id <> auth.uid() and not public.is_admin() then
    raise exception 'not authorised';
  end if;
  if app.status <> 'denied' then
    return jsonb_build_object('ok', false, 'reason', 'only a denied application can be appealed');
  end if;
  if app.appealed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already appealed');
  end if;

  update public.server_applications
    set status = 'appealed', appeal_text = coalesce(reason, ''), appealed_at = now()
    where id = application_id;
  return jsonb_build_object('ok', true, 'status', 'appealed');
end;
$$;

grant execute on function public.appeal_application(uuid, text) to authenticated;

notify pgrst, 'reload schema';
