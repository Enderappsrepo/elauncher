-- ELauncher cloud schema.
-- Paste this whole file into the Supabase SQL editor (Dashboard -> SQL Editor -> New query) and run it once.

-- ============================================================
-- Profiles: one row per account, created automatically on signup
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "signed-in users can read profiles"
  on public.profiles for select to authenticated using (true);

-- Rows are created by the signup trigger below. Admins can update profiles
-- (used by the in-app admin panel to grant/revoke admin); the first admin is
-- bootstrapped from the SQL editor (see README).
create policy "admins can update profiles"
  on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Helper used by policies; security definer avoids recursive RLS lookups.
create or replace function public.is_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ============================================================
-- Modpacks and their versions
-- ============================================================
create table public.modpacks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  minecraft_version text not null default '',
  loader text not null default 'vanilla',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.modpack_versions (
  id uuid primary key default gen_random_uuid(),
  modpack_id uuid not null references public.modpacks (id) on delete cascade,
  version text not null,
  storage_path text not null,
  file_size bigint not null default 0,
  -- files above the per-object storage limit are split into storage_path.partN chunks
  chunk_count integer not null default 1,
  changelog text not null default '',
  created_at timestamptz not null default now(),
  unique (modpack_id, version)
);

alter table public.modpacks enable row level security;
alter table public.modpack_versions enable row level security;

create policy "signed-in users can read modpacks"
  on public.modpacks for select to authenticated using (true);
create policy "anyone can read modpack metadata"
  on public.modpacks for select to anon, authenticated using (true);
create policy "admins can insert modpacks"
  on public.modpacks for insert to authenticated with check (public.is_admin());
create policy "admins can update modpacks"
  on public.modpacks for update to authenticated using (public.is_admin());
create policy "admins can delete modpacks"
  on public.modpacks for delete to authenticated using (public.is_admin());

create policy "signed-in users can read modpack versions"
  on public.modpack_versions for select to authenticated using (true);
create policy "anyone can read modpack version metadata"
  on public.modpack_versions for select to anon, authenticated using (true);
create policy "admins can insert modpack versions"
  on public.modpack_versions for insert to authenticated with check (public.is_admin());
create policy "admins can update modpack versions"
  on public.modpack_versions for update to authenticated using (public.is_admin());
create policy "admins can delete modpack versions"
  on public.modpack_versions for delete to authenticated using (public.is_admin());

-- ============================================================
-- Launcher news: admin-authored articles shown on the Home page
-- ============================================================
create table public.launcher_news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  excerpt text not null default '',
  image_url text,
  link_url text,
  linked_pack_ids uuid[] not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  author_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.launcher_news enable row level security;

-- News is public content: everyone (even signed-out launcher users) can read it
create policy "anyone can read launcher news"
  on public.launcher_news for select to anon, authenticated using (true);
create policy "admins can insert launcher news"
  on public.launcher_news for insert to authenticated with check (public.is_admin());
create policy "admins can update launcher news"
  on public.launcher_news for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins can delete launcher news"
  on public.launcher_news for delete to authenticated using (public.is_admin());

-- ============================================================
-- Storage bucket for the .mrpack files
-- ============================================================
insert into storage.buckets (id, name, public) values ('modpacks', 'modpacks', false);

create policy "signed-in users can download modpack files"
  on storage.objects for select to authenticated
  using (bucket_id = 'modpacks');
create policy "admins can upload modpack files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'modpacks' and public.is_admin());
create policy "admins can overwrite modpack files"
  on storage.objects for update to authenticated
  using (bucket_id = 'modpacks' and public.is_admin());
create policy "admins can delete modpack files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'modpacks' and public.is_admin());

-- ============================================================
-- Function privilege hardening (flagged by the security advisor)
-- ============================================================
-- handle_new_user is only ever invoked by the auth trigger; nobody should call it via RPC
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- is_admin is used inside RLS policies, which run as the signed-in (authenticated) role;
-- anon users have no business calling it. (authenticated keeps EXECUTE on purpose —
-- policies evaluate it as the caller, and it only reveals the caller's own flag.)
revoke execute on function public.is_admin() from public, anon;

-- ============================================================
-- Play Together: live sessions friends can join (added for the host/join feature)
-- Run this block on existing projects to enable the Play page.
-- ============================================================
create table if not exists public.sessions (
  host_id uuid primary key references public.profiles (id) on delete cascade,
  host_name text not null default '',
  name text not null default '',
  address text not null,
  minecraft_version text,
  loader text,
  cloud_pack_id uuid references public.modpacks (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

alter table public.sessions enable row level security;

-- everyone signed in can see who's hosting; you can only create/update/delete your own
create policy "signed-in users can read sessions"
  on public.sessions for select to authenticated using (true);
create policy "users manage their own session"
  on public.sessions for all to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());

-- ============================================================
-- Remote server management: let trusted friends manage your local
-- server from their launcher (added with the Server tab overhaul).
-- Run this block on existing projects to enable the Access tab.
-- ============================================================
create table if not exists public.server_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  server_id uuid not null,
  server_name text not null default '',
  grantee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (server_id, grantee_id)
);

create table if not exists public.server_status (
  server_id uuid primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default '',
  state text not null default 'stopped',
  players text[] not null default '{}',
  address text,
  console text not null default '',
  updated_at timestamptz not null default now()
);

-- live stats for the remote dashboard (2026-07-17). Existing clouds: run these
-- once in the SQL editor — the launcher publishes them automatically after.
alter table public.server_status add column if not exists memory_mb integer;
alter table public.server_status add column if not exists cpu_percent integer;
alter table public.server_status add column if not exists started_at timestamptz;
alter table public.server_status add column if not exists version text;

-- phone notifications (web push). The launcher generates a per-account VAPID
-- keypair; the dashboard registers each phone's push subscription.
create table if not exists public.push_config (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  label text not null default '',
  created_at timestamptz not null default now()
);

alter table public.push_config enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "owners manage their push config" on public.push_config;
create policy "owners manage their push config"
  on public.push_config for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owners manage their push subscriptions" on public.push_subscriptions;
create policy "owners manage their push subscriptions"
  on public.push_subscriptions for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- host performance estimator: the launcher publishes its specs + per-game
-- report so the phone dashboard can show the same "PC as a host" card.
create table if not exists public.host_specs (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  specs jsonb not null,
  report jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.host_specs enable row level security;

drop policy if exists "owners manage their host specs" on public.host_specs;
create policy "owners manage their host specs"
  on public.host_specs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============================================================
-- Hosting business (2026-07-18): plans, settings, orders.
-- Customers order in the web panel and pay via PayPal.me (or an optional
-- Stripe payment link) quoting a reference code. An admin approves the order,
-- and the admin's launcher provisions the server automatically: creates it
-- from the plan, starts it, and shares it with the customer.

create table if not exists public.hosting_plans (
  id text primary key,
  name text not null,
  game text not null check (game in ('minecraft', 'palworld')),
  max_players integer not null default 10,
  memory_mb integer not null default 4096,
  price_monthly numeric(8,2) not null,
  currency text not null default 'USD',
  stripe_link text,
  active boolean not null default true,
  sort integer not null default 0
);

create table if not exists public.hosting_settings (
  id integer primary key default 1 check (id = 1),
  paypal_me text not null default '',
  order_note text not null default ''
);
insert into public.hosting_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.hosting_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan_id text not null references public.hosting_plans (id),
  server_name text not null default 'My Server',
  reference text not null unique,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'pending_review', 'active', 'past_due', 'rejected', 'cancelled')),
  server_id uuid,
  paid_until timestamptz,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hosting_plans enable row level security;
alter table public.hosting_settings enable row level security;
alter table public.hosting_orders enable row level security;

drop policy if exists "anyone signed in reads plans" on public.hosting_plans;
create policy "anyone signed in reads plans"
  on public.hosting_plans for select to authenticated using (true);
drop policy if exists "admins manage plans" on public.hosting_plans;
create policy "admins manage plans"
  on public.hosting_plans for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "anyone signed in reads hosting settings" on public.hosting_settings;
create policy "anyone signed in reads hosting settings"
  on public.hosting_settings for select to authenticated using (true);
drop policy if exists "admins manage hosting settings" on public.hosting_settings;
create policy "admins manage hosting settings"
  on public.hosting_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "customers create their orders" on public.hosting_orders;
create policy "customers create their orders"
  on public.hosting_orders for insert to authenticated
  with check (user_id = auth.uid() and status = 'awaiting_payment' and server_id is null and paid_until is null);
drop policy if exists "customers see their orders" on public.hosting_orders;
create policy "customers see their orders"
  on public.hosting_orders for select to authenticated using (user_id = auth.uid());
drop policy if exists "admins manage orders" on public.hosting_orders;
create policy "admins manage orders"
  on public.hosting_orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- customers change order status ONLY through this function, so they can flag
-- payment or cancel but can never touch server_id/paid_until/active.
create or replace function public.hosting_mark(order_id uuid, new_status text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if new_status not in ('pending_review', 'cancelled') then
    raise exception 'invalid status';
  end if;
  update public.hosting_orders
    set status = new_status, updated_at = now()
    where id = order_id
      and user_id = auth.uid()
      and status in ('awaiting_payment', 'pending_review', 'past_due')
      and (new_status <> 'cancelled' or status <> 'past_due');
end;
$$;

-- starter plans — edit names, limits, and prices freely
insert into public.hosting_plans (id, name, game, max_players, memory_mb, price_monthly, sort) values
  ('mc-basic', 'Minecraft Basic', 'minecraft', 10, 4096, 4.00, 1),
  ('mc-plus', 'Minecraft Plus', 'minecraft', 20, 8192, 7.00, 2),
  ('pal-8', 'Palworld 8 slots', 'palworld', 8, 16384, 8.00, 3),
  ('pal-16', 'Palworld 16 slots', 'palworld', 16, 16384, 12.00, 4)
on conflict (id) do nothing;

create table if not exists public.server_commands (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  sender_name text not null default '',
  action text not null, -- 'start' | 'stop' | 'command'
  payload text not null default '',
  executed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.server_shares enable row level security;
alter table public.server_status enable row level security;
alter table public.server_commands enable row level security;

-- owners manage their grants; grantees can see grants aimed at them
-- (drop-then-create keeps this block safe to re-run on existing projects)
drop policy if exists "owners manage their shares" on public.server_shares;
create policy "owners manage their shares"
  on public.server_shares for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "grantees see their shares" on public.server_shares;
create policy "grantees see their shares"
  on public.server_shares for select to authenticated using (grantee_id = auth.uid());

-- owners publish status; grantees of that server can read it
drop policy if exists "owners publish their server status" on public.server_status;
create policy "owners publish their server status"
  on public.server_status for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "grantees read shared server status" on public.server_status;
create policy "grantees read shared server status"
  on public.server_status for select to authenticated
  using (exists (
    select 1 from public.server_shares s
    where s.server_id = server_status.server_id and s.grantee_id = auth.uid()
  ));

-- grantees queue commands for servers shared with them; owners read + mark them executed
drop policy if exists "grantees queue commands" on public.server_commands;
create policy "grantees queue commands"
  on public.server_commands for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.server_shares s
      where s.server_id = server_commands.server_id and s.grantee_id = auth.uid()
    )
  );
drop policy if exists "owners manage commands for their servers" on public.server_commands;
create policy "owners manage commands for their servers"
  on public.server_commands for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "senders see their own commands" on public.server_commands;
create policy "senders see their own commands"
  on public.server_commands for select to authenticated using (sender_id = auth.uid());

-- make PostgREST pick the new tables up immediately
notify pgrst, 'reload schema';
