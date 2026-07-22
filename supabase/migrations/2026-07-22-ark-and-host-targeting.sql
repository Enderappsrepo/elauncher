-- ELauncher migration — ARK plans + choosing which host builds an order.
-- Idempotent: safe to run more than once, and safe on a project that already
-- has the full schema.sql applied. Paste into Supabase → SQL Editor → Run.
-- Extracted from supabase/schema.sql, which remains the whole-database source.

-- ============================================================
-- ARK, and choosing which box builds an order (2026-07-22)
-- ============================================================

-- widen the game list again for both ARKs
alter table public.hosting_plans drop constraint if exists hosting_plans_game_check;
alter table public.hosting_plans add constraint hosting_plans_game_check
  check (game in ('minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa'));

-- ARK is the heaviest pair here: ASE wants ~8 GB steady state and ASA ~16 GB,
-- and both download tens of gigabytes before they first boot.
insert into public.hosting_plans (id, name, game, max_players, memory_mb, cpu_cores, price_monthly, sort) values
  ('ark-20', 'ARK: Survival Evolved', 'ark', 20, 10240, 4, 12.00, 10),
  -- ASA has no Linux server build; a Linux host runs it under GE-Proton, which
  -- the launcher fetches on first install. Any host can build it either way.
  ('arksa-20', 'ARK: Survival Ascended', 'arksa', 20, 20480, 6, 18.00, 11)
on conflict (id) do nothing;

-- The fleet as the operator sees it. Deliberately separate from host_health:
-- that table is telemetry each box publishes about itself and rewrites every
-- heartbeat, while this is operator-owned naming and policy that has to survive
-- a host going offline — and an admin cannot write host_health rows anyway,
-- they belong to the host's own account.
create table if not exists public.hosting_hosts (
  device_id text primary key,
  label text not null default '',
  region text not null default '',
  -- false parks a box: it keeps running what it has and takes no new orders
  enabled boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now()
);

alter table public.hosting_hosts enable row level security;
drop policy if exists "admins manage hosts" on public.hosting_hosts;
create policy "admins manage hosts"
  on public.hosting_hosts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Which box must build this order. Null keeps the original behaviour — the
-- first free host takes it — so existing orders are unaffected.
alter table public.hosting_orders add column if not exists target_device_id text;

-- customers still may not set the new column on their own inserts
drop policy if exists "customers create their orders" on public.hosting_orders;
create policy "customers create their orders"
  on public.hosting_orders for insert to authenticated
  with check (user_id = auth.uid() and status = 'awaiting_payment' and server_id is null and paid_until is null
              and provisioner_id is null and provisioner_seen_at is null and target_device_id is null);

-- Claim, now fenced by the target. Same contract as before for untargeted
-- orders; a targeted one is invisible to every other box, so a host that is
-- offline or still downloading never loses its order to a faster neighbour.
create or replace function public.hosting_claim(order_id uuid, node text, lease_seconds integer default 600)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare claimed boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorised';
  end if;
  update public.hosting_orders
    set provisioner_id = node, provisioner_seen_at = now()
    where id = order_id
      and status = 'active'
      and server_id is null
      and (target_device_id is null or target_device_id = node)
      -- a parked host finishes nothing new; unregistered boxes still work, so
      -- adding a host to hosting_hosts is opt-in naming, not a prerequisite
      and not exists (
        select 1 from public.hosting_hosts h where h.device_id = node and h.enabled = false
      )
      and (provisioner_id is null
           or provisioner_id = node
           -- a host that went dark mid-build releases the order; null seen_at
           -- is spelt out because null < interval is null, not true
           or provisioner_seen_at is null
           or provisioner_seen_at < now() - make_interval(secs => lease_seconds))
    returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

-- Point an order at a box (null = let any host take it). Clearing the claim is
-- the whole reason this is a function rather than an update: retargeting an
-- order a host already holds would otherwise leave that host free to finish it
-- and attach a server built in the wrong place. Only orders that have not
-- produced a server yet can move — a built server's files live on that box, so
-- reassigning it here would silently strand them.
create or replace function public.hosting_assign(order_id uuid, device text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare moved boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorised';
  end if;
  update public.hosting_orders
    set target_device_id = device,
        provisioner_id = case when provisioner_id is distinct from device then null else provisioner_id end,
        provisioner_seen_at = case when provisioner_id is distinct from device then null else provisioner_seen_at end,
        updated_at = now()
    where id = order_id and server_id is null
    returning true into moved;
  return coalesce(moved, false);
end;
$$;


-- make PostgREST pick the new table and functions up immediately
notify pgrst, 'reload schema';
