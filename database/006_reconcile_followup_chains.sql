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
