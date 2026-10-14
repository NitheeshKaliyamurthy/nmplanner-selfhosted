(() => {
  const monthlyClient = window.NMPlannerRuntime?.client;
  if (!monthlyClient) return;

  const state = {
    months: 6,
    mode: sessionStorage.getItem("nmplanner-insights-mode") === "monthly" ? "monthly" : "weekly",
    loading: false,
    scheduled: false,
    loadedKey: "",
    schemaReady: null,
    rows: [],
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
    const [y, m, d] = String(value || "").slice(0, 10).split("-").map(Number);
    return y && m && d ? new Date(y, m - 1, d, 12) : null;
  }

  function dateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    if (!date) return "";
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function monthStart(value) {
    const date = value instanceof Date ? new Date(value) : parseDate(value);
    if (!date) return "";
    return dateKey(new Date(date.getFullYear(), date.getMonth(), 1, 12));
  }

  function shiftMonth(value, amount) {
    const date = parseDate(value);
    if (!date) return "";
    return dateKey(new Date(date.getFullYear(), date.getMonth() + amount, 1, 12));
  }

  function monthEndExclusive(value) {
    return shiftMonth(value, 1);
  }

  function selectedMonth() {
    const week = document.querySelector("#week-picker")?.value || "";
    return monthStart(week || new Date());
  }

  function inRange(value, start, endExclusive) {
    const key = String(value || "").slice(0, 10);
    return Boolean(key && key >= start && key < endExclusive);
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  function rootId(task, taskMap) {
    if (!task) return "";
    if (task.split_group_id) return `split:${task.split_group_id}`;
    let cursor = task;
    const seen = new Set();
    while (cursor?.parent_task_id && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = taskMap.get(cursor.parent_task_id) || cursor;
      if (!cursor.parent_task_id) break;
    }
    return cursor?.id || task.id;
  }

  function reviewRoot(review, taskMap) {
    const task = taskMap.get(review.task_id);
    if (task) return rootId(task, taskMap);
    const snap = review.task_snapshot && typeof review.task_snapshot === "object" ? review.task_snapshot : {};
    if (snap.split_group_id) return `split:${snap.split_group_id}`;
    return snap.parent_task_id || snap.id || review.task_id || `review-${review.id}`;
  }

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(Number(total || 0)));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return `${m}m`;
    if (!m) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function monthLabel(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date) : value;
  }

  function scoreLabel(score) {
    if (score >= 85) return "Excellent";
    if (score >= 75) return "Very good";
    if (score >= 65) return "Balanced";
    if (score >= 50) return "Needs attention";
    return "Overloaded / reactive";
  }

  function pct(value, total) {
    return total ? Math.round(value / total * 100) : 0;
  }

  function buildMonths(endMonth, count) {
    return Array.from({ length: count }, (_, index) => shiftMonth(endMonth, index - count + 1));
  }

  function overlapMinutes(event, start, endExclusive) {
    const startMs = new Date(event.starts_at).getTime();
    const endMs = new Date(event.ends_at).getTime();
    const rangeStart = parseDate(start)?.getTime();
    const rangeEnd = parseDate(endExclusive)?.getTime();
    if (![startMs, endMs, rangeStart, rangeEnd].every(Number.isFinite)) return 0;
    return Math.max(0, Math.round((Math.min(endMs, rangeEnd) - Math.max(startMs, rangeStart)) / 60000));
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

  function summaryRow(record) {
    if (!record) return null;
    const metric = record.metrics && typeof record.metrics === "object" ? record.metrics : {};
    return {
      month: record.month_start,
      score: Number.isFinite(Number(record.planning_score)) ? Number(record.planning_score) : null,
      label: record.score_label || scoreLabel(Number(record.planning_score || 0)),
      committed: Number(metric.committed || 0),
      scheduled: Number(metric.scheduled || 0),
      completed: Number(metric.completed || 0),
      onPlan: Number(metric.on_plan || 0),
      moved: Number(metric.moved || 0),
      dropped: Number(metric.dropped || 0),
      unresolved: Number(metric.unresolved || 0),
      lastMinute: Number(metric.last_minute || 0),
      overtimeItems: Number(metric.overtime_items || 0),
      overtimeMinutes: Number(metric.overtime_minutes || 0),
      taskMinutes: Number(metric.task_minutes || 0),
      calendarMinutes: Number(metric.calendar_minutes || 0),
      totalPlannedMinutes: Number(metric.task_minutes || 0) + Number(metric.calendar_minutes || 0),
      q1Minutes: Number(metric.q1_minutes || 0),
      q2Minutes: Number(metric.q2_minutes || 0),
      q3Minutes: Number(metric.q3_minutes || 0),
      q4Minutes: Number(metric.q4_minutes || 0),
      workMinutes: Number(metric.work_minutes || 0),
      additionalMinutes: Number(metric.additional_minutes || 0),
      familyMinutes: Number(metric.family_minutes || 0),
      personalMinutes: Number(metric.personal_minutes || 0),
      estimationAccuracyPercent: metric.estimation_accuracy === null || metric.estimation_accuracy === undefined ? null : Number(metric.estimation_accuracy),
      estimationMeasured: Number(metric.estimation_measured || 0),
      scoreComponents: metric.score_components && typeof metric.score_components === "object" ? metric.score_components : null,
      fromSummary: true,
    };
  }

  function monthlyMetrics(month, data) {
    const end = monthEndExclusive(month);
    const taskMap = new Map(data.tasks.map((task) => [task.id, task]));
    const monthTasks = data.tasks.filter((task) => {
      const date = plannedDate(task);
      return date && inRange(date, month, end) && !task.discarded_at;
    });

    const familyTasks = new Map();
    for (const task of monthTasks) {
      const root = rootId(task, taskMap);
      if (!familyTasks.has(root)) familyTasks.set(root, []);
      familyTasks.get(root).push(task);
    }

    const committedRoots = new Set(familyTasks.keys());
    const scheduledRoots = new Set(
      monthTasks.filter((task) => Number.isInteger(task.day)).map((task) => rootId(task, taskMap))
    );

    const monthReviews = data.reviews.filter((review) => inRange(review.from_date, month, end));
    const movedRoots = new Set(monthReviews.filter((review) => review.action === "moved").map((review) => reviewRoot(review, taskMap)));
    const droppedRoots = new Set(monthReviews.filter((review) => review.action === "discarded").map((review) => reviewRoot(review, taskMap)));

    const completedRoots = new Set();
    const onPlanRoots = new Set();
    const lastMinuteRoots = new Set();

    for (const [root, rows] of familyTasks.entries()) {
      const plannedDates = rows.map(plannedDate).filter(Boolean).sort();
      const firstPlan = plannedDates[0] || "";
      const splitFamily = rows.some((task) => Boolean(task.split_group_id));
      const plannedCompletionDate = splitFamily ? (plannedDates.at(-1) || "") : firstPlan;
      const allFamilyRows = data.tasks.filter((task) => rootId(task, taskMap) === root);
      const activeRows = allFamilyRows.filter((task) => !task.discarded_at && task.superseded_by_followup !== true);
      const completions = allFamilyRows
        .filter((task) => task.completed_at && String(task.completed_at).slice(0, 10) < end)
        .map((task) => String(task.completed_at).slice(0, 10))
        .sort();

      const fullyCompleted = splitFamily
        ? activeRows.length > 0 && activeRows.every((task) => Boolean(task.completed))
        : completions.length > 0;

      if (fullyCompleted && completions.length) {
        completedRoots.add(root);
        const completedOn = completions.at(-1);
        if (!movedRoots.has(root) && plannedCompletionDate && completedOn <= plannedCompletionDate) onPlanRoots.add(root);
      }

      const createdDates = allFamilyRows.map((task) => String(task.created_at || "").slice(0, 10)).filter(Boolean).sort();
      if (firstPlan && createdDates[0] === firstPlan) lastMinuteRoots.add(root);
    }

    const unresolvedRoots = new Set(
      [...committedRoots].filter((root) => !completedRoots.has(root) && !droppedRoots.has(root))
    );

    const overtimeByRoot = new Map();
    for (const event of data.events) {
      if (!inRange(event.occurred_at, month, end)) continue;
      const snap = event.new_data && typeof event.new_data === "object" ? event.new_data : {};
      if (snap.capacity_override !== true || Number(snap.overtime_minutes || 0) <= 0) continue;
      const task = taskMap.get(event.task_id);
      const root = task ? rootId(task, taskMap) : event.task_id;
      if (!root) continue;
      overtimeByRoot.set(root, Math.max(overtimeByRoot.get(root) || 0, Number(snap.overtime_minutes || 0)));
    }
    for (const task of data.tasks) {
      if (!task.capacity_override_at || !inRange(task.capacity_override_at, month, end)) continue;
      if (!task.capacity_override || Number(task.overtime_minutes || 0) <= 0) continue;
      const root = rootId(task, taskMap);
      overtimeByRoot.set(root, Math.max(overtimeByRoot.get(root) || 0, Number(task.overtime_minutes || 0)));
    }

    const overtimeMinutes = [...overtimeByRoot.values()].reduce((sum, value) => sum + Number(value || 0), 0);
    const taskMinutes = monthTasks.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
    const linkedCalendarIds = new Set(
      data.tasks
        .map((task) => task.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    );
    const calendarRows = data.calendarEvents.filter(
      (event) => event.event_state !== "cancelled" && !linkedCalendarIds.has(String(event.id))
    );
    const calendarMinutes = calendarRows.reduce((sum, event) => sum + overlapMinutes(event, month, end), 0);

    const measuredEstimateRows = monthTasks.filter((task) =>
      task.completed
      && task.actual_minutes !== null
      && task.actual_minutes !== undefined
      && Number(task.minutes || 0) > 0
    );
    const estimationAccuracyRate = measuredEstimateRows.length
      ? measuredEstimateRows.reduce((sum, task) => {
          const estimate = Math.max(1, Number(task.minutes || 0));
          const actual = Math.max(0, Number(task.actual_minutes || 0));
          return sum + Math.max(0, 1 - Math.min(1, Math.abs(actual - estimate) / estimate));
        }, 0) / measuredEstimateRows.length
      : null;

    const q = { q1: 0, q2: 0, q3: 0, q4: 0 };
    const area = { work: 0, additional: 0, family: 0, personal: 0 };
    const addAreaAllocation = (rawArea, minutes) => {
      const value = Math.max(0, Number(minutes || 0));
      const category = normaliseArea(rawArea);
      if (category === "BCU / Teaching" || category === "Research") area.work += value;
      else if (category === "WorldSkills") area.additional += value;
      else if (category === "Family / Home") area.family += value;
      else if (category === "Personal Time") area.personal += value;
    };

    monthTasks.forEach((task) => {
      const minutes = Math.max(0, Number(task.minutes || 0));
      if (Object.hasOwn(q, task.quadrant)) q[task.quadrant] += minutes;
      taskAreaShares(task).forEach(([taskArea, percent]) => addAreaAllocation(taskArea, minutes * percent / 100));
    });
    calendarRows.forEach((event) => {
      const minutes = overlapMinutes(event, month, end);
      if (Object.hasOwn(q, event.quadrant)) q[event.quadrant] += minutes;
      addAreaAllocation(event.area, minutes);
    });

    const committed = committedRoots.size;
    const movedRate = committed ? movedRoots.size / committed : 0;
    const onPlanRate = committed ? onPlanRoots.size / committed : 0;
    const lastMinuteRate = committed ? lastMinuteRoots.size / committed : 0;
    const dropRate = committed ? droppedRoots.size / committed : 0;
    const totalPlannedMinutes = Math.max(1, taskMinutes + calendarMinutes);
    const overtimeLoadRate = Math.min(1, overtimeMinutes / totalPlannedMinutes * 4);
    const carryPressureRoots = new Set([...movedRoots, ...unresolvedRoots]);
    const carryPressureRate = committed ? Math.min(1, carryPressureRoots.size / committed) : 0;

    // Planning Health is deliberately not a productivity score. The six
    // components match the published 30/25/15/15/10/5 model. If no completed
    // tasks have actual-time evidence, the estimation component is omitted
    // rather than rewarding or punishing missing data, and the available
    // weights are normalised back to 100.
    const scoreComponents = {
      completed_as_planned: { weight: 30, rate: onPlanRate },
      sustainable_capacity: { weight: 25, rate: 1 - overtimeLoadRate },
      carry_forward_unresolved: { weight: 15, rate: 1 - carryPressureRate },
      reactive_work: { weight: 15, rate: 1 - Math.min(1, lastMinuteRate) },
      estimation_accuracy: { weight: 10, rate: estimationAccuracyRate },
      dropped_planning_quality: { weight: 5, rate: 1 - Math.min(1, dropRate) },
    };
    const applicableComponents = Object.values(scoreComponents).filter((component) => component.rate !== null);
    const applicableWeight = applicableComponents.reduce((sum, component) => sum + component.weight, 0);
    const weightedPoints = applicableComponents.reduce((sum, component) => sum + component.weight * component.rate, 0);

    const score = committed && applicableWeight
      ? Math.max(0, Math.min(100, Math.round(weightedPoints / applicableWeight * 100)))
      : null;

    return {
      month,
      score,
      label: score === null ? "No task data" : scoreLabel(score),
      committed,
      scheduled: scheduledRoots.size,
      completed: completedRoots.size,
      onPlan: onPlanRoots.size,
      moved: movedRoots.size,
      dropped: droppedRoots.size,
      unresolved: unresolvedRoots.size,
      lastMinute: lastMinuteRoots.size,
      overtimeItems: overtimeByRoot.size,
      overtimeMinutes,
      taskMinutes,
      calendarMinutes,
      totalPlannedMinutes: taskMinutes + calendarMinutes,
      q1Minutes: q.q1,
      q2Minutes: q.q2,
      q3Minutes: q.q3,
      q4Minutes: q.q4,
      workMinutes: area.work,
      additionalMinutes: area.additional,
      familyMinutes: area.family,
      personalMinutes: area.personal,
      estimationAccuracyPercent: estimationAccuracyRate === null ? null : Math.round(estimationAccuracyRate * 100),
      estimationMeasured: measuredEstimateRows.length,
      scoreComponents: Object.fromEntries(Object.entries(scoreComponents).map(([key, component]) => [
        key,
        {
          weight: component.weight,
          rate: component.rate === null ? null : Number(component.rate.toFixed(4)),
          points: component.rate === null ? null : Number((component.weight * component.rate).toFixed(1)),
        },
      ])),
      fromSummary: false,
    };
  }

  function suggestions(metric, previous) {
    const items = [];
    const committed = Math.max(1, metric.committed);
    const overtimeRate = metric.overtimeItems / committed;
    const lastMinuteRate = metric.lastMinute / committed;
    const movedRate = metric.moved / committed;
    const unresolvedRate = metric.unresolved / committed;

    if (overtimeRate >= 0.15) {
      items.push(`Overtime affected ${pct(metric.overtimeItems, metric.committed)}% of committed work. Protect contingency capacity before adding discretionary work.`);
    }
    if (lastMinuteRate >= 0.2) {
      items.push(`${pct(metric.lastMinute, metric.committed)}% of work was introduced on its planned day. Review same-day requests and move non-urgent work into Q2 planning time.`);
    }
    if (movedRate >= 0.2) {
      items.push(`${pct(metric.moved, metric.committed)}% of committed work moved. Review movement reasons and reduce the number of tasks committed before fixed calendar load is known.`);
    }
    if (unresolvedRate >= 0.2) {
      items.push(`${pct(metric.unresolved, metric.committed)}% remained unresolved at month end. Review older backlog before carrying more work into the next month.`);
    }
    if (metric.calendarMinutes > metric.taskMinutes && metric.overtimeMinutes > 0) {
      items.push("Fixed calendar commitments exceeded planner-task time and overtime still occurred. Treat high-meeting days as low-discretion planning days.");
    }
    const classifiedPriority = Number(metric.q1Minutes || 0) + Number(metric.q2Minutes || 0) + Number(metric.q3Minutes || 0) + Number(metric.q4Minutes || 0);
    if (classifiedPriority > 0 && Number(metric.q1Minutes || 0) > Number(metric.q2Minutes || 0) * 1.2) {
      items.push(`Q1 consumed ${pct(metric.q1Minutes, classifiedPriority)}% of classified time, above Q2. Protect more proactive Q2 preparation before important work becomes urgent.`);
    }
    if (previous && metric.score >= previous.score + 5) {
      items.push(`Planning health improved by ${metric.score - previous.score} points from the previous month. Keep the changes that reduced reactive or moved work.`);
    }
    if (!items.length && metric.committed) {
      items.push("Planning was comparatively stable this month. Keep capacity buffers and protect Q2 work so the pattern remains sustainable.");
    }
    if (!metric.committed) {
      items.push("There is not enough task data for a meaningful monthly rating yet.");
    }
    return items.slice(0, 4);
  }

  async function loadData(force = false) {
    const selected = selectedMonth();
    const start = shiftMonth(selected, -5);
    const key = `${start}:${selected}`;
    if (!force && state.loadedKey === key && state.rows.length) return state.rows;
    if (state.loading) return state.rows;
    state.loading = true;

    try {
      const { data: auth } = await monthlyClient.auth.getSession();
      const user = auth.session?.user;
      if (!user) return [];

      const rangeEnd = shiftMonth(selected, 1);
      const taskStart = shiftMonth(start, -1);
      const [taskResult, reviewResult, eventResult, calendarResult, summaryResult] = await Promise.all([
        monthlyClient
          .from("tasks")
          .select("id,parent_task_id,title,week,day,minutes,actual_minutes,quadrant,area,area_allocations,completed,completed_at,created_at,superseded_by_followup,discarded_at,capacity_override,overtime_minutes,capacity_override_at,external_calendar_event_id,split_group_id,split_instance_index,split_instance_count")
          .eq("user_id", user.id)
          .gte("week", taskStart)
          .lt("week", rangeEnd)
          .order("created_at", { ascending: true }),
        monthlyClient
          .from("task_reviews")
          .select("id,task_id,task_snapshot,action,reason,from_date,to_date,occurred_at")
          .eq("user_id", user.id)
          .gte("from_date", start)
          .lt("from_date", rangeEnd),
        monthlyClient
          .from("task_events")
          .select("id,task_id,event_type,new_data,old_data,occurred_at")
          .eq("user_id", user.id)
          .gte("occurred_at", `${start}T00:00:00`)
          .lt("occurred_at", `${rangeEnd}T00:00:00`),
        monthlyClient
          .from("external_calendar_events")
          .select("id,external_event_id,starts_at,ends_at,event_state,area,quadrant")
          .eq("user_id", user.id)
          .lt("starts_at", `${rangeEnd}T00:00:00`)
          .gt("ends_at", `${start}T00:00:00`),
        monthlyClient
          .from("monthly_summaries")
          .select("month_start,planning_score,score_label,metrics")
          .eq("user_id", user.id)
          .gte("month_start", start)
          .lt("month_start", rangeEnd),
      ]);

      if (taskResult.error || reviewResult.error || eventResult.error) return [];

      const schemaReady = !calendarResult.error && !summaryResult.error;
      state.schemaReady = schemaReady;
      const data = {
        tasks: taskResult.data || [],
        reviews: reviewResult.data || [],
        events: eventResult.data || [],
        calendarEvents: !calendarResult.error ? (calendarResult.data || []) : [],
      };

      const stored = new Map((summaryResult.data || []).map((row) => [row.month_start, summaryRow(row)]));
      const months = buildMonths(selected, 6);
      const rows = months.map((month) => {
        const live = monthlyMetrics(month, data);
        const archived = stored.get(month);
        return live.committed || live.calendarMinutes || !archived ? live : archived;
      });
      rows.forEach((row, index) => {
        row.suggestions = suggestions(row, index ? rows[index - 1] : null);
      });
      state.rows = rows;
      state.loadedKey = key;

      if (schemaReady) {
        const todayMonth = monthStart(new Date());
        const payload = rows
          .filter((row) => row.month < todayMonth && row.score !== null && !row.fromSummary)
          .map((row) => ({
            user_id: user.id,
            month_start: row.month,
            planning_score: row.score,
            score_label: row.label,
            metrics: {
              committed: row.committed,
              scheduled: row.scheduled,
              completed: row.completed,
              on_plan: row.onPlan,
              moved: row.moved,
              dropped: row.dropped,
              unresolved: row.unresolved,
              last_minute: row.lastMinute,
              overtime_items: row.overtimeItems,
              overtime_minutes: row.overtimeMinutes,
              task_minutes: row.taskMinutes,
              calendar_minutes: row.calendarMinutes,
              q1_minutes: row.q1Minutes,
              q2_minutes: row.q2Minutes,
              q3_minutes: row.q3Minutes,
              q4_minutes: row.q4Minutes,
              work_minutes: row.workMinutes,
              additional_minutes: row.additionalMinutes,
              family_minutes: row.familyMinutes,
              personal_minutes: row.personalMinutes,
              estimation_accuracy: row.estimationAccuracyPercent,
              estimation_measured: row.estimationMeasured,
              score_components: row.scoreComponents,
            },
            suggestions: [],
            schema_version: 2,
            generated_at: new Date().toISOString(),
          }));
        if (payload.length) {
          await monthlyClient.from("monthly_summaries").upsert(payload, { onConflict: "user_id,month_start" });
        }
      }

      return rows;
    } finally {
      state.loading = false;
    }
  }

  function chartMarkup(rows) {
    return `<div class="monthly-score-chart">${rows.map((row) => `
      <div class="monthly-score-column" title="${escapeHtml(monthLabel(row.month))}: ${row.score === null ? "no score" : `${row.score}/100`}">
        <div class="monthly-score-track"><span style="height:${row.score === null ? 4 : Math.max(4, row.score)}%"></span></div>
        <strong>${row.score === null ? "—" : row.score}</strong>
        <small>${escapeHtml(monthLabel(row.month).replace(/\s\d{4}$/, ""))}</small>
      </div>`).join("")}</div>`;
  }

  function scoreBreakdownMarkup(metric) {
    const labels = {
      completed_as_planned: "Completed as planned",
      sustainable_capacity: "Sustainable workload",
      carry_forward_unresolved: "Carry-forward / unresolved",
      reactive_work: "Reactive work",
      estimation_accuracy: "Estimation accuracy",
      dropped_planning_quality: "Dropped / planning quality",
    };
    const fallbackWeights = {
      completed_as_planned: 30,
      sustainable_capacity: 25,
      carry_forward_unresolved: 15,
      reactive_work: 15,
      estimation_accuracy: 10,
      dropped_planning_quality: 5,
    };
    const components = metric.scoreComponents || {};
    return `
      <div class="monthly-score-breakdown">
        ${Object.entries(fallbackWeights).map(([key, weight]) => {
          const component = components[key];
          const unavailable = key === "estimation_accuracy" && (component?.rate === null || metric.estimationAccuracyPercent === null);
          const points = component?.points;
          return `
            <div>
              <span>${escapeHtml(labels[key])}</span>
              <strong>${unavailable ? "Not enough data" : `${points === null || points === undefined ? "—" : Number(points).toFixed(1)} / ${weight}`}</strong>
            </div>`;
        }).join("")}
      </div>
      ${metric.estimationAccuracyPercent === null
        ? '<small class="monthly-score-note">Estimation accuracy is excluded until completed tasks have actual-time data; the remaining 90% is normalised to 100.</small>'
        : `<small class="monthly-score-note">Estimation accuracy: ${metric.estimationAccuracyPercent}% across ${metric.estimationMeasured} measured completed task${metric.estimationMeasured === 1 ? "" : "s"}.</small>`}
    `;
  }

  function modeSwitchMarkup() {
    return `
      <div class="insights-mode-switch" data-insights-mode-switch role="group" aria-label="Insights period">
        <button type="button" class="${state.mode === "weekly" ? "active" : ""}" data-insights-mode="weekly">Weekly</button>
        <button type="button" class="${state.mode === "monthly" ? "active" : ""}" data-insights-mode="monthly">Monthly</button>
      </div>`;
  }

  function ensureModeSwitch(dashboard) {
    const existing = document.querySelector("[data-insights-mode-switch]");
    const holder = document.createElement("div");
    holder.innerHTML = modeSwitchMarkup();
    const next = holder.firstElementChild;
    if (!next) return;
    if (existing) existing.replaceWith(next);
    else dashboard.insertAdjacentElement("beforebegin", next);
  }

  function applyMode() {
    const monthly = state.mode === "monthly";
    const weeklySelectors = [
      "[data-analytics-dashboard]",
      ".insight-layout",
      "[data-execution-detail]",
      "[data-overtime-insights]",
      "[data-overtime-insights-migration]",
      "[data-wellbeing-dashboard]",
      "[data-review-analytics]",
    ];
    weeklySelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        element.hidden = monthly;
      });
    });
    const panel = document.querySelector("[data-monthly-insights]");
    if (panel) panel.hidden = !monthly;
    const switcher = document.querySelector("[data-insights-mode-switch]");
    if (switcher) {
      switcher.querySelectorAll("[data-insights-mode]").forEach((button) => {
        button.classList.toggle("active", button.dataset.insightsMode === state.mode);
      });
    }
  }

  function renderPanel(rows) {
    const selected = selectedMonth();
    const current = rows.find((row) => row.month === selected) || rows.at(-1);
    if (!current) return "";

    const visible = state.months === 3 ? rows.slice(-3) : rows;
    const previousRows = rows
      .filter((row) => row.month < current.month && row.score !== null)
      .slice(-(state.months === 3 ? 3 : 6));
    const previousAverage = previousRows.length
      ? Math.round(previousRows.reduce((sum, row) => sum + row.score, 0) / previousRows.length)
      : null;
    const delta = previousAverage === null || current.score === null ? null : current.score - previousAverage;
    const provisional = selected >= monthStart(new Date());

    return `
      <article class="analytics-panel monthly-insights-panel" data-monthly-insights>
        <div class="analytics-panel-heading monthly-insights-heading">
          <div>
            <p class="eyebrow">MONTHLY PLANNING HEALTH</p>
            <h2>${escapeHtml(monthLabel(current.month))}</h2>
            <span>Planning quality, sustainability and reactive-work pattern — not a productivity score.</span>
          </div>
          <div class="monthly-window-switch" role="group" aria-label="Monthly comparison window">
            <button type="button" class="${state.months === 3 ? "active" : ""}" data-monthly-window="3">3 months</button>
            <button type="button" class="${state.months === 6 ? "active" : ""}" data-monthly-window="6">6 months</button>
          </div>
        </div>

        <div class="monthly-insights-body">
          ${state.schemaReady === false ? '<div class="monthly-schema-note"><strong>Calendar/storage foundation pending</strong><span>Run database/026_calendar_monthly_archive_foundation.sql. Task-only monthly analysis is shown until then.</span></div>' : ""}

          <div class="monthly-score-hero">
            <div class="monthly-score-ring" style="--monthly-score:${(current.score || 0) * 3.6}deg">
              <strong>${current.score === null ? "—" : current.score}</strong><span>${current.score === null ? "no score" : "/100"}</span>
            </div>
            <div>
              <h3>${escapeHtml(current.label)}${provisional ? " · provisional" : ""}</h3>
              <p>${delta === null ? "No earlier comparison is available yet." : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} points versus the previous ${previousRows.length}-month average (${previousAverage}/100).`}</p>
            </div>
          </div>

          ${chartMarkup(visible)}

          ${scoreBreakdownMarkup(current)}

          <div class="monthly-metric-grid">
            <div><strong>${current.committed}</strong><span>Committed work items</span></div>
            <div><strong>${pct(current.onPlan, current.committed)}%</strong><span>Completed as planned</span></div>
            <div><strong>${pct(current.moved, current.committed)}%</strong><span>Moved / extended</span></div>
            <div><strong>${pct(current.lastMinute, current.committed)}%</strong><span>Last-minute additions</span></div>
            <div><strong>${formatMinutes(current.overtimeMinutes)}</strong><span>Overtime accepted</span></div>
            <div><strong>${formatMinutes(current.calendarMinutes)}</strong><span>Fixed calendar time</span></div>
          </div>

          <div class="monthly-workload-split">
            <div><span>Planner task time</span><strong>${formatMinutes(current.taskMinutes)}</strong></div>
            <div><span>Fixed calendar commitments</span><strong>${formatMinutes(current.calendarMinutes)}</strong></div>
            <div><span>Still unresolved</span><strong>${current.unresolved} work item${current.unresolved === 1 ? "" : "s"}</strong></div>
          </div>

          <div class="monthly-priority-split">
            <span><b>Q1</b> ${formatMinutes(current.q1Minutes)}</span>
            <span><b>Q2</b> ${formatMinutes(current.q2Minutes)}</span>
            <span><b>Q3</b> ${formatMinutes(current.q3Minutes)}</span>
            <span><b>Q4</b> ${formatMinutes(current.q4Minutes)}</span>
            ${current.fromSummary ? '<span class="monthly-archive-badge">Compact summary</span>' : ""}
          </div>

          <section class="monthly-actions">
            <div class="execution-subheading"><strong>Marginal-gain actions</strong><span>based on this month's pattern</span></div>
            <ul>${current.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </section>
        </div>
      </article>`;
  }

  async function render(force = false) {
    const dashboard = document.querySelector("[data-analytics-dashboard]");
    if (!dashboard) {
      document.querySelector("[data-monthly-insights]")?.remove();
      return;
    }

    ensureModeSwitch(dashboard);
    const rows = await loadData(force);
    if (!rows.length) {
      applyMode();
      return;
    }
    const old = document.querySelector("[data-monthly-insights]");
    const signature = JSON.stringify({
      selected: selectedMonth(),
      window: state.months,
      ready: state.schemaReady,
      rows: rows.map((row) => [
        row.month,
        row.score,
        row.committed,
        row.onPlan,
        row.moved,
        row.lastMinute,
        row.overtimeMinutes,
        row.calendarMinutes,
        row.unresolved,
      ]),
    });
    if (old?.dataset.monthlySignature === signature) return;

    const holder = document.createElement("div");
    holder.innerHTML = renderPanel(rows);
    const panel = holder.firstElementChild;
    if (!panel) return;
    panel.dataset.monthlySignature = signature;
    if (old) old.replaceWith(panel);
    else {
      const overtime = document.querySelector("[data-overtime-insights]");
      (overtime || dashboard).insertAdjacentElement("afterend", panel);
    }
    applyMode();
  }

  function schedule(force = false) {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      render(force).catch(() => {});
    });
  }

  document.addEventListener("click", (event) => {
    const modeButton = event.target.closest?.("[data-insights-mode]");
    if (modeButton) {
      state.mode = modeButton.dataset.insightsMode === "monthly" ? "monthly" : "weekly";
      sessionStorage.setItem("nmplanner-insights-mode", state.mode);
      applyMode();
      schedule(false);
      return;
    }

    const button = event.target.closest?.("[data-monthly-window]");
    if (!button) return;
    state.months = Number(button.dataset.monthlyWindow) === 3 ? 3 : 6;
    schedule(false);
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.matches?.("#week-picker")) {
      state.loadedKey = "";
      schedule(true);
    }
  }, true);

  window.addEventListener("nmplanner-analytics-changed", () => {
    state.loadedKey = "";
    schedule(true);
  });
  window.addEventListener("nmplanner-settings-changed", () => schedule(false));

  const observer = new MutationObserver(() => schedule(false));
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  setTimeout(() => schedule(true), 1700);
})();
