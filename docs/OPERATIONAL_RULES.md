# NM Planner operational rules

This document is the canonical behaviour for the operational planner. Insights and future integrations should consume these rules rather than redefining them.

## Task lifecycle

A task row may be operational, superseded history, discarded history, or completed operational work.

- **Operational**: `superseded_by_followup = false` and `discarded_at is null`.
- **Open**: operational and `completed = false`.
- **Completed operational**: operational and `completed = true`.
- **Follow-up history**: `superseded_by_followup = true`. It remains in the database and keeps its original schedule metadata for history, but it is not current work.
- **Discarded history**: `discarded_at is not null`. It remains available for history/review but is not current work.

## Follow-up families

A follow-up is the next state of the same piece of work, not an additional copy of the parent's workload.

- Creating a child marks the parent as superseded history.
- Only terminal, non-discarded leaves are operational.
- Earlier rows remain visible in the task-history chain when the current task is opened.
- Historical rows must not consume current capacity as new active work. However, if an earlier follow-up stage had a real planned calendar time (or recorded actual time), that original occurrence remains visible on its original Day Plan slot as history and remains part of retrospective time-allocation analysis.
- Completing the final current leaf may close its ancestor chain for historical status.
- Genuine parallel terminal branches may coexist; each is operational until resolved.

## Q1 / Q2 capacity

Daily Q1 and Q2 limits come from `planner_settings`.

Capacity counts **planned operational time**:

- open operational tasks count;
- completed operational tasks count, because they were part of the day's planned workload;
- superseded follow-up history does not count;
- discarded work does not count;
- tasks without a day do not count toward daily capacity.

The Matrix is an **open-work view**, so it may show fewer minutes than planned capacity when some planned tasks are already completed. The Day Plan capacity badge should expose the open portion when this occurs.

### Half Day / Full Day blocks

The duration selector has two deliberate capacity-block presets after 3 hours:

- **Half Day** = 300 minutes (5h). It reserves the full configured Q2 daily capacity for that day. Q1 remains available.
- **Full Day** = 540 minutes (9h). It reserves the full configured Q1 and Q2 daily capacities for that day.

These reservations are independent of the task's Eisenhower classification. The selected quadrant still describes the task, while the Half/Full Day duration controls how much Q1/Q2 scheduling capacity is considered unavailable.

A normal Half Day cannot be added when Q2 capacity is already in use. A normal Full Day cannot be added when either Q1 or Q2 capacity is already in use. The inverse also applies: once these blocks exist, later normal Q1/Q2 work cannot exceed the reserved capacity.

The task's stored duration remains 300 or 540 minutes, so Weekly/Daily Balance and workload allocation continue to reflect 5h or 9h of planned time. Completed Half/Full Day work remains part of historical planned capacity, just like any other completed planned task.

## Urgent / Overtime capacity override

Capacity limits are guardrails, not a reason to hide genuine urgent work. A scheduled task can be deliberately marked **Urgent / Overtime** when it must be accepted even though normal capacity is already full.

- Normal tasks continue to respect Q1, Q2, Primary Work daily, and Primary Work weekly limits.
- An Urgent / Overtime task may exceed any of those limits deliberately.
- The task remains in its selected Eisenhower quadrant. Overtime is a capacity exception, not a fifth quadrant.
- The database calculates the **marginal excess** caused by that task and stores it in `overtime_minutes`.
- `capacity_override_at` records when the current overtime episode began.
- If the task is later moved/reduced so it no longer exceeds capacity, the live override is cleared. The change remains available in `task_events` for retrospective Insights.
- If a task still causes an over-capacity plan, its overtime marker cannot simply be removed; the task must remain marked Urgent / Overtime or be moved/reduced.
- Existing overtime does not create a new higher normal limit. Additional normal work is still blocked; further excess must also be explicitly marked as overtime.

For example, with Q1 = 4h and Q2 = 5h, a day already at Q1 4h + Q2 5h is normally full. Adding a 2h Q1 task as Urgent / Overtime produces Q1 6h / 4h and records 2h overtime. The normal daily target remains 9h, not 11h.

Insights treat overtime and last-minute work as separate process measures:

- **Overtime work**: distinct work items that required a deliberate capacity override.
- **Overtime minutes**: the stored marginal excess above configured capacity.
- **Last-minute additions**: work first added on its planned day.
- **Last-minute + overtime overlap**: work that was both introduced on the day and required a capacity override.

This separation helps distinguish an overloaded baseline plan from reactive incoming work.

## Primary work capacity

`BCU / Teaching` and `Research` are canonical database categories sharing one configurable Primary Work budget. The display name can be customised in Settings.

- Weekly hard limit: configurable, default 37h.
- Daily hard limit: configurable, default 10h.
- Uses the same operational-task definition as Q1/Q2 capacity.
- Completed operational work remains part of planned allocation.
- Superseded follow-up history does not consume current capacity; discarded history does not count.
- Urgent / Overtime can deliberately exceed the hard limit, but the excess is recorded rather than silently redefining the limit.

## Quick routine templates

The Day Plan includes reusable routine blocks for recurring time commitments:

- **Travel: Home → Work** = 60 minutes, stored under canonical Primary Work area `BCU / Teaching`.
- **Travel: Work → Home** = 60 minutes, stored under canonical Primary Work area `BCU / Teaching`.
- **School Run** = 30 minutes, stored under `Family / Home`.
- **Personal Time** = 60 minutes, stored under `Personal Time`.

Routine templates are normal task rows with a reserved marker in the notes field beginning `[[NM_ROUTINE:`. No separate template table is required.

- A routine can be dragged onto a Day Plan timeline or selected and then placed by clicking a 15-minute time slot.
- The routine contributes its planned minutes to Day Plan, Weekly/Daily Balance, area totals and task analytics as soon as it is placed.
- Future/current routine blocks remain open until their scheduled end so they continue to reserve the calendar slot.
- After the scheduled block ends, the planner automatically marks the routine completed and sets `actual_minutes` to the template duration. No manual completion is required.
- A routine placed retrospectively after its scheduled end is saved as completed immediately.
- Routine tasks have no Eisenhower quadrant by default, so routine time does not consume Q1/Q2 capacity unless the user later classifies the task.
- Work-travel routines still count toward Primary Work daily/weekly allocation because their canonical area is Primary Work.
- If a work-travel routine exceeds normal Primary Work capacity, the user may deliberately accept it through the existing Urgent / Overtime flow; any excess remains measurable.
- Same-day routine-template creation is excluded from the **Last-minute additions** KPI because adding a standard routine is not reactive incoming work. A routine that genuinely causes overtime still remains visible in overtime metrics.

## Day Plan timeline

- Day-assigned task with no `planned_start_minute`: appears in the top unscheduled list.
- Open operational task with a start time: appears in the calendar timeline, not duplicated in the top list.
- Moving time within the same day requires no reason.
- Cross-day movement requires a rescheduling reason.
- Completed timed work keeps its historical time and remains visible as completed history; its slot is released for new active work.
- Superseded/discarded history never reserves a new active timeline slot. A superseded stage that already had a calendar time remains drawn on its original slot as a historical record, marked with ★ when a follow-up exists.
- A moved task can leave a historical occurrence on the original day through `task_reviews`; the live row moves to the destination day.

## Rescheduling and review

`task_reviews.review_source` distinguishes:

- `planned_reschedule`: deliberate cross-day movement before/end outside the end-of-day resolution workflow;
- `end_of_day`: move/discard through the unfinished-task review;
- `legacy`: events recorded before source tracking existed.

At/after 18:00 local time, the browser requires unfinished work to be completed, moved to a later day with a reason, or discarded. Superseded/discarded rows do not enter this queue.

When moving work from the End-of-Day Review:

- the user can change the destination priority between Q1, Q2, Q3 and Q4;
- the original task snapshot, including its old quadrant, remains in `task_reviews`;
- the destination task uses the newly selected quadrant;
- normal target-day capacity remains enforced;
- **Urgent / Overtime** can be deliberately selected to override Q1/Q2 or Primary Work capacity on the destination day;
- the existing overtime triggers calculate the real marginal excess, so ticking the override does not create overtime when the moved task still fits normal capacity.

## Discard

Discard is a lifecycle state, not a physical deletion.

- `discarded_at` is set.
- The review outcome and snapshot are retained.
- The row leaves all operational views and capacities.
- Keeping the row prevents a discarded child from accidentally causing its historical parent to reappear as current work.

A user's explicit **Delete task permanently** action remains separate from end-of-day discard.

## Wellbeing / allocation summaries

Day Plan summaries and Weekly/Daily Balance distinguish current capacity from retrospective time allocation. Current capacity uses only operational tasks. Retrospective time allocation also includes a superseded follow-up stage when it had a planned calendar start time or recorded actual time, because that earlier stage represents time that was genuinely allocated before the continuation was created. Discarded work remains excluded. This preserves the original day's time record without counting the earlier stage as a second current work item.

Overtime remains part of planned time because it is real work accepted for the day. The normal configured limit remains visible beside any excess so the planner can distinguish sustainable planning from overwork.

## Microsoft calendar commitments

Microsoft 365 calendar commitments are a separate planning object from NM Planner tasks.

- Microsoft remains authoritative for event date/time. NM Planner is read-only and must not update Outlook or Teams.
- Imported events occupy calendar time before flexible NM Planner tasks are placed.
- If an imported Microsoft event conflicts with a manually scheduled NM Planner task, the event wins the slot and NM Planner must require an explicit conflict decision for the manual task.
- Conflict outcomes may include moving to a suggested free slot, selecting another time/day, clearing only the manual task's time, discarding the manual task, or explicitly keeping an overlap.
- Imported events are not automatically treated as BCU / Work. Each event may be classified as BCU / Teaching, Research, WorldSkills, Family / Home or Personal Time and may optionally receive Q1-Q4.
- Classification rules may be remembered by recurring series or exact title to reduce repeated weekly work.
- Imported commitments contribute time to Daily/Weekly/Monthly workload analysis but do not count as completed planner tasks, last-minute planner tasks, moved tasks or dropped tasks.
- Future/current weeks may be refreshed from Microsoft. Closed historical analysis must not be silently rewritten by later provider changes.

## Monthly planning health

Monthly Insights rate planning quality rather than raw productivity.

The score is calculated from transparent process measures including:

- completed-as-planned work;
- movement / plan instability;
- last-minute additions;
- deliberate overtime;
- dropped work.

The current month is provisional. Historical monthly rows are stored compactly in `monthly_summaries` for long-term comparison even if older detail is later archived.

Recommendations must be derived from measured patterns such as overtime, last-minute intake, movement, unresolved backlog and fixed-calendar load. They must not reward longer working hours by themselves.

## Data retention and archive

Detailed planner data is retained for analysis while useful. The default detailed-history target is six months.

- Retention is a user policy, not an automatic deletion rule.
- Archive review is recommended only when measured planner data reaches the configured threshold.
- Before detailed data is deleted in a future archive workflow, a local archive must be produced and verified.
- The archive file itself is not stored in Supabase; only a small archive ledger may be retained.
- Compact monthly summaries are intended to remain long-term.
- Microsoft calendar storage must be concise and must not contain access/refresh tokens, attendee lists, Teams chat content, email bodies, attachments or full provider payloads.

## Database source of truth

Migration `database/016_operational_consistency.sql` consolidates the lifecycle/capacity invariants after migrations 001-015. Migration `database/022_day_block_capacity.sql` extends Q1/Q2 capacity enforcement for Half Day and Full Day blocks. Migration `database/023_urgent_overtime_capacity.sql` adds deliberate capacity overrides and overtime measurement. Migration `database/025_end_of_day_move_priority_overtime.sql` extends End-of-Day moves with destination priority and overtime controls. Migration `database/026_calendar_monthly_archive_foundation.sql` adds compact calendar/monthly/archive storage and migration `database/027_security_hardening_calendar_foundation.sql` hardens that new surface. Migration `database/026_calendar_monthly_archive_foundation.sql` adds compact external-calendar, monthly-summary, storage-profile and archive-ledger structures with RLS. `database/audit_current_state.sql` is a read-only diagnostic for checking live database consistency after migration 016.
