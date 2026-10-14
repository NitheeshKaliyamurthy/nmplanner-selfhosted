(() => {
  const analyticsClient = window.NMPlannerRuntime?.client;
  if (!analyticsClient) return;

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const QUADRANTS = [
    { key: "q1", label: "Q1", title: "Urgent + Important" },
    { key: "q2", label: "Q2", title: "Important + Not urgent" },
    { key: "q3", label: "Q3", title: "Urgent + Not important" },
    { key: "q4", label: "Q4", title: "Not urgent + Not important" },
  ];
  const REASON_LABELS = {
    waiting_external: "Waiting for others / external dependency",
    priority_shift: "Higher-priority work took over",
    capacity: "Workload / capacity exceeded",
    personal_delay: "Personally postponed / delayed by me",
    underestimated: "Task took longer than expected",
    scope_change: "Scope changed / more work discovered",
    planned_continuation: "Planned continuation / staged work",
    other: "Other",
  };

  const state = {
    session: null,
    schemaReady: true,
    tasks: [],
    loading: null,
    loadedAt: 0,
    renderToken: 0,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseDate(value) {
    if (!value) return null;
    const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 12);
  }

  function dateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function timestampDateKey(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dateKey(date);
  }

  function weekStartCutoff(week) {
    const date = parseDate(week);
    if (!date) return null;
    date.setHours(6, 0, 0, 0);
    return date;
  }

  function createdBeforeWeekStart(task, week) {
    const cutoff = weekStartCutoff(week);
    const created = new Date(task?.created_at || "");
    return Boolean(cutoff && !Number.isNaN(created.getTime()) && created.getTime() < cutoff.getTime());
  }

  function normaliseArea(value) {
    if (value === "Personal / Admin" || value === "Lunch") return "Personal Time";
    return value;
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

  async function plannerSettings() {
    try {
      if (window.NMPlannerSettings?.get) return await window.NMPlannerSettings.get();
    } catch (_) {}
    return {
      q1_daily_minutes: 240,
      q2_daily_minutes: 300,
    };
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    if (!date) return "";
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  function differenceInDays(fromKey, toKey) {
    const from = parseDate(fromKey);
    const to = parseDate(toKey);
    if (!from || !to) return null;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function formatMinutes(total) {
    const numeric = Math.max(0, Number(total || 0));
    const hours = Math.floor(numeric / 60);
    const minutes = Math.round(numeric % 60);
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function formatWeekShort(week) {
    const start = parseDate(week);
    if (!start) return week;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const startText = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(start);
    const endText = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(end);
    return `${startText}–${endText}`;
  }

  function percent(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  function reasonLabel(code) {
    return REASON_LABELS[code] || (code ? "Other" : "Not recorded");
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  function isOperational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await analyticsClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function checkSchema() {
    // NM Planner's deployed schema already includes actual_minutes.
    // Keep this helper for callers without issuing a probe query.
    return state.schemaReady === true;
  }

  async function loadAllTasks(force = false) {
    const ready = await checkSchema();
    if (!ready) return [];
    if (!force && state.tasks.length && Date.now() - state.loadedAt < 300000) return state.tasks;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const session = await getSession();
      if (!session) return state.tasks;

      const richSelect = "id,parent_task_id,title,week,quadrant,day,area,area_allocations,due,minutes,actual_minutes,completed,created_at,updated_at,completed_at,followup_reason,rescheduled_from_week,rescheduled_to_week,superseded_by_followup,discarded_at,split_group_id,split_instance_index,split_instance_count";
      let result = await analyticsClient
        .from("tasks")
        .select(richSelect)
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: true });

      if (result.error && /followup_reason|rescheduled_from_week|rescheduled_to_week|superseded_by_followup|discarded_at|schema cache/i.test(result.error.message || "")) {
        result = await analyticsClient
          .from("tasks")
          .select("id,parent_task_id,title,week,quadrant,day,area,area_allocations,due,minutes,actual_minutes,completed,created_at,updated_at,completed_at,split_group_id,split_instance_index,split_instance_count")
          .eq("user_id", session.user.id)
          .order("created_at", { ascending: true });
      }

      if (result.error) return state.tasks;
      state.tasks = (result.data || []).map((task) => ({
        ...task,
        followup_reason: task.followup_reason || null,
        rescheduled_from_week: task.rescheduled_from_week || null,
        rescheduled_to_week: task.rescheduled_to_week || null,
        superseded_by_followup: task.superseded_by_followup === true,
        discarded_at: task.discarded_at || null,
      }));
      state.loadedAt = Date.now();
      return state.tasks;
    })();

    try {
      return await state.loading;
    } finally {
      state.loading = null;
    }
  }

  function planningCategory(task) {
    const created = timestampDateKey(task.created_at);
    const weekStart = task.week || "";
    const weekEnd = weekStart ? addDays(weekStart, 6) : "";
    const planned = plannedDate(task);
    if (!created || !weekStart) return "Unknown";
    if (created < weekStart) return "Added before week";
    if (planned && created === planned) return "Added same day";
    if (created <= weekEnd) return "Added during week";
    return "Added after planned week";
  }

  function completionCategory(task) {
    if (!task.completed) return "Open";
    if (!task.completed_at) return "Completed";
    if (!task.due) return "Completed - no due date";
    return timestampDateKey(task.completed_at) <= task.due ? "Completed on/before due" : "Completed late";
  }

  function weekMetrics(allTasks, week) {
    const weekTasks = allTasks.filter((task) => task.week === week && isOperational(task));
    const scheduled = weekTasks.filter((task) => Number.isInteger(task.day));
    const completed = weekTasks.filter((task) => task.completed);
    const open = weekTasks.filter((task) => !task.completed);
    const beforeStartRows = weekTasks.filter((task) => createdBeforeWeekStart(task, week));
    const addedLaterRows = weekTasks.filter((task) => !createdBeforeWeekStart(task, week));
    const beforeWeek = beforeStartRows.length;
    const duringWeek = addedLaterRows.length;
    const sameDay = scheduled.filter((task) => timestampDateKey(task.created_at) === plannedDate(task)).length;
    const measuredCompleted = completed.filter((task) => task.actual_minutes !== null && task.actual_minutes !== undefined);
    const estimatedMeasured = measuredCompleted.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const actualMeasured = measuredCompleted.reduce((sum, task) => sum + Number(task.actual_minutes || 0), 0);
    const dueCompleted = completed.filter((task) => task.due && task.completed_at);
    const onTime = dueCompleted.filter((task) => timestampDateKey(task.completed_at) <= task.due).length;
    const q1Minutes = weekTasks.filter((task) => task.quadrant === "q1").reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const q2Minutes = weekTasks.filter((task) => task.quadrant === "q2").reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const totalMinutes = weekTasks.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const startMinutes = beforeStartRows.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const addedMinutes = Math.max(0, totalMinutes - startMinutes);
    const leadDays = scheduled
      .map((task) => differenceInDays(timestampDateKey(task.created_at), plannedDate(task)))
      .filter((value) => value !== null);
    const avgLead = leadDays.length ? leadDays.reduce((sum, value) => sum + value, 0) / leadDays.length : 0;

    return {
      weekTasks,
      scheduled,
      completed,
      open,
      beforeStartRows,
      addedLaterRows,
      beforeWeek,
      duringWeek,
      sameDay,
      measuredCompleted,
      estimatedMeasured,
      actualMeasured,
      dueCompleted,
      onTime,
      q1Minutes,
      q2Minutes,
      totalMinutes,
      startMinutes,
      addedMinutes,
      avgLead,
      completionRate: percent(completed.length, weekTasks.length),
      preplannedRate: percent(startMinutes, totalMinutes),
      sameDayRate: percent(sameDay, scheduled.length),
      onTimeRate: percent(onTime, dueCompleted.length),
      actualCoverage: percent(measuredCompleted.length, completed.length),
    };
  }

  function quadrantRows(metrics) {
    return QUADRANTS.map((quadrant) => {
      const rows = metrics.weekTasks.filter((task) => task.quadrant === quadrant.key);
      const start = rows.filter((task) => metrics.beforeStartRows.includes(task)).reduce((sum, task) => sum + Number(task.minutes || 0), 0);
      const final = rows.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
      const completed = rows.filter((task) => task.completed).reduce((sum, task) => sum + Number(task.minutes || 0), 0);
      return { ...quadrant, start, final, added: Math.max(0, final - start), completed };
    });
  }

  function trendRows(allTasks, selected) {
    return [-21, -14, -7, 0].map((offset) => {
      const week = addDays(selected, offset);
      const metrics = weekMetrics(allTasks, week);
      return {
        week,
        label: formatWeekShort(week),
        completion: metrics.completionRate,
        completed: metrics.completed.length,
        total: metrics.weekTasks.length,
      };
    });
  }

  function plannerCue(metrics, trend) {
    if (!metrics.weekTasks.length) return "No operational tasks are recorded for this week yet.";
    const previous = trend.slice(0, -1).filter((item) => item.total > 0);
    const previousAverage = previous.length
      ? Math.round(previous.reduce((sum, item) => sum + item.completion, 0) / previous.length)
      : null;
    const q1Open = metrics.open.filter((task) => task.quadrant === "q1").length;
    if (q1Open) return `${q1Open} Q1 task${q1Open === 1 ? " remains" : "s remain"} incomplete. Resolve those before adding further urgent work.`;
    if (previousAverage !== null && metrics.completionRate + 10 < previousAverage) {
      return `Completion is ${metrics.completionRate}% this week versus a ${previousAverage}% average across the previous three displayed weeks. Review capacity and same-day additions before increasing next week's load.`;
    }
    if (metrics.completionRate === 100) return "All operational tasks for the selected week are complete. Preserve the planning pattern that produced this result.";
    if (metrics.sameDayRate > 30) return `${metrics.sameDayRate}% of scheduled work was added on the same day. Moving a little more capture into the previous evening should reduce reactive switching.`;
    if (percent(metrics.q2Minutes, metrics.totalMinutes) < 30 && metrics.totalMinutes) return "Q2 represents less than 30% of planned time. Protecting a little more proactive work may reduce future Q1 pressure.";
    return `Completion is ${metrics.completionRate}% with ${metrics.open.length} operational task${metrics.open.length === 1 ? "" : "s"} still open. The week is broadly tracking without a dominant risk signal.`;
  }

  function workflowMarkup(metrics) {
    const estimateText = metrics.measuredCompleted.length
      ? `${formatMinutes(metrics.actualMeasured)} actual / ${formatMinutes(metrics.estimatedMeasured)} estimated`
      : "No actual time logged yet";

    return `
      <section class="analytics-dashboard" data-analytics-dashboard>
        <div class="analytics-heading">
          <div><p class="eyebrow">MARGINAL GAINS</p><h2>How the week changed</h2><p>Start point is Monday 06:00 local time. This separates work planned before the week from work added after it began.</p></div>
          <button type="button" class="secondary-button" data-analytics-action="export">Download analytics CSV</button>
        </div>
        <div class="analytics-kpis">
          <article><strong>${formatMinutes(metrics.startMinutes)}</strong><span>Planned by Monday 06:00</span><small>${metrics.preplannedRate}% of the final ${formatMinutes(metrics.totalMinutes)} weekly load</small></article>
          <article><strong>+${formatMinutes(metrics.addedMinutes)}</strong><span>Added after Monday 06:00</span><small>${metrics.duringWeek} work item${metrics.duringWeek === 1 ? "" : "s"} added after the week started</small></article>
          <article><strong>${metrics.sameDayRate}%</strong><span>Same-day additions</span><small>${metrics.sameDay} / ${metrics.scheduled.length} scheduled operational items</small></article>
          <article><strong>${metrics.completionRate}%</strong><span>Completion rate</span><small>${metrics.completed.length} completed / ${metrics.weekTasks.length} operational task instances</small></article>
          <article><strong>${metrics.actualCoverage}%</strong><span>Actual-time coverage</span><small>${metrics.measuredCompleted.length} / ${metrics.completed.length} completed instances · ${estimateText}</small></article>
        </div>
      </section>`;
  }

  function quadrantUsageSignal(row, cfg, totalMinutes) {
    const target = row.key === "q1"
      ? Number(cfg.q1_daily_minutes || 0) * 7
      : row.key === "q2"
        ? Number(cfg.q2_daily_minutes || 0) * 7
        : 0;
    if (!target) return { label: `${percent(row.final, Math.max(1, totalMinutes))}% of weekly time · no configured target`, kind: "neutral", target: 0 };
    const ratio = row.final / target;
    if (ratio > 1) return { label: `Over by ${formatMinutes(row.final - target)}`, kind: "over", target };
    if (ratio < 0.5) return { label: `Underused · ${formatMinutes(target - row.final)} below capacity`, kind: "under", target };
    return { label: `${formatMinutes(row.final)} / ${formatMinutes(target)} capacity`, kind: "balanced", target };
  }

  function quadrantMarkup(metrics, cfg) {
    const rows = quadrantRows(metrics);
    const maxMinutes = Math.max(1, ...rows.map((row) => row.final));
    return `
      <article class="analytics-panel quadrant-balance-panel">
        <div class="analytics-panel-heading"><div><h3>Week start → final quadrant load</h3><span>hours already scheduled by Monday 06:00 versus hours present by the end/current point of the week</span></div><span>${formatMinutes(metrics.startMinutes)} → ${formatMinutes(metrics.totalMinutes)}</span></div>
        <div class="quadrant-chart week-change-chart" role="img" aria-label="Week-start and final time by Eisenhower quadrant">
          ${rows.map((row) => {
            const startWidth = Math.round((row.start / maxMinutes) * 100);
            const finalWidth = Math.round((row.final / maxMinutes) * 100);
            const signal = quadrantUsageSignal(row, cfg, metrics.totalMinutes);
            return `
              <div class="quadrant-chart-row ${row.key}">
                <div class="quadrant-chart-label"><strong>${row.label}</strong><span>${escapeHtml(row.title)}</span></div>
                <div class="quadrant-chart-bars">
                  <div class="quadrant-chart-track planned"><i style="width:${startWidth}%"></i></div>
                  <div class="quadrant-chart-track completed"><i style="width:${finalWidth}%"></i></div>
                </div>
                <div class="quadrant-chart-values week-change-values">
                  <strong>${formatMinutes(row.start)} → ${formatMinutes(row.final)}</strong>
                  <span>+${formatMinutes(row.added)} added · ${signal.target ? `target ${formatMinutes(signal.target)} · ` : ""}<em class="usage-signal ${signal.kind}">${escapeHtml(signal.label)}</em></span>
                </div>
              </div>`;
          }).join("")}
        </div>
        <div class="chart-legend compact"><span><i class="legend-planned"></i>Monday 06:00</span><span><i class="legend-completed"></i>Final/current weekly load</span></div>
      </article>`;
  }

  function trendMarkup(trend) {
    return `
      <div class="completion-trend" role="img" aria-label="Completion percentage over four weeks">
        ${trend.map((item, index) => `
          <div class="completion-week ${index === trend.length - 1 ? "current" : ""}">
            <div class="completion-bar-wrap"><span>${item.total ? `${item.completion}%` : "—"}</span><i style="height:${item.total ? Math.max(4, item.completion) : 2}%"></i></div>
            <strong>${escapeHtml(item.label)}</strong>
            <small>${item.total ? `${item.completed}/${item.total}` : "No tasks"}</small>
          </div>`).join("")}
      </div>`;
  }

  function incompleteMarkup(metrics) {
    if (!metrics.open.length) {
      return '<div class="incomplete-empty"><strong>Nothing incomplete</strong><span>All operational tasks for this week are complete.</span></div>';
    }

    const order = new Map([["q1", 1], ["q2", 2], ["q3", 3], ["q4", 4], [null, 5], [undefined, 5], ["", 5]]);
    const rows = [...metrics.open].sort((a, b) => {
      const qa = order.get(a.quadrant) || 5;
      const qb = order.get(b.quadrant) || 5;
      if (qa !== qb) return qa - qb;
      const da = Number.isInteger(a.day) ? a.day : 9;
      const db = Number.isInteger(b.day) ? b.day : 9;
      if (da !== db) return da - db;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

    return `
      <div class="incomplete-list">
        ${rows.map((task) => {
          const q = task.quadrant ? task.quadrant.toUpperCase() : "—";
          const day = Number.isInteger(task.day) ? DAYS[task.day] : "Unscheduled";
          return `
            <div class="incomplete-row">
              <span class="quadrant-pill ${task.quadrant || "none"}">${q}</span>
              <div><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.area || "Uncategorised")} · ${day} · ${formatMinutes(task.minutes)}</span></div>
            </div>`;
        }).join("")}
      </div>`;
  }

  function plannerMarkup(metrics, allTasks, week, cfg) {
    const trend = trendRows(allTasks, week);
    const cue = plannerCue(metrics, trend);
    return `
      ${quadrantMarkup(metrics, cfg)}
      <article class="analytics-panel planner-insight-panel">
        <div class="analytics-panel-heading"><div><h3>Planner insight</h3><span>four-week completion trend + unfinished work</span></div><strong class="planner-current-rate">${metrics.completionRate}%</strong></div>
        <div class="planner-insight-body">
          <p class="planner-cue">${escapeHtml(cue)}</p>
          <div class="planner-subheading"><strong>Completion trend</strong><span>previous 3 weeks + selected week</span></div>
          ${trendMarkup(trend)}
          <div class="planner-subheading incomplete-heading"><strong>Not completed this week</strong><span>${metrics.open.length} operational task${metrics.open.length === 1 ? "" : "s"}</span></div>
          ${incompleteMarkup(metrics)}
        </div>
      </article>`;
  }

  async function renderInsights(force = false) {
    const insightLayout = document.querySelector(".insight-layout");
    if (!insightLayout) return;
    const ready = await checkSchema();
    if (!ready) return;
    const token = ++state.renderToken;
    const allTasks = await loadAllTasks(force);
    if (token !== state.renderToken || !document.querySelector(".insight-layout")) return;
    const week = selectedWeek();
    if (!week) return;
    const metrics = weekMetrics(allTasks, week);
    const cfg = await plannerSettings();

    document.querySelector("[data-analytics-dashboard]")?.remove();
    insightLayout.insertAdjacentHTML("beforebegin", workflowMarkup(metrics));
    insightLayout.innerHTML = plannerMarkup(metrics, allTasks, week, cfg);
  }

  async function installActualTimeField() {
    const form = document.querySelector("#task-form");
    if (!form || form.querySelector('[name="actual_minutes"]')) return;
    if (!await checkSchema()) return;
    const grid = form.querySelector(".form-grid");
    if (!grid) return;
    const label = document.createElement("label");
    label.className = "field analytics-actual-field";
    label.innerHTML = '<span>Actual time spent</span><input name="actual_minutes" type="number" min="0" max="2880" step="5" inputmode="numeric" placeholder="Optional — minutes"><small>Log this after completion to improve estimate accuracy.</small>';
    grid.append(label);

    const id = form.querySelector('[data-action="delete"][data-id]')?.dataset.id;
    if (!id) return;
    const cachedTask = window.NMPlannerState?.getTasks?.().find((task) => String(task.id) === String(id));
    const input = form.querySelector('[name="actual_minutes"]');
    if (input && input.value === "" && cachedTask?.actual_minutes !== null && cachedTask?.actual_minutes !== undefined) {
      input.value = String(cachedTask.actual_minutes);
    }
  }

  async function installFollowupActualField() {
    const editor = document.querySelector("[data-followup-editor]");
    if (!editor || editor.querySelector('[data-followup-field="actual_minutes"]')) return;
    if (!await checkSchema()) return;
    const grid = editor.querySelector(".followup-form-grid");
    if (!grid) return;
    const completed = grid.querySelector(".followup-completed");
    const label = document.createElement("label");
    label.className = "field analytics-actual-field";
    label.innerHTML = '<span>Actual time spent</span><input data-followup-field="actual_minutes" type="number" min="0" max="2880" step="5" inputmode="numeric" placeholder="Optional — minutes"><small>Useful once this follow-up is complete.</small>';
    grid.insertBefore(label, completed || null);
  }

  async function loadFollowupActual(id) {
    await installFollowupActualField();
    const input = document.querySelector('[data-followup-field="actual_minutes"]');
    if (!input) return;
    input.value = "";
    if (!id) return;
    const cachedTask = window.NMPlannerState?.getTasks?.().find((task) => String(task.id) === String(id));
    if (cachedTask?.actual_minutes !== null && cachedTask?.actual_minutes !== undefined) input.value = String(cachedTask.actual_minutes);
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  }

  function analyticsRows(tasks) {
    return tasks.map((task) => {
      const createdDate = timestampDateKey(task.created_at);
      const planned = plannedDate(task);
      const completedDate = timestampDateKey(task.completed_at);
      const daysAhead = planned && createdDate ? differenceInDays(createdDate, planned) : "";
      const actual = task.actual_minutes === null || task.actual_minutes === undefined ? "" : Number(task.actual_minutes);
      const variance = actual === "" ? "" : actual - Number(task.minutes || 0);
      const variancePct = actual === "" || actual === 0 ? "" : Math.round((variance / actual) * 100);
      return {
        task_id: task.id,
        parent_task_id: task.parent_task_id || "",
        task: task.title,
        focus_area: task.area || "",
        quadrant: task.quadrant ? task.quadrant.toUpperCase() : "",
        week_start: task.week || "",
        planned_day: Number.isInteger(task.day) ? DAYS[task.day] : "",
        planned_date: planned,
        due_date: task.due || "",
        created_at: task.created_at || "",
        created_date: createdDate,
        planning_category: planningCategory(task),
        days_planned_ahead: daysAhead,
        added_before_week: createdDate && task.week && createdDate < task.week ? "Yes" : "No",
        added_during_week: createdDate && task.week && createdDate >= task.week && createdDate <= addDays(task.week, 6) ? "Yes" : "No",
        added_same_day: planned && createdDate === planned ? "Yes" : "No",
        followup_reason_code: task.followup_reason || "",
        followup_reason: task.followup_reason ? reasonLabel(task.followup_reason) : "",
        rescheduled_from_week: task.rescheduled_from_week || "",
        rescheduled_to_week: task.rescheduled_to_week || "",
        carried_forward: task.rescheduled_from_week && task.rescheduled_to_week ? "Yes" : "No",
        operational: isOperational(task) ? "Yes" : "No",
        superseded_by_followup: task.superseded_by_followup ? "Yes" : "No",
        discarded_at: task.discarded_at || "",
        completed: task.completed ? "Yes" : "No",
        completed_at: task.completed_at || "",
        completed_date: completedDate,
        completion_status: completionCategory(task),
        estimated_minutes: Number(task.minutes || 0),
        estimated_hours: (Number(task.minutes || 0) / 60).toFixed(2),
        actual_minutes: actual,
        actual_hours: actual === "" ? "" : (actual / 60).toFixed(2),
        variance_minutes: variance,
        variance_percent: variancePct,
      };
    });
  }

  async function exportAnalytics() {
    const tasks = await loadAllTasks(true);
    if (!tasks.length) return;
    const rows = analyticsRows(tasks);
    const headers = Object.keys(rows[0]);
    const csv = [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `nmplanner-analytics-${dateKey(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function installSettingsExport() {
    if (!await checkSchema()) return;
    const cards = [...document.querySelectorAll(".setting-card")];
    const backupCard = cards.find((card) => card.querySelector("h2")?.textContent.trim() === "Backup and transfer");
    if (!backupCard || backupCard.querySelector('[data-analytics-action="export"]')) return;
    const row = backupCard.querySelector(".button-row");
    if (!row) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.dataset.analyticsAction = "export";
    button.textContent = "Download analytics CSV";
    row.append(button);
  }

  document.addEventListener("click", (event) => {
    const analyticsButton = event.target.closest('[data-analytics-action="export"]');
    if (analyticsButton) {
      event.preventDefault();
      exportAnalytics().catch(() => {});
      return;
    }

    const followupButton = event.target.closest("[data-followup-action]");
    if (!followupButton) return;
    if (followupButton.dataset.followupAction === "edit") {
      setTimeout(() => loadFollowupActual(followupButton.dataset.id), 0);
    } else if (followupButton.dataset.followupAction === "add") {
      setTimeout(() => loadFollowupActual(null), 0);
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.id !== "week-picker") return;
    state.loadedAt = 0;
    setTimeout(() => renderInsights(true).catch(() => {}), 80);
  });

  let observerScheduled = false;
  const observer = new MutationObserver(() => {
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(() => {
      observerScheduled = false;
      installActualTimeField();
      installFollowupActualField();
      installSettingsExport();
      if (document.querySelector(".insight-layout") && !document.querySelector("[data-analytics-dashboard]")) renderInsights(true).catch(() => {});
    });
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    if (document.querySelector(".insight-layout")) renderInsights(false).catch(() => {});
  });
  window.addEventListener("nmplanner-analytics-changed", () => {
    if (document.querySelector(".insight-layout")) renderInsights(false).catch(() => {});
  });
  window.addEventListener("nmplanner-tasks-changed", () => {
    const appState = window.NMPlannerState;
    const week = appState?.getWeek?.();
    if (appState?.isWeekLoaded?.() && week) {
      const current = (appState.getTasks?.() || []).map((task) => ({
        ...task,
        followup_reason: task.followup_reason || null,
        rescheduled_from_week: task.rescheduled_from_week || null,
        rescheduled_to_week: task.rescheduled_to_week || null,
        superseded_by_followup: task.superseded_by_followup === true,
        discarded_at: task.discarded_at || null,
      }));
      if (state.tasks.length) {
        state.tasks = [...state.tasks.filter((task) => task.week !== week), ...current];
      }
      if (document.querySelector(".insight-layout")) renderInsights(false).catch(() => {});
    }
  });

  installActualTimeField();
  installFollowupActualField();
  installSettingsExport();
  renderInsights().catch(() => {});
})();