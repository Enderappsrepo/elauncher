-- ELauncher NV:MP plan for an existing hosting database.
-- Run in Supabase SQL Editor after updating the Linux host.
-- $6 USD/month, 10 players, 4 GB RAM, 2 shared CPU cores.
-- Existing plans, prices, orders and payment settings are preserved on rerun.
begin;
set local lock_timeout = '5s';

alter table public.hosting_plans add column if not exists cpu_cores integer;
alter table public.hosting_plans drop constraint if exists hosting_plans_game_check;
alter table public.hosting_plans add constraint hosting_plans_game_check
  check (game in ('minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa', 'nvmp'));
alter table public.hosting_plans drop constraint if exists hosting_plans_nvmp_slots_check;
alter table public.hosting_plans add constraint hosting_plans_nvmp_slots_check
  check (game <> 'nvmp' or max_players = 10);

insert into public.hosting_plans
  (id, name, game, max_players, memory_mb, cpu_cores, price_monthly, currency, active, sort)
values
  ('nvmp-10', 'Fallout: New Vegas Co-op', 'nvmp', 10, 4096, 2, 6.00, 'USD', true, 12)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
commit;

-- Confirm the plan is listed. A pre-existing nvmp-10 row keeps its prior settings.
select id, name, game, max_players, memory_mb, cpu_cores, price_monthly, currency, active
from public.hosting_plans where id = 'nvmp-10';
