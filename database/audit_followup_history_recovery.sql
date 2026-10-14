-- NM Planner read-only audit: can legacy follow-up history dates/times be recovered?
-- Run after database/016_operational_consistency.sql.
-- This script does NOT modify data.
--
-- It inspects superseded follow-up history rows that currently have day/time missing
-- and searches task_events for the latest earlier task state where those values were
-- still present. Use the result to decide whether a targeted repair is evidence-based.

with legacy as (
  select
    t.id,
    t.user_id,
    t.title,
    t.parent_task_id,
    t.week as current_week,
    t.day as current_day,
    t.planned_start_minute as current_start,
    t.minutes,
    t.created_at,
    t.updated_at
  from public.tasks t
  where coalesce(t.superseded_by_followup, false)
    and (t.day is null or t.planned_start_minute is null)
),
all_states as (
  select
    e.task_id,
    e.occurred_at,
    e.event_type,
    e.old_data as state_json,
    'old_data'::text as state_source
  from public.task_events e
  join legacy l on l.id = e.task_id
  where e.old_data is not null

  union all

  select
    e.task_id,
    e.occurred_at,
    e.event_type,
    e.new_data as state_json,
    'new_data'::text as state_source
  from public.task_events e
  join legacy l on l.id = e.task_id
  where e.new_data is not null
),
parsed as (
  select
    s.task_id,
    s.occurred_at,
    s.event_type,
    s.state_source,
    nullif(s.state_json ->> 'week', '')::date as state_week,
    case
      when s.state_json ? 'day' and nullif(s.state_json ->> 'day', '') is not null
        then (s.state_json ->> 'day')::integer
      else null
    end as state_day,
    case
      when s.state_json ? 'planned_start_minute'
           and nullif(s.state_json ->> 'planned_start_minute', '') is not null
        then (s.state_json ->> 'planned_start_minute')::integer
      else null
    end as state_start
  from all_states s
),
best_day as (
  select distinct on (task_id)
    task_id,
    state_week as recovered_week,
    state_day as recovered_day,
    occurred_at as recovered_day_event_at,
    event_type as recovered_day_event_type,
    state_source as recovered_day_source
  from parsed
  where state_day between 0 and 6
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
best_time as (
  select distinct on (task_id)
    task_id,
    state_start as recovered_start_minute,
    occurred_at as recovered_time_event_at,
    event_type as recovered_time_event_type,
    state_source as recovered_time_source
  from parsed
  where state_start between 0 and 1439
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
detail as (
  select
    l.id,
    l.title,
    l.parent_task_id,
    l.current_week,
    l.current_day,
    l.current_start,
    d.recovered_week,
    d.recovered_day,
    case
      when d.recovered_week is not null and d.recovered_day is not null
        then d.recovered_week + d.recovered_day
      else null
    end as recovered_date,
    d.recovered_day_event_at,
    d.recovered_day_event_type,
    d.recovered_day_source,
    tm.recovered_start_minute,
    tm.recovered_time_event_at,
    tm.recovered_time_event_type,
    tm.recovered_time_source,
    case when d.recovered_day is not null then true else false end as day_recoverable,
    case when tm.recovered_start_minute is not null then true else false end as time_recoverable
  from legacy l
  left join best_day d on d.task_id = l.id
  left join best_time tm on tm.task_id = l.id
),
summary as (
  select jsonb_build_object(
    'legacy_superseded_rows_checked', count(*),
    'missing_day_now', count(*) filter (where current_day is null),
    'day_recoverable_from_task_events', count(*) filter (where current_day is null and day_recoverable),
    'day_not_recoverable_from_task_events', count(*) filter (where current_day is null and not day_recoverable),
    'missing_start_time_now', count(*) filter (where current_start is null),
    'time_recoverable_from_task_events', count(*) filter (where current_start is null and time_recoverable),
    'time_not_recoverable_from_task_events', count(*) filter (where current_start is null and not time_recoverable)
  ) as result
  from detail
),
rows_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'title', title,
    'parent_task_id', parent_task_id,
    'current_week', current_week,
    'current_day', current_day,
    'current_start_minute', current_start,
    'recovered_week', recovered_week,
    'recovered_day', recovered_day,
    'recovered_date', recovered_date,
    'recovered_start_minute', recovered_start_minute,
    'day_recoverable', day_recoverable,
    'time_recoverable', time_recoverable,
    'day_evidence_at', recovered_day_event_at,
    'day_evidence_type', recovered_day_event_type,
    'day_evidence_source', recovered_day_source,
    'time_evidence_at', recovered_time_event_at,
    'time_evidence_type', recovered_time_event_type,
    'time_evidence_source', recovered_time_source
  ) order by recovered_date nulls last, title), '[]'::jsonb) as result
  from detail
)
select 'summary'::text as section, result from summary
union all
select 'rows'::text as section, result from rows_json;
