(() => {
  const executionClient = window.NMPlannerRuntime?.client;
  if (!executionClient) return;

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
    signature: "",
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

  function timestampDateKey(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dateKey(date);
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

  function differenceInDays(fromKey, toKey) {
    const from = parseDate(fromKey);
    const to = parseDate(toKey);
    if (!from || !to) return null;
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function percent(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  function formatWeekShort(week) {
    const start = parseDate(week);
    if (!start) return week;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const formatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
    return `${formatter.format(start)}–${formatter.format(end)}`;
  }

  function isOperational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await executionClient.auth.getSession();
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
        executionClient
          .from("tasks")
          .select("id,parent_task_id,title,week,day,planned_start_minute,quadrant,area,minutes,completed,completed_at,created_at,updated_at,followup_reason,rescheduled_from_week,rescheduled_to_week,superseded_by_followup,discarded_at,split_group_id,split_instance_index,split_instance_count")
          .eq("user_id", session.user.id)
          .order("created_at", { ascending: true }),
        executionClient
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

  function rootKeyForTask(task, taskMap) {
    if (!task) return "";
    if (task.split_group_id) return `split:${task.split_group_id}`;
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
    if (snapshot.split_group_id) return `split:${snapshot.split_group_id}`;
    return snapshot.parent_task_id || snapshot.id || review?.task_id || `review-${review?.id || "unknown"}`;
  }

  function buildFamilies(tasks, reviews) {
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const families = new Map();

    const ensure = (key) => {
      if (!families.has(key)) families.set(key, { key, tasks: [], reviews: [] });
      return families.get(key);
    };

    for (const task of tasks) {
      const key = rootKeyForTask(task, taskMap) || task.id;
      ensure(key).tasks.push(task);
    }
    for (const review of reviews) {
      const key = rootKeyForReview(review, taskMap);
      ensure(key).reviews.push(review);
    }

    return { taskMap, families };
  }

  function familyLeaves(family) {
    const parentIds = new Set(family.tasks.map((task) => task.parent_task_id).filter(Boolean));
    return family.tasks.filter((task) => !parentIds.has(task.id));
  }

  function familyOriginWeek(family) {
    const candidates = [];
    for (const task of family.tasks) {
      if (task.week) candidates.push(task.week);
      if (task.rescheduled_from_week) candidates.push(task.rescheduled_from_week);
    }
    for (const review of family.reviews) {
      const snapshotWeek = review.task_snapshot?.week;
      if (snapshotWeek) candidates.push(snapshotWeek);
      const fromWeek = mondayKey(review.from_date);
      if (fromWeek) candidates.push(fromWeek);
    }
    return candidates.sort()[0] || "";
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
    const status = familyCurrentState(family);
    const choices = status.openLeaves.length
      ? status.openLeaves
      : status.leaves.length
        ? status.leaves
        : family.tasks;
    return [...choices]
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0]?.title || "Untitled task";
  }

  function familyDisplayTask(family) {
    const status = familyCurrentState(family);
    const choices = status.openLeaves.length
      ? status.openLeaves
      : status.leaves.length
        ? status.leaves
        : family.tasks;
    return [...choices].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
  }

  function completionDateForFamily(family) {
    const status = familyCurrentState(family);
    if (status.state !== "completed") return "";
    const dates = status.completedLeaves.map((task) => timestampDateKey(task.completed_at)).filter(Boolean).sort();
    return dates.at(-1) || "";
  }

  function reviewInWeek(review, week) {
    const end = addDays(week, 6);
    return Boolean(review?.from_date && review.from_date >= week && review.from_date <= end);
  }

  function familyTouchesWeek(family, week) {
    if (family.tasks.some((task) => task.week === week || task.rescheduled_from_week === week)) return true;
    return family.reviews.some((review) => reviewInWeek(review, week) || review.task_snapshot?.week === week);
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
      .map((review) => ({
        id: `review-${review.id}`,
        reason: review.reason || "other",
        source: review.review_source || "legacy",
        from_date: review.from_date,
        to_date: review.to_date || "",
      }));

    for (const task of family.tasks) {
      if (task.rescheduled_from_week !== week || !task.rescheduled_to_week) continue;
      events.push({
        id: `followup-${task.id}`,
        reason: task.followup_reason || "other",
        source: "followup",
        from_date: task.rescheduled_from_week,
        to_date: task.rescheduled_to_week,
      });
    }
    return events;
  }

  function dropEventsForWeek(family, week) {
    return family.reviews
      .filter((review) => review.action === "discarded" && reviewInWeek(review, week))
      .map((review) => ({
        id: `review-${review.id}`,
        reason: review.reason || "other",
        source: review.review_source || "legacy",
        from_date: review.from_date,
      }));
  }

  function itemForWeek(family, week) {
    const scheduledDates = scheduledDatesForWeek(family, week);
    const movements = movementEventsForWeek(family, week);
    const drops = dropEventsForWeek(family, week);
    const current = familyCurrentState(family);
    const completionDate = completionDateForFamily(family);
    const firstScheduledDate = scheduledDates[0] || "";
    const splitFamily = family.tasks.some((task) => Boolean(task.split_group_id));
    const plannedCompletionDate = splitFamily ? (scheduledDates.at(-1) || "") : firstScheduledDate;
    const weekEnd = addDays(week, 6);
    const movedBeyondWeek = movements.some((event) => event.to_date && event.to_date > weekEnd)
      || current.openLeaves.some((task) => task.week && task.week > week);
    const dropped = current.state === "dropped" || drops.length > 0;
    const completed = current.state === "completed";
    const open = current.state === "open" || (!completed && !dropped && current.state === "historical");
    const completedAsPlanned = Boolean(
      completed
      && plannedCompletionDate
      && completionDate
      && completionDate <= plannedCompletionDate
      && movements.length === 0
    );

    return {
      key: family.key,
      family,
      title: familyTitle(family),
      scheduled: scheduledDates.length > 0,
      scheduledDates,
      firstScheduledDate,
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
      pending: open && !movedBeyondWeek,
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
    const pending = items.filter((item) => item.pending).length;
    const movementEvents = items.flatMap((item) => item.movements);
    const dropEvents = items.flatMap((item) => item.drops);

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
      pending,
      movementEvents,
      dropEvents,
      completionRate: percent(completed, committed),
      scheduledRate: percent(scheduled, committed),
      onPlanRate: percent(onPlan, scheduled),
      movedRate: percent(movedItems, committed),
      completedLaterRate: percent(completedLater, committed),
      droppedRate: percent(dropped, committed),
      openRate: percent(open, committed),
    };
  }

  function reasonRows(events) {
    const counts = new Map();
    for (const event of events) {
      const reason = event.reason || "other";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([reason, count]) => ({ reason, count, label: REASON_LABELS[reason] || "Other" }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function backlogRows(context, week) {
    return [...context.families.values()]
      .map((family) => {
        const status = familyCurrentState(family);
        if (status.state !== "open") return null;
        const originWeek = familyOriginWeek(family);
        if (!originWeek || originWeek >= week) return null;
        const ageDays = differenceInDays(originWeek, week);
        const ageWeeks = ageDays === null ? 0 : Math.max(0, Math.floor(ageDays / 7));
        if (!ageWeeks) return null;
        const task = familyDisplayTask(family);
        const moveCount = family.reviews.filter((review) => review.action === "moved").length
          + family.tasks.filter((row) => row.rescheduled_from_week && row.rescheduled_to_week).length;
        return {
          key: family.key,
          title: familyTitle(family),
          originWeek,
          ageWeeks,
          quadrant: task?.quadrant || "",
          area: task?.area || "Uncategorised",
          moveCount,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.ageWeeks - a.ageWeeks || b.moveCount - a.moveCount || a.title.localeCompare(b.title));
  }

  function kpi(value, label, detail, kind = "") {
    return `<article class="execution-kpi ${kind}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small></article>`;
  }

  function executionDashboardMarkup(execution) {
    return `
      <div class="analytics-heading">
        <div><p class="eyebrow">MARGINAL GAINS</p><h2>Weekly execution</h2><p>Committed work, plan reliability and carry-over for the selected week. Moved/extended is a process measure, so it can overlap a later completion outcome.</p></div>
        <button type="button" class="secondary-button" data-analytics-action="export">Download analytics CSV</button>
      </div>
      <div class="execution-kpis">
        ${kpi(String(execution.committed), "Committed work items", "Distinct logical jobs assigned to this week; planned split sessions count as one job", "committed")}
        ${kpi(`${execution.scheduledRate}%`, "Scheduled", `${execution.scheduled} / ${execution.committed} committed work items had a planned day`, "scheduled")}
        ${kpi(`${execution.completionRate}%`, "Completed overall", `${execution.completed} / ${execution.committed} committed work items are complete`, "completed")}
        ${kpi(`${execution.onPlanRate}%`, "Completed as planned", `${execution.onPlan} / ${execution.scheduled} scheduled work items completed on/before the original planned day without a recorded move`, "on-plan")}
        ${kpi(`${execution.movedRate}%`, "Moved / extended", `${execution.movedItems} / ${execution.committed} committed work items had at least one recorded move`, "moved")}
        ${kpi(`${execution.completedLaterRate}%`, "Completed later", `${execution.completedLater} / ${execution.committed} committed work items completed after a plan change or later than the original planned day`, "late")}
        ${kpi(`${execution.droppedRate}%`, "Dropped", `${execution.dropped} / ${execution.committed} committed work items were discarded`, "dropped")}
        ${kpi(`${execution.openRate}%`, "Still open", `${execution.open} / ${execution.committed} committed work items remain unresolved · ${execution.carriedForward} carried forward`, "open")}
      </div>`;
  }

  function reasonBreakdownMarkup(title, events, emptyText) {
    const rows = reasonRows(events);
    const total = events.length;
    return `
      <div class="execution-reason-block">
        <div class="execution-subheading"><strong>${escapeHtml(title)}</strong><span>${total} ${total === 1 ? "event" : "events"}</span></div>
        ${rows.length ? rows.map((row) => {
          const width = percent(row.count, total);
          return `<div class="execution-reason-row"><div><span>${escapeHtml(row.label)}</span><strong>${row.count}</strong></div><i><em style="width:${width}%"></em></i></div>`;
        }).join("") : `<p class="execution-empty">${escapeHtml(emptyText)}</p>`}
      </div>`;
  }

  function detailMarkup(execution, backlog) {
    const plannedMoves = execution.movementEvents.filter((event) => event.source === "planned_reschedule").length;
    const endOfDayMoves = execution.movementEvents.filter((event) => event.source === "end_of_day").length;
    const followupMoves = execution.movementEvents.filter((event) => event.source === "followup").length;
    const backlogOld = backlog.filter((item) => item.ageWeeks >= 4).length;

    return `
      <section class="execution-detail-grid" data-execution-detail>
        <article class="analytics-panel execution-reasons-panel">
          <div class="analytics-panel-heading"><div><h3>Why work moved or dropped</h3><span>reason events recorded against work originating in the selected week</span></div><span>${execution.movedItems} moved item${execution.movedItems === 1 ? "" : "s"}</span></div>
          <div class="execution-detail-body">
            ${reasonBreakdownMarkup("Move / extension reasons", execution.movementEvents, "No movement reasons recorded for this week.")}
            ${reasonBreakdownMarkup("Drop reasons", execution.dropEvents, "No dropped work recorded for this week.")}
            <div class="execution-source-strip"><span>Planned reschedule <strong>${plannedMoves}</strong></span><span>End-of-day move <strong>${endOfDayMoves}</strong></span><span>Follow-up extension <strong>${followupMoves}</strong></span></div>
          </div>
        </article>

        <article class="analytics-panel execution-backlog-panel">
          <div class="analytics-panel-heading"><div><h3>Historical backlog</h3><span>current unresolved work that originated before the selected week</span></div><span>${backlog.length} open · ${backlogOld} aged 4+ weeks</span></div>
          <div class="execution-backlog-list">
            ${backlog.length ? backlog.slice(0, 10).map((item) => `
              <div class="execution-backlog-row">
                <span class="quadrant-pill ${item.quadrant || "none"}">${item.quadrant ? item.quadrant.toUpperCase() : "—"}</span>
                <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.area)} · originated ${escapeHtml(formatWeekShort(item.originWeek))} · ${item.ageWeeks} week${item.ageWeeks === 1 ? "" : "s"} old${item.moveCount ? ` · ${item.moveCount} move${item.moveCount === 1 ? "" : "s"}` : ""}</span></div>
              </div>`).join("") : '<div class="incomplete-empty"><strong>No aged backlog</strong><span>No currently open work originated before the selected week.</span></div>'}
            ${backlog.length > 10 ? `<p class="execution-more">+ ${backlog.length - 10} more backlog item${backlog.length - 10 === 1 ? "" : "s"}</p>` : ""}
          </div>
        </article>
      </section>`;
  }

  function trendMarkup(context, selected) {
    const weeks = [-21, -14, -7, 0].map((offset) => weeklyExecution(context, addDays(selected, offset)));
    return `
      <div class="execution-trend-legend"><span><i class="on-plan"></i>Completed as planned</span><span><i class="late"></i>Completed later</span><span><i class="dropped"></i>Dropped</span><span><i class="open"></i>Still open</span></div>
      <div class="execution-trend">
        ${weeks.map((row, index) => {
          const denominator = Math.max(1, row.committed);
          const onPlan = row.committed ? row.onPlan / denominator * 100 : 0;
          const late = row.committed ? row.completedLater / denominator * 100 : 0;
          const dropped = row.committed ? row.dropped / denominator * 100 : 0;
          const open = row.committed ? row.open / denominator * 100 : 0;
          return `
            <div class="execution-trend-row ${index === weeks.length - 1 ? "current" : ""}">
              <div class="execution-trend-label"><strong>${escapeHtml(formatWeekShort(row.week))}</strong><span>${row.committed} committed · ${row.movedItems} moved</span></div>
              <div class="execution-trend-main">
                <div class="execution-trend-track" aria-label="${escapeHtml(formatWeekShort(row.week))}: ${row.onPlan} completed as planned, ${row.completedLater} completed later, ${row.dropped} dropped, ${row.open} still open">
                  <i class="on-plan" style="width:${onPlan.toFixed(2)}%"></i>
                  <i class="late" style="width:${late.toFixed(2)}%"></i>
                  <i class="dropped" style="width:${dropped.toFixed(2)}%"></i>
                  <i class="open" style="width:${open.toFixed(2)}%"></i>
                </div>
                <span>${row.onPlan} on-plan · ${row.completedLater} later · ${row.dropped} dropped · ${row.open} open</span>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  function plannerPanelMarkup(context, execution) {
    const previous = [-21, -14, -7].map((offset) => weeklyExecution(context, addDays(execution.week, offset)));
    const previousOnPlan = previous.filter((row) => row.scheduled > 0);
    const previousAverage = previousOnPlan.length
      ? Math.round(previousOnPlan.reduce((sum, row) => sum + row.onPlanRate, 0) / previousOnPlan.length)
      : null;

    let cue = "Use the four-week pattern to adjust workload gradually rather than reacting to a single week.";
    if (execution.movedRate >= 25) cue = `${execution.movedRate}% of committed work was moved or extended. Review the reason pattern before increasing next week's workload.`;
    else if (execution.droppedRate >= 10) cue = `${execution.droppedRate}% of committed work was dropped. Check whether the issue is prioritisation, dependencies or over-commitment.`;
    else if (previousAverage !== null && execution.onPlanRate + 10 < previousAverage) cue = `On-plan execution is ${execution.onPlanRate}% versus a ${previousAverage}% average across the previous three displayed weeks. Reduce avoidable movement before adding more commitments.`;
    else if (execution.onPlanRate >= 80 && execution.openRate <= 10) cue = "Execution is tracking well. Preserve this workload level unless the Weekly Balance section shows sustained spare capacity.";

    return `
      <div class="analytics-panel-heading"><div><h3>Four-week execution trend</h3><span>retrospective outcome of each week's committed work as of now</span></div><strong class="planner-current-rate">${execution.onPlanRate}% on-plan</strong></div>
      <div class="planner-insight-body">
        <p class="planner-cue">${escapeHtml(cue)}</p>
        ${trendMarkup(context, execution.week)}
        <p class="execution-note">“Moved / extended” is shown separately in Weekly Execution because a moved item may later become completed. The stacked trend shows the work item's current retrospective outcome.</p>
      </div>`;
  }

  function patchSummary(execution) {
    const cards = document.querySelectorAll(".summary-grid article");
    if (cards.length < 4 || !document.querySelector(".insight-layout")) return;
    const firstValue = cards[0].querySelector("strong");
    const firstLabel = cards[0].querySelector("small");
    const fourthValue = cards[3].querySelector("strong");
    const fourthLabel = cards[3].querySelector("small");
    if (firstValue) firstValue.textContent = String(execution.committed);
    if (firstLabel) firstLabel.textContent = "Committed work items";
    if (fourthValue) fourthValue.textContent = `${execution.onPlanRate}%`;
    if (fourthLabel) fourthLabel.textContent = "Completed as planned";
  }

  async function render(force = false) {
    if (!document.querySelector(".insight-layout")) {
      document.querySelector("[data-execution-detail]")?.remove();
      return;
    }
    const week = selectedWeek();
    if (!week || !await loadData(force)) return;

    const context = buildFamilies(state.tasks, state.reviews);
    const execution = weeklyExecution(context, week);
    const backlog = backlogRows(context, week);
    const signature = JSON.stringify([
      week,
      state.tasks.map((task) => [task.id, task.week, task.day, task.completed, task.completed_at, task.parent_task_id, task.superseded_by_followup, task.discarded_at, task.updated_at]),
      state.reviews.map((review) => [review.id, review.task_id, review.action, review.reason, review.from_date, review.to_date, review.review_source]),
    ]);

    const dashboard = document.querySelector("[data-analytics-dashboard]");
    const plannerPanel = document.querySelector(".planner-insight-panel");
    if (!dashboard || !plannerPanel) return;

    const alreadyPatched = dashboard.dataset.executionVersion === "1" && state.signature === signature;
    patchSummary(execution);
    if (alreadyPatched) return;

    state.signature = signature;
    dashboard.dataset.executionVersion = "1";
    dashboard.innerHTML = executionDashboardMarkup(execution);

    document.querySelector("[data-execution-detail]")?.remove();
    dashboard.insertAdjacentHTML("afterend", detailMarkup(execution, backlog));

    plannerPanel.dataset.executionVersion = "1";
    plannerPanel.innerHTML = plannerPanelMarkup(context, execution);
  }

  function invalidate() {
    state.loadedAt = 0;
    state.signature = "";
    schedule(true);
  }

  function schedule(force = false) {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      if (document.querySelector(".insight-layout")) render(force).catch(() => {});
    });
  }

  document.addEventListener("change", (event) => {
    if (event.target?.id !== "week-picker") return;
    state.signature = "";
    setTimeout(() => schedule(true), 100);
  });

  const observer = new MutationObserver(() => schedule(false));
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", invalidate);
  window.addEventListener("nmplanner-analytics-changed", invalidate);
  window.addEventListener("nmplanner-followup-changed", invalidate);
  window.addEventListener("nmplanner-task-rescheduled", invalidate);

  setTimeout(() => schedule(true), 900);
})();
