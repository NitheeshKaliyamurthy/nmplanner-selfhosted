-- NM Planner: configurable work labels and simplified time categories.
--
-- Changes:
--   * Adds per-user display names for primary work and additional work.
--   * Removes Lunch as a separate planning category; existing Lunch rows become Personal Time.
--   * Keeps canonical database area values so historical analytics and hard limits stay stable.
--   * Family / Home and Personal Time remain flexible recommendations across the week.
--
-- Canonical areas remain:
--   BCU / Teaching, Research, WorldSkills, Family / Home, Personal Time

begin;

alter table if exists public.planner_settings
  add column if not exists work_name text not null default 'Primary Work';

alter table if exists public.planner_settings
  add column if not exists additional_work_name text not null default 'Additional Work';

alter table if exists public.planner_settings
  drop constraint if exists planner_settings_work_name_check;

alter table if exists public.planner_settings
  add constraint planner_settings_work_name_check
  check (char_length(trim(work_name)) between 1 and 60);

alter table if exists public.planner_settings
  drop constraint if exists planner_settings_additional_work_name_check;

alter table if exists public.planner_settings
  add constraint planner_settings_additional_work_name_check
  check (char_length(trim(additional_work_name)) between 1 and 60);

-- Lunch is now part of Personal Time. Preserve any existing history by renaming rows.
update public.tasks
set area = 'Personal Time'
where area = 'Lunch';

update public.walking_logs
set area = 'Personal Time'
where area = 'Lunch';

alter table if exists public.walking_logs
  drop constraint if exists walking_logs_area_check;

alter table if exists public.walking_logs
  add constraint walking_logs_area_check
  check (area in (
    'BCU / Teaching',
    'Research',
    'WorldSkills',
    'Family / Home',
    'Personal Time'
  ));

-- Lunch no longer has its own target. The Personal Time recommendation covers it.
alter table if exists public.planner_settings
  drop column if exists lunch_daily_minutes;

-- Keep the hard primary-work limit configurable while using the user's chosen
-- display name in validation messages. Research continues to share this budget.
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
  v_work_name text := 'Primary Work';
begin
  if not v_new_is_work or new.day is null then
    return new;
  end if;

  select
    coalesce(work_weekly_minutes, 2220),
    coalesce(work_daily_minutes, 600),
    coalesce(nullif(trim(work_name), ''), 'Primary Work')
  into v_week_limit, v_day_limit, v_work_name
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_week_limit := 2220;
    v_day_limit := 600;
    v_work_name := 'Primary Work';
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
    raise exception '% weekly capacity exceeded: primary work including Research would total % hours, above your % hour weekly limit.',
      v_work_name, round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2)
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
    raise exception '% daily capacity exceeded: primary work including Research would total % hours on this day, above your % hour daily limit.',
      v_work_name, round(v_new_day_total / 60.0, 2), round(v_day_limit / 60.0, 2)
      using errcode = '23514';
  end if;

  return new;
end;
$$;

commit;
