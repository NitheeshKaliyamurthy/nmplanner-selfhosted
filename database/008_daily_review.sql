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
