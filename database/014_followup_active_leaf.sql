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
