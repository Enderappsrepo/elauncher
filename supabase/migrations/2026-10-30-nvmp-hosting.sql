-- NV:MP co-op hosting. Run only when the configured Linux host has passed a real join test.
-- Pricing and activation remain explicit admin choices; no public plan is inserted.
alter table public.hosting_plans drop constraint if exists hosting_plans_game_check;
alter table public.hosting_plans add constraint hosting_plans_game_check
  check (game in ('minecraft', 'palworld', 'valheim', 'sdtd', 'zomboid', 'tmodloader', 'ark', 'arksa', 'nvmp'));
alter table public.hosting_plans drop constraint if exists hosting_plans_nvmp_slots_check;
alter table public.hosting_plans add constraint hosting_plans_nvmp_slots_check
  check (game <> 'nvmp' or max_players = 10);
