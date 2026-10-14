-- NM Planner: close legacy trigger-function exposure and add focused FK indexes.
-- Run after database/027_security_hardening_calendar_foundation.sql.

begin;

-- record_task_event() is an internal trigger function. It must not be callable
-- directly through the Data API by anonymous or signed-in browser clients.
revoke all on function public.record_task_event() from public, anon, authenticated;

-- Cover the self-referencing follow-up relationship used by task history.
create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;

-- Cover the composite task-owner FK used by calendar conflict overrides.
create index if not exists calendar_overlap_overrides_task_owner_idx
  on public.calendar_overlap_overrides (user_id, task_id);

commit;
