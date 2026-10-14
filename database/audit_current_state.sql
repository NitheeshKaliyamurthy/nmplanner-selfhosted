-- NM Planner read-only operational audit.
-- Run AFTER database/016_operational_consistency.sql.
-- This script does not modify any data.
--
-- The first audit window is the week containing Friday 11 September 2026,
-- because that is the week where the Q1 capacity mismatch was reported.

with
params as (
  select date '2026-09-07' as week_start, 4::integer as friday_index
),
friday_q1 as (
  select t.*
  from public.tasks t, params p
  where t.week = p.week_start
    and t.day = p.friday_index
    and t.quadrant = 'q1'
),
friday_totals as (
  select jsonb_build_object(
    'week_start', (select week_start from params),
    'date', (select week_start + friday_index from params),
    'operational_planned_minutes', coalesce(sum(minutes) filter (
      where not coalesce(superseded_by_followup, false) and discarded_at is null
    ), 0),
    'operational_open_minutes', coalesce(sum(minutes) filter (
      where not coalesce(superseded_by_followup, false) and discarded_at is null and not completed
    ), 0),
    'operational_completed_minutes', coalesce(sum(minutes) filter (
      where not coalesce(superseded_by_followup, false) and discarded_at is null and completed
    ), 0),
    'superseded_history_minutes', coalesce(sum(minutes) filter (
      where coalesce(superseded_by_followup, false)
    ), 0),
    'discarded_minutes', coalesce(sum(minutes) filter (
      where discarded_at is not null
    ), 0),
    'row_count', count(*)
  ) as result
  from friday_q1
),
friday_detail as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'title', title,
      'minutes', minutes,
      'completed', completed,
      'superseded', coalesce(superseded_by_followup, false),
      'discarded_at', discarded_at,
      'parent_task_id', parent_task_id,
      'week', week,
      'day', day,
      'planned_start_minute', planned_start_minute,
      'area', area
    ) order by completed, superseded_by_followup, planned_start_minute nulls last, created_at
  ), '[]'::jsonb) as result
  from friday_q1
),
week_q1 as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'day_index', d.day_index,
      'planned_minutes', d.planned_minutes,
      'open_minutes', d.open_minutes,
      'completed_minutes', d.completed_minutes
    ) order by d.day_index
  ), '[]'::jsonb) as result
  from (
    select day as day_index,
      coalesce(sum(minutes) filter (
        where not coalesce(superseded_by_followup, false) and discarded_at is null
      ), 0)::integer as planned_minutes,
      coalesce(sum(minutes) filter (
        where not coalesce(superseded_by_followup, false) and discarded_at is null and not completed
      ), 0)::integer as open_minutes,
      coalesce(sum(minutes) filter (
        where not coalesce(superseded_by_followup, false) and discarded_at is null and completed
      ), 0)::integer as completed_minutes
    from public.tasks, params
    where week = params.week_start
      and quadrant = 'q1'
      and day is not null
    group by day
  ) d
),
settings as (
  select coalesce(
    jsonb_agg(to_jsonb(s) - 'user_id' - 'created_at' - 'updated_at'),
    '[]'::jsonb
  ) as result
  from public.planner_settings s
),
triggers as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'trigger', tg.tgname,
      'function', p.proname,
      'enabled', tg.tgenabled
    ) order by tg.tgname
  ), '[]'::jsonb) as result
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = tg.tgfoid
  where n.nspname = 'public'
    and c.relname = 'tasks'
    and not tg.tgisinternal
),
lifecycle_anomalies as (
  select jsonb_build_object(
    'superseded_without_child', (
      select count(*) from public.tasks parent
      where coalesce(parent.superseded_by_followup, false)
        and not exists (
          select 1 from public.tasks child
          where child.parent_task_id = parent.id and child.user_id = parent.user_id
        )
    ),
    'parent_with_child_not_superseded', (
      select count(*) from public.tasks parent
      where not coalesce(parent.superseded_by_followup, false)
        and parent.discarded_at is null
        and exists (
          select 1 from public.tasks child
          where child.parent_task_id = parent.id and child.user_id = parent.user_id
        )
    ),
    'discarded_rows_still_completed', (
      select count(*) from public.tasks
      where discarded_at is not null and completed
    ),
    'discarded_rows_with_children', (
      select count(*) from public.tasks parent
      where parent.discarded_at is not null
        and exists (select 1 from public.tasks child where child.parent_task_id = parent.id)
    ),
    'superseded_history_missing_day', (
      select count(*) from public.tasks
      where coalesce(superseded_by_followup, false) and day is null
    )
  ) as result
),
history_metadata as (
  -- Missing clock time is informational, not automatically an anomaly: many
  -- tasks were never deliberately placed on the 15-minute timeline.
  select jsonb_build_object(
    'superseded_history_rows', count(*) filter (where coalesce(superseded_by_followup, false)),
    'superseded_history_without_day', count(*) filter (
      where coalesce(superseded_by_followup, false) and day is null
    ),
    'superseded_history_without_start_time', count(*) filter (
      where coalesce(superseded_by_followup, false) and planned_start_minute is null
    ),
    'superseded_history_with_start_time', count(*) filter (
      where coalesce(superseded_by_followup, false) and planned_start_minute is not null
    )
  ) as result
  from public.tasks
),
review_sources as (
  select coalesce(jsonb_object_agg(review_source, total), '{}'::jsonb) as result
  from (
    select review_source, count(*)::integer as total
    from public.task_reviews
    group by review_source
  ) r
),
active_branch_families as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'parent_id', parent_id,
      'open_terminal_children', open_terminal_children
    ) order by open_terminal_children desc
  ), '[]'::jsonb) as result
  from (
    select c.parent_task_id as parent_id, count(*)::integer as open_terminal_children
    from public.tasks c
    where c.parent_task_id is not null
      and not c.completed
      and c.discarded_at is null
      and not coalesce(c.superseded_by_followup, false)
      and not exists (
        select 1 from public.tasks gc where gc.parent_task_id = c.id
      )
    group by c.parent_task_id
    having count(*) > 1
  ) branches
)
select section, result
from (
  select 1 as sort_order, 'planner_settings'::text as section, result from settings
  union all
  select 2, 'friday_2026_09_11_q1_totals', result from friday_totals
  union all
  select 3, 'friday_2026_09_11_q1_rows', result from friday_detail
  union all
  select 4, 'week_q1_by_day', result from week_q1
  union all
  select 5, 'task_triggers', result from triggers
  union all
  select 6, 'lifecycle_anomalies', result from lifecycle_anomalies
  union all
  select 7, 'history_metadata', result from history_metadata
  union all
  select 8, 'review_sources', result from review_sources
  union all
  select 9, 'families_with_multiple_open_terminal_branches', result from active_branch_families
) audit
order by sort_order;
