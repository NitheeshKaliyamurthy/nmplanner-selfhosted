-- Replace the original two-Q1-tasks-per-day rule with time-based daily capacity.
-- This migration is non-destructive: it does not delete, rewrite, or recreate task rows.
-- Q1: warning is handled in the UI after 180 minutes; hard maximum 240 minutes/day.
-- Q2: warning is handled in the UI after 240 minutes; hard maximum 300 minutes/day.
-- Q3 and Q4 have no daily capacity limit.

-- Remove only the old rule/trigger. Existing tasks remain untouched.
drop trigger if exists enforce_q1_daily_limit_trigger on public.tasks;
drop function if exists public.enforce_q1_daily_limit();

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
begin
  -- Unscheduled work and Q3/Q4 are intentionally unrestricted.
  if new.day is null or new.quadrant not in ('q1', 'q2') then
    return new;
  end if;

  if new.quadrant = 'q1' then
    capacity_minutes := 240;
    quadrant_label := 'Q1';
  else
    capacity_minutes := 300;
    quadrant_label := 'Q2';
  end if;

  -- Serialise competing writes into the same user/week/day/quadrant bucket.
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
    -- Preserve legacy data safely: if an existing day is already above the new
    -- capacity, edits that do not increase or move that workload are still allowed.
    if tg_op = 'UPDATE'
       and old.quadrant = new.quadrant
       and old.week = new.week
       and old.day is not distinct from new.day
       and new.minutes <= old.minutes then
      return new;
    end if;

    raise exception '% daily capacity exceeded: this change would schedule % minutes, above the % minute limit.',
      quadrant_label, candidate_minutes, capacity_minutes
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_daily_quadrant_capacity_trigger on public.tasks;
create trigger enforce_daily_quadrant_capacity_trigger
before insert or update of quadrant, day, week, minutes, user_id on public.tasks
for each row execute function public.enforce_daily_quadrant_capacity();
