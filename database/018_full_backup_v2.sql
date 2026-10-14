-- NM Planner Full Backup v2
--
-- Adds a complete, portable single-user backup/export RPC and a two-phase
-- preflight + atomic replace restore RPC. Run after migration 017.
--
-- Normal UI usage after this migration is button-driven from Settings.

begin;

-- ---------------------------------------------------------------------------
-- 1. Restore-mode helpers
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_in_restore_mode()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('nmplanner.restore_mode', true), '') = 'on';
$$;

revoke all on function public.nmplanner_in_restore_mode() from public;

create or replace function public.nmplanner_is_uuid(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null then return false; end if;
  perform p_value::uuid;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_date(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v_date date;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  v_date := p_value::date;
  return to_char(v_date, 'YYYY-MM-DD') = p_value;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_monday(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if not public.nmplanner_is_date(p_value) then return false; end if;
  return extract(isodow from p_value::date) = 1;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_is_timestamptz(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_value is null or btrim(p_value) = '' then return false; end if;
  perform p_value::timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_int_between(p_value text, p_min integer, p_max integer)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v integer;
begin
  if p_value is null or p_value !~ '^-?\d+$' then return false; end if;
  v := p_value::integer;
  return v between p_min and p_max;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_numeric_between(p_value text, p_min numeric, p_max numeric)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v numeric;
begin
  if p_value is null or p_value !~ '^-?(\d+)(\.\d+)?$' then return false; end if;
  v := p_value::numeric;
  return v between p_min and p_max;
exception when others then
  return false;
end;
$$;

create or replace function public.nmplanner_valid_start_minute(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare v integer;
begin
  if not public.nmplanner_int_between(p_value, 240, 1305) then return false; end if;
  v := p_value::integer;
  return mod(v, 15) = 0;
exception when others then
  return false;
end;
$$;

revoke all on function public.nmplanner_is_uuid(text) from public;
revoke all on function public.nmplanner_is_date(text) from public;
revoke all on function public.nmplanner_is_monday(text) from public;
revoke all on function public.nmplanner_is_timestamptz(text) from public;
revoke all on function public.nmplanner_int_between(text, integer, integer) from public;
revoke all on function public.nmplanner_numeric_between(text, numeric, numeric) from public;
revoke all on function public.nmplanner_valid_start_minute(text) from public;

create or replace function public.nmplanner_backup_snapshot(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_snapshot is null then null
    when jsonb_typeof(p_snapshot) = 'object' and p_snapshot ? 'user_id'
      then jsonb_set(p_snapshot, '{user_id}', to_jsonb('__OWNER__'::text), true)
    else p_snapshot
  end;
$$;

create or replace function public.nmplanner_restore_snapshot(p_snapshot jsonb, p_user_id uuid)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_snapshot is null then null
    when jsonb_typeof(p_snapshot) = 'object' and p_snapshot ? 'user_id'
      then jsonb_set(p_snapshot, '{user_id}', to_jsonb(p_user_id::text), true)
    else p_snapshot
  end;
$$;

revoke all on function public.nmplanner_backup_snapshot(jsonb) from public;
revoke all on function public.nmplanner_restore_snapshot(jsonb, uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. Make task triggers transaction-local restore aware
-- ---------------------------------------------------------------------------

create or replace function public.set_task_timestamps()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
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
    insert into public.task_events (user_id, task_id, event_type, old_data)
    values (old.user_id, old.id, 'deleted', to_jsonb(old));
    return old;
  end if;
  return null;
end;
$$;

create or replace function public.prepare_followup_reschedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare parent_week date;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.parent_task_id is null then
    new.followup_reason := null;
    new.rescheduled_from_week := null;
    new.rescheduled_to_week := null;
    return new;
  end if;
  if new.followup_reason is null then
    if tg_op = 'INSERT' then
      raise exception 'Choose a reason for this follow-up.' using errcode = '23514';
    elsif old.parent_task_id is null then
      raise exception 'Choose a reason for this follow-up.' using errcode = '23514';
    end if;
  end if;
  select week into parent_week
  from public.tasks
  where id = new.parent_task_id and user_id = new.user_id;
  if parent_week is null then raise exception 'The follow-up parent could not be found.'; end if;
  if new.week > parent_week then
    new.rescheduled_from_week := parent_week;
    new.rescheduled_to_week := new.week;
  else
    new.rescheduled_from_week := null;
    new.rescheduled_to_week := null;
  end if;
  return new;
end;
$$;

create or replace function public.prepare_followup_parent_as_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.parent_task_id is not null then
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id) then
      update public.tasks
      set superseded_by_followup = true,
          completed = false
      where id = new.parent_task_id and user_id = new.user_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.refresh_followup_parent_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_parent_id uuid; v_user_id uuid;
begin
  if public.nmplanner_in_restore_mode() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.parent_task_id is not null then
    v_parent_id := old.parent_task_id;
    v_user_id := old.user_id;
    update public.tasks parent
    set superseded_by_followup = exists (
      select 1 from public.tasks child
      where child.parent_task_id = parent.id and child.user_id = parent.user_id
    )
    where parent.id = v_parent_id and parent.user_id = v_user_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.parent_task_id is not null then
    update public.tasks parent
    set superseded_by_followup = true
    where parent.id = new.parent_task_id and parent.user_id = new.user_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.enforce_daily_quadrant_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  existing_minutes integer := 0;
  candidate_minutes integer := 0;
  capacity_minutes integer := 0;
  quadrant_label text;
  v_q1_limit integer := 240;
  v_q2_limit integer := 300;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.day is null
     or new.quadrant not in ('q1', 'q2')
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
  into v_q1_limit, v_q2_limit
  from public.planner_settings where user_id = new.user_id;
  if not found then v_q1_limit := 240; v_q2_limit := 300; end if;
  if new.quadrant = 'q1' then capacity_minutes := v_q1_limit; quadrant_label := 'Q1';
  else capacity_minutes := v_q2_limit; quadrant_label := 'Q2'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|' || new.quadrant, 0));
  select coalesce(sum(task.minutes), 0)::integer into existing_minutes
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and task.quadrant = new.quadrant and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  candidate_minutes := existing_minutes + coalesce(new.minutes, 0);
  if candidate_minutes > capacity_minutes then
    if tg_op = 'UPDATE' and old.quadrant = new.quadrant and old.week = new.week
       and old.day is not distinct from new.day and not coalesce(old.superseded_by_followup, false)
       and old.discarded_at is null and new.minutes <= old.minutes then return new; end if;
    raise exception '% daily capacity exceeded: this change would schedule % minutes, above your % minute limit.',
      quadrant_label, candidate_minutes, capacity_minutes using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_work_allocation_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new_week_total integer := 0; v_old_week_total integer := 0;
  v_new_day_total integer := 0; v_old_day_total integer := 0;
  v_new_is_work boolean := new.area in ('BCU / Teaching', 'Research');
  v_old_is_same_week_work boolean := false; v_old_is_same_day_work boolean := false;
  v_week_limit integer := 2220; v_day_limit integer := 600; v_work_name text := 'BCU / Teaching';
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if not v_new_is_work or new.day is null or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  select coalesce(work_weekly_minutes, 2220), coalesce(work_daily_minutes, 600),
         coalesce(nullif(trim(work_name), ''), 'BCU / Teaching')
  into v_week_limit, v_day_limit, v_work_name
  from public.planner_settings where user_id = new.user_id;
  if not found then v_week_limit := 2220; v_day_limit := 600; v_work_name := 'BCU / Teaching'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|work-allocation', 0));
  select coalesce(sum(task.minutes), 0)::integer into v_new_week_total
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day is not null
    and task.area in ('BCU / Teaching', 'Research') and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  v_new_week_total := v_new_week_total + coalesce(new.minutes, 0);
  if tg_op = 'UPDATE' then
    v_old_is_same_week_work := old.area in ('BCU / Teaching', 'Research') and old.week = new.week
      and old.day is not null and not coalesce(old.superseded_by_followup, false) and old.discarded_at is null;
  end if;
  v_old_week_total := v_new_week_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_week_work then coalesce(old.minutes, 0) else 0 end;
  if v_new_week_total > v_week_limit and v_new_week_total > v_old_week_total then
    raise exception '% weekly capacity exceeded: primary work including Research would total % hours, above your % hour weekly limit.',
      v_work_name, round(v_new_week_total / 60.0, 2), round(v_week_limit / 60.0, 2) using errcode = '23514';
  end if;
  select coalesce(sum(task.minutes), 0)::integer into v_new_day_total
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and task.area in ('BCU / Teaching', 'Research') and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null;
  v_new_day_total := v_new_day_total + coalesce(new.minutes, 0);
  if tg_op = 'UPDATE' then
    v_old_is_same_day_work := old.area in ('BCU / Teaching', 'Research') and old.week = new.week
      and old.day = new.day and not coalesce(old.superseded_by_followup, false) and old.discarded_at is null;
  end if;
  v_old_day_total := v_new_day_total - coalesce(new.minutes, 0)
    + case when v_old_is_same_day_work then coalesce(old.minutes, 0) else 0 end;
  if v_new_day_total > v_day_limit and v_new_day_total > v_old_day_total then
    raise exception '% daily capacity exceeded: primary work including Research would total % hours on this day, above your % hour daily limit.',
      v_work_name, round(v_new_day_total / 60.0, 2), round(v_day_limit / 60.0, 2) using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_task_timeline_slot()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_conflict_title text;
begin
  if public.nmplanner_in_restore_mode() then return new; end if;
  if new.planned_start_minute is null or new.completed or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then return new; end if;
  if new.day is null then raise exception 'Assign the task to a day before giving it a start time.' using errcode = '23514'; end if;
  if new.planned_start_minute < 240 or new.planned_start_minute > 1305 or mod(new.planned_start_minute, 15) <> 0 then
    raise exception 'Start time must be a 15-minute slot between 04:00 and 21:45.' using errcode = '23514';
  end if;
  if new.planned_start_minute + coalesce(new.minutes, 0) > 1320 then
    raise exception 'This task would finish after 22:00. Choose an earlier start time.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|timeline', 0));
  select task.title into v_conflict_title
  from public.tasks task
  where task.user_id = new.user_id and task.week = new.week and task.day = new.day
    and not task.completed and not coalesce(task.superseded_by_followup, false) and task.discarded_at is null
    and task.planned_start_minute is not null and task.id is distinct from new.id
    and new.planned_start_minute < task.planned_start_minute + task.minutes
    and task.planned_start_minute < new.planned_start_minute + new.minutes
  order by task.planned_start_minute limit 1;
  if found then
    raise exception 'This time overlaps with "%". Choose another 15-minute slot.', v_conflict_title using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. State hash and Full Backup v2 export
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_state_hash(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(concat_ws('|',
    'tasks', (select count(*)::text from public.tasks where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.tasks where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id::text) from public.tasks where user_id = p_user_id), ''),
    'reviews', (select count(*)::text from public.task_reviews where user_id = p_user_id),
    coalesce((select max(occurred_at)::text from public.task_reviews where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.task_reviews where user_id = p_user_id), ''),
    'events', (select count(*)::text from public.task_events where user_id = p_user_id),
    coalesce((select max(occurred_at)::text from public.task_events where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.task_events where user_id = p_user_id), ''),
    'settings', (select count(*)::text from public.planner_settings where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.planner_settings where user_id = p_user_id), ''),
    'wellbeing', (select count(*)::text from public.wellbeing_daily where user_id = p_user_id),
    coalesce((select max(updated_at)::text from public.wellbeing_daily where user_id = p_user_id), ''),
    coalesce((select string_agg(entry_date::text, ',' order by entry_date) from public.wellbeing_daily where user_id = p_user_id), ''),
    'walking', (select count(*)::text from public.walking_logs where user_id = p_user_id),
    coalesce((select max(created_at)::text from public.walking_logs where user_id = p_user_id), ''),
    coalesce((select string_agg(id::text, ',' order by id) from public.walking_logs where user_id = p_user_id), '')
  ), 'sha256'), 'hex');
$$;

revoke all on function public.nmplanner_state_hash(uuid) from public;

create or replace function public.export_full_backup_v2()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_exported_at timestamptz := clock_timestamp();
  v_backup_id uuid := gen_random_uuid();
  v_tasks jsonb;
  v_reviews jsonb;
  v_events jsonb;
  v_settings jsonb;
  v_wellbeing jsonb;
  v_walking jsonb;
  c_tasks integer; c_reviews integer; c_events integer; c_settings integer; c_wellbeing integer; c_walking integer;
begin
  if v_user_id is null then raise exception 'You must be signed in.' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(t) - 'user_id' order by t.created_at, t.id), '[]'::jsonb)
  into v_tasks from public.tasks t where t.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id::text,
    'task_id', r.task_id::text,
    'task_snapshot', public.nmplanner_backup_snapshot(r.task_snapshot),
    'action', r.action,
    'reason', r.reason,
    'from_date', r.from_date,
    'to_date', r.to_date,
    'review_source', r.review_source,
    'occurred_at', r.occurred_at
  ) order by r.id), '[]'::jsonb)
  into v_reviews from public.task_reviews r where r.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id::text,
    'task_id', case when e.task_id is null then null else to_jsonb(e.task_id::text) end,
    'event_type', e.event_type,
    'old_data', public.nmplanner_backup_snapshot(e.old_data),
    'new_data', public.nmplanner_backup_snapshot(e.new_data),
    'occurred_at', e.occurred_at
  ) order by e.id), '[]'::jsonb)
  into v_events from public.task_events e where e.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'work_name', s.work_name,
    'additional_work_name', s.additional_work_name,
    'work_weekly_minutes', s.work_weekly_minutes,
    'work_daily_minutes', s.work_daily_minutes,
    'q1_daily_minutes', s.q1_daily_minutes,
    'q2_daily_minutes', s.q2_daily_minutes,
    'worldskills_weekly_minutes', s.worldskills_weekly_minutes,
    'family_daily_minutes', s.family_daily_minutes,
    'personal_daily_minutes', s.personal_daily_minutes,
    'sleep_daily_hours', s.sleep_daily_hours::text,
    'steps_per_mile', s.steps_per_mile,
    'created_at', s.created_at,
    'updated_at', s.updated_at
  )), '[]'::jsonb)
  into v_settings from public.planner_settings s where s.user_id = v_user_id;

  if jsonb_array_length(v_settings) = 0 then
    v_settings := jsonb_build_array(jsonb_build_object(
      'work_name', 'Primary Work',
      'additional_work_name', 'Additional Work',
      'work_weekly_minutes', 2220,
      'work_daily_minutes', 600,
      'q1_daily_minutes', 240,
      'q2_daily_minutes', 300,
      'worldskills_weekly_minutes', 1680,
      'family_daily_minutes', 180,
      'personal_daily_minutes', 180,
      'sleep_daily_hours', '6.00',
      'steps_per_mile', 2000,
      'created_at', v_exported_at,
      'updated_at', v_exported_at
    ));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'entry_date', w.entry_date,
    'sleep_hours', case when w.sleep_hours is null then null else to_jsonb(w.sleep_hours::text) end,
    'created_at', w.created_at,
    'updated_at', w.updated_at
  ) order by w.entry_date), '[]'::jsonb)
  into v_wellbeing from public.wellbeing_daily w where w.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id::text,
    'walk_date', w.walk_date,
    'area', w.area,
    'miles', w.miles::text,
    'created_at', w.created_at
  ) order by w.id), '[]'::jsonb)
  into v_walking from public.walking_logs w where w.user_id = v_user_id;

  c_tasks := jsonb_array_length(v_tasks);
  c_reviews := jsonb_array_length(v_reviews);
  c_events := jsonb_array_length(v_events);
  c_settings := jsonb_array_length(v_settings);
  c_wellbeing := jsonb_array_length(v_wellbeing);
  c_walking := jsonb_array_length(v_walking);

  return jsonb_build_object(
    'backup_format', 'nmplanner.full-backup',
    'backup_version', 2,
    'backup_revision', 0,
    'backup_id', v_backup_id,
    'exported_at', v_exported_at,
    'source', jsonb_build_object(
      'database_migration_level', 18,
      'data_model', 'operational-v1',
      'timezone', 'Europe/London',
      'app_build', null
    ),
    'ownership', jsonb_build_object(
      'scope', 'single-user',
      'user_id_in_rows', false,
      'restore_owner', 'authenticated-user',
      'authentication_data_included', false
    ),
    'restore_policy', jsonb_build_object(
      'mode', 'replace',
      'preserve_task_ids', true,
      'preserve_history_ids', true,
      'preserve_timestamps', true
    ),
    'record_counts', jsonb_build_object(
      'tasks', c_tasks,
      'task_reviews', c_reviews,
      'task_events', c_events,
      'planner_settings', c_settings,
      'wellbeing_daily', c_wellbeing,
      'walking_logs', c_walking,
      'total', c_tasks + c_reviews + c_events + c_settings + c_wellbeing + c_walking
    ),
    'integrity', jsonb_build_object(
      'algorithm', 'SHA-256',
      'canonicalization', 'RFC8785',
      'scope', 'data',
      'sha256', null
    ),
    'data', jsonb_build_object(
      'tasks', v_tasks,
      'task_reviews', v_reviews,
      'task_events', v_events,
      'planner_settings', v_settings,
      'wellbeing_daily', v_wellbeing,
      'walking_logs', v_walking
    )
  );
end;
$$;

revoke all on function public.export_full_backup_v2() from public;
grant execute on function public.export_full_backup_v2() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Server-side structural validator
-- ---------------------------------------------------------------------------

create or replace function public.nmplanner_validate_full_backup_v2(p_backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_data jsonb;
  v_tasks jsonb := '[]'::jsonb; v_reviews jsonb := '[]'::jsonb; v_events jsonb := '[]'::jsonb;
  v_settings jsonb := '[]'::jsonb; v_wellbeing jsonb := '[]'::jsonb; v_walking jsonb := '[]'::jsonb;
  c_tasks integer := 0; c_reviews integer := 0; c_events integer := 0; c_settings integer := 0; c_wellbeing integer := 0; c_walking integer := 0;
  v_bad integer := 0; v_has_cycle boolean := false; v_legacy integer := 0; v_branches integer := 0;
begin
  if p_backup is null or jsonb_typeof(p_backup) <> 'object' then
    return jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_REQUEST','message','Backup must be a JSON object.')), 'warnings', '[]'::jsonb, 'ready_to_restore', false);
  end if;

  if p_backup->>'backup_format' is distinct from 'nmplanner.full-backup' then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_WRONG_FORMAT','message','This is not an NM Planner Full Backup v2 file.'));
  end if;
  if p_backup->'backup_version' is distinct from '2'::jsonb then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_UNSUPPORTED_VERSION','message','Only Full Backup version 2 is supported.'));
  end if;
  if p_backup->'backup_revision' is distinct from '0'::jsonb then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_UNSUPPORTED_REVISION','message','This Full Backup v2 revision is not supported.'));
  end if;
  if not public.nmplanner_is_uuid(p_backup->>'backup_id') then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_BACKUP_ID','message','Backup ID is missing or invalid.'));
  end if;
  if not public.nmplanner_is_timestamptz(p_backup->>'exported_at') then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_EXPORTED_AT','message','Export timestamp is missing or invalid.'));
  end if;

  v_data := p_backup->'data';
  if v_data is null or jsonb_typeof(v_data) <> 'object' then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_MISSING_DATA_SECTION','message','The backup data section is missing.'));
    return jsonb_build_object('errors', v_errors, 'warnings', v_warnings, 'ready_to_restore', false);
  end if;

  if jsonb_typeof(v_data->'tasks') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','tasks','message','tasks must be an array.'));
  else v_tasks := v_data->'tasks'; end if;
  if jsonb_typeof(v_data->'task_reviews') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','task_reviews','message','task_reviews must be an array.'));
  else v_reviews := v_data->'task_reviews'; end if;
  if jsonb_typeof(v_data->'task_events') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','task_events','message','task_events must be an array.'));
  else v_events := v_data->'task_events'; end if;
  if jsonb_typeof(v_data->'planner_settings') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','planner_settings','message','planner_settings must be an array.'));
  else v_settings := v_data->'planner_settings'; end if;
  if jsonb_typeof(v_data->'wellbeing_daily') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','wellbeing_daily','message','wellbeing_daily must be an array.'));
  else v_wellbeing := v_data->'wellbeing_daily'; end if;
  if jsonb_typeof(v_data->'walking_logs') <> 'array' then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_INVALID','dataset','walking_logs','message','walking_logs must be an array.'));
  else v_walking := v_data->'walking_logs'; end if;

  c_tasks := jsonb_array_length(v_tasks); c_reviews := jsonb_array_length(v_reviews); c_events := jsonb_array_length(v_events);
  c_settings := jsonb_array_length(v_settings); c_wellbeing := jsonb_array_length(v_wellbeing); c_walking := jsonb_array_length(v_walking);

  if c_tasks > 10000 or c_reviews > 50000 or c_events > 200000 or c_wellbeing > 10000 or c_walking > 50000 then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DATASET_TOO_LARGE','message','The backup exceeds the supported Full Backup v2 record limits.'));
  end if;

  if p_backup#>'{record_counts,tasks}' is distinct from to_jsonb(c_tasks)
     or p_backup#>'{record_counts,task_reviews}' is distinct from to_jsonb(c_reviews)
     or p_backup#>'{record_counts,task_events}' is distinct from to_jsonb(c_events)
     or p_backup#>'{record_counts,planner_settings}' is distinct from to_jsonb(c_settings)
     or p_backup#>'{record_counts,wellbeing_daily}' is distinct from to_jsonb(c_wellbeing)
     or p_backup#>'{record_counts,walking_logs}' is distinct from to_jsonb(c_walking)
     or p_backup#>'{record_counts,total}' is distinct from to_jsonb(c_tasks + c_reviews + c_events + c_settings + c_wellbeing + c_walking) then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_COUNT_MISMATCH','message','Record counts do not match the backup data arrays.'));
  end if;

  if c_settings <> 1 then
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('code', case when c_settings=0 then 'NMV2_SETTINGS_MISSING' else 'NMV2_SETTINGS_MULTIPLE' end, 'dataset','planner_settings','message','Full Backup v2 must contain exactly one planner settings record.'));
  end if;

  select count(*) into v_bad from jsonb_array_elements(v_tasks) j
  where jsonb_typeof(j) <> 'object'
     or not public.nmplanner_is_uuid(j->>'id')
     or jsonb_typeof(j->'title') <> 'string' or char_length(btrim(j->>'title')) not between 1 and 160
     or not public.nmplanner_is_monday(j->>'week')
     or (j->'day' <> 'null'::jsonb and (jsonb_typeof(j->'day') <> 'number' or not public.nmplanner_int_between(j->>'day',0,6)))
     or (j->'quadrant' <> 'null'::jsonb and coalesce(j->>'quadrant','') not in ('q1','q2','q3','q4'))
     or coalesce(j->>'area','') not in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')
     or not public.nmplanner_int_between(j->>'minutes',5,720)
     or (j->'actual_minutes' <> 'null'::jsonb and not public.nmplanner_int_between(j->>'actual_minutes',0,2880))
     or (j->'day_rank' <> 'null'::jsonb and not public.nmplanner_int_between(j->>'day_rank',1,99))
     or (j->'planned_start_minute' <> 'null'::jsonb and not public.nmplanner_valid_start_minute(j->>'planned_start_minute'))
     or jsonb_typeof(j->'completed') <> 'boolean'
     or jsonb_typeof(j->'superseded_by_followup') <> 'boolean'
     or not public.nmplanner_is_timestamptz(j->>'created_at')
     or not public.nmplanner_is_timestamptz(j->>'updated_at')
     or (j->'completed_at' <> 'null'::jsonb and not public.nmplanner_is_timestamptz(j->>'completed_at'))
     or (j->'discarded_at' <> 'null'::jsonb and not public.nmplanner_is_timestamptz(j->>'discarded_at'))
     or (j->'due' <> 'null'::jsonb and not public.nmplanner_is_date(j->>'due'))
     or (j->'parent_task_id' <> 'null'::jsonb and not public.nmplanner_is_uuid(j->>'parent_task_id'))
     or (j->'followup_reason' <> 'null'::jsonb and coalesce(j->>'followup_reason','') not in ('waiting_external','priority_shift','capacity','personal_delay','underestimated','scope_change','planned_continuation','other'))
     or (j->'rescheduled_from_week' <> 'null'::jsonb and not public.nmplanner_is_monday(j->>'rescheduled_from_week'))
     or (j->'rescheduled_to_week' <> 'null'::jsonb and not public.nmplanner_is_monday(j->>'rescheduled_to_week'));
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_TASK','dataset','tasks','count',v_bad,'message','One or more task records contain invalid fields.')); end if;

  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_tasks) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','tasks','count',v_bad,'message','Duplicate task IDs were found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) c
  where c->'parent_task_id' <> 'null'::jsonb
    and not exists (select 1 from jsonb_array_elements(v_tasks) p where p->>'id' = c->>'parent_task_id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_PARENT_NOT_FOUND','dataset','tasks','count',v_bad,'message','One or more follow-up parent tasks are missing from the backup.')); end if;

  with recursive edges as (
    select j->>'id' id, nullif(j->>'parent_task_id','') parent_id from jsonb_array_elements(v_tasks) j
  ), walk as (
    select id as start_id, parent_id as current_id, array[id]::text[] as path, false as cycle from edges
    union all
    select w.start_id, e.parent_id, w.path || e.id, e.id = any(w.path)
    from walk w join edges e on e.id = w.current_id
    where w.current_id is not null and not w.cycle
  )
  select exists(select 1 from walk where cycle) into v_has_cycle;
  if v_has_cycle then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_PARENT_CYCLE','dataset','tasks','message','A follow-up cycle was found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where coalesce((p->>'superseded_by_followup')::boolean,false)
    and not exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Superseded tasks without follow-up children were found.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where not coalesce((p->>'superseded_by_followup')::boolean,false)
    and p->'discarded_at' = 'null'::jsonb
    and exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Parents with follow-up children must be historical/superseded.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_tasks) p
  where p->'discarded_at' <> 'null'::jsonb and coalesce((p->>'completed')::boolean,false);
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Discarded tasks cannot also be marked completed.')); end if;

  select count(*) into v_bad
  from jsonb_array_elements(v_tasks) p
  where p->'discarded_at' <> 'null'::jsonb
    and exists (select 1 from jsonb_array_elements(v_tasks) c where c->>'parent_task_id'=p->>'id');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_LIFECYCLE_INVALID','dataset','tasks','count',v_bad,'message','Discarded tasks cannot have active follow-up children.')); end if;

  if v_bad = 0 then null; end if;

  select count(*) into v_bad from jsonb_array_elements(v_reviews) j
  where jsonb_typeof(j) <> 'object'
     or coalesce(j->>'id','') !~ '^\d+$'
     or not public.nmplanner_is_uuid(j->>'task_id')
     or jsonb_typeof(j->'task_snapshot') <> 'object'
     or (j->'task_snapshot' ? 'user_id' and j#>>'{task_snapshot,user_id}' <> '__OWNER__')
     or coalesce(j->>'action','') not in ('moved','discarded')
     or coalesce(j->>'reason','') not in ('waiting_external','priority_shift','capacity','personal_delay','underestimated','scope_change','planned_continuation','other')
     or coalesce(j->>'review_source','') not in ('legacy','end_of_day','planned_reschedule')
     or not public.nmplanner_is_date(j->>'from_date')
     or not public.nmplanner_is_timestamptz(j->>'occurred_at')
     or (j->>'action'='moved' and (j->'to_date'='null'::jsonb or not public.nmplanner_is_date(j->>'to_date') or j->>'to_date'=j->>'from_date'))
     or (j->>'action'='discarded' and j->'to_date'<>'null'::jsonb);
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_REVIEW','dataset','task_reviews','count',v_bad,'message','One or more review records are invalid.')); end if;
  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_reviews) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','task_reviews','count',v_bad,'message','Duplicate review IDs were found.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_events) j
  where jsonb_typeof(j) <> 'object'
     or coalesce(j->>'id','') !~ '^\d+$'
     or (j->'task_id' <> 'null'::jsonb and not public.nmplanner_is_uuid(j->>'task_id'))
     or coalesce(j->>'event_type','') not in ('created','updated','deleted')
     or not public.nmplanner_is_timestamptz(j->>'occurred_at')
     or (j->'old_data' is not null and j->'old_data'<>'null'::jsonb and jsonb_typeof(j->'old_data')<>'object')
     or (j->'new_data' is not null and j->'new_data'<>'null'::jsonb and jsonb_typeof(j->'new_data')<>'object')
     or (j->'old_data' ? 'user_id' and j#>>'{old_data,user_id}' <> '__OWNER__')
     or (j->'new_data' ? 'user_id' and j#>>'{new_data,user_id}' <> '__OWNER__')
     or (j->>'event_type'='created' and (j->'old_data'<>'null'::jsonb or jsonb_typeof(j->'new_data')<>'object'))
     or (j->>'event_type'='updated' and (jsonb_typeof(j->'old_data')<>'object' or jsonb_typeof(j->'new_data')<>'object'))
     or (j->>'event_type'='deleted' and (jsonb_typeof(j->'old_data')<>'object' or j->'new_data'<>'null'::jsonb));
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_EVENT','dataset','task_events','count',v_bad,'message','One or more task-history events are invalid.')); end if;
  select count(*) - count(distinct j->>'id') into v_bad from jsonb_array_elements(v_events) j;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','task_events','count',v_bad,'message','Duplicate task-event IDs were found.')); end if;

  if c_settings = 1 then
    select count(*) into v_bad from jsonb_array_elements(v_settings) s
    where jsonb_typeof(s)<>'object'
      or char_length(btrim(coalesce(s->>'work_name',''))) not between 1 and 60
      or char_length(btrim(coalesce(s->>'additional_work_name',''))) not between 1 and 60
      or lower(btrim(s->>'work_name')) = lower(btrim(s->>'additional_work_name'))
      or not public.nmplanner_int_between(s->>'work_weekly_minutes',60,10080)
      or not public.nmplanner_int_between(s->>'work_daily_minutes',30,1440)
      or not public.nmplanner_int_between(s->>'q1_daily_minutes',15,1440)
      or not public.nmplanner_int_between(s->>'q2_daily_minutes',15,1440)
      or not public.nmplanner_int_between(s->>'worldskills_weekly_minutes',0,10080)
      or not public.nmplanner_int_between(s->>'family_daily_minutes',0,1440)
      or not public.nmplanner_int_between(s->>'personal_daily_minutes',0,1440)
      or not public.nmplanner_numeric_between(s->>'sleep_daily_hours',0,24)
      or not public.nmplanner_int_between(s->>'steps_per_mile',500,5000)
      or not public.nmplanner_is_timestamptz(s->>'created_at')
      or not public.nmplanner_is_timestamptz(s->>'updated_at');
    if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_SETTINGS','dataset','planner_settings','message','Planner settings are invalid.')); end if;
  end if;

  select count(*) into v_bad from jsonb_array_elements(v_wellbeing) w
  where jsonb_typeof(w)<>'object' or not public.nmplanner_is_date(w->>'entry_date')
    or (w->'sleep_hours'<>'null'::jsonb and not public.nmplanner_numeric_between(w->>'sleep_hours',0,24))
    or not public.nmplanner_is_timestamptz(w->>'created_at') or not public.nmplanner_is_timestamptz(w->>'updated_at');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_WELLBEING','dataset','wellbeing_daily','count',v_bad,'message','One or more wellbeing records are invalid.')); end if;
  select count(*) - count(distinct w->>'entry_date') into v_bad from jsonb_array_elements(v_wellbeing) w;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','wellbeing_daily','count',v_bad,'message','Duplicate wellbeing dates were found.')); end if;

  select count(*) into v_bad from jsonb_array_elements(v_walking) w
  where jsonb_typeof(w)<>'object' or coalesce(w->>'id','') !~ '^\d+$'
    or not public.nmplanner_is_date(w->>'walk_date')
    or coalesce(w->>'area','') not in ('BCU / Teaching','Research','WorldSkills','Family / Home','Personal Time')
    or not public.nmplanner_numeric_between(w->>'miles',0.000001,100)
    or not public.nmplanner_is_timestamptz(w->>'created_at');
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_INVALID_WALKING','dataset','walking_logs','count',v_bad,'message','One or more walking records are invalid.')); end if;
  select count(*) - count(distinct w->>'id') into v_bad from jsonb_array_elements(v_walking) w;
  if v_bad > 0 then v_errors := v_errors || jsonb_build_array(jsonb_build_object('code','NMV2_DUPLICATE_ID','dataset','walking_logs','count',v_bad,'message','Duplicate walking-log IDs were found.')); end if;

  select count(*) into v_legacy from jsonb_array_elements(v_reviews) r where r->>'review_source'='legacy';
  if v_legacy > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code','NMV2_LEGACY_REVIEWS','count',v_legacy,'message','Some review records pre-date review-source classification.')); end if;

  select count(*) into v_branches from (
    select p->>'id'
    from jsonb_array_elements(v_tasks) p
    where (select count(*) from jsonb_array_elements(v_tasks) c
           where c->>'parent_task_id'=p->>'id'
             and not coalesce((c->>'completed')::boolean,false)
             and not coalesce((c->>'superseded_by_followup')::boolean,false)
             and c->'discarded_at'='null'::jsonb
             and not exists (select 1 from jsonb_array_elements(v_tasks) gc where gc->>'parent_task_id'=c->>'id')) > 1
  ) q;
  if v_branches > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code','NMV2_MULTIPLE_OPEN_BRANCHES','count',v_branches,'message','Some follow-up families have more than one open terminal branch.')); end if;

  return jsonb_build_object(
    'errors', v_errors,
    'warnings', v_warnings,
    'ready_to_restore', jsonb_array_length(v_errors)=0,
    'record_counts', jsonb_build_object('tasks',c_tasks,'task_reviews',c_reviews,'task_events',c_events,'planner_settings',c_settings,'wellbeing_daily',c_wellbeing,'walking_logs',c_walking,'total',c_tasks+c_reviews+c_events+c_settings+c_wellbeing+c_walking),
    'checks', jsonb_build_object(
      'format_valid', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_WRONG_FORMAT'),
      'version_supported', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code' in ('NMV2_UNSUPPORTED_VERSION','NMV2_UNSUPPORTED_REVISION')),
      'record_counts_match', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_COUNT_MISMATCH'),
      'followup_cycles_absent', not v_has_cycle,
      'lifecycle_consistent', not exists(select 1 from jsonb_array_elements(v_errors) e where e->>'code'='NMV2_LIFECYCLE_INVALID')
    )
  );
end;
$$;

revoke all on function public.nmplanner_validate_full_backup_v2(jsonb) from public;

-- ---------------------------------------------------------------------------
-- 5. Two-phase restore RPC
-- ---------------------------------------------------------------------------

create or replace function public.restore_full_backup_v2(
  p_backup jsonb,
  p_dry_run boolean default true,
  p_confirmation_backup_id uuid default null,
  p_expected_current_state_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_validation jsonb;
  v_backup_id uuid;
  v_current_hash text;
  v_new_hash text;
  v_data jsonb;
  v_before jsonb;
  v_expected jsonb;
  v_actual jsonb;
  v_started timestamptz := clock_timestamp();
  v_completed timestamptz;
  v_bad integer := 0;
  v_seq text;
begin
  if v_user_id is null then
    raise exception using errcode='42501', message='NM Planner restore failed', detail='{"code":"NMV2_NOT_AUTHENTICATED"}';
  end if;

  v_validation := public.nmplanner_validate_full_backup_v2(p_backup);
  v_current_hash := public.nmplanner_state_hash(v_user_id);

  select jsonb_build_object(
    'tasks',(select count(*) from public.tasks where user_id=v_user_id),
    'task_reviews',(select count(*) from public.task_reviews where user_id=v_user_id),
    'task_events',(select count(*) from public.task_events where user_id=v_user_id),
    'planner_settings',(select count(*) from public.planner_settings where user_id=v_user_id),
    'wellbeing_daily',(select count(*) from public.wellbeing_daily where user_id=v_user_id),
    'walking_logs',(select count(*) from public.walking_logs where user_id=v_user_id)
  ) into v_before;

  if p_dry_run then
    return jsonb_build_object(
      'ok', (v_validation->>'ready_to_restore')::boolean,
      'operation','preflight',
      'backup_format',p_backup->>'backup_format',
      'backup_version',p_backup->'backup_version',
      'backup_revision',p_backup->'backup_revision',
      'backup_id',p_backup->>'backup_id',
      'compatible',(v_validation->>'ready_to_restore')::boolean,
      'current_state',jsonb_build_object('state_hash',v_current_hash,'record_counts',v_before),
      'incoming',jsonb_build_object('record_counts',v_validation->'record_counts'),
      'validation',jsonb_build_object('errors',v_validation->'errors','warnings',v_validation->'warnings','checks',v_validation->'checks'),
      'ready_to_restore',(v_validation->>'ready_to_restore')::boolean
    );
  end if;

  if not (v_validation->>'ready_to_restore')::boolean then
    raise exception using errcode='P0001', message='NM Planner restore failed',
      detail=jsonb_build_object('code','NMV2_INVALID_BACKUP','errors',v_validation->'errors')::text;
  end if;

  v_backup_id := (p_backup->>'backup_id')::uuid;
  if p_confirmation_backup_id is null or p_confirmation_backup_id <> v_backup_id then
    raise exception using errcode='P0001', message='NM Planner restore failed', detail='{"code":"NMV2_CONFIRMATION_REQUIRED"}';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('nmplanner-full-restore|' || v_user_id::text,0));
  v_current_hash := public.nmplanner_state_hash(v_user_id);
  if p_expected_current_state_hash is null or p_expected_current_state_hash <> v_current_hash then
    raise exception using errcode='P0001', message='NM Planner restore failed',
      detail=jsonb_build_object('code','NMV2_CURRENT_STATE_CHANGED','current_state_hash',v_current_hash)::text;
  end if;

  -- Prevent sequence races while explicit historical identity values are restored.
  lock table public.task_reviews, public.task_events, public.walking_logs in share row exclusive mode;
  perform set_config('nmplanner.restore_mode','on',true);
  v_data := p_backup->'data';
  v_expected := v_validation->'record_counts';

  delete from public.task_reviews where user_id=v_user_id;
  delete from public.task_events where user_id=v_user_id;
  delete from public.walking_logs where user_id=v_user_id;
  delete from public.wellbeing_daily where user_id=v_user_id;
  delete from public.planner_settings where user_id=v_user_id;
  delete from public.tasks where user_id=v_user_id;

  -- Pass 1: restore task bodies with parent links temporarily NULL.
  insert into public.tasks (
    id,user_id,parent_task_id,title,week,quadrant,day,area,due,minutes,actual_minutes,day_rank,planned_start_minute,
    notes,completed,completed_at,followup_reason,rescheduled_from_week,rescheduled_to_week,
    superseded_by_followup,discarded_at,created_at,updated_at
  )
  select
    (j->>'id')::uuid,v_user_id,null,(j->>'title'),(j->>'week')::date,nullif(j->>'quadrant',''),
    case when j->'day'='null'::jsonb then null else (j->>'day')::smallint end,
    j->>'area',case when j->'due'='null'::jsonb then null else (j->>'due')::date end,
    (j->>'minutes')::smallint,case when j->'actual_minutes'='null'::jsonb then null else (j->>'actual_minutes')::integer end,
    case when j->'day_rank'='null'::jsonb then null else (j->>'day_rank')::integer end,
    case when j->'planned_start_minute'='null'::jsonb then null else (j->>'planned_start_minute')::smallint end,
    coalesce(j->>'notes',''),(j->>'completed')::boolean,
    case when j->'completed_at'='null'::jsonb then null else (j->>'completed_at')::timestamptz end,
    case when j->'followup_reason'='null'::jsonb then null else j->>'followup_reason' end,
    case when j->'rescheduled_from_week'='null'::jsonb then null else (j->>'rescheduled_from_week')::date end,
    case when j->'rescheduled_to_week'='null'::jsonb then null else (j->>'rescheduled_to_week')::date end,
    (j->>'superseded_by_followup')::boolean,
    case when j->'discarded_at'='null'::jsonb then null else (j->>'discarded_at')::timestamptz end,
    (j->>'created_at')::timestamptz,(j->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'tasks') j;

  -- Pass 2: restore relationships after every task UUID exists.
  update public.tasks t
  set parent_task_id=(j->>'parent_task_id')::uuid
  from jsonb_array_elements(v_data->'tasks') j
  where t.user_id=v_user_id and t.id=(j->>'id')::uuid and j->'parent_task_id'<>'null'::jsonb;

  insert into public.planner_settings (
    user_id,work_name,additional_work_name,work_weekly_minutes,work_daily_minutes,q1_daily_minutes,q2_daily_minutes,
    worldskills_weekly_minutes,family_daily_minutes,personal_daily_minutes,sleep_daily_hours,steps_per_mile,created_at,updated_at
  )
  select v_user_id,s->>'work_name',s->>'additional_work_name',(s->>'work_weekly_minutes')::integer,(s->>'work_daily_minutes')::integer,
    (s->>'q1_daily_minutes')::integer,(s->>'q2_daily_minutes')::integer,(s->>'worldskills_weekly_minutes')::integer,
    (s->>'family_daily_minutes')::integer,(s->>'personal_daily_minutes')::integer,(s->>'sleep_daily_hours')::numeric,
    (s->>'steps_per_mile')::integer,(s->>'created_at')::timestamptz,(s->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'planner_settings') s;

  insert into public.wellbeing_daily (user_id,entry_date,sleep_hours,created_at,updated_at)
  select v_user_id,(w->>'entry_date')::date,
    case when w->'sleep_hours'='null'::jsonb then null else (w->>'sleep_hours')::numeric end,
    (w->>'created_at')::timestamptz,(w->>'updated_at')::timestamptz
  from jsonb_array_elements(v_data->'wellbeing_daily') w;

  insert into public.walking_logs (id,user_id,walk_date,area,miles,created_at)
  overriding system value
  select (w->>'id')::bigint,v_user_id,(w->>'walk_date')::date,w->>'area',(w->>'miles')::numeric,(w->>'created_at')::timestamptz
  from jsonb_array_elements(v_data->'walking_logs') w;

  insert into public.task_reviews (id,user_id,task_id,task_snapshot,action,reason,from_date,to_date,occurred_at,review_source)
  overriding system value
  select (r->>'id')::bigint,v_user_id,(r->>'task_id')::uuid,public.nmplanner_restore_snapshot(r->'task_snapshot',v_user_id),
    r->>'action',r->>'reason',(r->>'from_date')::date,
    case when r->'to_date'='null'::jsonb then null else (r->>'to_date')::date end,
    (r->>'occurred_at')::timestamptz,r->>'review_source'
  from jsonb_array_elements(v_data->'task_reviews') r;

  insert into public.task_events (id,user_id,task_id,event_type,old_data,new_data,occurred_at)
  overriding system value
  select (e->>'id')::bigint,v_user_id,
    case when e->'task_id'='null'::jsonb then null else (e->>'task_id')::uuid end,
    e->>'event_type',public.nmplanner_restore_snapshot(e->'old_data',v_user_id),public.nmplanner_restore_snapshot(e->'new_data',v_user_id),
    (e->>'occurred_at')::timestamptz
  from jsonb_array_elements(v_data->'task_events') e;

  -- Advance identities to the global maximum. Table locks above prevent races.
  v_seq := pg_get_serial_sequence('public.task_reviews','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.task_reviews),1),1), (select count(*)>0 from public.task_reviews)); end if;
  v_seq := pg_get_serial_sequence('public.task_events','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.task_events),1),1), (select count(*)>0 from public.task_events)); end if;
  v_seq := pg_get_serial_sequence('public.walking_logs','id');
  if v_seq is not null then perform setval(v_seq, greatest(coalesce((select max(id) from public.walking_logs),1),1), (select count(*)>0 from public.walking_logs)); end if;

  perform set_config('nmplanner.restore_mode','off',true);

  select jsonb_build_object(
    'tasks',(select count(*) from public.tasks where user_id=v_user_id),
    'task_reviews',(select count(*) from public.task_reviews where user_id=v_user_id),
    'task_events',(select count(*) from public.task_events where user_id=v_user_id),
    'planner_settings',(select count(*) from public.planner_settings where user_id=v_user_id),
    'wellbeing_daily',(select count(*) from public.wellbeing_daily where user_id=v_user_id),
    'walking_logs',(select count(*) from public.walking_logs where user_id=v_user_id)
  ) into v_actual;

  if v_actual->'tasks' is distinct from v_expected->'tasks'
     or v_actual->'task_reviews' is distinct from v_expected->'task_reviews'
     or v_actual->'task_events' is distinct from v_expected->'task_events'
     or v_actual->'planner_settings' is distinct from v_expected->'planner_settings'
     or v_actual->'wellbeing_daily' is distinct from v_expected->'wellbeing_daily'
     or v_actual->'walking_logs' is distinct from v_expected->'walking_logs' then
    raise exception using errcode='P0001', message='NM Planner restore failed', detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','record_counts','expected',v_expected,'actual',v_actual)::text;
  end if;

  select count(*) into v_bad from public.tasks p
  where p.user_id=v_user_id and coalesce(p.superseded_by_followup,false)
    and not exists(select 1 from public.tasks c where c.user_id=v_user_id and c.parent_task_id=p.id);
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','superseded_without_child','count',v_bad)::text; end if;

  select count(*) into v_bad from public.tasks p
  where p.user_id=v_user_id and not coalesce(p.superseded_by_followup,false) and p.discarded_at is null
    and exists(select 1 from public.tasks c where c.user_id=v_user_id and c.parent_task_id=p.id);
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','parent_with_child_not_superseded','count',v_bad)::text; end if;

  select count(*) into v_bad from public.tasks t
  where t.user_id=v_user_id and t.discarded_at is not null and t.completed;
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','discarded_completed','count',v_bad)::text; end if;

  select count(*) into v_bad
  from public.tasks a join public.tasks b on b.user_id=a.user_id and b.week=a.week and b.day=a.day and b.id>a.id
  where a.user_id=v_user_id and not a.completed and not b.completed
    and not coalesce(a.superseded_by_followup,false) and not coalesce(b.superseded_by_followup,false)
    and a.discarded_at is null and b.discarded_at is null
    and a.planned_start_minute is not null and b.planned_start_minute is not null
    and a.planned_start_minute < b.planned_start_minute + b.minutes
    and b.planned_start_minute < a.planned_start_minute + a.minutes;
  if v_bad>0 then raise exception using errcode='P0001',message='NM Planner restore failed',detail=jsonb_build_object('code','NMV2_POST_VERIFY_FAILED','check','open_timeline_overlaps','count',v_bad)::text; end if;

  v_new_hash := public.nmplanner_state_hash(v_user_id);
  v_completed := clock_timestamp();

  return jsonb_build_object(
    'ok',true,'operation','restore','status','committed',
    'backup',jsonb_build_object('backup_id',v_backup_id,'backup_version',2,'backup_revision',0,'exported_at',p_backup->>'exported_at'),
    'restore',jsonb_build_object('started_at',v_started,'completed_at',v_completed,'mode','replace','previous_record_counts',v_before,'restored_record_counts',v_actual),
    'verification',jsonb_build_object('passed',true,'counts_match',true,'followup_integrity',true,'lifecycle_integrity',true,'settings_integrity',true,'timeline_integrity',true),
    'warnings',v_validation->'warnings',
    'new_state_hash',v_new_hash
  );
exception when others then
  -- Never convert an actual write failure into a normal response; rethrow so the
  -- entire PostgreSQL function transaction is rolled back.
  raise;
end;
$$;

revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;

commit;