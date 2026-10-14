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
