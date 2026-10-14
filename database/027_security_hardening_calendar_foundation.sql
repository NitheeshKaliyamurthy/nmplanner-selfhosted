-- NM Planner: harden the calendar/monthly foundation introduced in migration 026.
-- Run after database/026_calendar_monthly_archive_foundation.sql.
--
-- Goals:
--   * preserve owner-only RLS and explicit least-privilege grants;
--   * close newly introduced callable-function surfaces;
--   * keep the End-of-Day review overload from migration 025 callable only by
--     authenticated users;
--   * tighten compact-summary payload limits without changing existing data.

begin;

-- ---------------------------------------------------------------------------
-- 1. Reassert table privileges for the new foundation.
-- ---------------------------------------------------------------------------

revoke all privileges on table
  public.external_calendar_events,
  public.calendar_classification_rules,
  public.calendar_sync_state,
  public.monthly_summaries,
  public.archive_log,
  public.calendar_overlap_overrides
from public, anon;

revoke all privileges on table
  public.external_calendar_events,
  public.calendar_classification_rules,
  public.calendar_sync_state,
  public.monthly_summaries,
  public.archive_log,
  public.calendar_overlap_overrides
from authenticated;

grant select, insert, update, delete on public.external_calendar_events to authenticated;
grant select, insert, update, delete on public.calendar_classification_rules to authenticated;
grant select, insert, update, delete on public.calendar_sync_state to authenticated;
grant select, insert, update, delete on public.monthly_summaries to authenticated;
grant select, insert, update, delete on public.archive_log to authenticated;
grant select, insert, update, delete on public.calendar_overlap_overrides to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Identity sequences: authenticated needs only the three directly-inserted
--    identity sequences. Anonymous/public access remains revoked.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.external_calendar_events_id_seq') is not null then
    execute 'revoke all privileges on sequence public.external_calendar_events_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.external_calendar_events_id_seq to authenticated';
  end if;

  if to_regclass('public.calendar_classification_rules_id_seq') is not null then
    execute 'revoke all privileges on sequence public.calendar_classification_rules_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.calendar_classification_rules_id_seq to authenticated';
  end if;

  if to_regclass('public.archive_log_id_seq') is not null then
    execute 'revoke all privileges on sequence public.archive_log_id_seq from public, anon, authenticated';
    execute 'grant usage, select on sequence public.archive_log_id_seq to authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Function surface.
-- ---------------------------------------------------------------------------

revoke all on function public.nmplanner_storage_profile() from public, anon, authenticated;
grant execute on function public.nmplanner_storage_profile() to authenticated;

revoke all on function public.touch_compact_calendar_updated_at() from public, anon, authenticated;

-- Migration 025 created a six-argument End-of-Day review overload.
revoke all on function public.review_unfinished_task(uuid, text, text, date, text, boolean)
  from public, anon, authenticated;
grant execute on function public.review_unfinished_task(uuid, text, text, date, text, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tighten compact monthly-summary payload limits.
--
-- Current browser summaries are far below these limits. The checks prevent this
-- small long-term table from accidentally becoming a large document store.
-- ---------------------------------------------------------------------------

alter table public.monthly_summaries
  drop constraint if exists monthly_summaries_payload_size_check;

alter table public.monthly_summaries
  add constraint monthly_summaries_payload_size_check
  check (
    octet_length(metrics::text) <= 4000
    and octet_length(suggestions::text) <= 3000
  );

-- ---------------------------------------------------------------------------
-- 5. Keep all new tables under RLS + FORCE RLS.
-- ---------------------------------------------------------------------------

alter table public.external_calendar_events enable row level security;
alter table public.external_calendar_events force row level security;
alter table public.calendar_classification_rules enable row level security;
alter table public.calendar_classification_rules force row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.calendar_sync_state force row level security;
alter table public.monthly_summaries enable row level security;
alter table public.monthly_summaries force row level security;
alter table public.archive_log enable row level security;
alter table public.archive_log force row level security;
alter table public.calendar_overlap_overrides enable row level security;
alter table public.calendar_overlap_overrides force row level security;

commit;
