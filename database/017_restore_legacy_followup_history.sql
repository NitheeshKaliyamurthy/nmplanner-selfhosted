-- NM Planner: evidence-based repair of legacy follow-up history metadata.
--
-- Run AFTER database/016_operational_consistency.sql.
--
-- Why this exists:
-- Older follow-up migrations moved parent/history rows into later weeks and then
-- cleared day/planned_start_minute so they would stop consuming capacity. The
-- current operational model no longer needs that destructive workaround:
-- superseded_by_followup=true explicitly excludes history from current capacity.
--
-- Recovery rule:
--   * only superseded history rows whose day is currently NULL are repaired;
--   * week + day are restored from the latest task_events state that proves a day;
--   * planned_start_minute is restored only when task_events proves a prior time;
--   * rows with no historical time evidence remain NULL (this is valid);
--   * follow-up reason/carry-forward metadata is not rewritten.
--
-- The repair is idempotent: after the missing days are restored there are no
-- candidates on a subsequent run.

begin;

-- Restoring a historical week should not make the older follow-up-reschedule
-- trigger reinterpret or rewrite rescheduled_from_week/rescheduled_to_week.
alter table public.tasks disable trigger prepare_followup_reschedule_trigger;

with legacy as (
  select t.id
  from public.tasks t
  where coalesce(t.superseded_by_followup, false)
    and t.day is null
),
all_states as (
  select
    e.task_id,
    e.occurred_at,
    e.old_data as state_json,
    'old_data'::text as state_source
  from public.task_events e
  join legacy l on l.id = e.task_id
  where e.old_data is not null

  union all

  select
    e.task_id,
    e.occurred_at,
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
    s.state_source,
    nullif(s.state_json ->> 'week', '')::date as state_week,
    case
      when s.state_json ? 'day'
           and nullif(s.state_json ->> 'day', '') is not null
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
    state_day as recovered_day
  from parsed
  where state_week is not null
    and extract(isodow from state_week) = 1
    and state_day between 0 and 6
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
best_time as (
  select distinct on (task_id)
    task_id,
    state_start as recovered_start_minute
  from parsed
  where state_start between 0 and 1439
  order by task_id, occurred_at desc,
    case when state_source = 'old_data' then 0 else 1 end
),
recovery as (
  select
    d.task_id,
    d.recovered_week,
    d.recovered_day,
    tm.recovered_start_minute
  from best_day d
  left join best_time tm on tm.task_id = d.task_id
)
update public.tasks t
set week = r.recovered_week,
    day = r.recovered_day,
    planned_start_minute = case
      when t.planned_start_minute is null then r.recovered_start_minute
      else t.planned_start_minute
    end
from recovery r
where t.id = r.task_id
  and coalesce(t.superseded_by_followup, false)
  and t.day is null;

alter table public.tasks enable trigger prepare_followup_reschedule_trigger;

commit;
