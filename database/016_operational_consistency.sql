-- NM Planner operational consistency hardening.
--
-- This migration consolidates the task lifecycle introduced across migrations
-- 005-015 so every operational rule uses the same definition of current work.
--
-- Operational task = NOT superseded by a follow-up AND NOT discarded.
-- Completed operational tasks remain part of planned Q1/Q2/work capacity because
-- they were genuinely planned for that day. Superseded history and discarded work
-- never consume current capacity.
--
-- Follow-up history now keeps its original week/day/time metadata. A newer
-- follow-up makes the previous step historical via superseded_by_followup instead
-- of erasing its schedule. The obsolete ancestor-moving trigger is removed.
--
-- Discard is now a soft lifecycle state so discarding the terminal follow-up does
-- not accidentally reactivate its parent. task_reviews still stores the outcome.

begin;

-- ---------------------------------------------------------------------------
-- 1. Lifecycle metadata and clean defaults
-- ---------------------------------------------------------------------------

alter table public.tasks
  add column if not exists discarded_at timestamptz;

alter table public.tasks
  alter column area set default 'Personal Time';

update public.tasks
set area = 'Personal Time'
where area in ('Personal / Admin', 'Lunch');

-- Distinguish end-of-day outcomes from proactive/manual rescheduling so future
-- Insights can analyse them separately. Existing history is deliberately marked
-- legacy because its source cannot be inferred reliably.
alter table public.task_reviews
  add column if not exists review_source text;

update public.task_reviews
set review_source = 'legacy'
where review_source is null;

alter table public.task_reviews
  alter column review_source set default 'legacy',
  alter column review_source set not null;

alter table public.task_reviews
  drop constraint if exists task_reviews_review_source_check;

alter table public.task_reviews
  add constraint task_reviews_review_source_check
  check (review_source in ('legacy', 'end_of_day', 'planned_reschedule'));

create index if not exists tasks_user_operational_week_idx
  on public.tasks (user_id, week, day, quadrant)
  where superseded_by_followup = false and discarded_at is null;

create index if not exists tasks_user_discarded_idx
  on public.tasks (user_id, discarded_at)
  where discarded_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Remove the obsolete follow-up carry-forward model
-- ---------------------------------------------------------------------------

-- Migration 006 moved open ancestors into a descendant's future week and erased
-- their planned day. That conflicts with the later active-leaf/history model.
drop trigger if exists move_open_ancestors_with_future_followup_trigger on public.tasks;
drop function if exists public.move_open_ancestors_with_future_followup();

drop trigger if exists move_parent_with_future_followup_trigger on public.tasks;
drop function if exists public.move_parent_with_future_followup();

-- History rows may retain their original schedule. They are excluded explicitly
-- from operational calculations instead of being made unscheduled.
alter table public.tasks
  drop constraint if exists tasks_superseded_unscheduled_check;

-- Make follow-up rescheduling metadata deterministic now that parent dates remain
-- historical rather than being carried forward.
create or replace function public.prepare_followup_reschedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_week date;
begin
  if new.parent_task_id is null then
    new.followup_reason := null;
    new.rescheduled_from_week := null;
    new.rescheduled_to_week := null;
    return new;
  end if;

  if new.followup_reason is null then
    if tg_op = 'INSERT' then
      raise exception 'Choose a reason for this follow-up.' using errcode = '23514';
    elsif old.parent_task_id is null then
      raise exception 'Choose a reason for this follow-up.' using errcode = '23514';
    end if;
  end if;

  select week
    into parent_week
  from public.tasks
  where id = new.parent_task_id
    and user_id = new.user_id;

  if parent_week is null then
    raise exception 'The follow-up parent could not be found.';
  end if;

  if new.week > parent_week then
    new.rescheduled_from_week := parent_week;
    new.rescheduled_to_week := new.week;
  else
    new.rescheduled_from_week := null;
    new.rescheduled_to_week := null;
  end if;

  return new;
end;
$$;

-- A parent becomes history when a child is created/re-parented, but its original
-- week/day/rank/time remain intact for the task chain and future analysis.
create or replace function public.prepare_followup_parent_as_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.parent_task_id is not null then
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id) then
      update public.tasks
      set superseded_by_followup = true,
          completed = false
      where id = new.parent_task_id
        and user_id = new.user_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists a_prepare_followup_parent_trigger on public.tasks;
create trigger a_prepare_followup_parent_trigger
before insert or update of parent_task_id on public.tasks
for each row execute function public.prepare_followup_parent_as_history();

create or replace function public.refresh_followup_parent_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_id uuid;
  v_user_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.parent_task_id is not null then
    v_parent_id := old.parent_task_id;
    v_user_id := old.user_id;

    update public.tasks parent
    set superseded_by_followup = exists (
      select 1
      from public.tasks child
      where child.parent_task_id = parent.id
        and child.user_id = parent.user_id
    )
    where parent.id = v_parent_id
      and parent.user_id = v_user_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.parent_task_id is not null then
    update public.tasks parent
    set superseded_by_followup = true
    where parent.id = new.parent_task_id
      and parent.user_id = new.user_id;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists z_refresh_followup_parent_state_trigger on public.tasks;
create trigger z_refresh_followup_parent_state_trigger
after insert or update of parent_task_id or delete on public.tasks
for each row execute function public.refresh_followup_parent_state();

-- ---------------------------------------------------------------------------
-- 3. One canonical Q1/Q2 capacity rule
-- ---------------------------------------------------------------------------

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
  if new.day is null
     or new.quadrant not in ('q1', 'q2')
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
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

  select coalesce(sum(task.minutes), 0)::integer
    into existing_minutes
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.quadrant = new.quadrant
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  candidate_minutes := existing_minutes + coalesce(new.minutes, 0);

  if candidate_minutes > capacity_minutes then
    -- Legacy/over-capacity rows may still be edited when the edit does not add
    -- more workload to the same capacity bucket.
    if tg_op = 'UPDATE'
       and old.quadrant = new.quadrant
       and old.week = new.week
       and old.day is not distinct from new.day
       and not coalesce(old.superseded_by_followup, false)
       and old.discarded_at is null
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

drop trigger if exists enforce_daily_quadrant_capacity_trigger on public.tasks;
create trigger enforce_daily_quadrant_capacity_trigger
before insert or update of quadrant, day, week, minutes, user_id, superseded_by_followup, discarded_at on public.tasks
for each row execute function public.enforce_daily_quadrant_capacity();

-- ---------------------------------------------------------------------------
-- 4. One canonical primary-work capacity rule
-- ---------------------------------------------------------------------------

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
    into v_new_week_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day is not null
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  v_new_week_total := v_new_week_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_week_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day is not null
      and not coalesce(old.superseded_by_followup, false)
      and old.discarded_at is null;
  end if;

  v_old_week_total := v_new_week_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;

  if v_new_week_total > v_week_limit and v_new_week_total > v_old_week_total then
    raise exception '% weekly capacity exceeded: primary work including Research would total % hours, above your % hour weekly limit.',
      v_work_name, round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2)
      using errcode = '23514';
  end if;

  select coalesce(sum(task.minutes), 0)::integer
    into v_new_day_total
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research')
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  v_new_day_total := v_new_day_total + coalesce(new.minutes, 0);

  if tg_op = 'UPDATE' then
    v_old_is_same_day_work :=
      old.area in ('BCU / Teaching', 'Research')
      and old.week = new.week
      and old.day = new.day
      and not coalesce(old.superseded_by_followup, false)
      and old.discarded_at is null;
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

drop trigger if exists enforce_work_allocation_capacity_trigger on public.tasks;
create trigger enforce_work_allocation_capacity_trigger
before insert or update of user_id, week, day, area, minutes, superseded_by_followup, discarded_at on public.tasks
for each row execute function public.enforce_work_allocation_capacity();

-- ---------------------------------------------------------------------------
-- 5. Timeline occupancy uses operational/open tasks only
-- ---------------------------------------------------------------------------

create or replace function public.enforce_task_timeline_slot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conflict_title text;
begin
  -- Completed tasks keep their historical time but release the slot. Follow-up
  -- history and discarded tasks also never reserve a current calendar slot.
  if new.planned_start_minute is null
     or new.completed
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
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
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null
    and task.planned_start_minute is not null
    and task.id is distinct from new.id
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
before insert or update of user_id, week, day, planned_start_minute, minutes, completed, superseded_by_followup, discarded_at on public.tasks
for each row execute function public.enforce_task_timeline_slot();

-- ---------------------------------------------------------------------------
-- 6. Harden planned/timed rescheduling and record its source
-- ---------------------------------------------------------------------------

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
  if v_user_id is null then raise exception 'You must be signed in.'; end if;
  if p_reason not in (
    'waiting_external', 'priority_shift', 'capacity', 'personal_delay',
    'underestimated', 'scope_change', 'planned_continuation', 'other'
  ) then raise exception 'Choose a valid rescheduling reason.'; end if;
  if p_target_date is null then raise exception 'Choose the new planned date.'; end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = v_user_id
  for update;

  if not found then raise exception 'Task could not be found.'; end if;
  if v_task.completed then raise exception 'Completed tasks cannot be rescheduled.'; end if;
  if coalesce(v_task.superseded_by_followup, false) then raise exception 'Historical follow-up steps cannot be rescheduled.'; end if;
  if v_task.discarded_at is not null then raise exception 'Discarded tasks cannot be rescheduled.'; end if;
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
    user_id, task_id, task_snapshot, action, reason, from_date, to_date, review_source
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date, 'planned_reschedule'
  );

  return jsonb_build_object(
    'action', 'moved', 'task_id', v_task.id,
    'from_date', v_from_date, 'to_date', p_target_date,
    'source', 'planned_reschedule'
  );
end;
$$;

revoke all on function public.reschedule_planned_task(uuid, text, date) from public;
grant execute on function public.reschedule_planned_task(uuid, text, date) to authenticated;

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
  if v_user_id is null then raise exception 'You must be signed in.'; end if;
  if p_reason not in (
    'waiting_external', 'priority_shift', 'capacity', 'personal_delay',
    'underestimated', 'scope_change', 'planned_continuation', 'other'
  ) then raise exception 'Choose a valid rescheduling reason.'; end if;
  if p_target_date is null then raise exception 'Choose the new planned date.'; end if;
  if p_start_minute is null
     or p_start_minute < 240
     or p_start_minute > 1305
     or mod(p_start_minute, 15) <> 0 then
    raise exception 'Choose a 15-minute start time between 04:00 and 21:45.';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = v_user_id
  for update;

  if not found then raise exception 'Task could not be found.'; end if;
  if v_task.completed then raise exception 'Completed tasks cannot be rescheduled.'; end if;
  if coalesce(v_task.superseded_by_followup, false) then raise exception 'Historical follow-up steps cannot be rescheduled.'; end if;
  if v_task.discarded_at is not null then raise exception 'Discarded tasks cannot be rescheduled.'; end if;
  if v_task.day is null then raise exception 'Only tasks assigned to a day can be rescheduled.'; end if;

  v_from_date := v_task.week + v_task.day;
  if p_target_date = v_from_date then raise exception 'Use the same-day timeline move for changes within one day.'; end if;
  if p_target_date < current_date then raise exception 'A task cannot be rescheduled into a past date.'; end if;
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
  where id = v_task.id and user_id = v_user_id;

  insert into public.task_reviews (
    user_id, task_id, task_snapshot, action, reason, from_date, to_date, review_source
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date, 'planned_reschedule'
  );

  return jsonb_build_object(
    'action', 'moved', 'task_id', v_task.id,
    'from_date', v_from_date, 'to_date', p_target_date,
    'planned_start_minute', p_start_minute,
    'source', 'planned_reschedule'
  );
end;
$$;

revoke all on function public.reschedule_timed_task(uuid, text, date, integer) from public;
grant execute on function public.reschedule_timed_task(uuid, text, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. End-of-day review: forward-only moves and soft discard
-- ---------------------------------------------------------------------------

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
  ) then raise exception 'Choose a valid review reason.'; end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and user_id = v_user_id
  for update;

  if not found then raise exception 'Task could not be found.'; end if;
  if v_task.completed then raise exception 'This task is already completed.'; end if;
  if coalesce(v_task.superseded_by_followup, false) then raise exception 'Historical follow-up steps do not require end-of-day review.'; end if;
  if v_task.discarded_at is not null then raise exception 'This task has already been discarded.'; end if;
  if v_task.day is null then raise exception 'Only tasks assigned to a day can be reviewed.'; end if;

  v_from_date := v_task.week + v_task.day;

  if p_action = 'moved' then
    if p_target_date is null then raise exception 'Choose the new planned date.'; end if;
    -- The database keeps this timezone-neutral: the new date must be later than
    -- the task's old date and cannot be in the past. The browser enforces the
    -- stricter 18:00 local rule (tomorrow or later) for the end-of-day dialog.
    if p_target_date <= v_from_date then
      raise exception 'Move the task to a later date than its current planned date.';
    end if;
    if p_target_date < current_date then
      raise exception 'A task cannot be moved into a past date.';
    end if;

    v_to_day := extract(isodow from p_target_date)::integer - 1;
    v_to_week := p_target_date - v_to_day;

    update public.tasks
    set week = v_to_week,
        day = v_to_day,
        day_rank = null,
        planned_start_minute = null
    where id = v_task.id and user_id = v_user_id;

    insert into public.task_reviews (
      user_id, task_id, task_snapshot, action, reason, from_date, to_date, review_source
    ) values (
      v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date, 'end_of_day'
    );

    return jsonb_build_object(
      'action', 'moved', 'task_id', v_task.id,
      'from_date', v_from_date, 'to_date', p_target_date,
      'source', 'end_of_day'
    );
  end if;

  insert into public.task_reviews (
    user_id, task_id, task_snapshot, action, reason, from_date, to_date, review_source
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'discarded', p_reason, v_from_date, null, 'end_of_day'
  );

  update public.tasks
  set discarded_at = now(),
      day_rank = null
  where id = v_task.id
    and user_id = v_user_id;

  return jsonb_build_object(
    'action', 'discarded', 'task_id', v_task.id,
    'from_date', v_from_date, 'source', 'end_of_day'
  );
end;
$$;

revoke all on function public.review_unfinished_task(uuid, text, text, date) from public;
grant execute on function public.review_unfinished_task(uuid, text, text, date) to authenticated;

commit;
