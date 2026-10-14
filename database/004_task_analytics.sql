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
