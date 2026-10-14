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
