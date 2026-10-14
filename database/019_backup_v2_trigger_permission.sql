-- NM Planner Full Backup v2 permission hardening.
-- Run immediately after database/018_full_backup_v2.sql.
--
-- Normal task trigger functions call nmplanner_in_restore_mode(). They execute in
-- the authenticated user's context, so this read-only helper must be executable
-- by authenticated users. It exposes no data and performs no writes.

grant execute on function public.nmplanner_in_restore_mode() to authenticated;
