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
