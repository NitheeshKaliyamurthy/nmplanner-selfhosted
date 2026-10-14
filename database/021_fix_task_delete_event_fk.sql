-- NM Planner: fix task deletion history foreign-key failure.
-- Run after database/020_security_hardening.sql.
--
-- The task_events.task_id foreign key uses ON DELETE SET NULL. Existing history
-- rows therefore detach cleanly when a task is deleted. However, the AFTER
-- DELETE audit trigger was inserting a *new* task_events row with task_id =
-- old.id after the parent task had already been removed. That new row cannot
-- satisfy the foreign key and causes every direct task deletion to fail.
--
-- Deleted-task identity is already preserved inside old_data, so deletion
-- events should store task_id = NULL. Created/updated events continue to keep
-- their live task_id reference.

begin;

create or replace function public.record_task_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.nmplanner_in_restore_mode() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    insert into public.task_events (user_id, task_id, event_type, new_data)
    values (new.user_id, new.id, 'created', to_jsonb(new));
    return new;

  elsif tg_op = 'UPDATE' then
    insert into public.task_events (user_id, task_id, event_type, old_data, new_data)
    values (new.user_id, new.id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;

  elsif tg_op = 'DELETE' then
    -- The task no longer exists by the time an AFTER DELETE trigger runs.
    -- Keep the complete deleted row in old_data and leave task_id NULL so the
    -- audit record remains valid without violating task_events_task_id_fkey.
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, null, 'deleted', to_jsonb(old));
    return old;
  end if;

  return null;
end;
$$;

commit;
