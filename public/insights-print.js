(() => {
  const printClient = window.NMPlannerRuntime?.client;
  if (!printClient) return;

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const QUADRANTS = {
    q1: { label: "Q1 · Urgent & Important" },
    q2: { label: "Q2 · Important, Not Urgent" },
    q3: { label: "Q3 · Urgent, Not Important" },
    q4: { label: "Q4 · Not Urgent, Not Important" },
  };
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
    tasks: [],
    reviews: [],
    loadedAt: 0,
    loading: null,
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
    const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
    return year && month && day ? new Date(year, month - 1, day, 12) : null;
  }

  function dateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
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

  function mondayKey(value) {
    const date = parseDate(value);
    if (!date) return "";
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return dateKey(date);
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  function formatDate(value, withWeekday = false) {
    const date = parseDate(value);
    if (!date) return value || "";
    return new Intl.DateTimeFormat("en-GB", withWeekday
      ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
      : { day: "numeric", month: "short", year: "numeric" }
    ).format(date);
  }

  function formatWeek(week) {
    return `${formatDate(week)} – ${formatDate(addDays(week, 6))}`;
  }

  function percent(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  function isOperational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(Number(total || 0)));
    if (minutes === 540) return "Full Day · 9h";
    if (minutes === 300) return "Half Day · 5h";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    if (!rest) return `${hours}h`;
    return `${hours}h ${rest}m`;
  }

  function formatClock(minute) {
    const value = Number(minute);
    if (!Number.isInteger(value)) return "";
    const h = String(Math.floor(value / 60)).padStart(2, "0");
    const m = String(value % 60).padStart(2, "0");
    return `${h}:${m}`;
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await printClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function loadData(force = false) {
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 10000) return true;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const session = await getSession();
      if (!session) return false;

      const [taskResult, reviewResult] = await Promise.all([
        printClient
          .from("tasks")
          .select("id,parent_task_id,title,week,day,day_rank,planned_start_minute,quadrant,area,due,minutes,completed,completed_at,created_at,updated_at,followup_reason,rescheduled_from_week,rescheduled_to_week,superseded_by_followup,discarded_at")
          .eq("user_id", session.user.id)
          .order("created_at", { ascending: true }),
        printClient
          .from("task_reviews")
          .select("id,task_id,task_snapshot,action,reason,from_date,to_date,occurred_at,review_source")
          .eq("user_id", session.user.id)
          .order("occurred_at", { ascending: true }),
      ]);

      if (taskResult.error) return false;
      state.tasks = (taskResult.data || []).map((task) => ({
        ...task,
        superseded_by_followup: task.superseded_by_followup === true,
        discarded_at: task.discarded_at || null,
      }));
      state.reviews = reviewResult.error ? [] : (reviewResult.data || []);
      state.loadedAt = Date.now();
      return true;
    })();

    try {
      return await state.loading;
    } finally {
      state.loading = null;
    }
  }

  async function settings() {
    try {
      if (window.NMPlannerSettings?.get) return await window.NMPlannerSettings.get();
    } catch (_) {}
    return { work_name: "Primary Work", additional_work_name: "Additional Work" };
  }

  function displayArea(area, cfg) {
    if (area === "BCU / Teaching") return cfg?.work_name || "Primary Work";
    if (area === "WorldSkills") return cfg?.additional_work_name || "Additional Work";
    if (area === "Personal / Admin" || area === "Lunch") return "Personal Time";
    return area || "Uncategorised";
  }

  function rootKeyForTask(task, taskMap) {
    if (!task) return "";
    let current = task;
    let key = task.id || "";
    const seen = new Set();
    while (current?.parent_task_id && !seen.has(current.parent_task_id)) {
      seen.add(current.id || current.parent_task_id);
      const parent = taskMap.get(current.parent_task_id);
      if (!parent) return current.parent_task_id || key;
      current = parent;
      key = parent.id;
    }
    return key;
  }

  function rootKeyForReview(review, taskMap) {
    if (review?.task_id && taskMap.has(review.task_id)) return rootKeyForTask(taskMap.get(review.task_id), taskMap);
    const snapshot = review?.task_snapshot || {};
    if (snapshot.id && taskMap.has(snapshot.id)) return rootKeyForTask(taskMap.get(snapshot.id), taskMap);
    if (snapshot.parent_task_id && taskMap.has(snapshot.parent_task_id)) return rootKeyForTask(taskMap.get(snapshot.parent_task_id), taskMap);
    return snapshot.parent_task_id || snapshot.id || review?.task_id || `review-${review?.id || "unknown"}`;
  }

  function buildFamilies() {
    const taskMap = new Map(state.tasks.map((task) => [task.id, task]));
    const families = new Map();
    const ensure = (key) => {
      if (!families.has(key)) families.set(key, { key, tasks: [], reviews: [] });
      return families.get(key);
    };

    for (const task of state.tasks) ensure(rootKeyForTask(task, taskMap) || task.id).tasks.push(task);
    for (const review of state.reviews) ensure(rootKeyForReview(review, taskMap)).reviews.push(review);
    return { taskMap, families };
  }

  function familyLeaves(family) {
    const parentIds = new Set(family.tasks.map((task) => task.parent_task_id).filter(Boolean));
    return family.tasks.filter((task) => !parentIds.has(task.id));
  }

  function familyCurrentState(family) {
    const leaves = familyLeaves(family);
    const currentLeaves = leaves.filter(isOperational);
    const openLeaves = currentLeaves.filter((task) => !task.completed);
    const completedLeaves = currentLeaves.filter((task) => task.completed);
    const discardedLeaves = leaves.filter((task) => Boolean(task.discarded_at));
    if (openLeaves.length) return { state: "open", leaves: currentLeaves, openLeaves, completedLeaves };
    if (currentLeaves.length && completedLeaves.length === currentLeaves.length) return { state: "completed", leaves: currentLeaves, openLeaves, completedLeaves };
    if (!currentLeaves.length && discardedLeaves.length) return { state: "dropped", leaves, openLeaves: [], completedLeaves: [] };
    return { state: "historical", leaves, openLeaves: [], completedLeaves };
  }

  function familyTitle(family) {
    const current = familyCurrentState(family);
    const choices = current.openLeaves.length ? current.openLeaves : current.leaves.length ? current.leaves : family.tasks;
    return [...choices]
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0]?.title || "Untitled task";
  }

  function familyDisplayTask(family, week) {
    const inWeek = family.tasks.filter((task) => task.week === week);
    if (inWeek.length) {
      return [...inWeek].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    }
    const current = familyCurrentState(family);
    const choices = current.openLeaves.length ? current.openLeaves : current.leaves.length ? current.leaves : family.tasks;
    return [...choices].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
  }

  function completionDateForFamily(family) {
    const current = familyCurrentState(family);
    if (current.state !== "completed") return "";
    return current.completedLeaves
      .map((task) => task.completed_at ? dateKey(new Date(task.completed_at)) : "")
      .filter(Boolean)
      .sort()
      .at(-1) || "";
  }

  function reviewInWeek(review, week) {
    const end = addDays(week, 6);
    return Boolean(review?.from_date && review.from_date >= week && review.from_date <= end);
  }

  function familyTouchesWeek(family, week) {
    if (family.tasks.some((task) => task.week === week || task.rescheduled_from_week === week || task.rescheduled_to_week === week)) return true;
    return family.reviews.some((review) => reviewInWeek(review, week) || review.task_snapshot?.week === week || (review.to_date && mondayKey(review.to_date) === week));
  }

  function scheduledDatesForWeek(family, week) {
    const dates = [];
    for (const task of family.tasks) {
      if (task.week === week && Number.isInteger(task.day)) dates.push(plannedDate(task));
    }
    for (const review of family.reviews) {
      const snapshot = review.task_snapshot || {};
      if (snapshot.week === week && Number.isInteger(snapshot.day)) dates.push(plannedDate(snapshot));
      if (reviewInWeek(review, week) && review.from_date) dates.push(review.from_date);
    }
    return [...new Set(dates.filter(Boolean))].sort();
  }

  function movementEventsForWeek(family, week) {
    const events = family.reviews
      .filter((review) => review.action === "moved" && reviewInWeek(review, week))
      .map((review) => ({ reason: review.reason || "other", source: review.review_source || "legacy", from_date: review.from_date, to_date: review.to_date || "" }));
    for (const task of family.tasks) {
      if (task.rescheduled_from_week !== week || !task.rescheduled_to_week) continue;
      events.push({ reason: task.followup_reason || "other", source: "followup", from_date: task.rescheduled_from_week, to_date: task.rescheduled_to_week });
    }
    return events;
  }

  function dropEventsForWeek(family, week) {
    return family.reviews
      .filter((review) => review.action === "discarded" && reviewInWeek(review, week))
      .map((review) => ({ reason: review.reason || "other", from_date: review.from_date }));
  }

  function itemForWeek(family, week) {
    const scheduledDates = scheduledDatesForWeek(family, week);
    const movements = movementEventsForWeek(family, week);
    const drops = dropEventsForWeek(family, week);
    const current = familyCurrentState(family);
    const completionDate = completionDateForFamily(family);
    const firstScheduledDate = scheduledDates[0] || "";
    const weekEnd = addDays(week, 6);
    const movedBeyondWeek = movements.some((event) => event.to_date && event.to_date > weekEnd)
      || current.openLeaves.some((task) => task.week && task.week > week);
    const dropped = current.state === "dropped" || drops.length > 0;
    const completed = current.state === "completed";
    const open = current.state === "open" || (!completed && !dropped && current.state === "historical");
    const completedAsPlanned = Boolean(completed && firstScheduledDate && completionDate && completionDate <= firstScheduledDate && movements.length === 0);
    return {
      key: family.key,
      family,
      title: familyTitle(family),
      displayTask: familyDisplayTask(family, week),
      scheduled: scheduledDates.length > 0,
      scheduledDates,
      movements,
      drops,
      moved: movements.length > 0,
      movedBeyondWeek,
      completed,
      completedAsPlanned,
      completedLater: completed && !completedAsPlanned,
      dropped: dropped && !completed,
      open: open && !dropped,
      carriedForward: open && movedBeyondWeek,
      completionDate,
    };
  }

  function weeklyExecution(context, week) {
    const items = [...context.families.values()]
      .filter((family) => familyTouchesWeek(family, week))
      .map((family) => itemForWeek(family, week));
    const committed = items.length;
    const scheduled = items.filter((item) => item.scheduled).length;
    const completed = items.filter((item) => item.completed).length;
    const onPlan = items.filter((item) => item.completedAsPlanned).length;
    const completedLater = items.filter((item) => item.completedLater).length;
    const movedItems = items.filter((item) => item.moved).length;
    const carriedForward = items.filter((item) => item.carriedForward).length;
    const dropped = items.filter((item) => item.dropped).length;
    const open = items.filter((item) => item.open).length;
    return {
      week,
      items,
      committed,
      scheduled,
      completed,
      onPlan,
      completedLater,
      movedItems,
      carriedForward,
      dropped,
      open,
      scheduledRate: percent(scheduled, committed),
      completionRate: percent(completed, committed),
      onPlanRate: percent(onPlan, scheduled),
      movedRate: percent(movedItems, committed),
      completedLaterRate: percent(completedLater, committed),
      droppedRate: percent(dropped, committed),
      openRate: percent(open, committed),
    };
  }

  function incomingEventsForFamily(family, week) {
    const end = addDays(week, 6);
    const events = family.reviews
      .filter((review) => review.action === "moved" && review.to_date && review.to_date >= week && review.to_date <= end && review.from_date < week)
      .map((review) => ({ reason: review.reason || "other", from_date: review.from_date, to_date: review.to_date }));
    for (const task of family.tasks) {
      if (task.rescheduled_to_week === week && task.rescheduled_from_week && task.rescheduled_from_week < week) {
        events.push({ reason: task.followup_reason || "other", from_date: task.rescheduled_from_week, to_date: task.rescheduled_to_week });
      }
    }
    return events.sort((a, b) => String(a.to_date).localeCompare(String(b.to_date)) || String(a.from_date).localeCompare(String(b.from_date)));
  }

  function planningBreakdown(execution, week) {
    const previousWeek = addDays(week, -7);
    const reasonCounts = new Map();
    let plannedBefore = 0;
    let movedIn = 0;
    let movedFromPrevious = 0;
    let plannedDuring = 0;

    for (const item of execution.items) {
      const inbound = incomingEventsForFamily(item.family, week);
      if (inbound.length) {
        movedIn += 1;
        const chosen = inbound.at(-1);
        if (chosen.from_date >= previousWeek && chosen.from_date < week) movedFromPrevious += 1;
        reasonCounts.set(chosen.reason, (reasonCounts.get(chosen.reason) || 0) + 1);
        continue;
      }

      const relevantTasks = item.family.tasks.filter((task) => task.week === week);
      const created = relevantTasks
        .map((task) => task.created_at ? dateKey(new Date(task.created_at)) : "")
        .filter(Boolean)
        .sort()[0] || "";
      if (created && created < week) plannedBefore += 1;
      else plannedDuring += 1;
    }

    return {
      plannedBefore,
      movedIn,
      movedFromPrevious,
      plannedDuring,
      reasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count, label: REASON_LABELS[reason] || "Other" }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  }

  function statusLabel(item) {
    if (item.completedAsPlanned) return "Completed as planned";
    if (item.completedLater) return "Completed later";
    if (item.dropped) return "Dropped";
    if (item.carriedForward) return "Carried forward";
    if (item.open) return "Still open";
    return "Historical";
  }

  function reportStyles() {
    return `
      @page { size: A4 landscape; margin: 10mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; font-size: 10px; background: white; }
      h1,h2,h3,p { margin: 0; }
      .page { padding: 0; }
      .header { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; padding-bottom: 10px; border-bottom: 2px solid #183b66; }
      .header h1 { font-size: 22px; color: #183b66; }
      .header p { margin-top: 4px; color: #5e6b7d; font-size: 10px; }
      .stamp { text-align: right; color: #6b7280; font-size: 8px; }
      .section { margin-top: 12px; break-inside: avoid; }
      .section-title { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 7px; }
      .section-title h2 { font-size: 14px; color: #233b5d; }
      .section-title span { color: #6b7280; font-size: 8px; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
      .kpi { padding: 9px; border: 1px solid #dbe3ec; border-radius: 8px; min-height: 74px; }
      .kpi strong { display: block; font-size: 17px; color: #17365d; }
      .kpi b { display: block; margin-top: 2px; font-size: 9px; }
      .kpi small { display: block; margin-top: 5px; color: #687486; font-size: 7.5px; line-height: 1.35; }
      .entry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .summary-box { padding: 10px; border: 1px solid #dbe3ec; border-radius: 8px; }
      .summary-box h3 { font-size: 11px; margin-bottom: 6px; }
      .summary-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-top: 1px solid #edf1f5; }
      .summary-row:first-of-type { border-top: 0; }
      .reason-list { display: grid; gap: 4px; }
      .matrix { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
      .quadrant { border: 1px solid #cfd9e5; border-radius: 9px; overflow: hidden; break-inside: avoid; }
      .quadrant h3 { padding: 7px 9px; background: #f2f6fa; font-size: 10px; border-bottom: 1px solid #dbe3ec; }
      .task { padding: 6px 8px; border-top: 1px solid #edf1f5; }
      .task:first-of-type { border-top: 0; }
      .task-title { display: flex; justify-content: space-between; gap: 8px; }
      .task-title strong { font-size: 8.5px; }
      .task-title span { color: #526173; font-size: 7.5px; white-space: nowrap; }
      .task-meta { margin-top: 3px; color: #6a7687; font-size: 7px; line-height: 1.3; }
      .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; align-items: start; }
      .day { border: 1px solid #ccd7e3; border-radius: 8px; min-height: 190px; overflow: hidden; break-inside: avoid; }
      .day-head { padding: 7px; background: #eef4fa; border-bottom: 1px solid #dbe3ec; }
      .day-head strong { display: block; font-size: 9px; }
      .day-head span { color: #657286; font-size: 7px; }
      .cal-task { margin: 5px; padding: 6px; border-left: 3px solid #6b85a5; background: #f8fafc; border-radius: 5px; }
      .cal-task.done { opacity: .7; }
      .cal-task.history { border-left-color: #b7791f; background: #fffaf0; }
      .cal-time { color: #264d78; font-weight: 700; font-size: 7px; }
      .cal-task strong { display: block; margin-top: 2px; font-size: 8px; line-height: 1.25; }
      .cal-task span { display: block; margin-top: 2px; color: #667386; font-size: 6.7px; line-height: 1.3; }
      .unscheduled { margin-top: 10px; padding: 8px; border: 1px dashed #cbd5e1; border-radius: 8px; }
      .unscheduled h3 { font-size: 9px; margin-bottom: 5px; }
      .footer { margin-top: 10px; padding-top: 7px; border-top: 1px solid #dbe3ec; color: #7a8594; font-size: 7px; display: flex; justify-content: space-between; }
      @media print { .page { break-after: auto; } }
    `;
  }

  function baseReport(title, week, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · ${escapeHtml(formatWeek(week))}</title><style>${reportStyles()}</style></head><body><main class="page"><header class="header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(formatWeek(week))}</p></div><div class="stamp">NM Planner<br>Printable weekly report</div></header>${body}<footer class="footer"><span>Generated from NM Planner</span><span>${escapeHtml(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date()))}</span></footer></main></body></html>`;
  }

  function metricCard(value, label, detail) {
    return `<div class="kpi"><strong>${escapeHtml(value)}</strong><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></div>`;
  }

  function matrixReport(context, execution, week, cfg) {
    const breakdown = planningBreakdown(execution, week);
    const reasonRows = breakdown.reasons.length
      ? breakdown.reasons.map((row) => `<div class="summary-row"><span>${escapeHtml(row.label)}</span><strong>${row.count}</strong></div>`).join("")
      : '<div class="summary-row"><span>No moved-in work recorded</span><strong>0</strong></div>';

    const matrixItems = { q1: [], q2: [], q3: [], q4: [], none: [] };
    for (const item of execution.items) {
      const task = item.displayTask;
      const key = ["q1", "q2", "q3", "q4"].includes(task?.quadrant) ? task.quadrant : "none";
      matrixItems[key].push(item);
    }

    const quadrantMarkup = (key, label) => {
      const rows = matrixItems[key];
      return `<article class="quadrant"><h3>${escapeHtml(label)} · ${rows.length} item${rows.length === 1 ? "" : "s"}</h3>${rows.length ? rows.map((item) => {
        const task = item.displayTask || {};
        const day = Number.isInteger(task.day) ? DAYS[task.day] : "Unscheduled";
        return `<div class="task"><div class="task-title"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(statusLabel(item))}</span></div><div class="task-meta">${escapeHtml(day)} · ${escapeHtml(displayArea(task.area, cfg))} · ${escapeHtml(formatMinutes(task.minutes || 0))}</div></div>`;
      }).join("") : '<div class="task"><div class="task-meta">No work items</div></div>'}</article>`;
    };

    const body = `
      <section class="section"><div class="section-title"><h2>Weekly execution summary</h2><span>Distinct task/follow-up families</span></div><div class="kpis">
        ${metricCard(String(execution.committed), "Committed work items", "Distinct task/follow-up families assigned to this week")}
        ${metricCard(`${execution.scheduledRate}%`, "Scheduled", `${execution.scheduled} / ${execution.committed} committed work items had a planned day`)}
        ${metricCard(`${execution.completionRate}%`, "Completed overall", `${execution.completed} / ${execution.committed} committed work items are complete`)}
        ${metricCard(`${execution.onPlanRate}%`, "Completed as planned", `${execution.onPlan} / ${execution.scheduled} scheduled work items completed on/before the original planned day without a recorded move`)}
        ${metricCard(`${execution.movedRate}%`, "Moved / extended", `${execution.movedItems} / ${execution.committed} committed work items had at least one recorded move`)}
        ${metricCard(`${execution.completedLaterRate}%`, "Completed later", `${execution.completedLater} / ${execution.committed} committed work items completed after a plan change or later than the original planned day`)}
        ${metricCard(`${execution.droppedRate}%`, "Dropped", `${execution.dropped} / ${execution.committed} committed work items were discarded`)}
        ${metricCard(`${execution.openRate}%`, "Still open", `${execution.open} / ${execution.committed} committed work items remain unresolved · ${execution.carriedForward} carried forward`)}
      </div></section>

      <section class="section"><div class="section-title"><h2>How work entered this week</h2><span>mutually exclusive committed-work categories</span></div><div class="entry-grid">
        <div class="summary-box"><h3>Committed-work origin</h3>
          <div class="summary-row"><span>Total committed work items</span><strong>${execution.committed}</strong></div>
          <div class="summary-row"><span>Planned before the week started</span><strong>${breakdown.plannedBefore}</strong></div>
          <div class="summary-row"><span>Moved in from earlier weeks</span><strong>${breakdown.movedIn}</strong></div>
          <div class="summary-row"><span>↳ from the immediately previous week</span><strong>${breakdown.movedFromPrevious}</strong></div>
          <div class="summary-row"><span>Planned during the week</span><strong>${breakdown.plannedDuring}</strong></div>
        </div>
        <div class="summary-box"><h3>Why work was moved into this week</h3><div class="reason-list">${reasonRows}</div></div>
      </div></section>

      <section class="section"><div class="section-title"><h2>Weekly Four-Quadrant Matrix</h2><span>retrospective status shown beside each committed work item</span></div><div class="matrix">
        ${quadrantMarkup("q1", QUADRANTS.q1.label)}
        ${quadrantMarkup("q2", QUADRANTS.q2.label)}
        ${quadrantMarkup("q3", QUADRANTS.q3.label)}
        ${quadrantMarkup("q4", QUADRANTS.q4.label)}
      </div>${matrixItems.none.length ? `<div style="margin-top:9px">${quadrantMarkup("none", "Unclassified")}</div>` : ""}</section>`;

    return baseReport("Weekly Four-Quadrant Matrix + Execution Summary", week, body);
  }

  function reviewCalendarEntries(week) {
    const entries = [];
    for (const review of state.reviews) {
      if (!review.from_date || mondayKey(review.from_date) !== week) continue;
      if (!review.task_snapshot || !Number.isInteger(review.task_snapshot.day)) continue;
      if (!["moved", "discarded"].includes(review.action)) continue;
      const snap = review.task_snapshot;
      entries.push({
        id: `review-${review.id}`,
        day: snap.day,
        title: snap.title || "Untitled task",
        area: snap.area || "Uncategorised",
        quadrant: snap.quadrant || "",
        minutes: Number(snap.minutes || 0),
        planned_start_minute: Number.isInteger(snap.planned_start_minute) ? snap.planned_start_minute : null,
        status: review.action === "moved" ? "Moved" : "Dropped",
        history: true,
      });
    }
    return entries;
  }

  function followupCalendarEntries(week) {
    const byParent = new Map();
    for (const task of state.tasks) {
      if (!task.parent_task_id) continue;
      if (!byParent.has(task.parent_task_id)) byParent.set(task.parent_task_id, []);
      byParent.get(task.parent_task_id).push(task);
    }

    return state.tasks
      .filter((task) =>
        task.week === week
        && task.superseded_by_followup === true
        && !task.discarded_at
        && Number.isInteger(task.day)
        && Number.isInteger(task.planned_start_minute)
      )
      .map((task) => {
        const children = (byParent.get(task.id) || [])
          .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
        const first = children[0] || null;
        const destination = first?.week && Number.isInteger(first.day)
          ? formatDate(addDays(first.week, first.day), true)
          : "";
        const status = children.length > 1
          ? `★ ${children.length} follow-ups`
          : destination
            ? `★ Follow-up → ${destination}`
            : "★ Follow-up created";
        return {
          id: `followup-${task.id}`,
          day: task.day,
          title: task.title,
          area: task.area,
          quadrant: task.quadrant || "",
          minutes: Number(task.minutes || 0),
          planned_start_minute: task.planned_start_minute,
          day_rank: Number.isInteger(task.day_rank) ? task.day_rank : 999,
          status,
          history: true,
        };
      });
  }

  function calendarReport(week, cfg) {
    const currentEntries = state.tasks
      .filter((task) => task.week === week && isOperational(task) && Number.isInteger(task.day))
      .map((task) => ({
        id: task.id,
        day: task.day,
        title: task.title,
        area: task.area,
        quadrant: task.quadrant || "",
        minutes: Number(task.minutes || 0),
        planned_start_minute: Number.isInteger(task.planned_start_minute) ? task.planned_start_minute : null,
        day_rank: Number.isInteger(task.day_rank) ? task.day_rank : 999,
        status: task.completed ? "Completed" : "Open",
        completed: Boolean(task.completed),
        history: false,
      }));
    const historyEntries = [...followupCalendarEntries(week), ...reviewCalendarEntries(week)];
    const allEntries = [...currentEntries, ...historyEntries];

    const dayMarkup = DAYS.map((day, index) => {
      const date = addDays(week, index);
      const rows = allEntries
        .filter((entry) => entry.day === index)
        .sort((a, b) => {
          const aTime = Number.isInteger(a.planned_start_minute) ? a.planned_start_minute : 9999;
          const bTime = Number.isInteger(b.planned_start_minute) ? b.planned_start_minute : 9999;
          return aTime - bTime || (a.day_rank || 999) - (b.day_rank || 999) || String(a.title).localeCompare(String(b.title));
        });
      return `<article class="day"><div class="day-head"><strong>${escapeHtml(day)}</strong><span>${escapeHtml(formatDate(date, false))}</span></div>${rows.length ? rows.map((entry) => {
        const start = entry.planned_start_minute;
        const time = Number.isInteger(start)
          ? `${formatClock(start)}–${formatClock(start + Number(entry.minutes || 0))}`
          : "Day task · no start time";
        const classes = ["cal-task", entry.completed ? "done" : "", entry.history ? "history" : ""].filter(Boolean).join(" ");
        return `<div class="${classes}"><div class="cal-time">${escapeHtml(time)}</div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.quadrant ? entry.quadrant.toUpperCase() : "No quadrant")} · ${escapeHtml(displayArea(entry.area, cfg))} · ${escapeHtml(formatMinutes(entry.minutes))} · ${escapeHtml(entry.status)}</span></div>`;
      }).join("") : '<div class="cal-task"><span>No planned work</span></div>'}</article>`;
    }).join("");

    const unassigned = state.tasks
      .filter((task) => task.week === week && isOperational(task) && !Number.isInteger(task.day))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));

    const body = `<section class="section"><div class="section-title"><h2>Weekly Time Plan</h2><span>current plan plus preserved follow-up, moved and dropped historical occurrences from this week</span></div><div class="calendar">${dayMarkup}</div></section>${unassigned.length ? `<section class="unscheduled"><h3>Unassigned to a day</h3>${unassigned.map((task) => `<div class="summary-row"><span>${escapeHtml(task.title)} · ${escapeHtml(task.quadrant ? task.quadrant.toUpperCase() : "No quadrant")} · ${escapeHtml(displayArea(task.area, cfg))}</span><strong>${escapeHtml(formatMinutes(task.minutes))}</strong></div>`).join("")}</section>` : ""}`;
    return baseReport("Weekly Time Plan · Calendar", week, body);
  }

  function showPreparing(popup) {
    const body = popup.document.body;
    if (!body) return;
    body.textContent = "Preparing printable report…";
    body.style.fontFamily = "Arial, Helvetica, sans-serif";
    body.style.padding = "24px";
    body.style.color = "#172033";
  }

  function writeAndPrint(popup, html) {
    const reportUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const printReport = () => {
      setTimeout(() => {
        try {
          popup.focus();
          popup.print();
        } finally {
          setTimeout(() => URL.revokeObjectURL(reportUrl), 1000);
        }
      }, 150);
    };
    popup.addEventListener("load", printReport, { once: true });
    popup.location.replace(reportUrl);
  }

  async function handlePrint(kind, popup) {
    const week = selectedWeek();
    if (!week || !await loadData(true)) {
      popup.close();
      window.alert("The printable report could not be prepared. Please refresh NM Planner and try again.");
      return;
    }
    const cfg = await settings();
    if (kind === "calendar") {
      writeAndPrint(popup, calendarReport(week, cfg));
      return;
    }
    const context = buildFamilies();
    const execution = weeklyExecution(context, week);
    writeAndPrint(popup, matrixReport(context, execution, week, cfg));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-insights-print]");
    if (!button) return;
    event.preventDefault();
    const popup = window.open("", "_blank", "width=1200,height=900");
    if (!popup) {
      window.alert("Please allow pop-ups for NM Planner so the printable report can open.");
      return;
    }
    popup.opener = null;
    showPreparing(popup);
    handlePrint(button.dataset.insightsPrint, popup).catch(() => {
      try { popup.close(); } catch (_) {}
      window.alert("The printable report could not be prepared. Please try again.");
    });
  });

  window.addEventListener("focus", () => { state.loadedAt = 0; });
  window.addEventListener("nmplanner-analytics-changed", () => { state.loadedAt = 0; });
  window.addEventListener("nmplanner-followup-changed", () => { state.loadedAt = 0; });
  window.addEventListener("nmplanner-task-rescheduled", () => { state.loadedAt = 0; });
})();