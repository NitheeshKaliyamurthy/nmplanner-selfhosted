-- NM Planner: configurable planning limits, daily recommendations and focus areas.
--
-- Defaults preserve the current planner behaviour, with the requested changes:
--   BCU / Teaching + Research: 37h/week hard maximum, 10h/day hard maximum
--   Q1: 4h/day hard maximum
--   Q2: 5h/day hard maximum
--   WorldSkills: 28h/week recommendation
--   Family / Home: 3h/day recommendation
--   Personal Time: 3h/day recommendation
--   Lunch: 1h/day recommendation (editable in Settings)
--   Sleep: 6h/day personal target
--   Walking estimate: 2,000 steps/mile
--
-- Existing 'Personal / Admin' task/walking rows are renamed to 'Personal Time'.

begin;

create table if not exists public.planner_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  work_weekly_minutes integer not null default 2220 check (work_weekly_minutes between 60 and 10080),
  work_daily_minutes integer not null default 600 check (work_daily_minutes between 30 and 1440),
  q1_daily_minutes integer not null default 240 check (q1_daily_minutes between 15 and 1440),
  q2_daily_minutes integer not null default 300 check (q2_daily_minutes between 15 and 1440),
  worldskills_weekly_minutes integer not null default 1680 check (worldskills_weekly_minutes between 0 and 10080),
  family_daily_minutes integer not null default 180 check (family_daily_minutes between 0 and 1440),
  personal_daily_minutes integer not null default 180 check (personal_daily_minutes between 0 and 1440),
  lunch_daily_minutes integer not null default 60 check (lunch_daily_minutes between 0 and 1440),
  sleep_daily_hours numeric(4,2) not null default 6 check (sleep_daily_hours between 0 and 24),
  steps_per_mile integer not null default 2000 check (steps_per_mile between 500 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.planner_settings enable row level security;

drop policy if exists "Users manage their own planner settings" on public.planner_settings;
create policy "Users manage their own planner settings"
on public.planner_settings
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.planner_settings to authenticated;

create or replace function public.touch_planner_settings_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_planner_settings_updated_at_trigger on public.planner_settings;
create trigger touch_planner_settings_updated_at_trigger
before update on public.planner_settings
for each row execute function public.touch_planner_settings_updated_at();

-- Rename the old personal area while preserving all task history.
update public.tasks
set area = 'Personal Time'
where area = 'Personal / Admin';

update public.walking_logs
set area = 'Personal Time'
where area = 'Personal / Admin';

alter table public.walking_logs
  drop constraint if exists walking_logs_area_check;

alter table public.walking_logs
  add constraint walking_logs_area_check
  check (area in (
    'BCU / Teaching',
    'Research',
    'WorldSkills',
    'Family / Home',
    'Personal Time',
    'Lunch'
  ));

-- Configurable Q1/Q2 hard limits.
create or replace function public.enforce_daily_quadrant_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  existing_minutes integer := 0;
  candidate_minutes integer := 0;
  capacity_minutes integer := 0;
  quadrant_label text;
  v_q1_limit integer := 240;
  v_q2_limit integer := 300;
begin
  if new.day is null or new.quadrant not in ('q1', 'q2') then
    return new;
  end if;

  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
    into v_q1_limit, v_q2_limit
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_q1_limit := 240;
    v_q2_limit := 300;
  end if;

  if new.quadrant = 'q1' then
    capacity_minutes := v_q1_limit;
    quadrant_label := 'Q1';
  else
    capacity_minutes := v_q2_limit;
    quadrant_label := 'Q2';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|' || new.quadrant,
      0
    )
  );

  select coalesce(sum(minutes), 0)::integer
    into existing_minutes
  from public.tasks
  where user_id = new.user_id
    and week = new.week
    and day = new.day
    and quadrant = new.quadrant
    and id <> new.id;

  candidate_minutes := existing_minutes + new.minutes;

  if candidate_minutes > capacity_minutes then
    if tg_op = 'UPDATE'
       and old.quadrant = new.quadrant
       and old.week = new.week
       and old.day is not distinct from new.day
       and new.minutes <= old.minutes then
      return new;
    end if;

    raise exception '% daily capacity exceeded: this change would schedule % minutes, above your % minute limit.',
      quadrant_label, candidate_minutes, capacity_minutes
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Configurable BCU/Research weekly and daily hard limits.
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
  v_new_is_work boolean := new.area in ('BCU / Teaching', 'Research');
  v_old_is_same_week_work boolean := false;
  v_old_is_same_day_work boolean := false;
  v_week_limit integer := 2220;
  v_day_limit integer := 600;
begin
  if not v_new_is_work or new.day is null then
    return new;
  end if;

  select coalesce(work_weekly_minutes, 2220), coalesce(work_daily_minutes, 600)
    into v_week_limit, v_day_limit
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_week_limit := 2220;
    v_day_limit := 600;
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
    and task.id <> new.id;

  v_new_week_total := v_new_week_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_week_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day is not null;
  end if;

  v_old_week_total := v_new_week_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;

  if v_new_week_total > v_week_limit and v_new_week_total > v_old_week_total then
    raise exception 'Work weekly capacity exceeded: BCU / Teaching + Research would total % hours, above your % hour weekly limit.',
      round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2)
      using errcode = '23514';
  end if;

  select coalesce(sum(task.minutes), 0)
    into v_new_day_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research')
    and task.id <> new.id;

  v_new_day_total := v_new_day_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_day_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day = new.day;
  end if;

  v_old_day_total := v_new_day_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_day_work then coalesce(old.minutes, 0) else 0 end;

  if v_new_day_total > v_day_limit and v_new_day_total > v_old_day_total then
    raise exception 'Work daily capacity exceeded: BCU / Teaching + Research would total % hours on this day, above your % hour daily limit.',
      round(v_new_day_total / 60.0, 2), round(v_day_limit / 60.0, 2)
      using errcode = '23514';
  end if;

  return new;
end;
$$;

commit;
