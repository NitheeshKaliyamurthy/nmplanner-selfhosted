-- NM Planner self-hosted fresh-install bundle
-- Generated from database migrations 001 through 035.
--
-- Run this file ONCE on a BRAND-NEW Supabase project.
-- Existing installations should apply only migrations newer than their current
-- schema level. Do not use this bundle as an upgrade script.
--


-- ============================================================================
-- 001_initial.sql
-- ============================================================================

-- NM Planner initial Supabase schema.
-- This is the reproducible copy of the migration applied during setup.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  week date not null check (extract(isodow from week) = 1),
  quadrant text check (quadrant is null or quadrant in ('q1', 'q2', 'q3', 'q4')),
  day smallint check (day is null or day between 0 and 6),
  area text not null default 'Personal / Admin' check (char_length(area) <= 80),
  due date,
  minutes smallint not null default 60 check (minutes between 5 and 720),
  notes text not null default '' check (char_length(notes) <= 4000),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  event_type text not null check (event_type in ('created', 'updated', 'deleted')),
  old_data jsonb,
  new_data jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists tasks_user_week_idx on public.tasks (user_id, week);
create index if not exists tasks_user_week_quadrant_day_idx on public.tasks (user_id, week, quadrant, day);
create index if not exists task_events_user_date_idx on public.task_events (user_id, occurred_at desc);
create index if not exists task_events_task_idx on public.task_events (task_id);

create or replace function public.set_task_timestamps()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.completed and new.completed_at is null then new.completed_at := now(); end if;
  elsif tg_op = 'UPDATE' then
    if new.completed and not old.completed then new.completed_at := now();
    elsif not new.completed then new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists set_task_timestamps_trigger on public.tasks;
create trigger set_task_timestamps_trigger before insert or update on public.tasks
for each row execute function public.set_task_timestamps();

create or replace function public.enforce_q1_daily_limit()
returns trigger language plpgsql set search_path = public as $$
declare existing_q1_count integer;
begin
  if new.quadrant = 'q1' and new.day is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text, 0));
    select count(*) into existing_q1_count from public.tasks
    where user_id = new.user_id and week = new.week and day = new.day
      and quadrant = 'q1' and id <> new.id;
    if existing_q1_count >= 2 then
      raise exception 'This day already contains two Urgent and Important tasks.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_q1_daily_limit_trigger on public.tasks;
create trigger enforce_q1_daily_limit_trigger before insert or update on public.tasks
for each row execute function public.enforce_q1_daily_limit();

create or replace function public.record_task_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.task_events (user_id, task_id, event_type, new_data)
    values (new.user_id, new.id, 'created', to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.task_events (user_id, task_id, event_type, old_data, new_data)
    values (new.user_id, new.id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, old.id, 'deleted', to_jsonb(old));
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists record_task_event_trigger on public.tasks;
create trigger record_task_event_trigger after insert or update or delete on public.tasks
for each row execute function public.record_task_event();

alter table public.tasks enable row level security;
alter table public.task_events enable row level security;

drop policy if exists "Users can read their own tasks" on public.tasks;
create policy "Users can read their own tasks" on public.tasks for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own tasks" on public.tasks;
create policy "Users can create their own tasks" on public.tasks for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own tasks" on public.tasks;
create policy "Users can update their own tasks" on public.tasks for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own tasks" on public.tasks;
create policy "Users can delete their own tasks" on public.tasks for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own task history" on public.task_events;
create policy "Users can read their own task history" on public.task_events for select to authenticated
using ((select auth.uid()) = user_id);


-- ============================================================================
-- 002_task_followups.sql
-- ============================================================================

-- NM Planner follow-up task hierarchy.
-- Run this migration once in the Supabase SQL Editor after deployment.

alter table public.tasks
  add column if not exists parent_task_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_parent_task_id_fkey'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_parent_task_id_fkey
      foreign key (parent_task_id)
      references public.tasks(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists tasks_user_parent_idx
  on public.tasks (user_id, parent_task_id);

create or replace function public.enforce_task_parent_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  creates_cycle boolean;
begin
  if new.parent_task_id is null then
    return new;
  end if;

  if new.parent_task_id = new.id then
    raise exception 'A task cannot be its own follow-up parent.';
  end if;

  if not exists (
    select 1
    from public.tasks parent
    where parent.id = new.parent_task_id
      and parent.user_id = new.user_id
  ) then
    raise exception 'The follow-up parent must belong to the same user.';
  end if;

  with recursive ancestor_ids(id) as (
    select new.parent_task_id
    union
    select task.parent_task_id
    from public.tasks task
    join ancestor_ids ancestor on task.id = ancestor.id
    where task.user_id = new.user_id
      and task.parent_task_id is not null
  )
  select exists (
    select 1 from ancestor_ids where id = new.id
  ) into creates_cycle;

  if creates_cycle then
    raise exception 'A follow-up relationship cannot contain a cycle.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_task_parent_integrity_trigger on public.tasks;
create trigger enforce_task_parent_integrity_trigger
before insert or update of parent_task_id, user_id on public.tasks
for each row execute function public.enforce_task_parent_integrity();


-- ============================================================================
-- 003_daily_quadrant_capacity.sql
-- ============================================================================

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


-- ============================================================================
-- 004_task_analytics.sql
-- ============================================================================

-- NM Planner productivity analytics support.
-- Non-destructive migration: existing task rows and history remain unchanged.
-- actual_minutes is optional, so all historical tasks continue to work without backfilling.

alter table public.tasks
  add column if not exists actual_minutes integer;

-- Keep the value realistic while allowing long tasks when genuinely required.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_actual_minutes_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_actual_minutes_check
      check (actual_minutes is null or actual_minutes between 0 and 2880);
  end if;
end;
$$;

create index if not exists tasks_user_created_idx
  on public.tasks (user_id, created_at desc);

create index if not exists tasks_user_completed_idx
  on public.tasks (user_id, completed_at desc)
  where completed_at is not null;


-- ============================================================================
-- 005_followup_rescheduling.sql
-- ============================================================================

-- NM Planner follow-up reasons and future-week continuation.
-- Non-destructive migration: no existing task rows are deleted or rewritten.
-- Existing follow-ups may keep a null reason until they are deliberately edited.

alter table public.tasks
  add column if not exists followup_reason text,
  add column if not exists rescheduled_from_week date,
  add column if not exists rescheduled_to_week date;

-- Validate recognised reason values while allowing historical follow-ups that
-- pre-date this feature to keep a null reason. The app requires a reason for
-- every new follow-up.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_followup_reason_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_followup_reason_check
      check (
        followup_reason is null
        or followup_reason in (
          'waiting_external',
          'priority_shift',
          'capacity',
          'personal_delay',
          'underestimated',
          'scope_change',
          'planned_continuation',
          'other'
        )
      ) not valid;
  end if;
end;
$$;

create index if not exists tasks_user_followup_reason_idx
  on public.tasks (user_id, followup_reason)
  where parent_task_id is not null;

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

  -- Require a reason for newly created follow-ups (or a task newly converted
  -- into a follow-up), without breaking legacy follow-ups that already exist.
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

  -- Record the carry-forward only when the follow-up moves work into a later week.
  if new.week > parent_week then
    new.rescheduled_from_week := parent_week;
    new.rescheduled_to_week := new.week;
  elsif tg_op = 'INSERT' then
    new.rescheduled_from_week := null;
    new.rescheduled_to_week := null;
  end if;

  return new;
end;
$$;

drop trigger if exists prepare_followup_reschedule_trigger on public.tasks;
create trigger prepare_followup_reschedule_trigger
before insert or update of parent_task_id, followup_reason, week, user_id on public.tasks
for each row execute function public.prepare_followup_reschedule();

create or replace function public.move_parent_with_future_followup()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_week date;
  parent_completed boolean;
begin
  if new.parent_task_id is null then
    return new;
  end if;

  select week, completed
    into parent_week, parent_completed
  from public.tasks
  where id = new.parent_task_id
    and user_id = new.user_id;

  -- A completed parent remains historical. Open work moves forward to the
  -- future follow-up week and planned day. If the parent is itself a follow-up,
  -- its own trigger update naturally carries the chain forward to the root.
  if not coalesce(parent_completed, false) and new.week > parent_week then
    update public.tasks
      set week = new.week,
          day = new.day
    where id = new.parent_task_id
      and user_id = new.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists move_parent_with_future_followup_trigger on public.tasks;
create trigger move_parent_with_future_followup_trigger
after insert or update of parent_task_id, week, day on public.tasks
for each row execute function public.move_parent_with_future_followup();


-- ============================================================================
-- 006_reconcile_followup_chains.sql
-- ============================================================================

-- NM Planner: reconcile existing follow-up chains and make future carry-forward robust.
-- Non-destructive: no tasks are deleted or completed.
--
-- Capacity-safe reconciliation:
-- The actionable descendant keeps its exact planned day. Open ancestor/parent tasks
-- move to the descendant's week but become unscheduled (day = null), so they do not
-- consume Q1/Q2 daily capacity a second time.
--
-- The Q1/Q2 capacity trigger is disabled only inside this one migration transaction
-- while historical rows are reconciled, then re-enabled before COMMIT. If anything
-- fails, PostgreSQL rolls the transaction back, including the trigger state.

begin;

-- Remove any older parent-mover implementations first so reconciliation itself
-- cannot invoke obsolete carry-forward behaviour.
drop trigger if exists move_parent_with_future_followup_trigger on public.tasks;
drop function if exists public.move_parent_with_future_followup();
drop trigger if exists move_open_ancestors_with_future_followup_trigger on public.tasks;

-- Future behaviour: when a follow-up is placed in a later week, move every open
-- ancestor into that week but leave the ancestors unscheduled. Only the actual
-- follow-up keeps the exact planned day.
create or replace function public.move_open_ancestors_with_future_followup()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.parent_task_id is null then
    return new;
  end if;

  if pg_trigger_depth() > 1 then
    return new;
  end if;

  with recursive ancestors as (
    select
      parent.id,
      parent.parent_task_id,
      parent.week,
      parent.completed
    from public.tasks parent
    where parent.id = new.parent_task_id
      and parent.user_id = new.user_id

    union all

    select
      parent.id,
      parent.parent_task_id,
      parent.week,
      parent.completed
    from public.tasks parent
    join ancestors ancestor
      on parent.id = ancestor.parent_task_id
    where parent.user_id = new.user_id
  )
  update public.tasks task
  set week = new.week,
      day = null
  from ancestors ancestor
  where task.id = ancestor.id
    and task.user_id = new.user_id
    and not coalesce(task.completed, false)
    and task.week < new.week;

  return new;
end;
$$;

-- Historical reconciliation is maintenance, not new scheduling. Temporarily
-- disable the Q1/Q2 capacity guard so legacy parent rows can be moved to a future
-- week as unscheduled containers without being interpreted as new daily workload.
alter table public.tasks disable trigger enforce_daily_quadrant_capacity_trigger;

-- Preserve carry-forward history for legacy follow-ups before moving parents.
update public.tasks child
set rescheduled_from_week = parent.week,
    rescheduled_to_week = child.week
from public.tasks parent
where child.parent_task_id = parent.id
  and child.user_id = parent.user_id
  and child.week > parent.week
  and child.rescheduled_from_week is null
  and child.rescheduled_to_week is null;

-- One-time reconciliation for follow-up chains that already existed.
-- For every open task, find its latest-dated descendant and move that open ancestor
-- into the descendant's week with day = null. Completed historical tasks never move.
with recursive descendants as (
  select
    parent.id as ancestor_id,
    child.id as descendant_id,
    child.week as descendant_week,
    1 as depth
  from public.tasks parent
  join public.tasks child
    on child.parent_task_id = parent.id
   and child.user_id = parent.user_id

  union all

  select
    descendant.ancestor_id,
    child.id,
    child.week,
    descendant.depth + 1
  from descendants descendant
  join public.tasks child
    on child.parent_task_id = descendant.descendant_id
),
latest_descendant as (
  select distinct on (ancestor_id)
    ancestor_id,
    descendant_week,
    depth
  from descendants
  order by ancestor_id, descendant_week desc, depth desc, descendant_id
)
update public.tasks task
set week = latest.descendant_week,
    day = null
from latest_descendant latest
where task.id = latest.ancestor_id
  and not coalesce(task.completed, false)
  and task.week < latest.descendant_week;

-- Restore normal planner protection before leaving the transaction.
alter table public.tasks enable trigger enforce_daily_quadrant_capacity_trigger;

-- Install the corrected future carry-forward trigger only after reconciliation.
create trigger move_open_ancestors_with_future_followup_trigger
after insert or update of parent_task_id, week, day on public.tasks
for each row execute function public.move_open_ancestors_with_future_followup();

commit;


-- ============================================================================
-- 007_day_ranking.sql
-- ============================================================================

-- NM Planner optional day execution ranking.
-- Non-destructive: existing tasks remain unchanged with day_rank = null.

alter table public.tasks
  add column if not exists day_rank integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_day_rank_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_day_rank_check
      check (day_rank is null or day_rank between 1 and 99);
  end if;
end;
$$;

create index if not exists tasks_user_week_day_rank_idx
  on public.tasks (user_id, week, day, day_rank)
  where day_rank is not null;


-- ============================================================================
-- 008_daily_review.sql
-- ============================================================================

-- NM Planner daily end-of-day review history and actions.
-- Records why unfinished tasks are moved or discarded without distorting
-- completion rates or Q1/Q2 capacity. Discarded tasks leave the active planner,
-- but their review snapshot remains available for analytics.

create table if not exists public.task_reviews (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  task_snapshot jsonb not null,
  action text not null check (action in ('moved', 'discarded')),
  reason text not null check (reason in (
    'waiting_external',
    'priority_shift',
    'capacity',
    'personal_delay',
    'underestimated',
    'scope_change',
    'planned_continuation',
    'other'
  )),
  from_date date not null,
  to_date date,
  occurred_at timestamptz not null default now(),
  check (
    (action = 'moved' and to_date is not null and to_date > from_date)
    or (action = 'discarded' and to_date is null)
  )
);

create index if not exists task_reviews_user_from_date_idx
  on public.task_reviews (user_id, from_date desc);

create index if not exists task_reviews_user_task_idx
  on public.task_reviews (user_id, task_id, occurred_at desc);

alter table public.task_reviews enable row level security;

drop policy if exists "Users can read their own task reviews" on public.task_reviews;
create policy "Users can read their own task reviews"
on public.task_reviews for select to authenticated
using ((select auth.uid()) = user_id);

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
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if p_action not in ('moved', 'discarded') then
    raise exception 'Choose Move or Discard.';
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
    raise exception 'Choose a valid review reason.';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Task could not be found.';
  end if;

  if v_task.completed then
    raise exception 'This task is already completed.';
  end if;

  if v_task.day is null then
    raise exception 'Only tasks assigned to a day can be reviewed.';
  end if;

  v_from_date := v_task.week + v_task.day;

  if p_action = 'moved' then
    if p_target_date is null then
      raise exception 'Choose the new planned date.';
    end if;

    if p_target_date <= v_from_date then
      raise exception 'Move the task to a later date than its current planned date.';
    end if;

    v_to_day := extract(isodow from p_target_date)::integer - 1;
    v_to_week := p_target_date - v_to_day;

    update public.tasks
    set week = v_to_week,
        day = v_to_day,
        day_rank = null
    where id = v_task.id
      and user_id = v_user_id;

    insert into public.task_reviews (
      user_id, task_id, task_snapshot, action, reason, from_date, to_date
    ) values (
      v_user_id, v_task.id, to_jsonb(v_task), 'moved', p_reason, v_from_date, p_target_date
    );

    return jsonb_build_object(
      'action', 'moved',
      'task_id', v_task.id,
      'from_date', v_from_date,
      'to_date', p_target_date
    );
  end if;

  insert into public.task_reviews (
    user_id, task_id, task_snapshot, action, reason, from_date, to_date
  ) values (
    v_user_id, v_task.id, to_jsonb(v_task), 'discarded', p_reason, v_from_date, null
  );

  delete from public.tasks
  where id = v_task.id
    and user_id = v_user_id;

  return jsonb_build_object(
    'action', 'discarded',
    'task_id', v_task.id,
    'from_date', v_from_date
  );
end;
$$;

revoke all on function public.review_unfinished_task(uuid, text, text, date) from public;
grant execute on function public.review_unfinished_task(uuid, text, text, date) to authenticated;


-- ============================================================================
-- 009_planned_rescheduling.sql
-- ============================================================================

-- NM Planner planned rescheduling support.
-- Allows deliberate drag-and-drop rescheduling to any different non-past date
-- while preserving the stricter forward-only rule used by end-of-day review.

begin;

-- Replace the original task_reviews date check so planned reschedules may move
-- either earlier or later, as long as the destination differs from the source.
do $$
declare
  constraint_name text;
begin
  select conname
    into constraint_name
  from pg_constraint
  where conrelid = 'public.task_reviews'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%action%'
    and pg_get_constraintdef(oid) ilike '%moved%'
    and pg_get_constraintdef(oid) ilike '%to_date%'
    and pg_get_constraintdef(oid) ilike '%from_date%'
  order by conname
  limit 1;

  if constraint_name is not null then
    execute format('alter table public.task_reviews drop constraint %I', constraint_name);
  end if;
end;
$$;

alter table public.task_reviews
  drop constraint if exists task_reviews_action_dates_check;

alter table public.task_reviews
  add constraint task_reviews_action_dates_check
  check (
    (action = 'moved' and to_date is not null and to_date <> from_date)
    or (action = 'discarded' and to_date is null)
  );

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
    raise exception 'Choose a different planned date.';
  end if;

  if p_target_date < current_date then
    raise exception 'A task cannot be rescheduled into a past date.';
  end if;

  v_to_day := extract(isodow from p_target_date)::integer - 1;
  v_to_week := p_target_date - v_to_day;

  update public.tasks
  set week = v_to_week,
      day = v_to_day,
      day_rank = null
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
    'to_date', p_target_date
  );
end;
$$;

revoke all on function public.reschedule_planned_task(uuid, text, date) from public;
grant execute on function public.reschedule_planned_task(uuid, text, date) to authenticated;

commit;


-- ============================================================================
-- 010_time_allocation_wellbeing.sql
-- ============================================================================

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


-- ============================================================================
-- 011_custom_planner_settings.sql
-- ============================================================================

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


-- ============================================================================
-- 012_configurable_work_labels.sql
-- ============================================================================

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



-- ============================================================================
-- 013_day_timeline.sql
-- ============================================================================

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


-- ============================================================================
-- 014_followup_active_leaf.sql
-- ============================================================================

-- NM Planner: follow-up chains behave as one evolving piece of work.
--
-- A task that has one or more follow-ups becomes a history node:
--   * it is unscheduled and no longer consumes capacity/time
--   * only terminal follow-up leaves remain actionable
--   * completing the final active follow-up closes its ancestors automatically
--   * if a family branches, an ancestor closes only when all of its direct
--     child branches are complete
--
-- The full task rows remain in the database for activity-chain analysis.

begin;

alter table public.tasks
  add column if not exists superseded_by_followup boolean not null default false;

-- Existing chains: every task with at least one child becomes history only.
update public.tasks parent
set superseded_by_followup = true,
    day = null,
    day_rank = null,
    planned_start_minute = null
where exists (
  select 1
  from public.tasks child
  where child.parent_task_id = parent.id
    and child.user_id = parent.user_id
);

update public.tasks candidate
set superseded_by_followup = false
where candidate.superseded_by_followup = true
  and not exists (
    select 1
    from public.tasks child
    where child.parent_task_id = candidate.id
      and child.user_id = candidate.user_id
  );

alter table public.tasks
  drop constraint if exists tasks_superseded_unscheduled_check;

alter table public.tasks
  add constraint tasks_superseded_unscheduled_check
  check (not superseded_by_followup or day is null);

create index if not exists tasks_user_superseded_idx
  on public.tasks (user_id, superseded_by_followup);

-- Run before the normal task-capacity/timeline triggers. This removes the
-- previous active step from the schedule before a new child is capacity-checked,
-- preventing parent + follow-up from being counted together even momentarily.
create or replace function public.prepare_followup_parent_as_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.parent_task_id is not null then
    if tg_op = 'INSERT' then
      update public.tasks
      set superseded_by_followup = true,
          completed = false,
          day = null,
          day_rank = null,
          planned_start_minute = null
      where id = new.parent_task_id
        and user_id = new.user_id;
    elsif tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id then
      update public.tasks
      set superseded_by_followup = true,
          completed = false,
          day = null,
          day_rank = null,
          planned_start_minute = null
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

-- Recalculate parent history flags if a child is re-parented or deleted.
create or replace function public.refresh_followup_parent_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_parent_id uuid;
  v_user_id uuid;
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    if old.parent_task_id is not null then
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
  end if;

  if tg_op = 'INSERT' or tg_op = 'UPDATE' then
    if new.parent_task_id is not null then
      v_parent_id := new.parent_task_id;
      v_user_id := new.user_id;

      update public.tasks parent
      set superseded_by_followup = true,
          day = null,
          day_rank = null,
          planned_start_minute = null
      where parent.id = v_parent_id
        and parent.user_id = v_user_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists z_refresh_followup_parent_state_trigger on public.tasks;
create trigger z_refresh_followup_parent_state_trigger
after insert or update of parent_task_id or delete on public.tasks
for each row execute function public.refresh_followup_parent_state();

-- Completion propagation. Direct client updates (main planner, follow-up tree,
-- end-of-day review) all pass through this trigger, so behaviour is consistent.
create or replace function public.propagate_followup_completion()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.parent_task_id is null then
    return new;
  end if;

  if new.completed then
    -- Close the parent only when every direct branch beneath it is complete.
    update public.tasks parent
    set completed = true
    where parent.id = new.parent_task_id
      and parent.user_id = new.user_id
      and parent.completed = false
      and not exists (
        select 1
        from public.tasks child
        where child.parent_task_id = parent.id
          and child.user_id = parent.user_id
          and child.completed = false
      );
  else
    -- Reopening any leaf reopens its ancestor chain.
    update public.tasks parent
    set completed = false
    where parent.id = new.parent_task_id
      and parent.user_id = new.user_id
      and parent.completed = true;
  end if;

  return new;
end;
$$;

drop trigger if exists propagate_followup_completion_trigger on public.tasks;
create trigger propagate_followup_completion_trigger
after insert or update of completed on public.tasks
for each row
when (new.parent_task_id is not null)
execute function public.propagate_followup_completion();

-- Reconcile completion for existing chains from the leaves upward.
-- Repeating the pass is safe and closes ancestors when all child branches are done.
do $$
declare
  changed_rows integer := 1;
begin
  while changed_rows > 0 loop
    update public.tasks parent
    set completed = true
    where parent.superseded_by_followup = true
      and parent.completed = false
      and exists (
        select 1 from public.tasks child
        where child.parent_task_id = parent.id
          and child.user_id = parent.user_id
      )
      and not exists (
        select 1 from public.tasks child
        where child.parent_task_id = parent.id
          and child.user_id = parent.user_id
          and child.completed = false
      );
    get diagnostics changed_rows = row_count;
  end loop;
end;
$$;

commit;


-- ============================================================================
-- 015_completed_timeline_slots.sql
-- ============================================================================

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


-- ============================================================================
-- 016_operational_consistency.sql
-- ============================================================================

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


-- ============================================================================
-- 017_restore_legacy_followup_history.sql
-- ============================================================================

-- NM Planner: evidence-based repair of legacy follow-up history metadata.
--
-- Run AFTER database/016_operational_consistency.sql.
--
-- Why this exists:
-- Older follow-up migrations moved parent/history rows into later weeks and then
-- cleared day/planned_start_minute so they would stop consuming capacity. The
-- current operational model no longer needs that destructive workaround:
-- superseded_by_followup=true explicitly excludes history from current capacity.
--
-- Recovery rule:
--   * only superseded history rows whose day is currently NULL are repaired;
--   * week + day are restored from the latest task_events state that proves a day;
--   * planned_start_minute is restored only when task_events proves a prior time;
--   * rows with no historical time evidence remain NULL (this is valid);
--   * follow-up reason/carry-forward metadata is not rewritten.
--
-- The repair is idempotent: after the missing days are restored there are no
-- candidates on a subsequent run.

begin;

-- Restoring a historical week should not make the older follow-up-reschedule
-- trigger reinterpret or rewrite rescheduled_from_week/rescheduled_to_week.
alter table public.tasks disable trigger prepare_followup_reschedule_trigger;

with legacy as (
  select t.id
  from public.tasks t
  where coalesce(t.superseded_by_followup, false)
    and t.day is null
),
all_states as (
  select
    e.task_id,
    e.occurred_at,
    e.old_data as state_json,
    'old_data'::text as state_source
  from public.task_events e
  join legacy l on l.id = e.task_id
  where e.old_data is not null

  union all

  select
    e.task_id,
    e.occurred_at,
    e.new_data as state_json,
    'new_data'::text as state_source
  from public.task_events e
  join legacy l on l.id = e.task_id
  where e.new_data is not null
),
parsed as (
  select
    s.task_id,
    s.occurred_at,
    s.state_source,
    nullif(s.state_json ->> 'week', '')::date as state_week,
    case
      when s.state_json ? 'day'
           and nullif(s.state_json ->> 'day', '') is not null
        then (s.state_json ->> 'day')::integer
      else null
    end as state_day,
    case
      when s.state_json ? 'planned_start_minute'
           and nullif(s.state_json ->> 'planned_start_minute', '') is not null
        then (s.state_json ->> 'planned_start_minute')::integer
      else null
    end as state_start
  from all_states s
),
best_day as (
  select distinct on (task_id)
    task_id,
    state_week as recovered_week,
    state_day as recovered_day
  from parsed
  where state_week is not null
    and extract(isodow from state_week) = 1
    and state_day between 0 and 6
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
best_time as (
  select distinct on (task_id)
    task_id,
    state_start as recovered_start_minute
  from parsed
  where state_start between 0 and 1439
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
recovery as (
  select
    d.task_id,
    d.recovered_week,
    d.recovered_day,
    tm.recovered_start_minute
  from best_day d
  left join best_time tm on tm.task_id = d.task_id
)
update public.tasks t
set week = r.recovered_week,
    day = r.recovered_day,
    planned_start_minute = case
      when t.planned_start_minute is null then r.recovered_start_minute
      else t.planned_start_minute
    end
from recovery r
where t.id = r.task_id
  and coalesce(t.superseded_by_followup, false)
  and t.day is null;

alter table public.tasks enable trigger prepare_followup_reschedule_trigger;

commit;


-- ============================================================================
-- 018_full_backup_v2.sql
-- ============================================================================

-- NM Planner Full Backup v2
--
-- Adds a complete, portable single-user backup/export RPC and a two-phase
-- preflight + atomic replace restore RPC. Run after migration 017.
--
-- Normal UI usage after this migration is button-driven from Settings.

begin;

-- ---------------------------------------------------------------------------
-- 1. Restore-mode helpers
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_in_restore_mode()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('nmplanner.restore_mode', true), '') = 'on';
$$;

revoke all on function public.nmplanner_in_restore_mode() from public;

create or replace function public.nmplanner_is_uuid(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null then return false; end if;
  perform p_value::uuid;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_date(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v_date date;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  v_date := p_value::date;
  return to_char(v_date, 'YYYY-MM-DD') = p_value;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_monday(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if not public.nmplanner_is_date(p_value) then return false; end if;
  return extract(isodow from p_value::date) = 1;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_timestamptz(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null or btrim(p_value) = '' then return false; end if;
  perform p_value::timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_int_between(p_value text, p_min integer, p_max integer)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v integer;
begin
  if p_value is null or p_value !~ '^-?\d+$' then return false; end if;
  v := p_value::integer;
  return v between p_min and p_max;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_numeric_between(p_value text, p_min numeric, p_max numeric)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v numeric;
begin
  if p_value is null or p_value !~ '^-?(\d+)(\.\d+)?$' then return false; end if;
  v := p_value::numeric;
  return v between p_min and p_max;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_valid_start_minute(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v integer;
begin
  if not public.nmplanner_int_between(p_value, 240, 1305) then return false; end if;
  v := p_value::integer;
  return mod(v, 15) = 0;
exception when others then
  return false;
end;
$$;

revoke all on function public.nmplanner_is_uuid(text) from public;
revoke all on function public.nmplanner_is_date(text) from public;
revoke all on function public.nmplanner_is_monday(text) from public;
revoke all on function public.nmplanner_is_timestamptz(text) from public;
revoke all on function public.nmplanner_int_between(text, integer, integer) from public;
revoke all on function public.nmplanner_numeric_between(text, numeric, numeric) from public;
revoke all on function public.nmplanner_valid_start_minute(text) from public;

create or replace function public.nmplanner_backup_snapshot(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_snapshot is null then null
    when jsonb_typeof(p_snapshot) = 'object' and p_snapshot ? 'user_id'
      then jsonb_set(p_snapshot, '{user_id}', to_jsonb('__OWNER__'::text), true)
    else p_snapshot
  end;
$$;

create or replace function public.nmplanner_restore_snapshot(p_snapshot jsonb, p_user_id uuid)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_snapshot is null then null
    when jsonb_typeof(p_snapshot) = 'object' and p_snapshot ? 'user_id'
      then jsonb_set(p_snapshot, '{user_id}', to_jsonb(p_user_id::text), true)
    else p_snapshot
  end;
$$;

revoke all on function public.nmplanner_backup_snapshot(jsonb) from public;
revoke all on function public.nmplanner_restore_snapshot(jsonb, uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. Make task triggers transaction-local restore aware
-- ---------------------------------------------------------------------------

create or replace function public.set_task_timestamps()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.completed and new.completed_at is null then new.completed_at := now(); end if;
  elsif tg_op = 'UPDATE' then
    if new.completed and not old.completed then new.completed_at := now();
    elsif not new.completed then new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.record_task_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.nmplanner_in_restore_mode() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'INSERT' then
    insert into public.task_events (user_id, task_id, event_type, new_data)
    values (new.user_id, new.id, 'created', to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.task_events (user_id, task_id, event_type, old_data, new_data)
    values (new.user_id, new.id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, old.id, 'deleted', to_jsonb(old));
    return old;
  end if;
  return null;
end;
$$;

create or replace function public.prepare_followup_reschedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare parent_week date;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
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
  select week into parent_week
  from public.tasks
  where id = new.parent_task_id and user_id = new.user_id;
  if parent_week is null then raise exception 'The follow-up parent could not be found.'; end if;
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

create or replace function public.prepare_followup_parent_as_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.parent_task_id is not null then
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id) then
      update public.tasks
      set superseded_by_followup = true,
          completed = false
      where id = new.parent_task_id and user_id = new.user_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.refresh_followup_parent_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_parent_id uuid; v_user_id uuid;
begin
  if public.nmplanner_in_restore_mode() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.parent_task_id is not null then
    v_parent_id := old.parent_task_id;
    v_user_id := old.user_id;
    update public.tasks parent
    set superseded_by_followup = exists (
      select 1 from public.tasks child
      where child.parent_task_id = parent.id and child.user_id = parent.user_id
    )
    where parent.id = v_parent_id and parent.user_id = v_user_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.parent_task_id is not null then
    update public.tasks parent
    set superseded_by_followup = true
    where parent.id = new.parent_task_id and parent.user_id = new.user_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

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
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.day is null
     or new.quadrant not in ('q1', 'q2')
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
  into v_q1_limit, v_q2_limit
  from public.planner_settings where user_id = new.user_id;
  if not found then v_q1_limit := 240; v_q2_limit := 300; end if;
  if new.quadrant = 'q1' then capacity_minutes := v_q1_limit; quadrant_label := 'Q1';
  else capacity_minutes := v_q2_limit; quadrant_label := 'Q2'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|' || new.quadrant, 0));
  select coalesce(sum(task.minutes), 0)::integer into existing_minutes
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and task.quadrant = new.quadrant and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  candidate_minutes := existing_minutes + coalesce(new.minutes, 0);
  if candidate_minutes > capacity_minutes then
    if tg_op = 'UPDATE' and old.quadrant = new.quadrant and old.week = new.week
       and old.day is not distinct from new.day and not coalesce(old.superseded_by_followup, false)
       and old.discarded_at is null and new.minutes <= old.minutes then return new; end if;
    raise exception '% daily capacity exceeded: this change would schedule % minutes, above your % minute limit.',
      quadrant_label, candidate_minutes, capacity_minutes using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_work_allocation_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new_week_total integer := 0; v_old_week_total integer := 0;
  v_new_day_total integer := 0; v_old_day_total integer := 0;
  v_new_is_work boolean := new.area in ('BCU / Teaching', 'Research');
  v_old_is_same_week_work boolean := false; v_old_is_same_day_work boolean := false;
  v_week_limit integer := 2220; v_day_limit integer := 600; v_work_name text := 'Primary Work';
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if not v_new_is_work or new.day is null or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  select coalesce(work_weekly_minutes, 2220), coalesce(work_daily_minutes, 600),
         coalesce(nullif(trim(work_name), ''), 'Primary Work')
  into v_week_limit, v_day_limit, v_work_name
  from public.planner_settings where user_id = new.user_id;
  if not found then v_week_limit := 2220; v_day_limit := 600; v_work_name := 'Primary Work'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|work-allocation', 0));
  select coalesce(sum(task.minutes), 0)::integer into v_new_week_total
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day is not null
    and task.area in ('BCU / Teaching', 'Research') and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  v_new_week_total := v_new_week_total + coalesce(new.minutes, 0);
  if tg_op = 'UPDATE' then
    v_old_is_same_week_work := old.area in ('BCU / Teaching', 'Research') and old.week = new.week
      and old.day is not null and not coalesce(old.superseded_by_followup, false) and old.discarded_at is null;
  end if;
  v_old_week_total := v_new_week_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;
  if v_new_week_total > v_week_limit and v_new_week_total > v_old_week_total then
    raise exception '% weekly capacity exceeded: primary work including Research would total % hours, above your % hour weekly limit.',
      v_work_name, round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2) using errcode = '23514';
  end if;
  select coalesce(sum(task.minutes), 0)::integer into v_new_day_total
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research') and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  v_new_day_total := v_new_day_total + coalesce(new.minutes, 0);
  if tg_op = 'UPDATE' then
    v_old_is_same_day_work := old.area in ('BCU / Teaching', 'Research') and old.week = new.week
      and old.day = new.day and not coalesce(old.superseded_by_followup, false) and old.discarded_at is null;
  end if;
  v_old_day_total := v_new_day_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_day_work then coalesce(old.minutes, 0) else 0 end;
  if v_new_day_total > v_day_limit and v_new_day_total > v_old_day_total then
    raise exception '% daily capacity exceeded: primary work including Research would total % hours on this day, above your % hour daily limit.',
      v_work_name, round(v_new_day_total / 60.0, 2), round(v_day_limit / 60.0, 2) using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_task_timeline_slot()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_conflict_title text;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.planned_start_minute is null or new.completed or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  if new.day is null then raise exception 'Assign the task to a day before giving it a start time.' using errcode = '23514'; end if;
  if new.planned_start_minute < 240 or new.planned_start_minute > 1305 or mod(new.planned_start_minute, 15) <> 0 then
    raise exception 'Start time must be a 15-minute slot between 04:00 and 21:45.' using errcode = '23514';
  end if;
  if new.planned_start_minute + coalesce(new.minutes, 0) > 1320 then
    raise exception 'This task would finish after 22:00. Choose an earlier start time.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|timeline', 0));
  select task.title into v_conflict_title
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and not task.completed and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null
    and task.planned_start_minute is not null and task.id is distinct from new.id
    and new.planned_start_minute < task.planned_start_minute + task.minutes
    and task.planned_start_minute < new.planned_start_minute + new.minutes
  order by task.planned_start_minute limit 1;
  if found then
    raise exception 'This time overlaps with "%". Choose another 15-minute slot.', v_conflict_title using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. State hash and Full Backup v2 export
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_state_hash(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(concat_ws('|',
    'tasks', (select count(*)::text from public.tasks where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.tasks where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id::text) from public.tasks where user_id = p_user_id), ''),
    'reviews', (select count(*)::text from public.task_reviews where user_id = p_user_id),
    coalesce((select max(occurred_at)::text from public.task_reviews where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.task_reviews where user_id = p_user_id), ''),
    'events', (select count(*)::text from public.task_events where user_id = p_user_id),
    coalesce((select max(occurred_at)::text from public.task_events where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.task_events where user_id = p_user_id), ''),
    'settings', (select count(*)::text from public.planner_settings where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.planner_settings where user_id = p_user_id), ''),
    'wellbeing', (select count(*)::text from public.wellbeing_daily where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.wellbeing_daily where user_id = p_user_id), ''),
    coalesce((select string_agg(entry_date::text, ',' order by entry_date) from public.wellbeing_daily where user_id = p_user_id), ''),
    'walking', (select count(*)::text from public.walking_logs where user_id = p_user_id),
    coalesce((select max(created_at)::text from public.walking_logs where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.walking_logs where user_id = p_user_id), '')
  ), 'sha256'), 'hex');
$$;

revoke all on function public.nmplanner_state_hash(uuid) from public;

create or replace function public.export_full_backup_v2()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_exported_at timestamptz := clock_timestamp();
  v_backup_id uuid := gen_random_uuid();
  v_tasks jsonb;
  v_reviews jsonb;
  v_events jsonb;
  v_settings jsonb;
  v_wellbeing jsonb;
  v_walking jsonb;
  c_tasks integer; c_reviews integer; c_events integer; c_settings integer; c_wellbeing integer; c_walking integer;
begin
  if v_user_id is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(t) - 'user_id' order by t.created_at, t.id), '[]'::jsonb)
  into v_tasks from public.tasks t where t.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id::text,
    'task_id', r.task_id::text,
    'task_snapshot', public.nmplanner_backup_snapshot(r.task_snapshot),
    'action', r.action,
    'reason', r.reason,
    'from_date', r.from_date,
    'to_date', r.to_date,
    'review_source', r.review_source,
    'occurred_at', r.occurred_at
  ) order by r.id), '[]'::jsonb)
  into v_reviews from public.task_reviews r where r.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id::text,
    'task_id', case when e.task_id is null then null else to_jsonb(e.task_id::text) end,
    'event_type', e.event_type,
    'old_data', public.nmplanner_backup_snapshot(e.old_data),
    'new_data', public.nmplanner_backup_snapshot(e.new_data),
    'occurred_at', e.occurred_at
  ) order by e.id), '[]'::jsonb)
  into v_events from public.task_events e where e.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'work_name', s.work_name,
    'additional_work_name', s.additional_work_name,
    'work_weekly_minutes', s.work_weekly_minutes,
    'work_daily_minutes', s.work_daily_minutes,
    'q1_daily_minutes', s.q1_daily_minutes,
    'q2_daily_minutes', s.q2_daily_minutes,
    'worldskills_weekly_minutes', s.worldskills_weekly_minutes,
    'family_daily_minutes', s.family_daily_minutes,
    'personal_daily_minutes', s.personal_daily_minutes,
    'sleep_daily_hours', s.sleep_daily_hours::text,
    'steps_per_mile', s.steps_per_mile,
    'created_at', s.created_at,
    'updated_at', s.updated_at
  )), '[]'::jsonb)
  into v_settings from public.planner_settings s where s.user_id = v_user_id;

  if jsonb_array_length(v_settings) = 0 then
    v_settings := jsonb_build_array(jsonb_build_object(
      'work_name', 'Primary Work',
      'additional_work_name', 'Additional Work',
      'work_weekly_minutes', 2220,
      'work_daily_minutes', 600,
      'q1_daily_minutes', 240,
      'q2_daily_minutes', 300,
      'worldskills_weekly_minutes', 1680,
      'family_daily_minutes', 180,
      'personal_daily_minutes', 180,
      'sleep_daily_hours', '6.00',
      'steps_per_mile', 2000,
      'created_at', v_exported_at,
      'updated_at', v_exported_at
    ));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'entry_date', w.entry_date,
    'sleep_hours', case when w.sleep_hours is null then null else to_jsonb(w.sleep_hours::text) end,
    'created_at', w.created_at,
    'updated_at', w.updated_at
  ) order by w.entry_date), '[]'::jsonb)
  into v_wellbeing from public.wellbeing_daily w where w.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id::text,
    'walk_date', w.walk_date,
    'area', w.area,
    'miles', w.miles::text,
    'created_at', w.created_at
  ) order by w.id), '[]'::jsonb)
  into v_walking from public.walking_logs w where w.user_id = v_user_id;

  c_tasks := jsonb_array_length(v_tasks);
  c_reviews := jsonb_array_length(v_reviews);
  c_events := jsonb_array_length(v_events);
  c_settings := jsonb_array_length(v_settings);
  c_wellbeing := jsonb_array_length(v_wellbeing);
  c_walking := jsonb_array_length(v_walking);

  return jsonb_build_object(
    'backup_format', 'nmplanner.full-backup',
    'backup_version', 2,
    'backup_revision', 0,
    'backup_id', v_backup_id,
    'exported_at', v_exported_at,
    'source', jsonb_build_object(
      'database_migration_level', 18,
      'data_model', 'operational-v1',
      'timezone', 'Europe/London',
      'app_build', null
    ),
    'ownership', jsonb_build_object(
      'scope', 'single-user',
      'user_id_in_rows', false,
      'restore_owner', 'authenticated-user',
      'authentication_data_included', false
    ),
    'restore_policy', jsonb_build_object(
      'mode', 'replace',
      'preserve_task_ids', true,
      'preserve_history_ids', true,
      'preserve_timestamps', true
    ),
    'record_counts', jsonb_build_object(
      'tasks', c_tasks,
      'task_reviews', c_reviews,
      'task_events', c_events,
      'planner_settings', c_settings,
      'wellbeing_daily', c_wellbeing,
      'walking_logs', c_walking,
      'total', c_tasks + c_reviews + c_events + c_settings + c_wellbeing + c_walking
    ),
    'integrity', jsonb_build_object(
      'algorithm', 'SHA-256',
      'canonicalization', 'RFC8785',
      'scope', 'data',
      'sha256', null
    ),
    'data', jsonb_build_object(
      'tasks', v_tasks,
      'task_reviews', v_reviews,
      'task_events', v_events,
      'planner_settings', v_settings,
      'wellbeing_daily', v_wellbeing,
      'walking_logs', v_walking
    )
  );
end;
$$;

revoke all on function public.export_full_backup_v2() from public;
grant execute on function public.export_full_backup_v2() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Server-side structural validator
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_validate_full_backup_v2(p_backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_data jsonb;
  v_tasks jsonb := '[]'::jsonb; v_reviews jsonb := '[]'::jsonb; v_events jsonb := '[]'::jsonb;
  v_settings jsonb := '[]'::jsonb; v_wellbeing jsonb := '[]'::jsonb; v_walking jsonb := '[]'::jsonb;
  c_tasks integer := 0; c_reviews integer := 0; c_events integer := 0; c_settings integer := 0; c_wellbeing integer := 0; c_walking integer := 0;
  v_bad integer := 0; v_has_cycle boolean := false; v_legacy integer := 0; v_branches integer := 0;
begin
  if p_backup is null or jsonb_typeof(p_backup) <> 'object' then
    return jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_REQUEST','message','Backup must be a JSON object.')), 'warnings', '[]'::jsonb, 'ready_to_restore', false);
  end if;

  if p_backup->>'backup_format' is distinct from 'nmplanner.full-backup' then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_WRONG_FORMAT','message','This is not an NM Planner Full Backup v2 file.'));
  end if;
  if p_backup->'backup_version' is distinct from '2'::jsonb then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_UNSUPPORTED_VERSION','message','Only Full Backup version 2 is supported.'));
  end if;
  if p_backup->'backup_revision' is distinct from '0'::jsonb then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_UNSUPPORTED_REVISION','message','This Full Backup v2 revision is not supported.'));
  end if;
  if not public.nmplanner_is_uuid(p_backup->>'backup_id') then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_BACKUP_ID','message','Backup ID is missing or invalid.'));
  end if;
  if not public.nmplanner_is_timestamptz(p_backup->>'exported_at') then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_EXPORTED_AT','message','Export timestamp is missing or invalid.'));
  end if;

  v_data := p_backup->'data';
  if v_data is null or jsonb_typeof(v_data) <> 'object' then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_MISSING_DATA_SECTION','message','The backup data section is missing.'));
    return jsonb_build_object('errors', v_errors, 'warnings', v_warnings, 'ready_to_restore', false);
  end if;

  if jsonb_typeof(v_data->'tasks') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','tasks','message','tasks must be an array.'));
  else v_tasks := v_data->'tasks'; end if;
  if jsonb_typeof(v_data->'task_reviews') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','task_reviews','message','task_reviews must be an array.'));
  else v_reviews := v_data->'task_reviews'; end if;
  if jsonb_typeof(v_data->'task_events') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','task_events','message','task_events must be an array.'));
  else v_events := v_data->'task_events'; end if;
  if jsonb_typeof(v_data->'planner_settings') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','planner_settings','message','planner_settings must be an array.'));
  else v_settings := v_data->'planner_settings'; end if;
  if jsonb_typeof(v_data->'wellbeing_daily') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','wellbeing_daily','message','wellbeing_daily must be an array.'));
  else v_wellbeing := v_data->'wellbeing_daily'; end if;
  if jsonb_typeof(v_data->'walking_logs') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','walking_logs','message','walking_logs must be an array.'));
  else v_walking := v_data->'walking_logs'; end if;

  c_tasks := jsonb_array_length(v_tasks); c_reviews := jsonb_array_length(v_reviews); c_events := jsonb_array_length(v_events);
  c_settings := jsonb_array_length(v_settings); c_wellbeing := jsonb_array_length(v_wellbeing); c_walking := jsonb_array_length(v_walking);

  if c_tasks > 10000 or c_reviews > 50000 or c_events > 200000 or c_wellbeing > 10000 or c_walking > 50000 then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_TOO_LARGE','message','The backup exceeds the supported Full Backup v2 record limits.'));
  end if;

  if p_backup#>'{record_counts,tasks}' is distinct from to_jsonb(c_tasks)
     or p_backup#>'{record_counts,task_reviews}' is distinct from to_jsonb(c_reviews)
     or p_backup#>'{record_counts,task_events}' is distinct from to_jsonb(c_events)
     or p_backup#>'{record_counts,planner_settings}' is distinct from to_jsonb(c_settings)
     or p_backup#>'{record_counts,wellbeing_daily}' is distinct from to_jsonb(c_wellbeing)
     or p_backup#>'{record_counts,walking_logs}' is distinct from to_jsonb(c_walking)
     or p_backup#>'{record_counts,total}' is distinct from to_jsonb(c_tasks + c_reviews + c_events + c_settings + c_wellbeing + c_walking) then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_COUNT_MISMATCH','message','Record counts do not match the backup data arrays.'));
  end if;

  if c_settings <> 1 then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', case when c_settings=0 then 'NMV2_SETTINGS_MISSING' else 'NMV2_SETTINGS_MULTIPLE' end, 'dataset','planner_settings','message','Full Backup v2 must contain exactly one planner settings record.'));
  end if;

  select count(*) into v_bad from jsonb_array_elements(v_tasks) j
  where jsonb_typeof(j) <> 'object'
     or not public.nmplanner_is_uuid(j->>'id')
     or jsonb_typeof(j->'title') <> 'string' or char_length(btrim(j->>'title')) not between 1 and 160
     or not public.nmplanner_is_monday(j->>'week')
     or (j->'day' <> 'null'::jsonb and (jsonb_typeof(j->'day') <> 'number' or not public.nmplanner_int_between(j->>'day',0,6)))
     or (j->'quadrant' <> 'null'::jsonb and coalesce(j->>'quadrant','') not in ('q1','q2','q3','q4'))
     or coalesce(j->>'area','') not in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')
     or not public.nmplanner_int_between(j->>'minutes',5,720)
     or (j->'actual_minutes' <> 'null'::jsonb and not public.nmplanner_int_between(j->>'actual_minutes',0,2880))
     or (j->'day_rank' <> 'null'::jsonb and not public.nmplanner_int_between(j->>'day_rank',1,99))
     or (j->'planned_start_minute' <> 'null'::jsonb and not public.nmplanner_valid_start_minute(j->>'planned_start_minute'))
     or jsonb_typeof(j->'completed') <> 'boolean'
     or jsonb_typeof(j->'superseded_by_followup') <> 'boolean'
     or not public.nmplanner_is_timestamptz(j->>'created_at')
     or not public.nmplanner_is_timestamptz(j->>'updated_at')
     or (j->'completed_at' <> 'null'::jsonb and not public.nmplanner_is_timestamptz(j->>'completed_at'))
     or (j->'discarded_at' <> 'null'::jsonb and not public.nmplanner_is_timestamptz(j->>'discarded_at'))
     or (j->'due' <> 'null'::jsonb and not public.nmplanner_is_date(j->>'due'))
     or (j->'parent_task_id' <> 'null'::jsonb and not public.nmplanner_is_uuid(j->>'parent_task_id'))
     or (j->'followup_reason' <> 'null'::jsonb and coalesce(j->>'followup_reason','') not in ('waiting_external','priority_shift','capacity','personal_delay','underestimated','scope_change','planned_continuation','other'))
     or (j->'rescheduled_from_week' <> 'null'::jsonb and not public.nmplanner_is_monday(j->>'rescheduled_from_week'))
     or (j->'rescheduled_to_week' <> 'null'::jsonb and not public.nmplanner_is_monday(j->>'rescheduled_to_week'));
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_TASK','dataset','tasks','count',v_bad,'message','One or more task records contain invalid fields.')); end if;

  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_tasks) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','tasks','count',v_bad,'message','Duplicate task IDs were found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) c
  where c->'parent_task_id' <> 'null'::jsonb
    and not exists (select 1 from jsonb_array_elements(v_tasks) p where p->>'id' = c->>'parent_task_id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_PARENT_NOT_FOUND','dataset','tasks','count',v_bad,'message','One or more follow-up parent tasks are missing from the backup.')); end if;

  with recursive edges as (
    select j->>'id' id, nullif(j->>'parent_task_id','') parent_id from jsonb_array_elements(v_tasks) j
  ), walk as (
    select id as start_id, parent_id as current_id, array[id]::text[] as path, false as cycle from edges
    union all
    select w.start_id, e.parent_id, w.path || e.id, e.id = any(w.path)
    from walk w join edges e on e.id = w.current_id
    where w.current_id is not null and not w.cycle
  )
  select exists(select 1 from walk where cycle) into v_has_cycle;
  if v_has_cycle then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_PARENT_CYCLE','dataset','tasks','message','A follow-up cycle was found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where coalesce((p->>'superseded_by_followup')::boolean,false)
    and not exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Superseded tasks without follow-up children were found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where not coalesce((p->>'superseded_by_followup')::boolean,false)
    and p->'discarded_at' = 'null'::jsonb
    and exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Parents with follow-up children must be historical/superseded.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_tasks) p
  where p->'discarded_at' <> 'null'::jsonb and coalesce((p->>'completed')::boolean,false);
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Discarded tasks cannot also be marked completed.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where p->'discarded_at' <> 'null'::jsonb
    and exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Discarded tasks cannot have active follow-up children.')); end if;

  if v_bad = 0 then null; end if;

  select count(*) into v_bad from jsonb_array_elements(v_reviews) j
  where jsonb_typeof(j) <> 'object'
     or coalesce(j->>'id','') !~ '^\d+$'
     or not public.nmplanner_is_uuid(j->>'task_id')
     or jsonb_typeof(j->'task_snapshot') <> 'object'
     or (j->'task_snapshot' ? 'user_id' and j#>>'{task_snapshot,user_id}' <> '__OWNER__')
     or coalesce(j->>'action','') not in ('moved','discarded')
     or coalesce(j->>'reason','') not in ('waiting_external','priority_shift','capacity','personal_delay','underestimated','scope_change','planned_continuation','other')
     or coalesce(j->>'review_source','') not in ('legacy','end_of_day','planned_reschedule')
     or not public.nmplanner_is_date(j->>'from_date')
     or not public.nmplanner_is_timestamptz(j->>'occurred_at')
     or (j->>'action'='moved' and (j->'to_date'='null'::jsonb or not public.nmplanner_is_date(j->>'to_date') or j->>'to_date'=j->>'from_date'))
     or (j->>'action'='discarded' and j->'to_date'<>'null'::jsonb);
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_REVIEW','dataset','task_reviews','count',v_bad,'message','One or more review records are invalid.')); end if;
  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_reviews) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','task_reviews','count',v_bad,'message','Duplicate review IDs were found.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_events) j
  where jsonb_typeof(j) <> 'object'
     or coalesce(j->>'id','') !~ '^\d+$'
     or (j->'task_id' <> 'null'::jsonb and not public.nmplanner_is_uuid(j->>'task_id'))
     or coalesce(j->>'event_type','') not in ('created','updated','deleted')
     or not public.nmplanner_is_timestamptz(j->>'occurred_at')
     or (j->'old_data' is not null and j->'old_data'<>'null'::jsonb and jsonb_typeof(j->'old_data')<>'object')
     or (j->'new_data' is not null and j->'new_data'<>'null'::jsonb and jsonb_typeof(j->'new_data')<>'object')
     or (j->'old_data' ? 'user_id' and j#>>'{old_data,user_id}' <> '__OWNER__')
     or (j->'new_data' ? 'user_id' and j#>>'{new_data,user_id}' <> '__OWNER__')
     or (j->>'event_type'='created' and (j->'old_data'<>'null'::jsonb or jsonb_typeof(j->'new_data')<>'object'))
     or (j->>'event_type'='updated' and (jsonb_typeof(j->'old_data')<>'object' or jsonb_typeof(j->'new_data')<>'object'))
     or (j->>'event_type'='deleted' and (jsonb_typeof(j->'old_data')<>'object' or j->'new_data'<>'null'::jsonb));
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_EVENT','dataset','task_events','count',v_bad,'message','One or more task-history events are invalid.')); end if;
  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_events) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','task_events','count',v_bad,'message','Duplicate task-event IDs were found.')); end if;

  if c_settings = 1 then
    select count(*) into v_bad from jsonb_array_elements(v_settings) s
    where jsonb_typeof(s)<>'object'
      or char_length(btrim(coalesce(s->>'work_name',''))) not between 1 and 60
      or char_length(btrim(coalesce(s->>'additional_work_name',''))) not between 1 and 60
      or lower(btrim(s->>'work_name')) = lower(btrim(s->>'additional_work_name'))
      or not public.nmplanner_int_between(s->>'work_weekly_minutes',60,10080)
      or not public.nmplanner_int_between(s->>'work_daily_minutes',30,1440)
      or not public.nmplanner_int_between(s->>'q1_daily_minutes',15,1440)
      or not public.nmplanner_int_between(s->>'q2_daily_minutes',15,1440)
      or not public.nmplanner_int_between(s->>'worldskills_weekly_minutes',0,10080)
      or not public.nmplanner_int_between(s->>'family_daily_minutes',0,1440)
      or not public.nmplanner_int_between(s->>'personal_daily_minutes',0,1440)
      or not public.nmplanner_numeric_between(s->>'sleep_daily_hours',0,24)
      or not public.nmplanner_int_between(s->>'steps_per_mile',500,5000)
      or not public.nmplanner_is_timestamptz(s->>'created_at')
      or not public.nmplanner_is_timestamptz(s->>'updated_at');
    if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_SETTINGS','dataset','planner_settings','message','Planner settings are invalid.')); end if;
  end if;

  select count(*) into v_bad from jsonb_array_elements(v_wellbeing) w
  where jsonb_typeof(w)<>'object' or not public.nmplanner_is_date(w->>'entry_date')
    or (w->'sleep_hours'<>'null'::jsonb and not public.nmplanner_numeric_between(w->>'sleep_hours',0,24))
    or not public.nmplanner_is_timestamptz(w->>'created_at') or not public.nmplanner_is_timestamptz(w->>'updated_at');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_WELLBEING','dataset','wellbeing_daily','count',v_bad,'message','One or more wellbeing records are invalid.')); end if;
  select count(*) - count(distinct w->>'entry_date') into v_bad from jsonb_array_elements(v_wellbeing) w;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','wellbeing_daily','count',v_bad,'message','Duplicate wellbeing dates were found.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_walking) w
  where jsonb_typeof(w)<>'object' or coalesce(w->>'id','') !~ '^\d+$'
    or not public.nmplanner_is_date(w->>'walk_date')
    or coalesce(w->>'area','') not in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')
    or not public.nmplanner_numeric_between(w->>'miles',0.000001,100)
    or not public.nmplanner_is_timestamptz(w->>'created_at');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_WALKING','dataset','walking_logs','count',v_bad,'message','One or more walking records are invalid.')); end if;
  select count(*) - count(distinct w->>'id') into v_bad from jsonb_array_elements(v_walking) w;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','walking_logs','count',v_bad,'message','Duplicate walking-log IDs were found.')); end if;

  select count(*) into v_legacy from jsonb_array_elements(v_reviews) r where r->>'review_source'='legacy';
  if v_legacy > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code','NMV2_LEGACY_REVIEWS','count',v_legacy,'message','Some review records pre-date review-source classification.')); end if;

  select count(*) into v_branches from (
    select p->>'id'
    from jsonb_array_elements(v_tasks) p
    where (select count(*) from jsonb_array_elements(v_tasks) c
           where c->>'parent_task_id'=p->>'id'
             and not coalesce((c->>'completed')::boolean,false)
             and not coalesce((c->>'superseded_by_followup')::boolean,false)
             and c->'discarded_at'='null'::jsonb
             and not exists (select 1 from jsonb_array_elements(v_tasks) gc where gc->>'parent_task_id'=c->>'id')) > 1
  ) q;
  if v_branches > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code','NMV2_MULTIPLE_OPEN_BRANCHES','count',v_branches,'message','Some follow-up families have more than one open terminal branch.')); end if;

  return jsonb_build_object(
    'errors', v_errors,
    'warnings', v_warnings,
    'ready_to_restore', jsonb_array_length(v_errors)=0,
    'record_counts', jsonb_build_object('tasks',c_tasks,'task_reviews',c_reviews,'task_events',c_events,'planner_settings',c_settings,'wellbeing_daily',c_wellbeing,'walking_logs',c_walking,'total',c_tasks+c_reviews+c_events+c_settings+c_wellbeing+c_walking),
    'checks', jsonb_build_object(
      'format_valid', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_WRONG_FORMAT'),
      'version_supported', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code' in ('NMV2_UNSUPPORTED_VERSION','NMV2_UNSUPPORTED_REVISION')),
      'record_counts_match', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_COUNT_MISMATCH'),
      'followup_cycles_absent', not v_has_cycle,
      'lifecycle_consistent', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_LIFECYCLE_INVALID')
    )
  );
end;
$$;

revoke all on function public.nmplanner_validate_full_backup_v2(jsonb) from public;

-- ---------------------------------------------------------------------------
-- 5. Two-phase restore RPC
-- ---------------------------------------------------------------------------

create or replace function public.restore_full_backup_v2(
  p_backup jsonb,
  p_dry_run boolean default true,
  p_confirmation_backup_id uuid default null,
  p_expected_current_state_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_validation jsonb;
  v_backup_id uuid;
  v_current_hash text;
  v_new_hash text;
  v_data jsonb;
  v_before jsonb;
  v_expected jsonb;
  v_actual jsonb;
  v_started timestamptz := clock_timestamp();
  v_completed timestamptz;
  v_bad integer := 0;
  v_seq text;
begin
  if v_user_id is null then
    raise exception using errcode='42501', message='NM Planner restore failed', detail='{"code":"NMV2_NOT_AUTHENTICATED"}';
  end if;

  v_validation := public.nmplanner_validate_full_backup_v2(p_backup);
  v_current_hash := public.nmplanner_state_hash(v_user_id);

  select jsonb_build_object(
    'tasks',(select count(*) from public.tasks where user_id=v_user_id),
    'task_reviews',(select count(*) from public.task_reviews where user_id=v_user_id),
    'task_events',(select count(*) from public.task_events where user_id=v_user_id),
    'planner_settings',(select count(*) from public.planner_settings where user_id=v_user_id),
    'wellbeing_daily',(select count(*) from public.wellbeing_daily where user_id=v_user_id),
    'walking_logs',(select count(*) from public.walking_logs where user_id=v_user_id)
  ) into v_before;

  if p_dry_run then
    return jsonb_build_object(
      'ok', (v_validation->>'ready_to_restore')::boolean,
      'operation','preflight',
      'backup_format',p_backup->>'backup_format',
      'backup_version',p_backup->'backup_version',
      'backup_revision',p_backup->'backup_revision',
      'backup_id',p_backup->>'backup_id',
      'compatible',(v_validation->>'ready_to_restore')::boolean,
      'current_state',jsonb_build_object('state_hash',v_current_hash,'record_counts',v_before),
      'incoming',jsonb_build_object('record_counts',v_validation->'record_counts'),
      'validation',jsonb_build_object('errors',v_validation->'errors','warnings',v_validation->'warnings','checks',v_validation->'checks'),
      'ready_to_restore',(v_validation->>'ready_to_restore')::boolean
    );
  end if;

  if not (v_validation->>'ready_to_restore')::boolean then
    raise exception using errcode='P0001', message='NM Planner restore failed',
      detail=jsonb_build_object('code','NMV2_INVALID_BACKUP','errors',v_validation->'errors')::text;
  end if;

  v_backup_id := (p_backup->>'backup_id')::uuid;
  if p_confirmation_backup_id is null or p_confirmation_backup_id <> v_backup_id then
    raise exception using errcode='P0001', message='NM Planner restore failed', detail='{"code":"NMV2_CONFIRMATION_REQUIRED"}';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('nmplanner-full-restore|' || v_user_id::text,0));
  v_current_hash := public.nmplanner_state_hash(v_user_id);
  if p_expected_current_state_hash is null or p_expected_current_state_hash <> v_current_hash then
    raise exception using errcode='P0001', message='NM Planner restore failed',
      detail=jsonb_build_object('code','NMV2_CURRENT_STATE_CHANGED','current_state_hash',v_current_hash)::text;
  end if;

  -- Prevent sequence races while explicit historical identity values are restored.
  lock table public.task_reviews, public.task_events, public.walking_logs in share row exclusive mode;
  perform set_config('nmplanner.restore_mode','on',true);
  v_data := p_backup->'data';
  v_expected := v_validation->'record_counts';

  delete from public.task_reviews where user_id=v_user_id;
  delete from public.task_events where user_id=v_user_id;
  delete from public.walking_logs where user_id=v_user_id;
  delete from public.wellbeing_daily where user_id=v_user_id;
  delete from public.planner_settings where user_id=v_user_id;
  delete from public.tasks where user_id=v_user_id;

  -- Pass 1: restore task bodies with parent links temporarily NULL.
  insert into public.tasks (
    id,user_id,parent_task_id,title,week,quadrant,day,area,due,minutes,actual_minutes,day_rank,planned_start_minute,
    notes,completed,completed_at,followup_reason,rescheduled_from_week,rescheduled_to_week,
    superseded_by_followup,discarded_at,created_at,updated_at
  )
  select
    (j->>'id')::uuid,v_user_id,null,(j->>'title'),(j->>'week')::date,nullif(j->>'quadrant',''),
    case when j->'day'='null'::jsonb then null else (j->>'day')::smallint end,
    j->>'area',case when j->'due'='null'::jsonb then null else (j->>'due')::date end,
    (j->>'minutes')::smallint,case when j->'actual_minutes'='null'::jsonb then null else (j->>'actual_minutes')::integer end,
    case when j->'day_rank'='null'::jsonb then null else (j->>'day_rank')::integer end,
    case when j->'planned_start_minute'='null'::jsonb then null else (j->>'planned_start_minute')::smallint end,
    coalesce(j->>'notes',''),(j->>'completed')::boolean,
    case when j->'completed_at'='null'::jsonb then null else (j->>'completed_at')::timestamptz end,
    case when j->'followup_reason'='null'::jsonb then null else j->>'followup_reason' end,
    case when j->'rescheduled_from_week'='null'::jsonb then null else (j->>'rescheduled_from_week')::date end,
    case when j->'rescheduled_to_week'='null'::jsonb then null else (j->>'rescheduled_to_week')::date end,
    (j->>'superseded_by_followup')::boolean,
    case when j->'discarded_at'='null'::jsonb then null else (j->>'discarded_at')::timestamptz end,
    (j->>'created_at')::timestamptz,(j->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'tasks') j;

  -- Pass 2: restore relationships after every task UUID exists.
  update public.tasks t
  set parent_task_id=(j->>'parent_task_id')::uuid
  from jsonb_array_elements(v_data->'tasks') j
  where t.user_id=v_user_id and t.id=(j->>'id')::uuid and j->'parent_task_id'<>'null'::jsonb;

  insert into public.planner_settings (
    user_id,work_name,additional_work_name,work_weekly_minutes,work_daily_minutes,q1_daily_minutes,q2_daily_minutes,
    worldskills_weekly_minutes,family_daily_minutes,personal_daily_minutes,sleep_daily_hours,steps_per_mile,created_at,updated_at
  )
  select v_user_id,s->>'work_name',s->>'additional_work_name',(s->>'work_weekly_minutes')::integer,(s->>'work_daily_minutes')::integer,
    (s->>'q1_daily_minutes')::integer,(s->>'q2_daily_minutes')::integer,(s->>'worldskills_weekly_minutes')::integer,
    (s->>'family_daily_minutes')::integer,(s->>'personal_daily_minutes')::integer,(s->>'sleep_daily_hours')::numeric,
    (s->>'steps_per_mile')::integer,(s->>'created_at')::timestamptz,(s->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'planner_settings') s;

  insert into public.wellbeing_daily (user_id,entry_date,sleep_hours,created_at,updated_at)
  select v_user_id,(w->>'entry_date')::date,
    case when w->'sleep_hours'='null'::jsonb then null else (w->>'sleep_hours')::numeric end,
    (w->>'created_at')::timestamptz,(w->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'wellbeing_daily') w;

  insert into public.walking_logs (id,user_id,walk_date,area,miles,created_at)
  overriding system value
  select (w->>'id')::bigint,v_user_id,(w->>'walk_date')::date,w->>'area',(w->>'miles')::numeric,(w->>'created_at')::timestamptz
  from jsonb_array_elements(v_data->'walking_logs') w;

  insert into public.task_reviews (id,user_id,task_id,task_snapshot,action,reason,from_date,to_date,occurred_at,review_source)
  overriding system value
  select (r->>'id')::bigint,v_user_id,(r->>'task_id')::uuid,public.nmplanner_restore_snapshot(r->'task_snapshot',v_user_id),
    r->>'action',r->>'reason',(r->>'from_date')::date,
    case when r->'to_date'='null'::jsonb then null else (r->>'to_date')::date end,
    (r->>'occurred_at')::timestamptz,r->>'review_source'
  from jsonb_array_elements(v_data->'task_reviews') r;

  insert into public.task_events (id,user_id,task_id,event_type,old_data,new_data,occurred_at)
  overriding system value
  select (e->>'id')::bigint,v_user_id,
    case when e->'task_id'='null'::jsonb then null else (e->>'task_id')::uuid end,
    e->>'event_type',public.nmplanner_restore_snapshot(e->'old_data',v_user_id),public.nmplanner_restore_snapshot(e->'new_data',v_user_id),
    (e->>'occurred_at')::timestamptz
  from jsonb_array_elements(v_data->'task_events') e;

  -- Advance identities to the global maximum. Table locks above prevent races.
  v_seq := pg_get_serial_sequence('public.task_reviews','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.task_reviews),1),1), (select count(*)>0 from public.task_reviews)); end if;
  v_seq := pg_get_serial_sequence('public.task_events','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.task_events),1),1), (select count(*)>0 from public.task_events)); end if;
  v_seq := pg_get_serial_sequence('public.walking_logs','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.walking_logs),1),1), (select count(*)>0 from public.walking_logs)); end if;

  perform set_config('nmplanner.restore_mode','off',true);

  select jsonb_build_object(
    'tasks',(select count(*) from public.tasks where user_id=v_user_id),
    'task_reviews',(select count(*) from public.task_reviews where user_id=v_user_id),
    'task_events',(select count(*) from public.task_events where user_id=v_user_id),
    'planner_settings',(select count(*) from public.planner_settings where user_id=v_user_id),
    'wellbeing_daily',(select count(*) from public.wellbeing_daily where user_id=v_user_id),
    'walking_logs',(select count(*) from public.walking_logs where user_id=v_user_id)
  ) into v_actual;

  if v_actual->'tasks' is distinct from v_expected->'tasks'
     or v_actual->'task_reviews' is distinct from v_expected->'task_reviews'
     or v_actual->'task_events' is distinct from v_expected->'task_events'
     or v_actual->'planner_settings' is distinct from v_expected->'planner_settings'
     or v_actual->'wellbeing_daily' is distinct from v_expected->'wellbeing_daily'
     or v_actual->'walking_logs' is distinct from v_expected->'walking_logs' then
    raise exception using errcode='P0001', message='NM Planner restore failed', detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','record_counts','expected',v_expected,'actual',v_actual)::text;
  end if;

  select count(*) into v_bad from public.tasks p
  where p.user_id=v_user_id and coalesce(p.superseded_by_followup,false)
    and not exists(select 1 from public.tasks c where c.user_id=v_user_id and c.parent_task_id=p.id);
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','superseded_without_child','count',v_bad)::text; end if;

  select count(*) into v_bad from public.tasks p
  where p.user_id=v_user_id and not coalesce(p.superseded_by_followup,false) and p.discarded_at is null
    and exists(select 1 from public.tasks c where c.user_id=v_user_id and c.parent_task_id=p.id);
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','parent_with_child_not_superseded','count',v_bad)::text; end if;

  select count(*) into v_bad from public.tasks t
  where t.user_id=v_user_id and t.discarded_at is not null and t.completed;
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','discarded_completed','count',v_bad)::text; end if;

  select count(*) into v_bad
  from public.tasks a join public.tasks b on b.user_id=a.user_id and b.week=a.week and b.day=a.day and b.id>a.id
  where a.user_id=v_user_id and not a.completed and not b.completed
    and not coalesce(a.superseded_by_followup,false) and not coalesce(b.superseded_by_followup,false)
    and a.discarded_at is null and b.discarded_at is null
    and a.planned_start_minute is not null and b.planned_start_minute is not null
    and a.planned_start_minute < b.planned_start_minute + b.minutes
    and b.planned_start_minute < a.planned_start_minute + a.minutes;
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','open_timeline_overlaps','count',v_bad)::text; end if;

  v_new_hash := public.nmplanner_state_hash(v_user_id);
  v_completed := clock_timestamp();

  return jsonb_build_object(
    'ok',true,'operation','restore','status','committed',
    'backup',jsonb_build_object('backup_id',v_backup_id,'backup_version',2,'backup_revision',0,'exported_at',p_backup->>'exported_at'),
    'restore',jsonb_build_object('started_at',v_started,'completed_at',v_completed,'mode','replace','previous_record_counts',v_before,'restored_record_counts',v_actual),
    'verification',jsonb_build_object('passed',true,'counts_match',true,'followup_integrity',true,'lifecycle_integrity',true,'settings_integrity',true,'timeline_integrity',true),
    'warnings',v_validation->'warnings',
    'new_state_hash',v_new_hash
  );
exception when others then
  -- Never convert an actual write failure into a normal response; rethrow so the
  -- entire PostgreSQL function transaction is rolled back.
  raise;
end;
$$;

revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;

commit;


-- ============================================================================
-- 019_backup_v2_trigger_permission.sql
-- ============================================================================

-- NM Planner Full Backup v2 permission hardening.
-- Run immediately after database/018_full_backup_v2.sql.
--
-- Normal task trigger functions call nmplanner_in_restore_mode(). They execute in
-- the authenticated user's context, so this read-only helper must be executable
-- by authenticated users. It exposes no data and performs no writes.

grant execute on function public.nmplanner_in_restore_mode() to authenticated;


-- ============================================================================
-- 020_security_hardening.sql
-- ============================================================================

-- NM Planner: database privilege hardening.
-- Run after database/019_backup_v2_trigger_permission.sql.
--
-- Goals:
--   * RLS remains the row-isolation layer, but anonymous callers should not also
--     hold broad table privileges.
--   * Only the RPCs actually called by the browser remain executable by the
--     authenticated role.
--   * Backup/validation helper functions stay internal to SECURITY DEFINER RPCs.
--   * Future objects in public do not silently inherit broad API grants.

begin;

-- ---------------------------------------------------------------------------
-- 1. Remove anonymous/public table access, then grant only what the app needs.
-- ---------------------------------------------------------------------------

revoke all privileges on table
  public.tasks,
  public.task_events,
  public.task_reviews,
  public.planner_settings,
  public.wellbeing_daily,
  public.walking_logs
from public, anon;

-- Reset authenticated privileges to an explicit least-privilege surface.
revoke all privileges on table
  public.tasks,
  public.task_events,
  public.task_reviews,
  public.planner_settings,
  public.wellbeing_daily,
  public.walking_logs
from authenticated;

grant select, insert, update, delete on public.tasks to authenticated;
grant select on public.task_events to authenticated;
grant select on public.task_reviews to authenticated;
grant select, insert, update, delete on public.planner_settings to authenticated;
grant select, insert, update, delete on public.wellbeing_daily to authenticated;
grant select, insert, update, delete on public.walking_logs to authenticated;

-- walking_logs is inserted directly by authenticated clients and therefore
-- needs its identity sequence. The history sequences are written by privileged
-- trigger/RPC code and do not need browser access.
do $$
begin
  if to_regclass('public.task_events_id_seq') is not null then
    execute 'revoke all privileges on sequence public.task_events_id_seq from public, anon, authenticated';
  end if;
  if to_regclass('public.task_reviews_id_seq') is not null then
    execute 'revoke all privileges on sequence public.task_reviews_id_seq from public, anon, authenticated';
  end if;
  if to_regclass('public.walking_logs_id_seq') is not null then
    execute 'revoke all privileges on sequence public.walking_logs_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.walking_logs_id_seq to authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Close the callable function surface.
-- ---------------------------------------------------------------------------

-- Remove PUBLIC/anon execution from every non-trigger helper/RPC currently
-- exposed by NM Planner. Supabase default privileges can otherwise grant direct
-- EXECUTE even when a migration revoked EXECUTE from PUBLIC.
revoke all on function public.export_full_backup_v2() from public, anon, authenticated;
revoke all on function public.nmplanner_backup_snapshot(jsonb) from public, anon, authenticated;
revoke all on function public.nmplanner_in_restore_mode() from public, anon, authenticated;
revoke all on function public.nmplanner_int_between(text, integer, integer) from public, anon, authenticated;
revoke all on function public.nmplanner_is_date(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_monday(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_timestamptz(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_uuid(text) from public, anon, authenticated;
revoke all on function public.nmplanner_numeric_between(text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.nmplanner_restore_snapshot(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.nmplanner_state_hash(uuid) from public, anon, authenticated;
revoke all on function public.nmplanner_valid_start_minute(text) from public, anon, authenticated;
revoke all on function public.nmplanner_validate_full_backup_v2(jsonb) from public, anon, authenticated;
revoke all on function public.reschedule_planned_task(uuid, text, date) from public, anon, authenticated;
revoke all on function public.reschedule_timed_task(uuid, text, date, integer) from public, anon, authenticated;
revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.review_unfinished_task(uuid, text, text, date) from public, anon, authenticated;

-- Browser-callable RPCs. Every one derives ownership from auth.uid().
grant execute on function public.export_full_backup_v2() to authenticated;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;
grant execute on function public.reschedule_planned_task(uuid, text, date) to authenticated;
grant execute on function public.reschedule_timed_task(uuid, text, date, integer) to authenticated;
grant execute on function public.review_unfinished_task(uuid, text, text, date) to authenticated;

-- Normal task trigger functions call this harmless transaction-local boolean
-- helper in the invoker's context, so authenticated must retain EXECUTE.
grant execute on function public.nmplanner_in_restore_mode() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Harden defaults for future public-schema objects.
-- ---------------------------------------------------------------------------

-- New database objects must be granted deliberately by their migration rather
-- than becoming API-accessible automatically.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;

commit;


-- ============================================================================
-- 021_fix_task_delete_event_fk.sql
-- ============================================================================

-- NM Planner: fix task deletion history foreign-key failure.
-- Run after database/020_security_hardening.sql.
--
-- The task_events.task_id foreign key uses ON DELETE SET NULL. Existing history
-- rows therefore detach cleanly when a task is deleted. However, the AFTER
-- DELETE audit trigger was inserting a *new* task_events row with task_id =
-- old.id after the parent task had already been removed. That new row cannot
-- satisfy the foreign key and causes every direct task deletion to fail.
--
-- Deleted-task identity is already preserved inside old_data, so deletion
-- events should store task_id = NULL. Created/updated events continue to keep
-- their live task_id reference.

begin;

create or replace function public.record_task_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.nmplanner_in_restore_mode() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    insert into public.task_events (user_id, task_id, event_type, new_data)
    values (new.user_id, new.id, 'created', to_jsonb(new));
    return new;

  elsif tg_op = 'UPDATE' then
    insert into public.task_events (user_id, task_id, event_type, old_data, new_data)
    values (new.user_id, new.id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;

  elsif tg_op = 'DELETE' then
    -- The task no longer exists by the time an AFTER DELETE trigger runs.
    -- Keep the complete deleted row in old_data and leave task_id NULL so the
    -- audit record remains valid without violating task_events_task_id_fkey.
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, null, 'deleted', to_jsonb(old));
    return old;
  end if;

  return null;
end;
$$;

commit;


-- ============================================================================
-- 022_day_block_capacity.sql
-- ============================================================================

-- NM Planner special Half Day / Full Day capacity semantics.
--
-- Half Day = 300 minutes (5h) and reserves the full configured Q2 daily capacity.
-- Full Day = 540 minutes (9h) and reserves the full configured Q1 + Q2 daily capacity.
--
-- These are scheduling-capacity semantics only. The task's own quadrant remains its
-- Eisenhower classification; choosing a Half/Full Day duration does not rewrite it.

begin;

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
begin
  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
    into v_q1_limit, v_q2_limit
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_q1_limit := 240;
    v_q2_limit := 300;
  end if;

  -- Capacity only applies to scheduled, current work. Moving a row out of a day,
  -- superseding it, or discarding it always reduces/clears its reservation.
  if new.day is null
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
    return new;
  end if;

  -- Half/Full Day can reserve Q-capacity even when the task is classified Q3/Q4
  -- or left unclassified, so the lock is per day rather than per quadrant.
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

  -- Compare an edit against the row's previous reservation on this same target
  -- day. This preserves the existing rule that legacy over-capacity rows may be
  -- edited when the change does not add more capacity pressure.
  if tg_op = 'UPDATE' then
    if old.user_id = new.user_id
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
  end if;

  v_candidate_q1 := v_existing_q1 + v_new_q1;
  v_candidate_q2 := v_existing_q2 + v_new_q2;
  v_previous_q1 := v_existing_q1 + v_old_q1;
  v_previous_q2 := v_existing_q2 + v_old_q2;

  if new.minutes = v_full_day_minutes
     and (
       (v_candidate_q1 > v_q1_limit and v_candidate_q1 > v_previous_q1)
       or (v_candidate_q2 > v_q2_limit and v_candidate_q2 > v_previous_q2)
     ) then
    raise exception 'Full Day requires all Q1 and Q2 capacity on this day. Move or reduce existing Q1/Q2 work first.'
      using errcode = '23514';
  end if;

  if new.minutes = v_half_day_minutes
     and v_candidate_q2 > v_q2_limit
     and v_candidate_q2 > v_previous_q2 then
    raise exception 'Half Day requires all Q2 capacity on this day. Move or reduce existing Q2 work first.'
      using errcode = '23514';
  end if;

  if v_candidate_q1 > v_q1_limit and v_candidate_q1 > v_previous_q1 then
    raise exception 'Q1 daily capacity exceeded: this change would reserve % minutes, above your % minute limit.',
      v_candidate_q1, v_q1_limit
      using errcode = '23514';
  end if;

  if v_candidate_q2 > v_q2_limit and v_candidate_q2 > v_previous_q2 then
    raise exception 'Q2 daily capacity exceeded: this change would reserve % minutes, above your % minute limit.',
      v_candidate_q2, v_q2_limit
      using errcode = '23514';
  end if;

  return new;
end;
$$;

commit;


-- ============================================================================
-- 023_urgent_overtime_capacity.sql
-- ============================================================================

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


-- ============================================================================
-- 024_backup_overtime_metadata.sql
-- ============================================================================

-- Preserve migration-023 urgent/overtime task metadata in Full Backup v2 restore.
--
-- Migration 018 exports task rows dynamically, so the new overtime fields are
-- already present in backups created after migration 023. Its original restore
-- function predates those columns, however. This wrapper keeps the existing
-- validated/atomic restore and then reapplies overtime metadata while restore
-- mode is active. Any failure still rolls back the entire outer transaction.

begin;

-- Keep the migration safe to inspect/re-run in development: rename the original
-- restore function only the first time this migration is applied.
do $$
begin
  if to_regprocedure('public.restore_full_backup_v2_core_pre_overtime(jsonb,boolean,uuid,text)') is null then
    alter function public.restore_full_backup_v2(jsonb, boolean, uuid, text)
      rename to restore_full_backup_v2_core_pre_overtime;
  end if;
end;
$$;

revoke all on function public.restore_full_backup_v2_core_pre_overtime(jsonb, boolean, uuid, text) from public;
revoke all on function public.restore_full_backup_v2_core_pre_overtime(jsonb, boolean, uuid, text) from authenticated;

create or replace function public.restore_full_backup_v2(
  p_backup jsonb,
  p_dry_run boolean default true,
  p_confirmation_backup_id uuid default null,
  p_expected_current_state_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
  v_tasks jsonb := coalesce(p_backup#>'{data,tasks}', '[]'::jsonb);
  v_bad integer := 0;
  v_new_hash text;
begin
  if v_user_id is null then
    raise exception using errcode='42501', message='NM Planner restore failed', detail='{"code":"NMV2_NOT_AUTHENTICATED"}';
  end if;

  -- The original migration-018 RPC still performs structural validation,
  -- confirmation, concurrency protection, atomic replacement and post-restore
  -- integrity checks.
  v_result := public.restore_full_backup_v2_core_pre_overtime(
    p_backup,
    p_dry_run,
    p_confirmation_backup_id,
    p_expected_current_state_hash
  );

  if p_dry_run then
    return v_result;
  end if;

  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'status' is distinct from 'committed' then
    return v_result;
  end if;

  -- Operational triggers deliberately bypass work while restore mode is active.
  -- This lets the exact persisted overtime episode timestamp and marginal excess
  -- be restored without creating new task-event history or recalculating it as a
  -- brand-new overtime decision.
  perform set_config('nmplanner.restore_mode', 'on', true);

  update public.tasks t
  set
    capacity_override = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      then true else false end,
    overtime_minutes = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      then (j->>'overtime_minutes')::integer else 0 end,
    capacity_override_at = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
           and nullif(j->>'capacity_override_at', '') is not null
      then (j->>'capacity_override_at')::timestamptz
      else null end
  from jsonb_array_elements(v_tasks) j
  where t.user_id = v_user_id
    and t.id = (j->>'id')::uuid;

  perform set_config('nmplanner.restore_mode', 'off', true);

  -- Verify the live task fields against the backup. Backups made before migration
  -- 023 contain no overtime keys and therefore correctly expect false/0/null.
  select count(*)
  into v_bad
  from public.tasks t
  join jsonb_array_elements(v_tasks) j on t.id = (j->>'id')::uuid
  where t.user_id = v_user_id
    and (
      t.capacity_override is distinct from (
        coalesce((j->>'capacity_override')::boolean, false)
        and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      )
      or t.overtime_minutes is distinct from case
        when coalesce((j->>'capacity_override')::boolean, false)
             and coalesce((j->>'overtime_minutes')::integer, 0) > 0
        then (j->>'overtime_minutes')::integer else 0 end
      or t.capacity_override_at is distinct from case
        when coalesce((j->>'capacity_override')::boolean, false)
             and coalesce((j->>'overtime_minutes')::integer, 0) > 0
             and nullif(j->>'capacity_override_at', '') is not null
        then (j->>'capacity_override_at')::timestamptz
        else null end
    );

  if v_bad > 0 then
    raise exception using
      errcode='P0001',
      message='NM Planner restore failed',
      detail=jsonb_build_object(
        'code','NMV2_POST_VERIFY_FAILED',
        'check','overtime_metadata',
        'count',v_bad
      )::text;
  end if;

  v_new_hash := public.nmplanner_state_hash(v_user_id);
  v_result := jsonb_set(v_result, '{new_state_hash}', to_jsonb(v_new_hash), true);
  v_result := jsonb_set(
    v_result,
    '{verification}',
    coalesce(v_result->'verification', '{}'::jsonb) || jsonb_build_object('overtime_metadata', true),
    true
  );

  return v_result;
exception when others then
  -- Any error in the wrapper rethrows and rolls back the core restore as well.
  raise;
end;
$$;

revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;

commit;



-- ============================================================================
-- 025_end_of_day_move_priority_overtime.sql
-- ============================================================================

-- NM Planner: end-of-day review move controls.
--
-- Adds an overloaded review_unfinished_task RPC used by the End-of-Day Review
-- dialog so a moved task can:
--   1. change Eisenhower priority (Q1-Q4), and
--   2. deliberately request the existing Urgent / Overtime capacity override.
--
-- The original 4-argument RPC is retained for backward compatibility. The new
-- 6-argument RPC is selected when p_quadrant and p_capacity_override are sent.
-- Existing capacity triggers remain the source of truth for whether overtime is
-- actually required and for calculating overtime_minutes.

begin;

create or replace function public.review_unfinished_task(
  p_task_id uuid,
  p_action text,
  p_reason text,
  p_target_date date,
  p_quadrant text,
  p_capacity_override boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_saved public.tasks%rowtype;
  v_from_date date;
  v_to_week date;
  v_to_day integer;
  v_target_quadrant text;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if p_action not in ('moved', 'discarded') then
    raise exception 'Choose Move or Discard.';
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
    raise exception 'Choose a valid review reason.';
  end if;

  if p_quadrant is not null
     and p_quadrant not in ('q1', 'q2', 'q3', 'q4') then
    raise exception 'Choose a valid priority from Q1 to Q4.';
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
    raise exception 'This task is already completed.';
  end if;
  if coalesce(v_task.superseded_by_followup, false) then
    raise exception 'Historical follow-up steps do not require end-of-day review.';
  end if;
  if v_task.discarded_at is not null then
    raise exception 'This task has already been discarded.';
  end if;
  if v_task.day is null then
    raise exception 'Only tasks assigned to a day can be reviewed.';
  end if;

  v_from_date := v_task.week + v_task.day;

  if p_action = 'moved' then
    if p_target_date is null then
      raise exception 'Choose the new planned date.';
    end if;

    if p_target_date <= v_from_date then
      raise exception 'Move the task to a later date than its current planned date.';
    end if;

    if p_target_date < current_date then
      raise exception 'A task cannot be moved into a past date.';
    end if;

    v_to_day := extract(isodow from p_target_date)::integer - 1;
    v_to_week := p_target_date - v_to_day;
    v_target_quadrant := coalesce(p_quadrant, v_task.quadrant);

    update public.tasks
    set week = v_to_week,
        day = v_to_day,
        quadrant = v_target_quadrant,
        day_rank = null,
        planned_start_minute = null,
        capacity_override = coalesce(p_capacity_override, false)
    where id = v_task.id
      and user_id = v_user_id
    returning * into v_saved;

    insert into public.task_reviews (
      user_id,
      task_id,
      task_snapshot,
      action,
      reason,
      from_date,
      to_date,
      review_source
    ) values (
      v_user_id,
      v_task.id,
      to_jsonb(v_task),
      'moved',
      p_reason,
      v_from_date,
      p_target_date,
      'end_of_day'
    );

    return jsonb_build_object(
      'action', 'moved',
      'task_id', v_task.id,
      'from_date', v_from_date,
      'to_date', p_target_date,
      'source', 'end_of_day',
      'old_quadrant', v_task.quadrant,
      'new_quadrant', v_saved.quadrant,
      'capacity_override', coalesce(v_saved.capacity_override, false),
      'overtime_minutes', coalesce(v_saved.overtime_minutes, 0)
    );
  end if;

  insert into public.task_reviews (
    user_id,
    task_id,
    task_snapshot,
    action,
    reason,
    from_date,
    to_date,
    review_source
  ) values (
    v_user_id,
    v_task.id,
    to_jsonb(v_task),
    'discarded',
    p_reason,
    v_from_date,
    null,
    'end_of_day'
  );

  update public.tasks
  set discarded_at = now(),
      day_rank = null
  where id = v_task.id
    and user_id = v_user_id;

  return jsonb_build_object(
    'action', 'discarded',
    'task_id', v_task.id,
    'from_date', v_from_date,
    'source', 'end_of_day'
  );
end;
$$;

revoke all on function public.review_unfinished_task(uuid, text, text, date, text, boolean) from public;
grant execute on function public.review_unfinished_task(uuid, text, text, date, text, boolean) to authenticated;

commit;


-- ============================================================================
-- 026_calendar_monthly_archive_foundation.sql
-- ============================================================================

-- NM Planner: compact external-calendar, monthly-summary and archive foundation.
--
-- Design goals:
--   * keep Microsoft/other calendar data concise;
--   * never store access tokens, refresh tokens, attendee lists, message bodies,
--     Teams chat content, attachments or full provider payloads;
--   * retain only the fields required for planning, conflict review and analysis;
--   * isolate every row by auth.uid() with RLS;
--   * keep long-term history as one compact monthly summary row per month;
--   * make detailed-data archiving user-controlled rather than automatic deletion.

begin;

-- ---------------------------------------------------------------------------
-- 1. Compact external calendar events
-- ---------------------------------------------------------------------------

create table if not exists public.external_calendar_events (
  id bigint generated by default as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'microsoft' check (provider in ('microsoft')),
  external_event_id text not null check (char_length(external_event_id) between 1 and 255),
  series_id text check (series_id is null or char_length(series_id) <= 255),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_all_day boolean not null default false,
  title text not null default '' check (char_length(title) <= 240),
  event_state text not null default 'active' check (event_state in ('active','cancelled')),
  area text check (area is null or area in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')),
  quadrant text check (quadrant is null or quadrant in ('q1','q2','q3','q4')),
  source_modified_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_calendar_events_valid_range check (ends_at > starts_at),
  constraint external_calendar_events_user_provider_external_key unique (user_id, provider, external_event_id)
);

create unique index if not exists external_calendar_events_user_id_id_uidx
  on public.external_calendar_events (user_id, id);

create unique index if not exists tasks_user_id_id_uidx
  on public.tasks (user_id, id);

create index if not exists external_calendar_events_user_time_idx
  on public.external_calendar_events (user_id, starts_at, ends_at);

create index if not exists external_calendar_events_user_series_idx
  on public.external_calendar_events (user_id, provider, series_id)
  where series_id is not null;

create index if not exists external_calendar_events_user_seen_idx
  on public.external_calendar_events (user_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- 2. Reusable classification rules
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_classification_rules (
  id bigint generated by default as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'microsoft' check (provider in ('microsoft')),
  rule_type text not null check (rule_type in ('series','title_exact')),
  match_value text not null check (char_length(match_value) between 1 and 255),
  area text not null check (area in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')),
  quadrant text check (quadrant is null or quadrant in ('q1','q2','q3','q4')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_classification_rules_unique unique (user_id, provider, rule_type, match_value)
);

create index if not exists calendar_classification_rules_user_idx
  on public.calendar_classification_rules (user_id, provider, rule_type);

-- ---------------------------------------------------------------------------
-- 3. Per-user sync/retention preferences. No credentials are stored here.
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_sync_state (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'microsoft' check (provider in ('microsoft')),
  last_synced_at timestamptz,
  last_range_start date,
  last_range_end date,
  sync_horizon_weeks smallint not null default 6 check (sync_horizon_weeks between 1 and 12),
  detail_retention_months smallint not null default 6 check (detail_retention_months between 3 and 24),
  storage_archive_threshold_mb smallint not null default 25 check (storage_archive_threshold_mb between 5 and 500),
  sunday_planning_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  constraint calendar_sync_state_range_check check (
    last_range_start is null
    or last_range_end is null
    or last_range_end >= last_range_start
  )
);

-- ---------------------------------------------------------------------------
-- 4. One compact long-term summary row per month.
-- ---------------------------------------------------------------------------

create table if not exists public.monthly_summaries (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month_start date not null,
  planning_score smallint not null check (planning_score between 0 and 100),
  score_label text not null check (char_length(score_label) between 1 and 32),
  metrics jsonb not null default '{}'::jsonb,
  suggestions jsonb not null default '[]'::jsonb,
  schema_version smallint not null default 1,
  generated_at timestamptz not null default now(),
  primary key (user_id, month_start),
  constraint monthly_summaries_month_start_check check (extract(day from month_start) = 1),
  constraint monthly_summaries_metrics_object_check check (jsonb_typeof(metrics) = 'object'),
  constraint monthly_summaries_suggestions_array_check check (jsonb_typeof(suggestions) = 'array'),
  constraint monthly_summaries_payload_size_check check (
    octet_length(metrics::text) <= 12000
    and octet_length(suggestions::text) <= 8000
  )
);

create index if not exists monthly_summaries_user_month_idx
  on public.monthly_summaries (user_id, month_start desc);

-- ---------------------------------------------------------------------------
-- 5. Tiny archive ledger only. Archive files themselves stay local to the user.
-- ---------------------------------------------------------------------------

create table if not exists public.archive_log (
  id bigint generated by default as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  file_name text not null check (char_length(file_name) between 1 and 180),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  row_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint archive_log_period_check check (period_end >= period_start),
  constraint archive_log_row_counts_object_check check (jsonb_typeof(row_counts) = 'object'),
  constraint archive_log_row_counts_size_check check (octet_length(row_counts::text) <= 4000)
);

create index if not exists archive_log_user_period_idx
  on public.archive_log (user_id, period_start, period_end);

-- Explicit overlap exceptions are stored separately and only when the user
-- deliberately chooses to keep a manual task overlapping a fixed calendar event.
create table if not exists public.calendar_overlap_overrides (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  external_event_id bigint not null,
  task_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, external_event_id, task_id),
  constraint calendar_overlap_event_owner_fkey
    foreign key (user_id, external_event_id)
    references public.external_calendar_events(user_id, id)
    on delete cascade,
  constraint calendar_overlap_task_owner_fkey
    foreign key (user_id, task_id)
    references public.tasks(user_id, id)
    on delete cascade
);

create index if not exists calendar_overlap_overrides_user_idx
  on public.calendar_overlap_overrides (user_id, external_event_id);

-- ---------------------------------------------------------------------------
-- 6. Timestamp maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_compact_calendar_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists touch_external_calendar_events_updated_at on public.external_calendar_events;
create trigger touch_external_calendar_events_updated_at
before update on public.external_calendar_events
for each row execute function public.touch_compact_calendar_updated_at();

drop trigger if exists touch_calendar_classification_rules_updated_at on public.calendar_classification_rules;
create trigger touch_calendar_classification_rules_updated_at
before update on public.calendar_classification_rules
for each row execute function public.touch_compact_calendar_updated_at();

drop trigger if exists touch_calendar_sync_state_updated_at on public.calendar_sync_state;
create trigger touch_calendar_sync_state_updated_at
before update on public.calendar_sync_state
for each row execute function public.touch_compact_calendar_updated_at();

-- ---------------------------------------------------------------------------
-- 7. RLS and least-privilege grants
-- ---------------------------------------------------------------------------

alter table public.external_calendar_events enable row level security;
alter table public.external_calendar_events force row level security;
alter table public.calendar_classification_rules enable row level security;
alter table public.calendar_classification_rules force row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.calendar_sync_state force row level security;
alter table public.monthly_summaries enable row level security;
alter table public.monthly_summaries force row level security;
alter table public.archive_log enable row level security;
alter table public.archive_log force row level security;
alter table public.calendar_overlap_overrides enable row level security;
alter table public.calendar_overlap_overrides force row level security;

drop policy if exists "Users manage own external calendar events" on public.external_calendar_events;
create policy "Users manage own external calendar events"
on public.external_calendar_events
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own calendar classification rules" on public.calendar_classification_rules;
create policy "Users manage own calendar classification rules"
on public.calendar_classification_rules
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own calendar sync state" on public.calendar_sync_state;
create policy "Users manage own calendar sync state"
on public.calendar_sync_state
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own monthly summaries" on public.monthly_summaries;
create policy "Users manage own monthly summaries"
on public.monthly_summaries
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own archive log" on public.archive_log;
create policy "Users manage own archive log"
on public.archive_log
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own calendar overlap overrides" on public.calendar_overlap_overrides;
create policy "Users manage own calendar overlap overrides"
on public.calendar_overlap_overrides
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all privileges on table
  public.external_calendar_events,
  public.calendar_classification_rules,
  public.calendar_sync_state,
  public.monthly_summaries,
  public.archive_log,
  public.calendar_overlap_overrides
from public, anon, authenticated;

grant select, insert, update, delete on public.external_calendar_events to authenticated;
grant select, insert, update, delete on public.calendar_classification_rules to authenticated;
grant select, insert, update, delete on public.calendar_sync_state to authenticated;
grant select, insert, update, delete on public.monthly_summaries to authenticated;
grant select, insert, update, delete on public.archive_log to authenticated;
grant select, insert, update, delete on public.calendar_overlap_overrides to authenticated;

do $$
begin
  if to_regclass('public.external_calendar_events_id_seq') is not null then
    execute 'revoke all privileges on sequence public.external_calendar_events_id_seq from public, anon';
    execute 'grant usage, select on sequence public.external_calendar_events_id_seq to authenticated';
  end if;
  if to_regclass('public.calendar_classification_rules_id_seq') is not null then
    execute 'revoke all privileges on sequence public.calendar_classification_rules_id_seq from public, anon';
    execute 'grant usage, select on sequence public.calendar_classification_rules_id_seq to authenticated';
  end if;
  if to_regclass('public.archive_log_id_seq') is not null then
    execute 'revoke all privileges on sequence public.archive_log_id_seq from public, anon';
    execute 'grant usage, select on sequence public.archive_log_id_seq to authenticated';
  end if;
end;
$$;

revoke all on function public.touch_compact_calendar_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Authenticated storage profile for archive decisions.
--    Approximate bytes are based only on the signed-in user's rows.
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_storage_profile()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tasks_count bigint := 0;
  v_events_count bigint := 0;
  v_reviews_count bigint := 0;
  v_calendar_count bigint := 0;
  v_month_count bigint := 0;
  v_wellbeing_count bigint := 0;
  v_walking_count bigint := 0;
  v_rules_count bigint := 0;
  v_overlap_count bigint := 0;
  v_archive_count bigint := 0;
  v_tasks_bytes bigint := 0;
  v_events_bytes bigint := 0;
  v_reviews_bytes bigint := 0;
  v_calendar_bytes bigint := 0;
  v_month_bytes bigint := 0;
  v_wellbeing_bytes bigint := 0;
  v_walking_bytes bigint := 0;
  v_rules_bytes bigint := 0;
  v_overlap_bytes bigint := 0;
  v_archive_bytes bigint := 0;
  v_retention smallint := 6;
  v_threshold smallint := 25;
  v_total bigint := 0;
  v_archive_before date;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  select count(*), coalesce(sum(pg_column_size(t)), 0)
    into v_tasks_count, v_tasks_bytes
  from public.tasks t
  where t.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(e)), 0)
    into v_events_count, v_events_bytes
  from public.task_events e
  where e.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(r)), 0)
    into v_reviews_count, v_reviews_bytes
  from public.task_reviews r
  where r.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(c)), 0)
    into v_calendar_count, v_calendar_bytes
  from public.external_calendar_events c
  where c.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(m)), 0)
    into v_month_count, v_month_bytes
  from public.monthly_summaries m
  where m.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(w)), 0)
    into v_wellbeing_count, v_wellbeing_bytes
  from public.wellbeing_daily w
  where w.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(w)), 0)
    into v_walking_count, v_walking_bytes
  from public.walking_logs w
  where w.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(r)), 0)
    into v_rules_count, v_rules_bytes
  from public.calendar_classification_rules r
  where r.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(o)), 0)
    into v_overlap_count, v_overlap_bytes
  from public.calendar_overlap_overrides o
  where o.user_id = v_user_id;

  select count(*), coalesce(sum(pg_column_size(a)), 0)
    into v_archive_count, v_archive_bytes
  from public.archive_log a
  where a.user_id = v_user_id;

  select coalesce(detail_retention_months, 6), coalesce(storage_archive_threshold_mb, 25)
    into v_retention, v_threshold
  from public.calendar_sync_state
  where user_id = v_user_id and provider = 'microsoft';

  if not found then
    v_retention := 6;
    v_threshold := 25;
  end if;

  v_total := v_tasks_bytes + v_events_bytes + v_reviews_bytes + v_calendar_bytes + v_month_bytes
    + v_wellbeing_bytes + v_walking_bytes + v_rules_bytes + v_overlap_bytes + v_archive_bytes;
  v_archive_before := (date_trunc('month', current_date) - make_interval(months => v_retention))::date;

  return jsonb_build_object(
    'approx_bytes', v_total,
    'archive_threshold_mb', v_threshold,
    'detail_retention_months', v_retention,
    'archive_before', v_archive_before,
    'archive_recommended', v_total >= (v_threshold::bigint * 1024 * 1024),
    'rows', jsonb_build_object(
      'tasks', v_tasks_count,
      'task_events', v_events_count,
      'task_reviews', v_reviews_count,
      'external_calendar_events', v_calendar_count,
      'monthly_summaries', v_month_count,
      'wellbeing_daily', v_wellbeing_count,
      'walking_logs', v_walking_count,
      'calendar_classification_rules', v_rules_count,
      'calendar_overlap_overrides', v_overlap_count,
      'archive_log', v_archive_count
    ),
    'approx_bytes_by_dataset', jsonb_build_object(
      'tasks', v_tasks_bytes,
      'task_events', v_events_bytes,
      'task_reviews', v_reviews_bytes,
      'external_calendar_events', v_calendar_bytes,
      'monthly_summaries', v_month_bytes,
      'wellbeing_daily', v_wellbeing_bytes,
      'walking_logs', v_walking_bytes,
      'calendar_classification_rules', v_rules_bytes,
      'calendar_overlap_overrides', v_overlap_bytes,
      'archive_log', v_archive_bytes
    )
  );
end;
$$;

revoke all on function public.nmplanner_storage_profile() from public, anon, authenticated;
grant execute on function public.nmplanner_storage_profile() to authenticated;

commit;


-- ============================================================================
-- 027_security_hardening_calendar_foundation.sql
-- ============================================================================

-- NM Planner: harden the calendar/monthly foundation introduced in migration 026.
-- Run after database/026_calendar_monthly_archive_foundation.sql.
--
-- Goals:
--   * preserve owner-only RLS and explicit least-privilege grants;
--   * close newly introduced callable-function surfaces;
--   * keep the End-of-Day review overload from migration 025 callable only by
--     authenticated users;
--   * tighten compact-summary payload limits without changing existing data.

begin;

-- ---------------------------------------------------------------------------
-- 1. Reassert table privileges for the new foundation.
-- ---------------------------------------------------------------------------

revoke all privileges on table
  public.external_calendar_events,
  public.calendar_classification_rules,
  public.calendar_sync_state,
  public.monthly_summaries,
  public.archive_log,
  public.calendar_overlap_overrides
from public, anon;

revoke all privileges on table
  public.external_calendar_events,
  public.calendar_classification_rules,
  public.calendar_sync_state,
  public.monthly_summaries,
  public.archive_log,
  public.calendar_overlap_overrides
from authenticated;

grant select, insert, update, delete on public.external_calendar_events to authenticated;
grant select, insert, update, delete on public.calendar_classification_rules to authenticated;
grant select, insert, update, delete on public.calendar_sync_state to authenticated;
grant select, insert, update, delete on public.monthly_summaries to authenticated;
grant select, insert, update, delete on public.archive_log to authenticated;
grant select, insert, update, delete on public.calendar_overlap_overrides to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Identity sequences: authenticated needs only the three directly-inserted
--    identity sequences. Anonymous/public access remains revoked.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.external_calendar_events_id_seq') is not null then
    execute 'revoke all privileges on sequence public.external_calendar_events_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.external_calendar_events_id_seq to authenticated';
  end if;

  if to_regclass('public.calendar_classification_rules_id_seq') is not null then
    execute 'revoke all privileges on sequence public.calendar_classification_rules_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.calendar_classification_rules_id_seq to authenticated';
  end if;

  if to_regclass('public.archive_log_id_seq') is not null then
    execute 'revoke all privileges on sequence public.archive_log_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.archive_log_id_seq to authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Function surface.
-- ---------------------------------------------------------------------------

revoke all on function public.nmplanner_storage_profile() from public, anon, authenticated;
grant execute on function public.nmplanner_storage_profile() to authenticated;

revoke all on function public.touch_compact_calendar_updated_at() from public, anon, authenticated;

-- Migration 025 created a six-argument End-of-Day review overload.
revoke all on function public.review_unfinished_task(uuid, text, text, date, text, boolean)
  from public, anon, authenticated;
grant execute on function public.review_unfinished_task(uuid, text, text, date, text, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tighten compact monthly-summary payload limits.
--
-- Current browser summaries are far below these limits. The checks prevent this
-- small long-term table from accidentally becoming a large document store.
-- ---------------------------------------------------------------------------

alter table public.monthly_summaries
  drop constraint if exists monthly_summaries_payload_size_check;

alter table public.monthly_summaries
  add constraint monthly_summaries_payload_size_check
  check (
    octet_length(metrics::text) <= 4000
    and octet_length(suggestions::text) <= 3000
  );

-- ---------------------------------------------------------------------------
-- 5. Keep all new tables under RLS + FORCE RLS.
-- ---------------------------------------------------------------------------

alter table public.external_calendar_events enable row level security;
alter table public.external_calendar_events force row level security;
alter table public.calendar_classification_rules enable row level security;
alter table public.calendar_classification_rules force row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.calendar_sync_state force row level security;
alter table public.monthly_summaries enable row level security;
alter table public.monthly_summaries force row level security;
alter table public.archive_log enable row level security;
alter table public.archive_log force row level security;
alter table public.calendar_overlap_overrides enable row level security;
alter table public.calendar_overlap_overrides force row level security;

commit;


-- ============================================================================
-- 028_security_and_index_cleanup.sql
-- ============================================================================

-- NM Planner: close legacy trigger-function exposure and add focused FK indexes.
-- Run after database/027_security_hardening_calendar_foundation.sql.

begin;

-- record_task_event() is an internal trigger function. It must not be callable
-- directly through the Data API by anonymous or signed-in browser clients.
revoke all on function public.record_task_event() from public, anon, authenticated;

-- Cover the self-referencing follow-up relationship used by task history.
create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;

-- Cover the composite task-owner FK used by calendar conflict overrides.
create index if not exists calendar_overlap_overrides_task_owner_idx
  on public.calendar_overlap_overrides (user_id, task_id);

commit;


-- ============================================================================
-- 029_microsoft_ics_import.sql
-- ============================================================================

-- Compatibility placeholder.
--
-- Older development builds briefly supported iCalendar snapshot imports.
-- Fresh public installations intentionally use the Power Automate calendar.json
-- browser-upload workflow introduced by migration 030. No schema change is
-- required at this migration number.

begin;
commit;


-- ============================================================================
-- 030_power_automate_calendar_ingest.sql
-- ============================================================================

-- NM Planner: browser-import calendar provider.
--
-- Fresh installations use calendar.json upload from the browser. The legacy
-- token-based Supabase Edge Function ingestion path has been retired.

begin;

alter table public.external_calendar_events
  drop constraint if exists external_calendar_events_provider_check;
alter table public.external_calendar_events
  add constraint external_calendar_events_provider_check
  check (provider = 'microsoft_power_automate');

alter table public.calendar_sync_state
  drop constraint if exists calendar_sync_state_provider_check;
alter table public.calendar_sync_state
  add constraint calendar_sync_state_provider_check
  check (provider in ('microsoft','microsoft_power_automate'));

drop table if exists public.calendar_ingest_credentials;

commit;


-- ============================================================================
-- 031_calendar_events_as_scheduled_tasks.sql
-- ============================================================================

-- Classified external calendar events become first-class scheduled tasks.
-- The link prevents duplicate materialisation while preserving calendar identity.

begin;

alter table public.tasks
  add column if not exists external_calendar_event_id bigint;

create unique index if not exists tasks_user_external_calendar_event_uidx
  on public.tasks (user_id, external_calendar_event_id)
  where external_calendar_event_id is not null;

alter table public.tasks
  drop constraint if exists tasks_external_calendar_event_owner_fkey;

alter table public.tasks
  add constraint tasks_external_calendar_event_owner_fkey
  foreign key (user_id, external_calendar_event_id)
  references public.external_calendar_events (user_id, id)
  on delete restrict;

create index if not exists tasks_external_calendar_event_idx
  on public.tasks (external_calendar_event_id)
  where external_calendar_event_id is not null;

commit;


-- ============================================================================
-- 032_allow_fixed_calendar_tasks_outside_manual_limits.sql
-- ============================================================================

-- Fixed imported calendar commitments must be materialisable even when they
-- exceed manual-planning capacity or overlap a manually planned task.
-- Manual tasks keep all existing safeguards.

begin;

drop trigger if exists enforce_daily_quadrant_capacity_trigger on public.tasks;
create trigger enforce_daily_quadrant_capacity_trigger
before insert or update of quadrant, day, week, area, minutes, user_id, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_daily_quadrant_capacity();

drop trigger if exists enforce_task_timeline_slot_trigger on public.tasks;
create trigger enforce_task_timeline_slot_trigger
before insert or update of user_id, week, day, planned_start_minute, minutes, completed, superseded_by_followup, discarded_at
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_task_timeline_slot();

drop trigger if exists enforce_work_allocation_capacity_trigger on public.tasks;
create trigger enforce_work_allocation_capacity_trigger
before insert or update of user_id, week, day, area, minutes, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_work_allocation_capacity();

commit;


-- ============================================================================
-- 033_task_multiple_focus_areas.sql
-- ============================================================================

-- Store optional proportional focus-area allocations for tasks that span
-- more than one area. The existing tasks.area column remains the primary
-- backwards-compatible area used by legacy capacity safeguards.

begin;

alter table public.tasks
  add column if not exists area_allocations jsonb;

alter table public.tasks
  drop constraint if exists tasks_area_allocations_check;

alter table public.tasks
  add constraint tasks_area_allocations_check
  check (
    area_allocations is null
    or jsonb_typeof(area_allocations) = 'object'
  );

commit;


-- ============================================================================
-- 034_split_tasks_across_week.sql
-- ============================================================================

-- Planned split jobs: one logical job can have multiple scheduled task instances.
-- Each instance is independently completable/reschedulable, while split_group_id
-- lets analytics treat the planned sessions as one committed job.

begin;

alter table public.tasks
  add column if not exists split_group_id uuid,
  add column if not exists split_instance_index smallint,
  add column if not exists split_instance_count smallint;

alter table public.tasks
  drop constraint if exists tasks_split_instance_check;

alter table public.tasks
  add constraint tasks_split_instance_check
  check (
    (split_group_id is null and split_instance_index is null and split_instance_count is null)
    or
    (
      split_group_id is not null
      and split_instance_index is not null
      and split_instance_count is not null
      and split_instance_index >= 1
      and split_instance_count >= 2
      and split_instance_index <= split_instance_count
    )
  );

create unique index if not exists tasks_user_split_instance_uidx
  on public.tasks (user_id, split_group_id, split_instance_index)
  where split_group_id is not null;

create index if not exists tasks_split_group_idx
  on public.tasks (split_group_id)
  where split_group_id is not null;

commit;


-- ============================================================================
-- 035_sleep_intervals.sql
-- ============================================================================

-- NM Planner: timed sleep sessions used by the 24-hour Insights map.

begin;

create table if not exists public.sleep_intervals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleep_intervals_order_check check (ended_at > started_at),
  constraint sleep_intervals_duration_check check (ended_at <= started_at + interval '36 hours')
);

create index if not exists sleep_intervals_user_start_idx
  on public.sleep_intervals (user_id, started_at);

create index if not exists sleep_intervals_user_end_idx
  on public.sleep_intervals (user_id, ended_at);

alter table public.sleep_intervals enable row level security;
alter table public.sleep_intervals force row level security;

drop policy if exists "Users manage their own sleep intervals" on public.sleep_intervals;
create policy "Users manage their own sleep intervals"
  on public.sleep_intervals
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all privileges on table public.sleep_intervals from public, anon;
grant select, insert, update, delete on table public.sleep_intervals to authenticated;
grant usage, select on sequence public.sleep_intervals_id_seq to authenticated;

commit;
