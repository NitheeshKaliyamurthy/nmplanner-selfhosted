(() => {
  const insightsClient = window.NMPlannerRuntime?.client;
  if (!insightsClient) return;

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const AREAS = ["BCU / Teaching", "Research", "WorldSkills", "Family / Home", "Personal Time"];
  const FALLBACK = {
    work_name: "BCU / Teaching",
    additional_work_name: "WorldSkills",
    work_weekly_minutes: 2220,
    work_daily_minutes: 600,
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
    worldskills_weekly_minutes: 1680,
    family_daily_minutes: 180,
    personal_daily_minutes: 180,
    sleep_daily_hours: 6,
    steps_per_mile: 2000,
  };

  const state = {
    session: null,
    week: "",
    tasks: [],
    wellbeing: [],
    sleepIntervals: [],
    walks: [],
    reviews: [],
    calendarEvents: [],
    loadedAt: 0,
    loading: null,
    scheduled: false,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normaliseArea(area) {
    if (area === "Personal / Admin" || area === "Lunch") return "Personal Time";
    return area;
  }

  function taskAreaShares(task) {
    const raw = task?.area_allocations;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const entries = Object.entries(raw)
        .map(([area, percent]) => [normaliseArea(area), Number(percent || 0)])
        .filter(([, percent]) => Number.isFinite(percent) && percent > 0);
      if (entries.length >= 2) return entries;
    }
    return task?.area ? [[normaliseArea(task.area), 100]] : [];
  }

  function displayArea(area, cfg) {
    const normal = normaliseArea(area);
    if (normal === "BCU / Teaching") return cfg.work_name || FALLBACK.work_name;
    if (normal === "WorldSkills") return cfg.additional_work_name || FALLBACK.additional_work_name;
    return normal;
  }

  function isOperational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  function timeAllocationRows() {
    const parentIds = new Set(state.tasks.map((task) => task.parent_task_id).filter(Boolean));
    return state.tasks.filter((task) => {
      if (task.discarded_at) return false;
      const historicalFollowupStage = (
        task.superseded_by_followup === true || parentIds.has(task.id)
      ) && Number.isInteger(task.day) && (
        Number.isInteger(task.planned_start_minute)
        || Number(task.actual_minutes || 0) > 0
      );
      const operational = task.superseded_by_followup !== true && !parentIds.has(task.id);
      return operational || historicalFollowupStage;
    });
  }

  function parseDate(value) {
    const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
    return year && month && day ? new Date(year, month - 1, day, 12) : null;
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    if (!date) return "";
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function weekStartCutoff(week) {
    const date = parseDate(week);
    if (!date) return null;
    date.setHours(6, 0, 0, 0);
    return date;
  }

  function createdBeforeWeekStart(task) {
    const cutoff = weekStartCutoff(state.week);
    const created = new Date(task?.created_at || "");
    return Boolean(cutoff && !Number.isNaN(created.getTime()) && created.getTime() < cutoff.getTime());
  }

  function formatClock(minute) {
    const safe = Math.max(0, Math.min(1440, Math.round(Number(minute || 0))));
    if (safe === 1440) return "24:00";
    const hour = Math.floor(safe / 60) % 24;
    const mins = safe % 60;
    return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  function timelineGaps(day) {
    const start = 240;
    const end = 1320;
    const intervals = timeAllocationRows()
      .filter((task) => task.day === day && Number.isInteger(task.planned_start_minute))
      .map((task) => ({
        start: Math.max(start, Number(task.planned_start_minute)),
        end: Math.min(end, Number(task.planned_start_minute) + Number(task.minutes || 0)),
      }))
      .filter((row) => row.end > row.start)
      .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const row of intervals) {
      const last = merged.at(-1);
      if (!last || row.start > last.end) merged.push({ ...row });
      else last.end = Math.max(last.end, row.end);
    }

    const gaps = [];
    let cursor = start;
    for (const row of merged) {
      if (row.start > cursor) gaps.push({ start: cursor, end: row.start });
      cursor = Math.max(cursor, row.end);
    }
    if (cursor < end) gaps.push({ start: cursor, end });
    return gaps.filter((gap) => gap.end - gap.start >= 15);
  }

  function localMidnight(value) {
    const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
    return year && month && day ? new Date(year, month - 1, day, 0, 0, 0, 0) : null;
  }

  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function overlapPart(startValue, endValue, dateKeyValue) {
    const dayStart = localMidnight(dateKeyValue);
    if (!dayStart) return null;
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
    const overlapStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const overlapEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    if (overlapEnd <= overlapStart) return null;
    return {
      start: Math.max(0, Math.round((overlapStart.getTime() - dayStart.getTime()) / 60000)),
      end: Math.min(1440, Math.round((overlapEnd.getTime() - dayStart.getTime()) / 60000)),
    };
  }

  function sleepPartsForDate(date) {
    return state.sleepIntervals
      .map((session) => {
        const part = overlapPart(session.started_at, session.ended_at, date);
        return part ? { ...part, id: session.id, started_at: session.started_at, ended_at: session.ended_at } : null;
      })
      .filter(Boolean);
  }

  function sleepMinutesForDate(date) {
    return sleepPartsForDate(date).reduce((sum, part) => sum + Math.max(0, part.end - part.start), 0);
  }

  function legacySleepHoursForDate(date) {
    const item = state.wellbeing.find((entry) => entry.entry_date === date);
    return item?.sleep_hours === null || item?.sleep_hours === undefined ? null : Number(item.sleep_hours);
  }

  function primaryTaskArea(task) {
    return taskAreaShares(task)[0]?.[0] || normaliseArea(task.area) || "";
  }

  function areaClass(area) {
    if (area === "BCU / Teaching") return "bcu";
    if (area === "Research") return "research";
    if (area === "WorldSkills") return "worldskills";
    if (area === "Family / Home") return "family";
    if (area === "Personal Time") return "personal";
    return "other";
  }

  function routineKey(task) {
    const match = String(task?.notes || "").match(/^\[\[NM_ROUTINE:([^\]]+)\]\]/);
    return match?.[1] || "";
  }

  function routineInsightStyle(task) {
    const key = routineKey(task);
    if (key === "travel_to_work") return { className: "routine-travel-to-work", label: "Travel · Home → Work" };
    if (key === "travel_to_home") return { className: "routine-travel-to-home", label: "Travel · Work → Home" };
    if (key === "school_run") return { className: "routine-school-run", label: "School Run" };
    if (["personal_time", "tea", "breakfast", "lunch", "dinner"].includes(key)) {
      return { className: "routine-personal-time", label: task.title || "Personal Routine" };
    }
    return null;
  }

  function routineLegendItems() {
    const present = new Set(timeAllocationRows().map(routineKey).filter(Boolean));
    const items = [];
    if (present.has("travel_to_work") || present.has("travel_to_home")) {
      items.push(["travel", "routine-travel-to-work", "Travel"]);
    }
    if (present.has("school_run")) {
      items.push(["school_run", "routine-school-run", "School Run"]);
    }
    if (["personal_time", "tea", "breakfast", "lunch", "dinner"].some((key) => present.has(key))) {
      items.push(["personal", "routine-personal-time", "Personal Routines"]);
    }
    return items;
  }

  function linkedCalendarIds() {
    return new Set(
      state.tasks
        .map((task) => task.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    );
  }

  function timedSegmentsForDay(day, cfg) {
    const date = addDays(state.week, day);
    const segments = [];

    for (const task of timeAllocationRows()) {
      if (task.day !== day || !Number.isInteger(task.planned_start_minute)) continue;
      const start = Math.max(0, Number(task.planned_start_minute));
      const end = Math.min(1440, start + Number(task.minutes || 0));
      if (end <= start) continue;
      const area = primaryTaskArea(task);
      const shares = taskAreaShares(task).map(([name]) => displayArea(name, cfg)).join(" + ");
      const routineStyle = routineInsightStyle(task);
      segments.push({
        start, end,
        className: routineStyle?.className || areaClass(area),
        label: routineStyle?.label || task.title || displayArea(area, cfg) || "Scheduled work",
        detail: routineStyle ? `${shares || displayArea(area, cfg)} · routine` : (shares || displayArea(area, cfg)),
        kind: routineStyle ? "routine" : "task",
      });
    }

    const linked = linkedCalendarIds();
    for (const event of state.calendarEvents) {
      if (linked.has(String(event.id)) || event.event_state === "cancelled" || event.is_all_day) continue;
      const part = overlapPart(event.starts_at, event.ends_at, date);
      if (!part) continue;
      const area = normaliseArea(event.area);
      segments.push({
        ...part,
        className: areaClass(area),
        label: event.title || "Calendar event",
        detail: displayArea(area, cfg) || "Unclassified",
        kind: "calendar",
      });
    }

    for (const part of sleepPartsForDate(date)) {
      segments.push({
        ...part,
        className: "sleep",
        label: "Sleep",
        detail: "Sleep / nap",
        kind: "sleep",
      });
    }

    return segments.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function unionCoverage(segments) {
    const rows = segments
      .map((segment) => ({ start: Math.max(0, segment.start), end: Math.min(1440, segment.end) }))
      .filter((segment) => segment.end > segment.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (!last || row.start > last.end) merged.push({ ...row });
      else last.end = Math.max(last.end, row.end);
    }
    return merged;
  }

  function gapsFromCoverage(segments) {
    const merged = unionCoverage(segments);
    const gaps = [];
    let cursor = 0;
    for (let index = 0; index < merged.length; index += 1) {
      const row = merged[index];
      if (row.start > cursor) {
        gaps.push({
          start: cursor,
          end: row.start,
          between: index > 0,
        });
      }
      cursor = Math.max(cursor, row.end);
    }
    if (cursor < 1440) gaps.push({ start: cursor, end: 1440, between: false });
    return gaps.filter((gap) => gap.end > gap.start);
  }

  function coverageMinutes(segments) {
    return unionCoverage(segments).reduce((sum, row) => sum + row.end - row.start, 0);
  }

  function classifyUnaccountedGaps(gaps) {
    const small = [];
    const long = [];
    for (const gap of gaps) {
      const minutes = Math.max(0, Number(gap.end || 0) - Number(gap.start || 0));
      // A 30-minute gap is still treated as a small break. Only gaps longer
      // than 30 minutes are listed individually as unaccounted time.
      if (gap.between && minutes <= 30) small.push({ ...gap, minutes });
      else long.push({ ...gap, minutes });
    }
    return {
      small,
      long,
      smallMinutes: small.reduce((sum, gap) => sum + gap.minutes, 0),
    };
  }

  function roundedBreakHours(minutes) {
    if (!minutes) return 0;
    return Math.round(minutes / 60);
  }

  function gapMinutes(gaps) {
    return gaps.reduce((sum, gap) => sum + Math.max(0, Number(gap.end || 0) - Number(gap.start || 0)), 0);
  }

  function busiestGapHour(gaps) {
    const buckets = Array(24).fill(0);
    for (const gap of gaps) {
      const start = Math.max(0, Math.min(1440, Number(gap.start || 0)));
      const end = Math.max(start, Math.min(1440, Number(gap.end || 0)));
      for (let hour = 0; hour < 24; hour += 1) {
        const bucketStart = hour * 60;
        const bucketEnd = bucketStart + 60;
        buckets[hour] += Math.max(0, Math.min(end, bucketEnd) - Math.max(start, bucketStart));
      }
    }
    const peak = Math.max(...buckets);
    if (!peak) return { label: "none", minutes: 0 };
    const hour = buckets.indexOf(peak);
    return {
      label: `${formatClock(hour * 60)}–${formatClock((hour + 1) * 60)}`,
      minutes: peak,
    };
  }

  function weeklyUnaccountedStats() {
    const byDay = DAYS.map((day, index) => {
      const segments = timedSegmentsForDay(index, {});
      const accounted = coverageMinutes(segments);
      const groups = classifyUnaccountedGaps(gapsFromCoverage(segments));
      return {
        day,
        accounted,
        small: groups.small,
        long: groups.long,
        smallMinutes: groups.smallMinutes,
        longMinutes: gapMinutes(groups.long),
      };
    });

    const plannedMinutes = byDay.reduce((sum, row) => sum + row.accounted, 0);
    const totalMinutes = 7 * 1440;
    const smallMinutes = byDay.reduce((sum, row) => sum + row.smallMinutes, 0);
    const longMinutes = byDay.reduce((sum, row) => sum + row.longMinutes, 0);
    const unaccountedMinutes = Math.max(0, totalMinutes - plannedMinutes);

    const busiestDay = (key) => {
      const best = byDay.reduce((winner, row) => !winner || row[key] > winner[key] ? row : winner, null);
      return best && best[key] > 0 ? { day: best.day, minutes: best[key] } : { day: "none", minutes: 0 };
    };

    return {
      plannedMinutes,
      totalMinutes,
      unaccountedMinutes,
      smallMinutes,
      longMinutes,
      smallBreaks: byDay.reduce((sum, row) => sum + row.small.length, 0),
      longGaps: byDay.reduce((sum, row) => sum + row.long.length, 0),
      smallDay: busiestDay("smallMinutes"),
      longDay: busiestDay("longMinutes"),
      smallTime: busiestGapHour(byDay.flatMap((row) => row.small)),
      longTime: busiestGapHour(byDay.flatMap((row) => row.long)),
    };
  }

  function formatDateTimeLocalInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function calendarPartsForWeek() {
    const parts = [];
    const linkedEventIds = new Set(
      state.tasks
        .map((task) => task.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    );
    for (const event of state.calendarEvents) {
      if (linkedEventIds.has(String(event.id))) continue;
      if (event.event_state === "cancelled" || event.is_all_day) continue;
      const eventStart = new Date(event.starts_at);
      const eventEnd = new Date(event.ends_at);
      if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime())) continue;

      for (let day = 0; day < 7; day += 1) {
        const date = addDays(state.week, day);
        const start = localMidnight(date);
        if (!start) continue;
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const overlap = Math.max(0, Math.min(eventEnd.getTime(), end.getTime()) - Math.max(eventStart.getTime(), start.getTime()));
        if (!overlap) continue;
        parts.push({
          day,
          minutes: Math.round(overlap / 60000),
          area: normaliseArea(event.area),
          quadrant: event.quadrant || null,
        });
      }
    }
    return parts;
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    if (!rest) return `${hours}h`;
    return `${hours}h ${rest}m`;
  }

  function formatHours(value) {
    const n = Number(value || 0);
    return Number.isInteger(n) ? `${n}h` : `${n.toFixed(1)}h`;
  }

  function formatDate(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(date) : value;
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await insightsClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function settings() {
    try {
      if (window.NMPlannerSettings?.get) return { ...FALLBACK, ...(await window.NMPlannerSettings.get()) };
    } catch (_) {}
    return FALLBACK;
  }

  async function loadWeek(force = false) {
    const week = selectedWeek();
    if (!week) return false;
    if (!force && state.week === week && Date.now() - state.loadedAt < 300000) return true;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const session = await getSession();
      if (!session) return false;
      const end = addDays(week, 6);
      const rangeStart = localMidnight(week);
      const rangeEnd = localMidnight(addDays(week, 7));
      const appState = window.NMPlannerState;
      const appTasksReady = appState?.isWeekLoaded?.() && appState.getWeek?.() === week;
      const taskPromise = appTasksReady
        ? Promise.resolve({ data: appState.getTasks?.() || [], error: null })
        : insightsClient.from("tasks").select("id,parent_task_id,title,week,day,planned_start_minute,area,area_allocations,quadrant,minutes,completed,actual_minutes,created_at,notes,superseded_by_followup,discarded_at,external_calendar_event_id").eq("user_id", session.user.id).eq("week", week);

      const [taskResult, wellbeingResult, sleepResult, walkResult, reviewResult, calendarResult] = await Promise.all([
        taskPromise,
        insightsClient.from("wellbeing_daily").select("entry_date,sleep_hours").eq("user_id", session.user.id).gte("entry_date", week).lte("entry_date", end),
        insightsClient.from("sleep_intervals").select("id,started_at,ended_at,created_at").eq("user_id", session.user.id).lt("started_at", rangeEnd.toISOString()).gt("ended_at", rangeStart.toISOString()).order("started_at"),
        insightsClient.from("walking_logs").select("id,walk_date,area,miles,created_at").eq("user_id", session.user.id).gte("walk_date", week).lte("walk_date", end).order("walk_date"),
        insightsClient.from("task_reviews").select("action,reason,from_date,to_date,occurred_at").eq("user_id", session.user.id).gte("from_date", week).lte("from_date", end),
        insightsClient.from("external_calendar_events")
          .select("id,title,starts_at,ends_at,is_all_day,event_state,area,quadrant")
          .eq("user_id", session.user.id)
          .lt("starts_at", rangeEnd.toISOString())
          .gt("ends_at", rangeStart.toISOString()),
      ]);

      if (taskResult.error || wellbeingResult.error || sleepResult.error || walkResult.error) return false;
      state.week = week;
      state.tasks = (taskResult.data || []).map((task) => ({
        ...task,
        area: normaliseArea(task.area),
        superseded_by_followup: task.superseded_by_followup === true,
        discarded_at: task.discarded_at || null,
      }));
      state.wellbeing = wellbeingResult.data || [];
      state.sleepIntervals = sleepResult.data || [];
      state.walks = (walkResult.data || []).map((walk) => ({ ...walk, area: normaliseArea(walk.area) }));
      state.reviews = reviewResult.error ? [] : (reviewResult.data || []);
      state.calendarEvents = calendarResult.error ? [] : (calendarResult.data || []);
      state.loadedAt = Date.now();
      return true;
    })();

    try {
      return await state.loading;
    } finally {
      state.loading = null;
    }
  }

  function metrics(cfg) {
    const operational = state.tasks.filter(isOperational);
    const scheduled = timeAllocationRows().filter((task) => Number.isInteger(task.day));
    const area = new Map(AREAS.map((name) => [name, 0]));
    const daily = Array.from({ length: 7 }, () => ({ bcu: 0, research: 0, worldskills: 0, family: 0, personal: 0, other: 0, q1: 0, q2: 0, q3: 0, q4: 0, scheduled: 0 }));

    for (const task of scheduled) {
      const minutes = Number(task.minutes || 0);
      const row = daily[task.day];
      row.scheduled += minutes;
      for (const [taskArea, percent] of taskAreaShares(task)) {
        const share = minutes * percent / 100;
        area.set(taskArea, (area.get(taskArea) || 0) + share);
        if (taskArea === "BCU / Teaching") row.bcu += share;
        else if (taskArea === "Research") row.research += share;
        else if (taskArea === "WorldSkills") row.worldskills += share;
        else if (taskArea === "Family / Home") row.family += share;
        else if (taskArea === "Personal Time") row.personal += share;
        else row.other += share;
      }
      if (task.quadrant === "q1") row.q1 += minutes;
      if (task.quadrant === "q2") row.q2 += minutes;
      if (task.quadrant === "q3") row.q3 += minutes;
      if (task.quadrant === "q4") row.q4 += minutes;
    }

    const calendarParts = calendarPartsForWeek();
    let fixedCalendarMinutes = 0;
    for (const part of calendarParts) {
      fixedCalendarMinutes += part.minutes;
      if (part.area) area.set(part.area, (area.get(part.area) || 0) + part.minutes);
      const row = daily[part.day];
      row.scheduled += part.minutes;
      if (part.area === "BCU / Teaching") row.bcu += part.minutes;
      else if (part.area === "Research") row.research += part.minutes;
      else if (part.area === "WorldSkills") row.worldskills += part.minutes;
      else if (part.area === "Family / Home") row.family += part.minutes;
      else if (part.area === "Personal Time") row.personal += part.minutes;
      else row.other += part.minutes;
      if (part.quadrant === "q1") row.q1 += part.minutes;
      if (part.quadrant === "q2") row.q2 += part.minutes;
    }

    const work = (area.get("BCU / Teaching") || 0) + (area.get("Research") || 0);
    const sleepByDate = new Map();
    const timedSleepDays = new Set();
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(state.week, day);
      const timedMinutes = sleepMinutesForDate(date);
      if (timedMinutes > 0) {
        sleepByDate.set(date, timedMinutes / 60);
        timedSleepDays.add(date);
      } else {
        sleepByDate.set(date, legacySleepHoursForDate(date));
      }
    }
    const sleepValues = [...sleepByDate.values()].filter((value) => value !== null && value !== undefined && Number.isFinite(value));
    const sleepTotal = sleepValues.reduce((sum, value) => sum + value, 0);
    const walkingMiles = state.walks.reduce((sum, walk) => sum + Number(walk.miles || 0), 0);
    const walkingSteps = Math.round(walkingMiles * Number(cfg.steps_per_mile || 2000));
    const areaStart = new Map(AREAS.map((name) => [name, 0]));
    for (const task of scheduled.filter(createdBeforeWeekStart)) {
      const minutes = Number(task.minutes || 0);
      for (const [taskArea, percent] of taskAreaShares(task)) {
        areaStart.set(taskArea, (areaStart.get(taskArea) || 0) + minutes * percent / 100);
      }
    }

    return {
      operational,
      scheduled,
      area,
      areaStart,
      daily,
      work,
      completed: operational.filter((task) => task.completed).length,
      sleepByDate,
      timedSleepDays,
      sleepValues,
      sleepTotal,
      sleepAverage: sleepValues.length ? sleepTotal / sleepValues.length : 0,
      walkingMiles,
      walkingSteps,
      fixedCalendarMinutes,
    };
  }

  function dayWalk(date) {
    return state.walks.filter((walk) => walk.walk_date === date).reduce((sum, walk) => sum + Number(walk.miles || 0), 0);
  }

  function weeklyRows(m, cfg) {
    const workTotal = (m.area.get("BCU / Teaching") || 0) + (m.area.get("Research") || 0);
    const workStart = (m.areaStart.get("BCU / Teaching") || 0) + (m.areaStart.get("Research") || 0);
    return [
      { key: "bcu", label: cfg.work_name, start: m.areaStart.get("BCU / Teaching") || 0, value: m.area.get("BCU / Teaching") || 0, target: Number(cfg.work_weekly_minutes || 0), targetLabel: "shared Work pool", poolValue: workTotal, poolStart: workStart, hard: true },
      { key: "research", label: "Research", start: m.areaStart.get("Research") || 0, value: m.area.get("Research") || 0, target: 0, targetLabel: "no separate target" },
      { key: "additional", label: cfg.additional_work_name, start: m.areaStart.get("WorldSkills") || 0, value: m.area.get("WorldSkills") || 0, target: Number(cfg.worldskills_weekly_minutes || 0) },
      { key: "family", label: "Family / Home", start: m.areaStart.get("Family / Home") || 0, value: m.area.get("Family / Home") || 0, target: Number(cfg.family_daily_minutes || 0) * 7 },
      { key: "personal", label: "Personal Time", start: m.areaStart.get("Personal Time") || 0, value: m.area.get("Personal Time") || 0, target: Number(cfg.personal_daily_minutes || 0) * 7 },
      { key: "sleep", label: "Sleep", start: 0, value: m.sleepTotal * 60, target: Number(cfg.sleep_daily_hours || 0) * 7 * 60, wellbeing: true },
    ];
  }

  function usageText(row) {
    if (row.key === "research" && !row.value) return { text: "No Research time scheduled", kind: "under" };
    if (!row.target) return { text: "No separate target configured", kind: "neutral" };
    const value = row.poolValue ?? row.value;
    const ratio = value / Math.max(1, row.target);
    if (ratio > 1) return { text: `Over by ${formatMinutes(value - row.target)}`, kind: "over" };
    if (ratio < 0.5) return { text: `Underused · ${formatMinutes(row.target - value)} below target`, kind: "under" };
    return { text: `${Math.round(ratio * 100)}% of target used`, kind: "balanced" };
  }

  function weeklyChart(m, cfg) {
    return `
      <div class="weekly-balance-chart" role="img" aria-label="Week-start versus final time compared with configured target or recommendation">
        ${weeklyRows(m, cfg).map((row) => {
          const target = Math.max(1, row.target || row.value || 1);
          const valueForTarget = row.poolValue ?? row.value;
          const ratio = valueForTarget / target;
          const fill = Math.min(100, ratio * 80);
          const signal = usageText(row);
          const added = Math.max(0, row.value - row.start);
          const targetText = row.target ? ` / ${formatMinutes(row.target)}` : "";
          return `
            <div class="weekly-balance-row ${row.key} ${signal.kind}">
              <div class="weekly-balance-label"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.targetLabel || (row.wellbeing ? "target" : row.hard ? "hard limit" : "recommendation"))}</span></div>
              <div class="weekly-balance-track"><i style="width:${fill.toFixed(1)}%"></i>${row.target ? '<b title="Target" aria-hidden="true"></b>' : ""}</div>
              <div class="weekly-balance-value week-change-area-value">
                <strong>${formatMinutes(row.start)} → ${formatMinutes(row.value)}${targetText}</strong>
                <span>+${formatMinutes(added)} added after Monday 06:00 · <em class="usage-signal ${signal.kind}">${escapeHtml(signal.text)}</em></span>
              </div>
            </div>`;
        }).join("")}
        <section class="weekly-unaccounted-summary" aria-label="Weekly unaccounted time summary">
          <div class="weekly-unaccounted-total">
            <strong>Total Unaccounted Time in the Week</strong>
            <span>${formatMinutes(weeklyGaps.plannedMinutes)} planned out of 168h · ${formatMinutes(weeklyGaps.unaccountedMinutes)} unaccounted · ${formatMinutes(weeklyGaps.smallMinutes)} of that is Small Breaks</span>
          </div>
          <div class="weekly-unaccounted-stats">
            <article class="unaccounted-stat-card small-breaks">
              <strong>Unaccounted Small Breaks</strong>
              <span>Total: ${formatMinutes(weeklyGaps.smallMinutes)} · ${weeklyGaps.smallBreaks} breaks · Average ${formatMinutes(weeklyGaps.smallMinutes / 7)}/day</span>
              <span>Most on: ${escapeHtml(weeklyGaps.smallDay.day)} · ${formatMinutes(weeklyGaps.smallDay.minutes)}</span>
              <span>Most common time: ${escapeHtml(weeklyGaps.smallTime.label)}</span>
            </article>
            <article class="unaccounted-stat-card long-gaps">
              <strong>Unaccounted Time <em>(excluding Small Breaks)</em></strong>
              <span>Total: ${formatMinutes(weeklyGaps.longMinutes)} · ${weeklyGaps.longGaps} gaps · Average ${formatMinutes(weeklyGaps.longMinutes / 7)}/day</span>
              <span>Most on: ${escapeHtml(weeklyGaps.longDay.day)} · ${formatMinutes(weeklyGaps.longDay.minutes)}</span>
              <span>Most common time: ${escapeHtml(weeklyGaps.longTime.label)}</span>
            </article>
          </div>
          <p class="weekly-unaccounted-note">Small Break = a gap of 30 minutes or less between two accounted activities. Longer gaps, plus unaccounted time before the first or after the last activity of a day, remain Unaccounted Time.</p>
        </section>
      </div>`;
  }

  function timelineSegment(segment) {
    const left = Math.max(0, Math.min(100, segment.start / 1440 * 100));
    const width = Math.max(0.12, Math.min(100 - left, (segment.end - segment.start) / 1440 * 100));
    const title = `${segment.label}: ${formatClock(segment.start)}–${formatClock(segment.end)}${segment.detail ? ` · ${segment.detail}` : ""}`;
    return `<i class="daily-time-segment ${segment.className} ${segment.kind}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHtml(title)}"></i>`;
  }

  function dailyChart(m, cfg) {
    const weeklyGaps = weeklyUnaccountedStats();
    return `
      <div class="daily-balance-chart chronological">
        <div class="daily-balance-legend" aria-label="Daily time allocation legend">
          <span><i class="bcu"></i>${escapeHtml(cfg.work_name)}</span>
          <span><i class="research"></i>Research</span>
          <span><i class="worldskills"></i>${escapeHtml(cfg.additional_work_name)}</span>
          <span><i class="family"></i>Family / Home</span>
          <span><i class="personal"></i>Personal</span>
          <span><i class="sleep"></i>Sleep / nap</span>
          <span><i class="other"></i>Other / unclassified</span>
        </div>
        ${routineLegendItems().length ? `
          <div class="daily-routine-legend" aria-label="Routine colours">
            <strong>Routines</strong>
            ${routineLegendItems().map(([, className, label]) => `<span><i class="${className}"></i>${escapeHtml(label)}</span>`).join("")}
          </div>` : ""}
        <div class="daily-time-axis" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
        ${DAYS.map((day, index) => {
          const date = addDays(state.week, index);
          const row = m.daily[index];
          const segments = timedSegmentsForDay(index, cfg);
          const accounted = coverageMinutes(segments);
          const gaps = gapsFromCoverage(segments);
          const gapGroups = classifyUnaccountedGaps(gaps);
          const sleep = m.sleepByDate.get(date);
          const hasTimedSleep = m.timedSleepDays.has(date);
          const legacySleep = !hasTimedSleep && sleep !== null && sleep !== undefined ? Number(sleep) * 60 : 0;
          const untimedScheduled = timeAllocationRows()
            .filter((task) => task.day === index && !Number.isInteger(task.planned_start_minute))
            .reduce((sum, task) => sum + Number(task.minutes || 0), 0);
          const miles = dayWalk(date);
          return `
            <div class="daily-balance-row">
              <div class="daily-balance-day"><strong>${day.slice(0, 3)}</strong><span>${formatDate(date).replace(`${day.slice(0, 3)}, `, "")}</span></div>
              <div class="daily-balance-main">
                <div class="daily-balance-track chronological-track" aria-label="${day}: ${formatMinutes(accounted)} placed on the 24-hour timeline">
                  <span class="hour-grid six"></span><span class="hour-grid twelve"></span><span class="hour-grid eighteen"></span>
                  ${segments.map(timelineSegment).join("")}
                </div>
                <div class="daily-balance-meta">
                  <span>${formatMinutes(accounted)} / 24h placed · ${formatMinutes(Math.max(0, 1440 - accounted))} unaccounted${untimedScheduled ? ` · ${formatMinutes(untimedScheduled)} scheduled without a time` : ""}</span>
                  <span>Q1 ${formatMinutes(row.q1)} · Q2 ${formatMinutes(row.q2)} · Q3 ${formatMinutes(row.q3)} · Q4 ${formatMinutes(row.q4)}${miles ? ` · Walking ${miles.toFixed(1)}mi` : ""}</span>
                  <span class="daily-gap-text">
                    ${gapGroups.small.length
                      ? `Unaccounted Small Breaks: Total Hours: ${roundedBreakHours(gapGroups.smallMinutes)} · Total Breaks: ${gapGroups.small.length}`
                      : "Unaccounted Small Breaks: none"}
                    ${gapGroups.long.length
                      ? ` · Unaccounted Time: ${gapGroups.long.map((gap) => `${formatClock(gap.start)}–${formatClock(gap.end)}`).join(" · ")}`
                      : ""}
                    ${legacySleep ? ` · ${formatMinutes(legacySleep)} legacy sleep duration is not placed until you add its start/end times` : ""}
                  </span>
                </div>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  function walkEntries(date, cfg) {
    const walks = state.walks.filter((walk) => walk.walk_date === date);
    if (!walks.length) return '<span class="balance-no-entry">No walking logged</span>';
    return walks.map((walk) => `<span class="balance-walk-chip">${escapeHtml(displayArea(walk.area, cfg))} · ${Number(walk.miles).toFixed(1)}mi <button type="button" data-balance-action="delete-walk" data-walk-id="${walk.id}">×</button></span>`).join("");
  }

  function sleepSessionRows() {
    if (!state.sleepIntervals.length) return '<div class="sleep-session-empty">No timed sleep sessions recorded for this week yet.</div>';
    return `
      <div class="sleep-session-list">
        ${state.sleepIntervals.map((session) => {
          const minutes = Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000);
          return `<div class="sleep-session-chip">
            <span><strong>${escapeHtml(formatDateTime(session.started_at))}</strong> → <strong>${escapeHtml(formatDateTime(session.ended_at))}</strong> · ${formatMinutes(minutes)}</span>
            <button type="button" data-balance-action="delete-sleep-session" data-sleep-id="${session.id}" aria-label="Delete sleep session">×</button>
          </div>`;
        }).join("")}
      </div>`;
  }

  function sleepLogger() {
    const start = localMidnight(state.week) || new Date();
    start.setHours(22, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(6, 0, 0, 0);
    return `
      <section class="sleep-session-editor">
        <div><strong>Add sleep / nap</strong><span>Use actual start and wake times. Sessions can cross midnight, and you can add multiple naps.</span></div>
        <label><span>Sleep started</span><input type="datetime-local" data-sleep-start value="${formatDateTimeLocalInput(start)}"></label>
        <label><span>Woke up</span><input type="datetime-local" data-sleep-end value="${formatDateTimeLocalInput(end)}"></label>
        <button type="button" class="primary-button" data-balance-action="add-sleep-session">Add sleep / nap</button>
      </section>
      ${sleepSessionRows()}`;
  }

  function loggingRows(m, cfg) {
    return `
      ${sleepLogger()}
      <div class="walking-log-heading"><strong>Walking</strong><span>Walking remains separate because it may overlap with commuting or another activity.</span></div>
      ${DAYS.map((day, index) => {
        const date = addDays(state.week, index);
        return `
          <div class="balance-log-row">
            <div><strong>${day}</strong><span>${formatDate(date)}</span></div>
            <label><span>Walking for</span><select data-balance-walk-area="${date}">${AREAS.map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(displayArea(area, cfg))}</option>`).join("")}</select></label>
            <label><span>Miles</span><input type="number" min="0.1" max="100" step="0.1" data-balance-walk-miles="${date}" placeholder="0.0"></label>
            <button type="button" class="secondary-button" data-balance-action="add-walk" data-date="${date}">Add walk</button>
            <div class="balance-walk-list">${walkEntries(date, cfg)}</div>
          </div>`;
      }).join("")}`;
  }

  function downloadCanvasJpeg(canvas, filename) {
    const link = document.createElement("a");
    link.download = filename;
    link.href = canvas.toDataURL("image/jpeg", 0.94);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadInsightJpeg(target) {
    const selector = target === "weekly"
      ? "[data-export-card='weekly-area']"
      : "[data-export-card='daily-timeline']";
    const node = document.querySelector(selector);
    if (!node) return window.alert("The insight chart is not available yet.");
    if (typeof window.html2canvas !== "function") return window.alert("Image export is still loading. Please try again in a moment.");

    const filename = target === "weekly"
      ? `nmplanner-weekly-plan-evolution-${state.week}.jpg`
      : `nmplanner-daily-24-hour-time-map-${state.week}.jpg`;

    const canvas = await window.html2canvas(node, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      logging: false,
      ignoreElements: (element) => element.hasAttribute?.("data-export-ignore"),
      onclone: (doc) => {
        const cloned = doc.querySelector(selector);
        if (cloned) {
          cloned.style.width = `${Math.max(1180, node.scrollWidth)}px`;
          cloned.style.maxWidth = "none";
          cloned.style.margin = "0";
          cloned.style.boxShadow = "none";
        }
      },
    });
    downloadCanvasJpeg(canvas, filename);
  }

  function markup(m, cfg) {
    return `
      <section class="balance-dashboard" data-wellbeing-dashboard>
        <div class="balance-heading graphical">
          <div><p class="eyebrow">TIME ALLOCATION + WELLBEING</p><h2>Weekly planning & 24-hour time map</h2><p>See how the weekly plan grew after Monday 06:00 and how each day was actually positioned across a 24-hour timeline, including timed sleep and unaccounted gaps.</p></div>
          <button type="button" class="secondary-button" data-balance-action="export">Download full insights CSV</button>
        </div>

        <article class="balance-panel weekly-chart-panel" data-export-card="weekly-area">
          <div class="balance-panel-heading">
            <div><h3>Weekly plan evolution by area</h3><span>Monday 06:00 starting plan → final/current weekly load, including hours added during the week</span></div>
            <div class="insight-heading-actions">
              <div class="weekly-balance-summary"><strong>${formatMinutes(m.fixedCalendarMinutes)} fixed calendar</strong><span>${m.walkingMiles.toFixed(1)}mi walked · ~${m.walkingSteps.toLocaleString("en-GB")} steps</span></div>
              <button type="button" class="secondary-button insight-image-button" data-balance-action="download-jpeg" data-image-target="weekly" data-export-ignore>Download JPG</button>
            </div>
          </div>
          ${weeklyChart(m, cfg)}
        </article>

        <article class="balance-panel daily-chart-panel" data-export-card="daily-timeline">
          <div class="balance-panel-heading">
            <div><h3>24-hour daily time map</h3><span>Chronological view of sleep, scheduled work by area, and unaccounted time across each day</span></div>
            <div class="insight-heading-actions">
              <div class="weekly-balance-summary"><strong>${m.sleepValues.length}/7 sleep days</strong><span>${m.sleepValues.length ? `${m.sleepAverage.toFixed(1)}h average` : "not logged"}</span></div>
              <button type="button" class="secondary-button insight-image-button" data-balance-action="download-jpeg" data-image-target="daily" data-export-ignore>Download JPG</button>
            </div>
          </div>
          ${dailyChart(m, cfg)}
        </article>

        <details class="balance-panel balance-log-panel">
          <summary><div><h3>Sleep sessions & walking log</h3><span>Log actual sleep start/wake times and any daytime naps.</span></div><span class="details-hint">Show log</span></summary>
          <div class="balance-log-content">
            <div class="balance-log-actions"><p>Sleep sessions are placed on the same 24-hour timeline as scheduled work. An overnight session is automatically split at midnight, so each day shows only the portion that belongs to that date.</p></div>
            <div class="balance-log-list">${loggingRows(m, cfg)}</div>
          </div>
        </details>
      </section>`;
  }

  async function render(force = false) {
    if (!document.querySelector(".insight-layout")) {
      document.querySelector("[data-wellbeing-dashboard]")?.remove();
      return;
    }
    if (!await loadWeek(force)) return;
    const cfg = await settings();
    const m = metrics(cfg);

    // Other Insights modules can redraw the page while the async Supabase reads
    // above are in flight. Always reacquire the live layout node immediately
    // before insertion so the dashboard is never attached to a stale/detached node.
    const liveInsightLayout = document.querySelector(".insight-layout");
    if (!liveInsightLayout) return;
    document.querySelector("[data-wellbeing-dashboard]")?.remove();
    liveInsightLayout.insertAdjacentHTML("afterend", markup(m, cfg));
  }

  async function addSleepSession() {
    const session = await getSession();
    if (!session) return;
    const startInput = document.querySelector("[data-sleep-start]");
    const endInput = document.querySelector("[data-sleep-end]");
    const start = new Date(startInput?.value || "");
    const end = new Date(endInput?.value || "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return window.alert("Choose both the sleep start time and wake-up time.");
    if (end <= start) return window.alert("Wake-up time must be after the sleep start time.");
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (durationMinutes > 36 * 60) return window.alert("A single sleep session cannot be longer than 36 hours.");
    const { error } = await insightsClient.from("sleep_intervals").insert({
      user_id: session.user.id,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
    });
    if (error) return window.alert(`Sleep session could not be saved: ${error.message}`);
    state.loadedAt = 0;
    window.dispatchEvent(new Event("nmplanner-wellbeing-changed"));
    await render(true);
  }

  async function deleteSleepSession(id) {
    const session = await getSession();
    if (!session) return;
    const { error } = await insightsClient.from("sleep_intervals").delete().eq("id", id).eq("user_id", session.user.id);
    if (error) return window.alert(`Sleep session could not be deleted: ${error.message}`);
    state.loadedAt = 0;
    window.dispatchEvent(new Event("nmplanner-wellbeing-changed"));
    await render(true);
  }

  async function addWalk(date) {
    const session = await getSession();
    if (!session) return;
    const area = document.querySelector(`[data-balance-walk-area="${date}"]`)?.value || "";
    const input = document.querySelector(`[data-balance-walk-miles="${date}"]`);
    const miles = Number(input?.value || 0);
    if (!AREAS.includes(area)) return window.alert("Choose a walking category.");
    if (!Number.isFinite(miles) || miles <= 0 || miles > 100) return window.alert("Enter walking miles between 0.1 and 100.");
    const { error } = await insightsClient.from("walking_logs").insert({ user_id: session.user.id, walk_date: date, area, miles });
    if (error) return window.alert(`Walking could not be saved: ${error.message}`);
    state.loadedAt = 0;
    window.dispatchEvent(new Event("nmplanner-wellbeing-changed"));
    await render(true);
  }

  async function deleteWalk(id) {
    const session = await getSession();
    if (!session) return;
    const { error } = await insightsClient.from("walking_logs").delete().eq("id", id).eq("user_id", session.user.id);
    if (error) return window.alert(`Walking entry could not be deleted: ${error.message}`);
    state.loadedAt = 0;
    window.dispatchEvent(new Event("nmplanner-wellbeing-changed"));
    await render(true);
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportRows(m, cfg) {
    const rows = [];
    const push = (section, metric, value, unit = "", target = "", date = "", area = "", notes = "") => rows.push({ section, metric, date, area, value, unit, target, notes });

    push("Configuration", "Work Name", cfg.work_name);
    push("Configuration", "Additional Work Name", cfg.additional_work_name);
    push("Settings", `${cfg.work_name} + Research weekly maximum`, cfg.work_weekly_minutes / 60, "hours");
    push("Settings", `${cfg.work_name} + Research daily maximum`, cfg.work_daily_minutes / 60, "hours");
    push("Settings", "Q1 daily maximum", cfg.q1_daily_minutes / 60, "hours");
    push("Settings", "Q2 daily maximum", cfg.q2_daily_minutes / 60, "hours");
    push("Settings", `${cfg.additional_work_name} weekly recommendation`, cfg.worldskills_weekly_minutes / 60, "hours");
    push("Settings", "Family weekly-equivalent recommendation", cfg.family_daily_minutes * 7 / 60, "hours", "", "", "", `${cfg.family_daily_minutes / 60}h/day planning average; daily distribution flexible`);
    push("Settings", "Personal Time weekly-equivalent recommendation", cfg.personal_daily_minutes * 7 / 60, "hours", "", "", "", `${cfg.personal_daily_minutes / 60}h/day planning average; includes lunch/admin`);
    push("Settings", "Sleep daily target", cfg.sleep_daily_hours, "hours");
    push("Settings", "Steps per mile estimate", cfg.steps_per_mile, "steps/mile");

    push("Weekly allocation", `${cfg.work_name} + Research`, (m.work / 60).toFixed(2), "hours", (cfg.work_weekly_minutes / 60).toFixed(2));
    push("Weekly allocation", cfg.additional_work_name, ((m.area.get("WorldSkills") || 0) / 60).toFixed(2), "hours", (cfg.worldskills_weekly_minutes / 60).toFixed(2));
    push("Weekly allocation", "Family / Home", ((m.area.get("Family / Home") || 0) / 60).toFixed(2), "hours", (cfg.family_daily_minutes * 7 / 60).toFixed(2));
    push("Weekly allocation", "Personal Time", ((m.area.get("Personal Time") || 0) / 60).toFixed(2), "hours", (cfg.personal_daily_minutes * 7 / 60).toFixed(2));
    push("Wellbeing", "Sleep total", m.sleepTotal.toFixed(2), "hours", (cfg.sleep_daily_hours * 7).toFixed(2), "", "", `${m.sleepValues.length}/7 days logged`);
    push("Wellbeing", "Walking", m.walkingMiles.toFixed(2), "miles");
    push("Wellbeing", "Estimated steps", m.walkingSteps, "steps");

    DAYS.forEach((day, index) => {
      const date = addDays(state.week, index);
      const row = m.daily[index];
      const sleep = m.sleepByDate.get(date);
      const miles = dayWalk(date);
      const timedSegments = timedSegmentsForDay(index, cfg);
      const accountedMinutes = coverageMinutes(timedSegments);
      const accounted = (accountedMinutes / 60).toFixed(2);
      push("Daily", "Q1", (row.q1 / 60).toFixed(2), "hours", (cfg.q1_daily_minutes / 60).toFixed(2), date);
      push("Daily", "Q2", (row.q2 / 60).toFixed(2), "hours", (cfg.q2_daily_minutes / 60).toFixed(2), date);
      push("Daily", `${cfg.work_name} + Research`, (row.work / 60).toFixed(2), "hours", (cfg.work_daily_minutes / 60).toFixed(2), date);
      push("Daily", cfg.additional_work_name, (row.additional / 60).toFixed(2), "hours", "", date);
      push("Daily", "Family / Home", (row.family / 60).toFixed(2), "hours", "", date);
      push("Daily", "Personal Time", (row.personal / 60).toFixed(2), "hours", "", date);
      push("Daily", "Scheduled task time", (row.scheduled / 60).toFixed(2), "hours", "", date);
      push("Daily", "Sleep", sleep === null || sleep === undefined ? "" : sleep, "hours", cfg.sleep_daily_hours, date);
      push("Daily", "Accounted 24h", accounted, "hours", "24", date, "", "Union of timed scheduled work, fixed calendar commitments, and timed sleep intervals; overlaps are counted once");
      push("Daily", "Walking", miles.toFixed(2), "miles", "", date, "", `~${Math.round(miles * cfg.steps_per_mile)} estimated steps`);
    });

    for (const area of AREAS) push("Focus area", displayArea(area, cfg), ((m.area.get(area) || 0) / 60).toFixed(2), "hours", "", "", area, "Canonical area retained for data compatibility");
    for (const sleep of state.sleepIntervals) push("Sleep log", "Sleep interval", ((new Date(sleep.ended_at) - new Date(sleep.started_at)) / 3600000).toFixed(2), "hours", "", String(sleep.started_at).slice(0,10), "", `${formatDateTime(sleep.started_at)} → ${formatDateTime(sleep.ended_at)}`);
    for (const walk of state.walks) push("Walking log", "Walking", Number(walk.miles).toFixed(2), "miles", "", walk.walk_date, displayArea(walk.area, cfg), `~${Math.round(Number(walk.miles) * cfg.steps_per_mile)} estimated steps`);
    for (const review of state.reviews) push("Review", review.action, review.reason || "", "", "", review.from_date, "", review.to_date ? `Moved to ${review.to_date}` : "");
    return rows;
  }

  async function exportCsv() {
    if (!await loadWeek(true)) return;
    const cfg = await settings();
    const rows = exportRows(metrics(cfg), cfg);
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nmplanner-full-insights-${state.week}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-balance-action]");
    if (!button) return;
    const action = button.dataset.balanceAction;
    if (action === "add-sleep-session") addSleepSession().catch((error) => window.alert(error.message));
    else if (action === "delete-sleep-session") deleteSleepSession(button.dataset.sleepId).catch((error) => window.alert(error.message));
    else if (action === "add-walk") addWalk(button.dataset.date).catch((error) => window.alert(error.message));
    else if (action === "delete-walk") deleteWalk(button.dataset.walkId).catch((error) => window.alert(error.message));
    else if (action === "download-jpeg") downloadInsightJpeg(button.dataset.imageTarget).catch((error) => window.alert(`Image could not be downloaded: ${error.message}`));
    else if (action === "export") exportCsv().catch((error) => window.alert(error.message));
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.id === "week-picker") {
      state.loadedAt = 0;
      setTimeout(() => render(true).catch(() => {}), 100);
    }
  });

  window.addEventListener("nmplanner-settings-changed", () => { render(false).catch(() => {}); });

  // Generic planner/task changes should redraw Insights from the shared task state,
  // but must not refetch wellbeing, walking, sleep and calendar support data.
  window.addEventListener("nmplanner-analytics-changed", () => { render(false).catch(() => {}); });
  window.addEventListener("nmplanner-task-rescheduled", () => { render(false).catch(() => {}); });

  // These events represent genuine changes to the supporting datasets, so bypass
  // the five-minute cache once and refresh immediately.
  window.addEventListener("nmplanner-wellbeing-changed", () => {
    state.loadedAt = 0;
    render(true).catch(() => {});
  });
  window.addEventListener("nmplanner-calendar-changed", () => {
    state.loadedAt = 0;
    render(true).catch(() => {});
  });

  window.addEventListener("nmplanner-tasks-changed", () => {
    const appState = window.NMPlannerState;
    if (appState?.isWeekLoaded?.() && appState.getWeek?.() === selectedWeek()) {
      state.tasks = (appState.getTasks?.() || []).map((task) => ({
        ...task,
        area: normaliseArea(task.area),
        superseded_by_followup: task.superseded_by_followup === true,
        discarded_at: task.discarded_at || null,
      }));
      if (document.querySelector(".insight-layout")) render(false).catch(() => {});
    }
  });

  // DOM mutations are render/layout signals only. render(false) reuses the
  // five-minute support-data cache instead of turning DOM activity into API traffic.
  const observer = new MutationObserver(() => {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      if (document.querySelector(".insight-layout") && !document.querySelector("[data-wellbeing-dashboard]")) render(false).catch(() => {});
    });
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  setTimeout(() => render(false).catch(() => {}), 1200);
})();
