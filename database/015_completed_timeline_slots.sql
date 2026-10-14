-- NM Planner: completed tasks release their intraday calendar slot.
--
-- A completed task keeps its historical planned_start_minute for analytics,
-- but it must not block new active work from using the same time.
-- Reopening a completed task re-runs the overlap check, so an occupied old
-- slot cannot silently create a double-booking.

begin;

create or replace function public.enforce_task_timeline_slot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conflict_title text;
begin
  -- Untimed tasks and completed tasks do not reserve calendar capacity.
  -- The planned time remains stored on completed rows for historical analysis.
  if new.planned_start_minute is null or new.completed then
    return new;
  end if;

  if new.day is null then
    raise exception 'Assign the task to a day before giving it a start time.'
      using errcode = '23514';
  end if;

  if new.planned_start_minute < 240
     or new.planned_start_minute > 1305
     or mod(new.planned_start_minute, 15) <> 0 then
    raise exception 'Start time must be a 15-minute slot between 04:00 and 21:45.'
      using errcode = '23514';
  end if;

  if new.planned_start_minute + coalesce(new.minutes, 0) > 1320 then
    raise exception 'This task would finish after 22:00. Choose an earlier start time.'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|timeline', 0)
  );

  select task.title
    into v_conflict_title
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.completed = false
    and task.planned_start_minute is not null
    and task.id <> new.id
    and new.planned_start_minute < task.planned_start_minute + task.minutes
    and task.planned_start_minute < new.planned_start_minute + new.minutes
  order by task.planned_start_minute
  limit 1;

  if found then
    raise exception 'This time overlaps with "%". Choose another 15-minute slot.', v_conflict_title
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Include completed in the trigger columns so reopening a task validates its
-- retained historical time against whatever active work now occupies that slot.
drop trigger if exists enforce_task_timeline_slot_trigger on public.tasks;
create trigger enforce_task_timeline_slot_trigger
before insert or update of user_id, week, day, planned_start_minute, minutes, completed on public.tasks
for each row execute function public.enforce_task_timeline_slot();

commit;
