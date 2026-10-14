-- NM Planner: browser-import calendar provider.
--
-- Fresh installations use calendar.json upload from the browser. The legacy
-- token-based Supabase Edge Function ingestion path has been retired.

begin;

alter table public.external_calendar_events
  drop constraint if exists external_calendar_events_provider_check;
alter table public.external_calendar_events
  add constraint external_calendar_events_provider_check
  check (provider = 'microsoft_power_automate');

alter table public.calendar_sync_state
  drop constraint if exists calendar_sync_state_provider_check;
alter table public.calendar_sync_state
  add constraint calendar_sync_state_provider_check
  check (provider in ('microsoft','microsoft_power_automate'));

drop table if exists public.calendar_ingest_credentials;

commit;
