-- NM Planner read-only security and isolation audit.
-- Run in Supabase SQL Editor after the latest migrations.
-- This script does NOT modify schema or data.

with managed_tables(table_name) as (
  values
    ('tasks'),
    ('task_events'),
    ('task_reviews'),
    ('planner_settings'),
    ('wellbeing_daily'),
    ('walking_logs'),
    ('external_calendar_events'),
    ('calendar_classification_rules'),
    ('calendar_sync_state'),
    ('monthly_summaries'),
    ('archive_log'),
    ('calendar_overlap_overrides')
),
rls_status as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'table', mt.table_name,
    'exists', c.oid is not null,
    'rls_enabled', coalesce(c.relrowsecurity, false),
    'force_rls', coalesce(c.relforcerowsecurity, false),
    'owner', case when c.oid is null then null else pg_get_userbyid(c.relowner) end
  ) order by mt.table_name), '[]'::jsonb) as result
  from managed_tables mt
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class c on c.relnamespace = n.oid and c.relname = mt.table_name and c.relkind = 'r'
),
policy_list as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'table', p.tablename,
    'policy', p.policyname,
    'command', p.cmd,
    'roles', p.roles,
    'using', p.qual,
    'with_check', p.with_check
  ) order by p.tablename, p.policyname), '[]'::jsonb) as result
  from pg_policies p
  join managed_tables mt on mt.table_name = p.tablename
  where p.schemaname = 'public'
),
policy_summary as (
  select jsonb_build_object(
    'managed_tables', (select count(*) from managed_tables),
    'tables_missing_rls', (
      select count(*)
      from managed_tables mt
      left join pg_namespace n on n.nspname = 'public'
      left join pg_class c on c.relnamespace = n.oid and c.relname = mt.table_name and c.relkind = 'r'
      where c.oid is null or not coalesce(c.relrowsecurity, false)
    ),
    'tables_without_authenticated_policy', (
      select count(*)
      from managed_tables mt
      where not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = mt.table_name
          and ('authenticated' = any(p.roles) or 'public' = any(p.roles))
      )
    ),
    'anon_policies', (
      select count(*)
      from pg_policies p
      join managed_tables mt on mt.table_name = p.tablename
      where p.schemaname = 'public'
        and ('anon' = any(p.roles) or 'public' = any(p.roles))
    )
  ) as result
),
anon_table_grants as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'table', g.table_name,
    'privilege', g.privilege_type
  ) order by g.table_name, g.privilege_type), '[]'::jsonb) as result
  from information_schema.role_table_grants g
  join managed_tables mt on mt.table_name = g.table_name
  where g.table_schema = 'public' and g.grantee = 'anon'
),
public_functions as (
  select
    p.oid,
    p.proname,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_function_result(p.oid) as result_type,
    p.prosecdef as security_definer,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
function_surface as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'function', proname,
    'arguments', identity_arguments,
    'returns', result_type,
    'security_definer', security_definer,
    'anon_execute', anon_execute,
    'authenticated_execute', authenticated_execute
  ) order by proname, identity_arguments), '[]'::jsonb) as result
  from public_functions
  where result_type <> 'trigger'
),
function_risk_summary as (
  select jsonb_build_object(
    'security_definer_non_trigger_functions', count(*) filter (where security_definer and result_type <> 'trigger'),
    'security_definer_executable_by_anon', count(*) filter (where security_definer and result_type <> 'trigger' and anon_execute),
    'non_trigger_functions_executable_by_anon', count(*) filter (where result_type <> 'trigger' and anon_execute)
  ) as result
  from public_functions
),
owner_isolation as (
  select jsonb_build_object(
    'cross_user_parent_links', (
      select count(*)
      from public.tasks child
      join public.tasks parent on parent.id = child.parent_task_id
      where child.user_id <> parent.user_id
    ),
    'task_event_owner_mismatches', (
      select count(*)
      from public.task_events e
      join public.tasks t on t.id = e.task_id
      where e.user_id <> t.user_id
    ),
    'task_review_owner_mismatches_for_existing_tasks', (
      select count(*)
      from public.task_reviews r
      join public.tasks t on t.id = r.task_id
      where r.user_id <> t.user_id
    ),
    'tasks_with_null_owner', (select count(*) from public.tasks where user_id is null),
    'task_events_with_null_owner', (select count(*) from public.task_events where user_id is null),
    'task_reviews_with_null_owner', (select count(*) from public.task_reviews where user_id is null),
    'settings_with_null_owner', (select count(*) from public.planner_settings where user_id is null),
    'wellbeing_with_null_owner', (select count(*) from public.wellbeing_daily where user_id is null),
    'walking_with_null_owner', (select count(*) from public.walking_logs where user_id is null),
    'external_calendar_events_with_null_owner', (select count(*) from public.external_calendar_events where user_id is null),
    'calendar_rules_with_null_owner', (select count(*) from public.calendar_classification_rules where user_id is null),
    'calendar_sync_state_with_null_owner', (select count(*) from public.calendar_sync_state where user_id is null),
    'monthly_summaries_with_null_owner', (select count(*) from public.monthly_summaries where user_id is null),
    'archive_log_with_null_owner', (select count(*) from public.archive_log where user_id is null),
    'calendar_overlap_overrides_with_null_owner', (select count(*) from public.calendar_overlap_overrides where user_id is null),
    'calendar_overlap_event_owner_mismatches', (
      select count(*)
      from public.calendar_overlap_overrides o
      join public.external_calendar_events e on e.id = o.external_event_id
      where o.user_id <> e.user_id
    ),
    'calendar_overlap_task_owner_mismatches', (
      select count(*)
      from public.calendar_overlap_overrides o
      join public.tasks t on t.id = o.task_id
      where o.user_id <> t.user_id
    )
  ) as result
),
pgcrypto_status as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'extension', e.extname,
    'schema', n.nspname,
    'version', e.extversion
  )), '[]'::jsonb) as result
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto'
),
trigger_status as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'trigger', tg.tgname,
    'enabled', tg.tgenabled,
    'function', p.proname
  ) order by tg.tgname), '[]'::jsonb) as result
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = tg.tgfoid
  where n.nspname = 'public'
    and c.relname = 'tasks'
    and not tg.tgisinternal
)
select 'rls_status'::text as section, result from rls_status
union all
select 'policy_summary', result from policy_summary
union all
select 'policies', result from policy_list
union all
select 'anon_table_grants', result from anon_table_grants
union all
select 'function_risk_summary', result from function_risk_summary
union all
select 'function_surface', result from function_surface
union all
select 'owner_isolation', result from owner_isolation
union all
select 'pgcrypto_status', result from pgcrypto_status
union all
select 'task_triggers', result from trigger_status;
