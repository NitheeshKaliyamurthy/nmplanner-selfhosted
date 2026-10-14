-- NM Planner: intraday 15-minute timeline support.
--
-- Adds an optional planned start time to dated tasks for the Day Plan calendar.
-- The timeline runs from 04:00 to 22:00 and snaps to 15-minute boundaries.
-- Moving only the time within the same day does not create a rescheduling review.
-- Moving to another day still requires a reason and is recorded in task_reviews.

begin;

alter table public.tasks
  add column if not exists planned_start_minute smallint;

alter table public.tasks
  drop constraint if exists tasks_planned_start_minute_check;

alter table public.tasks
  add constraint tasks_planned_start_minute_check
  check (
    planned_start_minute is null
    or (
      planned_start_minute between 240 and 1305
      and mod(planned_start_minute, 15) = 0
    )
  );

create index if not exists tasks_user_week_day_start_idx
  on public.tasks (user_id, week, day, planned_start_minute)
  where planned_start_minute is not null;

-- Keep timed tasks inside the visible 04:00-22:00 board and prevent accidental
-- overlaps. Untimed tasks remain unrestricted and continue to appear in the day list.
create or replace function public.enforce_task_timeline_slot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conflict_title text;
begin
  if new.planned_start_minute is null then
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

drop trigger if exists enforce_task_timeline_slot_trigger on public.tasks;
create trigger enforce_task_timeline_slot_trigger
before insert or update of user_id, week, day, planned_start_minute, minutes on public.tasks
for each row execute function public.enforce_task_timeline_slot();

-- Cross-day drag directly onto a timeline slot. The move and new time are one
-- transaction, and the reason is recorded exactly once in task_reviews.
create or replace function public.reschedule_timed_task(
  p_task_id uuid,
  p_reason text,
  p_target_date date,
  p_start_minute integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_from_date date;
  v_to_week date;
  v_to_day integer;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if p_reason not in (
    'waiting_external',
    'priority_shift',
    'capacity',
    'personal_delay',
    'underestimated',
    'scope_change',
    'planned_continuation',
    'other'
  ) then
    raise exception 'Choose a valid rescheduling reason.';
  end if;

  if p_target_date is null then
    raise exception 'Choose the new planned date.';
  end if;

  if p_start_minute is null
     or p_start_minute < 240
     or p_start_minute > 1305
     or mod(p_start_minute, 15) <> 0 then
    raise exception 'Choose a 15-minute start time between 04:00 and 21:45.';
  end if;

  select *
    into v_task
  from public.tasks
  where id = p_task_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Task could not be found.';
  end if;

  if v_task.completed then
    raise exception 'Completed tasks cannot be rescheduled.';
  end if;

  if v_task.day is null then
    raise exception 'Only tasks assigned to a day can be rescheduled.';
  end if;

  v_from_date := v_task.week + v_task.day;

  if p_target_date = v_from_date then
    raise exception 'Use the same-day timeline move for changes within one day.';
  end if;

  if p_target_date < current_date then
    raise exception 'A task cannot be rescheduled into a past date.';
  end if;

  if p_start_minute + v_task.minutes > 1320 then
    raise exception 'This task would finish after 22:00. Choose an earlier start time.';
  end if;

  v_to_day := extract(isodow from p_target_date)::integer - 1;
  v_to_week := p_target_date - v_to_day;

  update public.tasks
  set week = v_to_week,
      day = v_to_day,
      day_rank = null,
      planned_start_minute = p_start_minute
  where id = v_task.id
    and user_id = v_user_id;

  insert into public.task_reviews (
    user_id,
    task_id,
    task_snapshot,
    action,
    reason,
    from_date,
    to_date
  ) values (
    v_user_id,
    v_task.id,
    to_jsonb(v_task),
    'moved',
    p_reason,
    v_from_date,
    p_target_date
  );

  return jsonb_build_object(
    'action', 'moved',
    'task_id', v_task.id,
    'from_date', v_from_date,
    'to_date', p_target_date,
    'planned_start_minute', p_start_minute
  );
end;
$$;

revoke all on function public.reschedule_timed_task(uuid, text, date, integer) from public;
grant execute on function public.reschedule_timed_task(uuid, text, date, integer) to authenticated;

-- Existing drag-to-day behaviour now clears an old intraday time when no new
-- time was selected on the destination day.
create or replace function public.reschedule_planned_task(
  p_task_id uuid,
  p_reason text,
  p_target_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_from_date date;
  v_to_week date;
  v_to_day integer;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if p_reason not in (
    'waiting_external', 'priority_shift', 'capacity', 'personal_delay',
    'underestimated', 'scope_change', 'planned_continuation', 'other'
  ) then
    raise exception 'Choose a valid rescheduling reason.';
  end if;

  if p_target_date is null then
    raise exception 'Choose the new planned date.';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = v_user_id
  for update;

  if not found then raise exception 'Task could not be found.'; end if;
  if v_task.completed then raise exception 'Completed tasks cannot be rescheduled.'; end if;
  if v_task.day is null then raise exception 'Only tasks assigned to a day can be rescheduled.'; end if;

  v_from_date := v_task.week + v_task.day;
  if p_target_date = v_from_date then raise exception 'Choose a different planned date.'; end if;
  if p_target_date < current_date then raise exception 'A task cannot be rescheduled into a past date.'; end if;

  v_to_day := extract(isodow from p_target_date)::integer - 1;
  v_to_week := p_target_date - v_to_day;

  update public.tasks
  set week = v_to_week,
      day = v_to_day,
      day_rank = null,
      planned_start_minute = null
  where id = v_task.id and user_id = v_user_id;

  insert into public.task_reviews (
    user_id, task_id, task_snapshot, action, reason, from_date, to_date
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date
  );

  return jsonb_build_object(
    'action', 'moved', 'task_id', v_task.id,
    'from_date', v_from_date, 'to_date', p_target_date
  );
end;
$$;

revoke all on function public.reschedule_planned_task(uuid, text, date) from public;
grant execute on function public.reschedule_planned_task(uuid, text, date) to authenticated;

-- End-of-day review moves also start untimed on the destination day.
create or replace function public.review_unfinished_task(
  p_task_id uuid,
  p_action text,
  p_reason text,
  p_target_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_from_date date;
  v_to_week date;
  v_to_day integer;
begin
  if v_user_id is null then raise exception 'You must be signed in.'; end if;
  if p_action not in ('moved', 'discarded') then raise exception 'Choose Move or Discard.'; end if;
  if p_reason not in (
    'waiting_external', 'priority_shift', 'capacity', 'personal_delay',
    'underestimated', 'scope_change', 'planned_continuation', 'other'
  ) then
    raise exception 'Choose a valid review reason.';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = v_user_id
  for update;

  if not found then raise exception 'Task could not be found.'; end if;
  if v_task.completed then raise exception 'This task is already completed.'; end if;
  if v_task.day is null then raise exception 'Only tasks assigned to a day can be reviewed.'; end if;

  v_from_date := v_task.week + v_task.day;

  if p_action = 'moved' then
    if p_target_date is null then raise exception 'Choose the new planned date.'; end if;
    if p_target_date <= v_from_date then raise exception 'Move the task to a later date than its current planned date.'; end if;

    v_to_day := extract(isodow from p_target_date)::integer - 1;
    v_to_week := p_target_date - v_to_day;

    update public.tasks
    set week = v_to_week,
        day = v_to_day,
        day_rank = null,
        planned_start_minute = null
    where id = v_task.id and user_id = v_user_id;

    insert into public.task_reviews (
      user_id, task_id, task_snapshot, action, reason, from_date, to_date
    ) values (
      v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date
    );

    return jsonb_build_object(
      'action', 'moved', 'task_id', v_task.id,
      'from_date', v_from_date, 'to_date', p_target_date
    );
  end if;

  insert into public.task_reviews (
    user_id, task_id, task_snapshot, action, reason, from_date, to_date
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'discarded', p_reason, v_from_date, null
  );

  delete from public.tasks
  where id = v_task.id and user_id = v_user_id;

  return jsonb_build_object(
    'action', 'discarded', 'task_id', v_task.id, 'from_date', v_from_date
  );
end;
$$;

revoke all on function public.review_unfinished_task(uuid, text, text, date) from public;
grant execute on function public.review_unfinished_task(uuid, text, text, date) to authenticated;

commit;
