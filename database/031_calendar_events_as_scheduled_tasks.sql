-- Classified external calendar events become first-class scheduled tasks.
-- The link prevents duplicate materialisation while preserving calendar identity.

begin;

alter table public.tasks
  add column if not exists external_calendar_event_id bigint;

create unique index if not exists tasks_user_external_calendar_event_uidx
  on public.tasks (user_id, external_calendar_event_id)
  where external_calendar_event_id is not null;

alter table public.tasks
  drop constraint if exists tasks_external_calendar_event_owner_fkey;

alter table public.tasks
  add constraint tasks_external_calendar_event_owner_fkey
  foreign key (user_id, external_calendar_event_id)
  references public.external_calendar_events (user_id, id)
  on delete restrict;

create index if not exists tasks_external_calendar_event_idx
  on public.tasks (external_calendar_event_id)
  where external_calendar_event_id is not null;

commit;
