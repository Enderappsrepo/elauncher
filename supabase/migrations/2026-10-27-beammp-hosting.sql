-- BeamMP hosting and version-aware provisioning (2026-10-27).
-- This only permits an operator to configure BeamMP plans. It does not create
-- or activate a paid plan, choose a price, or provision any server.
begin;

alter table public.hosting_plans drop constraint if exists hosting_plans_game_check;
alter table public.hosting_plans add constraint hosting_plans_game_check
  check (game in ('minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa', 'beammp'));

-- Older launchers treat an unknown game as Minecraft. Keep their existing
-- claim RPC for supported games, but never let it claim or renew a BeamMP order.
-- The game predicate is evaluated together with the lease/target update, so a
-- concurrent old host cannot win between a separate capability check and claim.
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
      and exists (
        select 1 from public.hosting_plans p
        where p.id = hosting_orders.plan_id and p.game <> 'beammp'
      )
      and (target_device_id is null or target_device_id = node)
      and not exists (
        select 1 from public.hosting_hosts h where h.device_id = node and h.enabled = false
      )
      and (provisioner_id is null
           or provisioner_id = node
           or provisioner_seen_at is null
           or provisioner_seen_at < now() - make_interval(secs => lease_seconds))
    returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

-- BeamMP-capable launchers use this RPC for initial claims AND lease renewals.
-- Absence of this RPC means the cloud has not been upgraded: callers must fail
-- closed rather than fall back to hosting_claim or unclaimed provisioning.
create or replace function public.hosting_claim_beammp(order_id uuid, node text, lease_seconds integer default 600)
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
      and exists (
        select 1 from public.hosting_plans p
        where p.id = hosting_orders.plan_id and p.game = 'beammp'
      )
      and (target_device_id is null or target_device_id = node)
      and not exists (
        select 1 from public.hosting_hosts h where h.device_id = node and h.enabled = false
      )
      and (provisioner_id is null
           or provisioner_id = node
           or provisioner_seen_at is null
           or provisioner_seen_at < now() - make_interval(secs => lease_seconds))
    returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

-- SECURITY DEFINER RPCs still verify is_admin() internally. In particular, an
-- authenticated customer cannot provision orders just because this grant exists.
revoke execute on function public.hosting_claim(uuid, text, integer) from public, anon;
revoke execute on function public.hosting_claim_beammp(uuid, text, integer) from public, anon;
grant execute on function public.hosting_claim(uuid, text, integer) to authenticated;
grant execute on function public.hosting_claim_beammp(uuid, text, integer) to authenticated;

-- hosting_finish keeps its existing provisioner-id fence: a host whose lease
-- another node reclaimed cannot attach a late server to that node's order.
notify pgrst, 'reload schema';
commit;
