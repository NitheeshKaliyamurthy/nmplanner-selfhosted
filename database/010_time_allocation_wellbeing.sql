-- NM Planner: weekly time allocation limits and wellbeing tracking.
--
-- Hard planning limits:
--   BCU / Teaching + Research combined: max 37 hours per week
--   BCU / Teaching + Research combined: max 10 hours on any one day
-- Only tasks assigned to a day count toward these hard allocation limits.
-- Existing unscheduled task-family/container rows therefore do not consume capacity.
--
-- Recommendation-only targets are handled in the Insights UI:
--   WorldSkills 28h/week, Family / Home 3h/week, Personal / Admin 3h/week,
--   Sleep 6h/day (42h/week).

begin;

create table if not exists public.wellbeing_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  sleep_hours numeric(4,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_date),
  constraint wellbeing_daily_sleep_hours_check
    check (sleep_hours is null or (sleep_hours >= 0 and sleep_hours <= 24))
);

create table if not exists public.walking_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  walk_date date not null,
  area text not null,
  miles numeric(7,2) not null,
  created_at timestamptz not null default now(),
  constraint walking_logs_area_check
    check (area in (
      'BCU / Teaching',
      'Research',
      'WorldSkills',
      'Family / Home',
      'Personal / Admin'
    )),
  constraint walking_logs_miles_check
    check (miles > 0 and miles <= 100)
);

create index if not exists wellbeing_daily_user_date_idx
  on public.wellbeing_daily (user_id, entry_date);

create index if not exists walking_logs_user_date_idx
  on public.walking_logs (user_id, walk_date);

alter table public.wellbeing_daily enable row level security;
alter table public.walking_logs enable row level security;

drop policy if exists "Users manage their own wellbeing" on public.wellbeing_daily;
create policy "Users manage their own wellbeing"
on public.wellbeing_daily
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own walking logs" on public.walking_logs;
create policy "Users manage their own walking logs"
on public.walking_logs
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.wellbeing_daily to authenticated;
grant select, insert, update, delete on public.walking_logs to authenticated;
grant usage, select on sequence public.walking_logs_id_seq to authenticated;

create or replace function public.touch_wellbeing_daily_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_wellbeing_daily_updated_at_trigger on public.wellbeing_daily;
create trigger touch_wellbeing_daily_updated_at_trigger
before update on public.wellbeing_daily
for each row execute function public.touch_wellbeing_daily_updated_at();

create or replace function public.enforce_work_allocation_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new_week_total integer := 0;
  v_old_week_total integer := 0;
  v_new_day_total integer := 0;
  v_old_day_total integer := 0;
  v_new_is_work boolean := coalesce(new.area in ('BCU / Teaching', 'Research'), false);
  v_old_is_same_week_work boolean := false;
  v_old_is_same_day_work boolean := false;
begin
  -- Unscheduled rows do not consume the 37h/10h scheduled-work allocation.
  if not v_new_is_work or new.day is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.user_id::text || '|' || new.week::text || '|work-allocation', 0)
  );

  select coalesce(sum(task.minutes), 0)
    into v_new_week_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day is not null
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id;

  v_new_week_total := v_new_week_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_week_work := coalesce(
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day is not null,
      false
    );
  end if;

  v_old_week_total := v_new_week_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;

  if v_new_week_total > 2220 and v_new_week_total > v_old_week_total then
    raise exception 'Work weekly capacity exceeded: BCU / Teaching + Research would total % hours, above the 37 hour weekly limit.',
      round(v_new_week_total / 60.0, 2);
  end if;

  select coalesce(sum(task.minutes), 0)
    into v_new_day_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id;

  v_new_day_total := v_new_day_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_day_work := coalesce(
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day = new.day,
      false
    );
  end if;

  v_old_day_total := v_new_day_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_day_work then coalesce(old.minutes, 0) else 0 end;

  if v_new_day_total > 600 and v_new_day_total > v_old_day_total then
    raise exception 'Work daily capacity exceeded: BCU / Teaching + Research would total % hours on this day, above the 10 hour daily limit.',
      round(v_new_day_total / 60.0, 2);
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_work_allocation_capacity_trigger on public.tasks;
create trigger enforce_work_allocation_capacity_trigger
before insert or update of user_id, week, day, area, minutes on public.tasks
for each row execute function public.enforce_work_allocation_capacity();

commit;
