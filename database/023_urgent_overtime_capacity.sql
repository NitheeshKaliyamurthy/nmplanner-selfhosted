-- NM Planner urgent/overtime capacity override.
--
-- A normal task continues to respect Q1/Q2 and Primary Work capacity limits.
-- A task explicitly marked capacity_override = true may exceed those limits.
-- The database calculates the marginal amount of capacity exceeded by that task
-- and stores it in overtime_minutes so the exception remains measurable.
--
-- Half Day (300m) still reserves all Q2 capacity.
-- Full Day (540m / 9h) still reserves all Q1 + Q2 capacity.
-- Overtime is the amount above normal configured capacity, not a new capacity target.

begin;

alter table public.tasks
  add column if not exists capacity_override boolean not null default false,
  add column if not exists overtime_minutes integer not null default 0,
  add column if not exists capacity_override_at timestamptz;

alter table public.tasks
  drop constraint if exists tasks_overtime_minutes_check;

alter table public.tasks
  add constraint tasks_overtime_minutes_check
  check (overtime_minutes between 0 and 720);

create index if not exists tasks_user_overtime_week_idx
  on public.tasks (user_id, week, capacity_override_at)
  where capacity_override = true and overtime_minutes > 0;

-- ---------------------------------------------------------------------------
-- Q1 / Q2 capacity, including Half Day and Full Day reservations.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_daily_quadrant_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_q1_limit integer := 240;
  v_q2_limit integer := 300;
  v_half_day_minutes constant integer := 300;
  v_full_day_minutes constant integer := 540;

  v_existing_q1 integer := 0;
  v_existing_q2 integer := 0;
  v_new_q1 integer := 0;
  v_new_q2 integer := 0;
  v_old_q1 integer := 0;
  v_old_q2 integer := 0;
  v_candidate_q1 integer := 0;
  v_candidate_q2 integer := 0;
  v_previous_q1 integer := 0;
  v_previous_q2 integer := 0;
  v_q1_overtime integer := 0;
  v_q2_overtime integer := 0;
  v_q_overtime integer := 0;
begin
  -- Full Backup v2 intentionally disables operational triggers while restoring
  -- historical state. Do not recalculate or normalize restored values there.
  if public.nmplanner_in_restore_mode() then return new; end if;

  -- This trigger runs before the Primary Work trigger. Start the calculated
  -- overtime contribution from the Q-capacity result; the Work trigger may raise
  -- it if the work-day/week limit is the tighter constraint.
  new.overtime_minutes := 0;

  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
    into v_q1_limit, v_q2_limit
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_q1_limit := 240;
    v_q2_limit := 300;
  end if;

  if new.day is null
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|quadrant-capacity',
      0
    )
  );

  select
    coalesce(sum(
      case
        when task.minutes = v_full_day_minutes then v_q1_limit
        when task.minutes = v_half_day_minutes then 0
        when task.quadrant = 'q1' then coalesce(task.minutes, 0)
        else 0
      end
    ), 0)::integer,
    coalesce(sum(
      case
        when task.minutes = v_full_day_minutes then v_q2_limit
        when task.minutes = v_half_day_minutes then v_q2_limit
        when task.quadrant = 'q2' then coalesce(task.minutes, 0)
        else 0
      end
    ), 0)::integer
  into v_existing_q1, v_existing_q2
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  if new.minutes = v_full_day_minutes then
    v_new_q1 := v_q1_limit;
    v_new_q2 := v_q2_limit;
  elsif new.minutes = v_half_day_minutes then
    v_new_q2 := v_q2_limit;
  elsif new.quadrant = 'q1' then
    v_new_q1 := coalesce(new.minutes, 0);
  elsif new.quadrant = 'q2' then
    v_new_q2 := coalesce(new.minutes, 0);
  end if;

  if tg_op = 'UPDATE'
     and old.user_id = new.user_id
     and old.week = new.week
     and old.day is not distinct from new.day
     and not coalesce(old.superseded_by_followup, false)
     and old.discarded_at is null then
    if old.minutes = v_full_day_minutes then
      v_old_q1 := v_q1_limit;
      v_old_q2 := v_q2_limit;
    elsif old.minutes = v_half_day_minutes then
      v_old_q2 := v_q2_limit;
    elsif old.quadrant = 'q1' then
      v_old_q1 := coalesce(old.minutes, 0);
    elsif old.quadrant = 'q2' then
      v_old_q2 := coalesce(old.minutes, 0);
    end if;
  end if;

  v_candidate_q1 := v_existing_q1 + v_new_q1;
  v_candidate_q2 := v_existing_q2 + v_new_q2;
  v_previous_q1 := v_existing_q1 + v_old_q1;
  v_previous_q2 := v_existing_q2 + v_old_q2;

  -- Attribute only the marginal excess caused by this row. If a day is already
  -- in overtime, a new override receives only the additional excess it creates.
  v_q1_overtime := greatest(0, v_candidate_q1 - v_q1_limit)
    - greatest(0, v_existing_q1 - v_q1_limit);
  v_q2_overtime := greatest(0, v_candidate_q2 - v_q2_limit)
    - greatest(0, v_existing_q2 - v_q2_limit);
  v_q_overtime := greatest(0, v_q1_overtime) + greatest(0, v_q2_overtime);

  if not coalesce(new.capacity_override, false) then
    if tg_op = 'UPDATE'
       and coalesce(old.capacity_override, false)
       and v_q_overtime > 0 then
      raise exception 'This task still exceeds normal Q1/Q2 capacity. Keep Urgent / Overtime enabled, or move/reduce the task.'
        using errcode = '23514';
    end if;

    if v_candidate_q1 > v_q1_limit and v_candidate_q1 > v_previous_q1 then
      raise exception 'Q1 daily capacity exceeded: this change would reserve % minutes, above your % minute limit. Mark the task Urgent / Overtime to override deliberately.',
        v_candidate_q1, v_q1_limit
        using errcode = '23514';
    end if;

    if v_candidate_q2 > v_q2_limit and v_candidate_q2 > v_previous_q2 then
      raise exception 'Q2 daily capacity exceeded: this change would reserve % minutes, above your % minute limit. Mark the task Urgent / Overtime to override deliberately.',
        v_candidate_q2, v_q2_limit
        using errcode = '23514';
    end if;
  else
    new.overtime_minutes := greatest(0, v_q_overtime);
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_daily_quadrant_capacity_trigger on public.tasks;
create trigger enforce_daily_quadrant_capacity_trigger
before insert or update of quadrant, day, week, area, minutes, user_id, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row execute function public.enforce_daily_quadrant_capacity();

-- ---------------------------------------------------------------------------
-- Primary Work capacity. Overtime may also deliberately exceed configured
-- daily/weekly work allocation, because otherwise a Q override could still be
-- rejected by the work-capacity rule.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_work_allocation_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new_week_total integer := 0;
  v_old_week_total integer := 0;
  v_existing_week_total integer := 0;
  v_new_day_total integer := 0;
  v_old_day_total integer := 0;
  v_existing_day_total integer := 0;
  v_new_is_work boolean := new.area in ('BCU / Teaching', 'Research');
  v_old_is_same_week_work boolean := false;
  v_old_is_same_day_work boolean := false;
  v_week_limit integer := 2220;
  v_day_limit integer := 600;
  v_work_name text := 'Primary Work';
  v_week_overtime integer := 0;
  v_day_overtime integer := 0;
  v_work_overtime integer := 0;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;

  if not v_new_is_work
     or new.day is null
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
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

  select coalesce(sum(task.minutes), 0)::integer
    into v_existing_week_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day is not null
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  v_new_week_total := v_existing_week_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_week_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day is not null
      and not coalesce(old.superseded_by_followup, false)
      and old.discarded_at is null;
  end if;

  v_old_week_total := v_existing_week_total
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;

  select coalesce(sum(task.minutes), 0)::integer
    into v_existing_day_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  v_new_day_total := v_existing_day_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_day_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day = new.day
      and not coalesce(old.superseded_by_followup, false)
      and old.discarded_at is null;
  end if;

  v_old_day_total := v_existing_day_total
    + case when v_old_is_same_day_work then coalesce(old.minutes, 0) else 0 end;

  v_week_overtime := greatest(0, v_new_week_total - v_week_limit)
    - greatest(0, v_existing_week_total - v_week_limit);
  v_day_overtime := greatest(0, v_new_day_total - v_day_limit)
    - greatest(0, v_existing_day_total - v_day_limit);
  v_work_overtime := greatest(greatest(0, v_week_overtime), greatest(0, v_day_overtime));

  if not coalesce(new.capacity_override, false) then
    if tg_op = 'UPDATE'
       and coalesce(old.capacity_override, false)
       and v_work_overtime > 0 then
      raise exception 'This task still exceeds normal Primary Work capacity. Keep Urgent / Overtime enabled, or move/reduce the task.'
        using errcode = '23514';
    end if;

    if v_new_week_total > v_week_limit and v_new_week_total > v_old_week_total then
      raise exception '% weekly capacity exceeded: primary work including Research would total % hours, above your % hour weekly limit. Mark the task Urgent / Overtime to override deliberately.',
        v_work_name, round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2)
        using errcode = '23514';
    end if;

    if v_new_day_total > v_day_limit and v_new_day_total > v_old_day_total then
      raise exception '% daily capacity exceeded: primary work including Research would total % hours on this day, above your % hour daily limit. Mark the task Urgent / Overtime to override deliberately.',
        v_work_name, round(v_new_day_total / 60.0, 2), round(v_day_limit / 60.0, 2)
        using errcode = '23514';
    end if;
  else
    new.overtime_minutes := greatest(coalesce(new.overtime_minutes, 0), v_work_overtime);
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_work_allocation_capacity_trigger on public.tasks;
create trigger enforce_work_allocation_capacity_trigger
before insert or update of user_id, week, day, area, minutes, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row execute function public.enforce_work_allocation_capacity();

-- Final normalization runs after the capacity triggers. A task is considered an
-- overtime task only when the database calculated a real excess above capacity.
create or replace function public.finalize_capacity_override()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.nmplanner_in_restore_mode() then return new; end if;

  if new.day is null
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null
     or not coalesce(new.capacity_override, false)
     or coalesce(new.overtime_minutes, 0) <= 0 then
    new.capacity_override := false;
    new.overtime_minutes := 0;
    new.capacity_override_at := null;
    return new;
  end if;

  if tg_op = 'INSERT'
     or not coalesce(old.capacity_override, false)
     or coalesce(old.overtime_minutes, 0) <= 0
     or old.capacity_override_at is null then
    new.capacity_override_at := clock_timestamp();
  else
    new.capacity_override_at := old.capacity_override_at;
  end if;

  return new;
end;
$$;

drop trigger if exists zz_finalize_capacity_override_trigger on public.tasks;
create trigger zz_finalize_capacity_override_trigger
before insert or update on public.tasks
for each row execute function public.finalize_capacity_override();

commit;
