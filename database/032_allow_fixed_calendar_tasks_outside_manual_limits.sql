-- Fixed imported calendar commitments must be materialisable even when they
-- exceed manual-planning capacity or overlap a manually planned task.
-- Manual tasks keep all existing safeguards.

begin;

drop trigger if exists enforce_daily_quadrant_capacity_trigger on public.tasks;
create trigger enforce_daily_quadrant_capacity_trigger
before insert or update of quadrant, day, week, area, minutes, user_id, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_daily_quadrant_capacity();

drop trigger if exists enforce_task_timeline_slot_trigger on public.tasks;
create trigger enforce_task_timeline_slot_trigger
before insert or update of user_id, week, day, planned_start_minute, minutes, completed, superseded_by_followup, discarded_at
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_task_timeline_slot();

drop trigger if exists enforce_work_allocation_capacity_trigger on public.tasks;
create trigger enforce_work_allocation_capacity_trigger
before insert or update of user_id, week, day, area, minutes, superseded_by_followup, discarded_at, capacity_override, overtime_minutes
on public.tasks
for each row
when (new.external_calendar_event_id is null)
execute function public.enforce_work_allocation_capacity();

commit;
