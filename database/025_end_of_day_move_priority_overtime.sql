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
