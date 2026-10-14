-- NM Planner: database privilege hardening.
-- Run after database/019_backup_v2_trigger_permission.sql.
--
-- Goals:
--   * RLS remains the row-isolation layer, but anonymous callers should not also
--     hold broad table privileges.
--   * Only the RPCs actually called by the browser remain executable by the
--     authenticated role.
--   * Backup/validation helper functions stay internal to SECURITY DEFINER RPCs.
--   * Future objects in public do not silently inherit broad API grants.

begin;

-- ---------------------------------------------------------------------------
-- 1. Remove anonymous/public table access, then grant only what the app needs.
-- ---------------------------------------------------------------------------

revoke all privileges on table
  public.tasks,
  public.task_events,
  public.task_reviews,
  public.planner_settings,
  public.wellbeing_daily,
  public.walking_logs
from public, anon;

-- Reset authenticated privileges to an explicit least-privilege surface.
revoke all privileges on table
  public.tasks,
  public.task_events,
  public.task_reviews,
  public.planner_settings,
  public.wellbeing_daily,
  public.walking_logs
from authenticated;

grant select, insert, update, delete on public.tasks to authenticated;
grant select on public.task_events to authenticated;
grant select on public.task_reviews to authenticated;
grant select, insert, update, delete on public.planner_settings to authenticated;
grant select, insert, update, delete on public.wellbeing_daily to authenticated;
grant select, insert, update, delete on public.walking_logs to authenticated;

-- walking_logs is inserted directly by authenticated clients and therefore
-- needs its identity sequence. The history sequences are written by privileged
-- trigger/RPC code and do not need browser access.
do $$
begin
  if to_regclass('public.task_events_id_seq') is not null then
    execute 'revoke all privileges on sequence public.task_events_id_seq from public, anon, authenticated';
  end if;
  if to_regclass('public.task_reviews_id_seq') is not null then
    execute 'revoke all privileges on sequence public.task_reviews_id_seq from public, anon, authenticated';
  end if;
  if to_regclass('public.walking_logs_id_seq') is not null then
    execute 'revoke all privileges on sequence public.walking_logs_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.walking_logs_id_seq to authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Close the callable function surface.
-- ---------------------------------------------------------------------------

-- Remove PUBLIC/anon execution from every non-trigger helper/RPC currently
-- exposed by NM Planner. Supabase default privileges can otherwise grant direct
-- EXECUTE even when a migration revoked EXECUTE from PUBLIC.
revoke all on function public.export_full_backup_v2() from public, anon, authenticated;
revoke all on function public.nmplanner_backup_snapshot(jsonb) from public, anon, authenticated;
revoke all on function public.nmplanner_in_restore_mode() from public, anon, authenticated;
revoke all on function public.nmplanner_int_between(text, integer, integer) from public, anon, authenticated;
revoke all on function public.nmplanner_is_date(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_monday(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_timestamptz(text) from public, anon, authenticated;
revoke all on function public.nmplanner_is_uuid(text) from public, anon, authenticated;
revoke all on function public.nmplanner_numeric_between(text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.nmplanner_restore_snapshot(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.nmplanner_state_hash(uuid) from public, anon, authenticated;
revoke all on function public.nmplanner_valid_start_minute(text) from public, anon, authenticated;
revoke all on function public.nmplanner_validate_full_backup_v2(jsonb) from public, anon, authenticated;
revoke all on function public.reschedule_planned_task(uuid, text, date) from public, anon, authenticated;
revoke all on function public.reschedule_timed_task(uuid, text, date, integer) from public, anon, authenticated;
revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.review_unfinished_task(uuid, text, text, date) from public, anon, authenticated;

-- Browser-callable RPCs. Every one derives ownership from auth.uid().
grant execute on function public.export_full_backup_v2() to authenticated;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;
grant execute on function public.reschedule_planned_task(uuid, text, date) to authenticated;
grant execute on function public.reschedule_timed_task(uuid, text, date, integer) to authenticated;
grant execute on function public.review_unfinished_task(uuid, text, text, date) to authenticated;

-- Normal task trigger functions call this harmless transaction-local boolean
-- helper in the invoker's context, so authenticated must retain EXECUTE.
grant execute on function public.nmplanner_in_restore_mode() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Harden defaults for future public-schema objects.
-- ---------------------------------------------------------------------------

-- New database objects must be granted deliberately by their migration rather
-- than becoming API-accessible automatically.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;

commit;
