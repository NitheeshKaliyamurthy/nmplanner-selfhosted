-- NM Planner: timed sleep sessions used by the 24-hour Insights map.

begin;

create table if not exists public.sleep_intervals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleep_intervals_order_check check (ended_at > started_at),
  constraint sleep_intervals_duration_check check (ended_at <= started_at + interval '36 hours')
);

create index if not exists sleep_intervals_user_start_idx
  on public.sleep_intervals (user_id, started_at);

create index if not exists sleep_intervals_user_end_idx
  on public.sleep_intervals (user_id, ended_at);

alter table public.sleep_intervals enable row level security;
alter table public.sleep_intervals force row level security;

drop policy if exists "Users manage their own sleep intervals" on public.sleep_intervals;
create policy "Users manage their own sleep intervals"
  on public.sleep_intervals
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all privileges on table public.sleep_intervals from public, anon;
grant select, insert, update, delete on table public.sleep_intervals to authenticated;
grant usage, select on sequence public.sleep_intervals_id_seq to authenticated;

commit;
