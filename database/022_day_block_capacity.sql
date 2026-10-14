-- NM Planner special Half Day / Full Day capacity semantics.
--
-- Half Day = 300 minutes (5h) and reserves the full configured Q2 daily capacity.
-- Full Day = 540 minutes (9h) and reserves the full configured Q1 + Q2 daily capacity.
--
-- These are scheduling-capacity semantics only. The task's own quadrant remains its
-- Eisenhower classification; choosing a Half/Full Day duration does not rewrite it.

begin;

create or replace function public.enforce_daily_quadrant_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_q1_limit integer := 240;
  v_q2_limit integer := 300;
  v_half_day_minutes constant integer := 300;
  v_full_day_minutes constant integer := 540;

  v_existing_q1 integer := 0;
  v_existing_q2 integer := 0;
  v_new_q1 integer := 0;
  v_new_q2 integer := 0;
  v_old_q1 integer := 0;
  v_old_q2 integer := 0;
  v_candidate_q1 integer := 0;
  v_candidate_q2 integer := 0;
  v_previous_q1 integer := 0;
  v_previous_q2 integer := 0;
begin
  select coalesce(q1_daily_minutes, 240), coalesce(q2_daily_minutes, 300)
    into v_q1_limit, v_q2_limit
  from public.planner_settings
  where user_id = new.user_id;

  if not found then
    v_q1_limit := 240;
    v_q2_limit := 300;
  end if;

  -- Capacity only applies to scheduled, current work. Moving a row out of a day,
  -- superseding it, or discarding it always reduces/clears its reservation.
  if new.day is null
     or coalesce(new.superseded_by_followup, false)
     or new.discarded_at is not null then
    return new;
  end if;

  -- Half/Full Day can reserve Q-capacity even when the task is classified Q3/Q4
  -- or left unclassified, so the lock is per day rather than per quadrant.
  perform pg_advisory_xact_lock(
    hashtextextended(
      new.user_id::text || '|' || new.week::text || '|' || new.day::text || '|quadrant-capacity',
      0
    )
  );

  select
    coalesce(sum(
      case
        when task.minutes = v_full_day_minutes then v_q1_limit
        when task.minutes = v_half_day_minutes then 0
        when task.quadrant = 'q1' then coalesce(task.minutes, 0)
        else 0
      end
    ), 0)::integer,
    coalesce(sum(
      case
        when task.minutes = v_full_day_minutes then v_q2_limit
        when task.minutes = v_half_day_minutes then v_q2_limit
        when task.quadrant = 'q2' then coalesce(task.minutes, 0)
        else 0
      end
    ), 0)::integer
  into v_existing_q1, v_existing_q2
  from public.tasks task
  where task.user_id = new.user_id
    and task.week = new.week
    and task.day = new.day
    and task.id is distinct from new.id
    and not coalesce(task.superseded_by_followup, false)
    and task.discarded_at is null;

  if new.minutes = v_full_day_minutes then
    v_new_q1 := v_q1_limit;
    v_new_q2 := v_q2_limit;
  elsif new.minutes = v_half_day_minutes then
    v_new_q2 := v_q2_limit;
  elsif new.quadrant = 'q1' then
    v_new_q1 := coalesce(new.minutes, 0);
  elsif new.quadrant = 'q2' then
    v_new_q2 := coalesce(new.minutes, 0);
  end if;

  -- Compare an edit against the row's previous reservation on this same target
  -- day. This preserves the existing rule that legacy over-capacity rows may be
  -- edited when the change does not add more capacity pressure.
  if tg_op = 'UPDATE' then
    if old.user_id = new.user_id
       and old.week = new.week
       and old.day is not distinct from new.day
       and not coalesce(old.superseded_by_followup, false)
       and old.discarded_at is null then
      if old.minutes = v_full_day_minutes then
        v_old_q1 := v_q1_limit;
        v_old_q2 := v_q2_limit;
      elsif old.minutes = v_half_day_minutes then
        v_old_q2 := v_q2_limit;
      elsif old.quadrant = 'q1' then
        v_old_q1 := coalesce(old.minutes, 0);
      elsif old.quadrant = 'q2' then
        v_old_q2 := coalesce(old.minutes, 0);
      end if;
    end if;
  end if;

  v_candidate_q1 := v_existing_q1 + v_new_q1;
  v_candidate_q2 := v_existing_q2 + v_new_q2;
  v_previous_q1 := v_existing_q1 + v_old_q1;
  v_previous_q2 := v_existing_q2 + v_old_q2;

  if new.minutes = v_full_day_minutes
     and (
       (v_candidate_q1 > v_q1_limit and v_candidate_q1 > v_previous_q1)
       or (v_candidate_q2 > v_q2_limit and v_candidate_q2 > v_previous_q2)
     ) then
    raise exception 'Full Day requires all Q1 and Q2 capacity on this day. Move or reduce existing Q1/Q2 work first.'
      using errcode = '23514';
  end if;

  if new.minutes = v_half_day_minutes
     and v_candidate_q2 > v_q2_limit
     and v_candidate_q2 > v_previous_q2 then
    raise exception 'Half Day requires all Q2 capacity on this day. Move or reduce existing Q2 work first.'
      using errcode = '23514';
  end if;

  if v_candidate_q1 > v_q1_limit and v_candidate_q1 > v_previous_q1 then
    raise exception 'Q1 daily capacity exceeded: this change would reserve % minutes, above your % minute limit.',
      v_candidate_q1, v_q1_limit
      using errcode = '23514';
  end if;

  if v_candidate_q2 > v_q2_limit and v_candidate_q2 > v_previous_q2 then
    raise exception 'Q2 daily capacity exceeded: this change would reserve % minutes, above your % minute limit.',
      v_candidate_q2, v_q2_limit
      using errcode = '23514';
  end if;

  return new;
end;
$$;

commit;
