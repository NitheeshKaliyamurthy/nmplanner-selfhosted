/* global tasks, currentWeek */

(() => {
  const balanceClient = window.NMPlannerRuntime?.client;
  if (!balanceClient) return;

  const FALLBACK = {
    work_name: "Primary Work",
    additional_work_name: "Additional Work",
    work_daily_minutes: 600,
    family_daily_minutes: 180,
    personal_daily_minutes: 180,
    sleep_daily_hours: 6,
    steps_per_mile: 2000,
  };

  const state = {
    week: "",
    wellbeing: [],
    walks: [],
    calendarEvents: [],
    loadedAt: 0,
    loading: null,
    scheduled: false,
  };

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

  function operationalRows() {
    try {
      if (window.NMPlannerActiveTasks?.current) return window.NMPlannerActiveTasks.current();
    } catch (_) {}
    const rows = Array.isArray(tasks) ? tasks : [];
    const parentIds = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
    return rows.filter((task) =>
      task.superseded_by_followup !== true
      && !parentIds.has(task.id)
      && !task.discarded_at
    );
  }

  function analysisRows() {
    const rows = Array.isArray(tasks) ? tasks : [];
    const parentIds = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
    return rows.filter((task) => {
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

  function localMidnight(value) {
    const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
    return year && month && day ? new Date(year, month - 1, day, 0, 0, 0, 0) : null;
  }

  function calendarMinutesForDay(day, predicate = () => true) {
    const week = typeof currentWeek !== "undefined" ? currentWeek : "";
    const date = addDays(week, day);
    const start = localMidnight(date);
    if (!start) return 0;
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const linkedEventIds = new Set(
      analysisRows()
        .map((task) => task.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    );

    return state.calendarEvents
      .filter((event) =>
        !linkedEventIds.has(String(event.id))
        && event.event_state !== "cancelled"
        && !event.is_all_day
        && predicate(normaliseArea(event.area), event)
      )
      .reduce((sum, event) => {
        const eventStart = new Date(event.starts_at);
        const eventEnd = new Date(event.ends_at);
        const overlap = Math.max(0, Math.min(eventEnd.getTime(), end.getTime()) - Math.max(eventStart.getTime(), start.getTime()));
        return sum + Math.round(overlap / 60000);
      }, 0);
  }

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    if (!rest) return `${hours}h`;
    return `${hours}h${rest}m`;
  }

  function formatHours(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return "—";
    return Number.isInteger(numeric) ? `${numeric}h` : `${numeric.toFixed(1)}h`;
  }

  function formatSteps(value) {
    const numeric = Math.round(Number(value || 0));
    if (numeric >= 1000) return `${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)}k`;
    return String(numeric);
  }

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function settings() {
    try {
      if (window.NMPlannerSettings?.get) return { ...FALLBACK, ...(await window.NMPlannerSettings.get()) };
    } catch (_) {}
    return FALLBACK;
  }

  async function loadWeek(force = false) {
    const week = typeof currentWeek !== "undefined" ? currentWeek : "";
    if (!week) return;
    if (!force && state.week === week && Date.now() - state.loadedAt < 15000) return;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const { data: auth } = await balanceClient.auth.getSession();
      const session = auth.session;
      if (!session) return;
      const end = addDays(week, 6);
      const rangeStart = localMidnight(week);
      const rangeEnd = localMidnight(addDays(week, 7));
      const [wellbeingResult, walkResult, calendarResult] = await Promise.all([
        balanceClient
          .from("wellbeing_daily")
          .select("entry_date,sleep_hours")
          .eq("user_id", session.user.id)
          .gte("entry_date", week)
          .lte("entry_date", end),
        balanceClient
          .from("walking_logs")
          .select("walk_date,miles,area")
          .eq("user_id", session.user.id)
          .gte("walk_date", week)
          .lte("walk_date", end),
        balanceClient
          .from("external_calendar_events")
          .select("id,starts_at,ends_at,is_all_day,event_state,area,quadrant")
          .eq("user_id", session.user.id)
          .lt("starts_at", rangeEnd.toISOString())
          .gt("ends_at", rangeStart.toISOString()),
      ]);

      if (wellbeingResult.error || walkResult.error) return;
      state.week = week;
      state.wellbeing = wellbeingResult.data || [];
      state.walks = walkResult.data || [];
      state.calendarEvents = calendarResult.error ? [] : (calendarResult.data || []);
      state.loadedAt = Date.now();
    })();

    try {
      await state.loading;
    } finally {
      state.loading = null;
    }
  }

  function minutesFor(day, predicate) {
    return analysisRows()
      .filter((task) => task.day === day)
      .reduce((sum, task) => {
        const minutes = Number(task.minutes || 0);
        return sum + taskAreaShares(task).reduce(
          (areaSum, [area, percent]) => areaSum + (predicate(area, task) ? minutes * percent / 100 : 0),
          0
        );
      }, 0);
  }

  function allScheduledMinutes(day) {
    return analysisRows()
      .filter((task) => task.day === day)
      .reduce((sum, task) => sum + Number(task.minutes || 0), 0);
  }

  function sleepFor(date) {
    const item = state.wellbeing.find((entry) => entry.entry_date === date);
    return item?.sleep_hours === null || item?.sleep_hours === undefined ? null : Number(item.sleep_hours);
  }

  function walkingFor(date) {
    return state.walks
      .filter((walk) => walk.walk_date === date)
      .reduce((sum, walk) => sum + Number(walk.miles || 0), 0);
  }

  function chip(label, value, title = "", kind = "") {
    const safeKind = /^[a-z0-9_-]*$/i.test(kind) ? kind : "";
    return `<span class="day-balance-chip ${safeKind}"${title ? ` title="${escapeHtml(title)}"` : ""}><b>${escapeHtml(label)}</b> ${escapeHtml(value)}</span>`;
  }

  async function render() {
    if (!document.querySelector(".days-grid")) return;
    await loadWeek(false);
    const cfg = await settings();
    const week = typeof currentWeek !== "undefined" ? currentWeek : "";
    if (!week) return;

    document.querySelectorAll(".days-grid .day-card").forEach((card, day) => {
      const date = addDays(week, day);
      const fixedCalendar = calendarMinutesForDay(day);
      const work = minutesFor(day, (area) => area === "BCU / Teaching" || area === "Research")
        + calendarMinutesForDay(day, (area) => area === "BCU / Teaching" || area === "Research");
      const additional = minutesFor(day, (area) => area === "WorldSkills")
        + calendarMinutesForDay(day, (area) => area === "WorldSkills");
      const family = minutesFor(day, (area) => area === "Family / Home")
        + calendarMinutesForDay(day, (area) => area === "Family / Home");
      const personal = minutesFor(day, (area) => area === "Personal Time")
        + calendarMinutesForDay(day, (area) => area === "Personal Time");
      const scheduledMinutes = allScheduledMinutes(day) + fixedCalendar;
      const sleep = sleepFor(date);
      const miles = walkingFor(date);
      const steps = Math.round(miles * Number(cfg.steps_per_mile || 2000));
      const accountedMinutes = sleep === null ? null : scheduledMinutes + Math.round(sleep * 60);
      const dayBalanceText = accountedMinutes === null
        ? `${formatMinutes(scheduledMinutes)} planned + sleep —`
        : `${formatMinutes(accountedMinutes)}/24h`;
      const dayBalanceTitle = accountedMinutes === null
        ? "Planned task time plus timed Microsoft calendar commitments are shown; log sleep in Insights to calculate the 24-hour balance. Preserved timed follow-up stages remain historical time and discarded work is excluded."
        : `Planned tasks and fixed calendar commitments (${formatMinutes(scheduledMinutes)}) + logged sleep (${formatHours(sleep)}). Completed work and preserved timed follow-up stages remain part of the day's historical plan; discarded work is excluded.`;

      const signature = [
        work, additional, family, personal, fixedCalendar, scheduledMinutes, sleep ?? "", miles,
        cfg.work_name, cfg.additional_work_name, cfg.work_daily_minutes,
        cfg.family_daily_minutes, cfg.personal_daily_minutes, cfg.sleep_daily_hours, cfg.steps_per_mile,
      ].join("|");

      let strip = card.querySelector(":scope > .day-balance-strip");
      if (!strip) {
        strip = document.createElement("div");
        strip.className = "day-balance-strip";
        card.querySelector(":scope > header")?.insertAdjacentElement("afterend", strip);
      }
      if (strip.dataset.signature === signature) return;
      strip.dataset.signature = signature;

      strip.innerHTML = [
        chip(cfg.work_name || "Primary Work", `${formatMinutes(work)}/${formatMinutes(cfg.work_daily_minutes)}`, "Primary planned work including Research plus Microsoft calendar commitments classified into those areas. Preserved timed follow-up stages remain in historical time; discarded work is excluded.", work >= cfg.work_daily_minutes ? "hard-full" : ""),
        chip("Fixed calendar", formatMinutes(fixedCalendar), "Timed Microsoft calendar commitments occupy the day before flexible NM Planner tasks. All-day events are shown separately and are not converted into artificial 24-hour work time."),
        chip(cfg.additional_work_name || "Additional Work", formatMinutes(additional), "Additional planner work plus fixed calendar commitments classified as Additional Work / WorldSkills."),
        chip("Family", formatMinutes(family), `Family time today. Flexible across the week; Settings currently imply a weekly recommendation of ${formatMinutes(cfg.family_daily_minutes * 7)}.`),
        chip("Personal", formatMinutes(personal), `Personal Time includes lunch/admin/personal activities. Flexible across the week; Settings currently imply ${formatMinutes(cfg.personal_daily_minutes * 7)} per week.`),
        chip("Sleep", `${sleep === null ? "—" : formatHours(sleep)}/${formatHours(cfg.sleep_daily_hours)}`, sleep === null ? "Sleep not logged for this day." : "Logged sleep compared with your wellbeing target.", sleep !== null && sleep < Number(cfg.sleep_daily_hours) ? "wellbeing-low" : ""),
        chip("Walk", `${miles.toFixed(1)}mi · ~${formatSteps(steps)} steps`, `Estimated using ${Number(cfg.steps_per_mile).toLocaleString("en-GB")} steps per mile. Walking is not added to the 24-hour total because it may overlap with commuting or other activities.`),
        chip("24h", dayBalanceText, dayBalanceTitle, accountedMinutes !== null && accountedMinutes > 1440 ? "day-overbooked" : ""),
      ].join("");
    });
  }

  function schedule(force = false) {
    if (force) state.loadedAt = 0;
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      render().catch(() => {});
    });
  }

  const observer = new MutationObserver(() => schedule(false));
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("nmplanner-settings-ready", () => schedule(true));
  window.addEventListener("nmplanner-settings-changed", () => schedule(true));
  window.addEventListener("nmplanner-wellbeing-changed", () => schedule(true));
  window.addEventListener("nmplanner-analytics-changed", () => schedule(true));
  window.addEventListener("nmplanner-task-rescheduled", () => schedule(true));
  window.addEventListener("nmplanner-calendar-changed", () => schedule(true));
  window.addEventListener("focus", () => schedule(true));

  schedule(true);
})();