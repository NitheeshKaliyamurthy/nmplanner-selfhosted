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
