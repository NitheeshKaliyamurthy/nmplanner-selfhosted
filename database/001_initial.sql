-- NM Planner initial Supabase schema.
-- This is the reproducible copy of the migration applied during setup.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  week date not null check (extract(isodow from week) = 1),
  quadrant text check (quadrant is null or quadrant in ('q1', 'q2', 'q3', 'q4')),
  day smallint check (day is null or day between 0 and 6),
  area text not null default 'Personal / Admin' check (char_length(area) <= 80),
  due date,
  minutes smallint not null default 60 check (minutes between 5 and 720),
  notes text not null default '' check (char_length(notes) <= 4000),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  event_type text not null check (event_type in ('created', 'updated', 'deleted')),
  old_data jsonb,
  new_data jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists tasks_user_week_idx on public.tasks (user_id, week);
create index if not exists tasks_user_week_quadrant_day_idx on public.tasks (user_id, week, quadrant, day);
create index if not exists task_events_user_date_idx on public.task_events (user_id, occurred_at desc);
create index if not exists task_events_task_idx on public.task_events (task_id);

create or replace function public.set_task_timestamps()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.completed and new.completed_at is null then new.completed_at := now(); end if;
  elsif tg_op = 'UPDATE' then
    if new.completed and not old.completed then new.completed_at := now();
    elsif not new.completed then new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists set_task_timestamps_trigger on public.tasks;
create trigger set_task_timestamps_trigger before insert or update on public.tasks
for each row execute function public.set_task_timestamps();

create or replace function public.enforce_q1_daily_limit()
returns trigger language plpgsql set search_path = public as $$
declare existing_q1_count integer;
begin
  if new.quadrant = 'q1' and new.day is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text, 0));
    select count(*) into existing_q1_count from public.tasks
    where user_id = new.user_id and week = new.week and day = new.day
      and quadrant = 'q1' and id <> new.id;
    if existing_q1_count >= 2 then
      raise exception 'This day already contains two Urgent and Important tasks.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_q1_daily_limit_trigger on public.tasks;
create trigger enforce_q1_daily_limit_trigger before insert or update on public.tasks
for each row execute function public.enforce_q1_daily_limit();

create or replace function public.record_task_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.task_events (user_id, task_id, event_type, new_data)
    values (new.user_id, new.id, 'created', to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.task_events (user_id, task_id, event_type, old_data, new_data)
    values (new.user_id, new.id, 'updated', to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, old.id, 'deleted', to_jsonb(old));
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists record_task_event_trigger on public.tasks;
create trigger record_task_event_trigger after insert or update or delete on public.tasks
for each row execute function public.record_task_event();

alter table public.tasks enable row level security;
alter table public.task_events enable row level security;

drop policy if exists "Users can read their own tasks" on public.tasks;
create policy "Users can read their own tasks" on public.tasks for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own tasks" on public.tasks;
create policy "Users can create their own tasks" on public.tasks for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own tasks" on public.tasks;
create policy "Users can update their own tasks" on public.tasks for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own tasks" on public.tasks;
create policy "Users can delete their own tasks" on public.tasks for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own task history" on public.task_events;
create policy "Users can read their own task history" on public.task_events for select to authenticated
using ((select auth.uid()) = user_id);
