-- Preserve migration-023 urgent/overtime task metadata in Full Backup v2 restore.
--
-- Migration 018 exports task rows dynamically, so the new overtime fields are
-- already present in backups created after migration 023. Its original restore
-- function predates those columns, however. This wrapper keeps the existing
-- validated/atomic restore and then reapplies overtime metadata while restore
-- mode is active. Any failure still rolls back the entire outer transaction.

begin;

-- Keep the migration safe to inspect/re-run in development: rename the original
-- restore function only the first time this migration is applied.
do $$
begin
  if to_regprocedure('public.restore_full_backup_v2_core_pre_overtime(jsonb,boolean,uuid,text)') is null then
    alter function public.restore_full_backup_v2(jsonb, boolean, uuid, text)
      rename to restore_full_backup_v2_core_pre_overtime;
  end if;
end;
$$;

revoke all on function public.restore_full_backup_v2_core_pre_overtime(jsonb, boolean, uuid, text) from public;
revoke all on function public.restore_full_backup_v2_core_pre_overtime(jsonb, boolean, uuid, text) from authenticated;

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
  v_result jsonb;
  v_tasks jsonb := coalesce(p_backup#>'{data,tasks}', '[]'::jsonb);
  v_bad integer := 0;
  v_new_hash text;
begin
  if v_user_id is null then
    raise exception using errcode='42501', message='NM Planner restore failed', detail='{"code":"NMV2_NOT_AUTHENTICATED"}';
  end if;

  -- The original migration-018 RPC still performs structural validation,
  -- confirmation, concurrency protection, atomic replacement and post-restore
  -- integrity checks.
  v_result := public.restore_full_backup_v2_core_pre_overtime(
    p_backup,
    p_dry_run,
    p_confirmation_backup_id,
    p_expected_current_state_hash
  );

  if p_dry_run then
    return v_result;
  end if;

  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'status' is distinct from 'committed' then
    return v_result;
  end if;

  -- Operational triggers deliberately bypass work while restore mode is active.
  -- This lets the exact persisted overtime episode timestamp and marginal excess
  -- be restored without creating new task-event history or recalculating it as a
  -- brand-new overtime decision.
  perform set_config('nmplanner.restore_mode', 'on', true);

  update public.tasks t
  set
    capacity_override = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      then true else false end,
    overtime_minutes = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      then (j->>'overtime_minutes')::integer else 0 end,
    capacity_override_at = case
      when coalesce((j->>'capacity_override')::boolean, false)
           and coalesce((j->>'overtime_minutes')::integer, 0) > 0
           and nullif(j->>'capacity_override_at', '') is not null
      then (j->>'capacity_override_at')::timestamptz
      else null end
  from jsonb_array_elements(v_tasks) j
  where t.user_id = v_user_id
    and t.id = (j->>'id')::uuid;

  perform set_config('nmplanner.restore_mode', 'off', true);

  -- Verify the live task fields against the backup. Backups made before migration
  -- 023 contain no overtime keys and therefore correctly expect false/0/null.
  select count(*)
  into v_bad
  from public.tasks t
  join jsonb_array_elements(v_tasks) j on t.id = (j->>'id')::uuid
  where t.user_id = v_user_id
    and (
      t.capacity_override is distinct from (
        coalesce((j->>'capacity_override')::boolean, false)
        and coalesce((j->>'overtime_minutes')::integer, 0) > 0
      )
      or t.overtime_minutes is distinct from case
        when coalesce((j->>'capacity_override')::boolean, false)
             and coalesce((j->>'overtime_minutes')::integer, 0) > 0
        then (j->>'overtime_minutes')::integer else 0 end
      or t.capacity_override_at is distinct from case
        when coalesce((j->>'capacity_override')::boolean, false)
             and coalesce((j->>'overtime_minutes')::integer, 0) > 0
             and nullif(j->>'capacity_override_at', '') is not null
        then (j->>'capacity_override_at')::timestamptz
        else null end
    );

  if v_bad > 0 then
    raise exception using
      errcode='P0001',
      message='NM Planner restore failed',
      detail=jsonb_build_object(
        'code','NMV2_POST_VERIFY_FAILED',
        'check','overtime_metadata',
        'count',v_bad
      )::text;
  end if;

  v_new_hash := public.nmplanner_state_hash(v_user_id);
  v_result := jsonb_set(v_result, '{new_state_hash}', to_jsonb(v_new_hash), true);
  v_result := jsonb_set(
    v_result,
    '{verification}',
    coalesce(v_result->'verification', '{}'::jsonb) || jsonb_build_object('overtime_metadata', true),
    true
  );

  return v_result;
exception when others then
  -- Any error in the wrapper rethrows and rolls back the core restore as well.
  raise;
end;
$$;

revoke all on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) from public;
grant execute on function public.restore_full_backup_v2(jsonb, boolean, uuid, text) to authenticated;

commit;
