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