(() => {
  const overtimeClient = window.NMPlannerRuntime?.client;
  if (!overtimeClient) return;

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const state = {
    session: null,
    tasks: [],
    events: [],
    loadedAt: 0,
    loading: null,
    scheduled: false,
    schemaReady: true,
    signature: "",
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

  function timestampDateKey(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dateKey(date);
  }

  function dayIndex(value) {
    if (value === null || value === undefined || value === "") return null;
    const day = Number(value);
    return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
  }

  function plannedDate(snapshot) {
    const day = dayIndex(snapshot?.day);
    if (!snapshot?.week || day === null) return "";
    return addDays(snapshot.week, day);
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function formatWeekShort(week) {
    const start = parseDate(week);
    if (!start) return week;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const formatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
    return `${formatter.format(start)}–${formatter.format(end)}`;
  }

  function percent(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await overtimeClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function load(force = false) {
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 300000) return true;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const session = await getSession();
      if (!session) return false;

      const [taskResult, eventResult] = await Promise.all([
        overtimeClient
          .from("tasks")
          .select("id,parent_task_id,title,week,day,quadrant,area,minutes,created_at,capacity_override,overtime_minutes,capacity_override_at,superseded_by_followup,discarded_at")
          .eq("user_id", session.user.id)
          .order("created_at", { ascending: true }),
        overtimeClient
          .from("task_events")
          .select("id,task_id,event_type,old_data,new_data,occurred_at")
          .eq("user_id", session.user.id)
          .order("occurred_at", { ascending: true }),
      ]);

      if (taskResult.error) {
        if (/capacity_override|overtime_minutes|capacity_override_at|schema cache|column/i.test(taskResult.error.message || "")) {
          state.schemaReady = false;
          state.tasks = [];
          state.events = [];
          state.loadedAt = Date.now();
          return true;
        }
        return false;
      }

      state.schemaReady = true;
      state.tasks = taskResult.data || [];
      state.events = eventResult.error ? [] : (eventResult.data || []);
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

  function familyKeyForSnapshot(snapshot, taskMap, taskId) {
    const id = snapshot?.id || taskId;
    if (id && taskMap.has(id)) return rootKeyForTask(taskMap.get(id), taskMap);
    if (snapshot?.parent_task_id && taskMap.has(snapshot.parent_task_id)) {
      return rootKeyForTask(taskMap.get(snapshot.parent_task_id), taskMap);
    }
    return snapshot?.parent_task_id || id || taskId || "unknown";
  }

  function activeOvertime(snapshot) {
    return Boolean(snapshot?.capacity_override === true && Number(snapshot?.overtime_minutes || 0) > 0);
  }

  function isRoutineSnapshot(snapshot) {
    return String(snapshot?.notes || "").startsWith("[[NM_ROUTINE:");
  }

  function episodeFrom(snapshot, event, taskMap) {
    return {
      taskId: snapshot?.id || event?.task_id || "",
      familyKey: familyKeyForSnapshot(snapshot, taskMap, event?.task_id),
      title: snapshot?.title || "Untitled task",
      week: snapshot?.week || "",
      day: dayIndex(snapshot?.day),
      quadrant: snapshot?.quadrant || "",
      area: snapshot?.area || "Uncategorised",
      minutes: Number(snapshot?.overtime_minutes || 0),
      startedAt: event?.occurred_at || snapshot?.capacity_override_at || "",
      endedAt: "",
    };
  }

  function overtimeEpisodes(taskMap) {
    const active = new Map();
    const episodes = [];

    for (const event of state.events) {
      const oldData = event.old_data || {};
      const newData = event.new_data || {};
      const taskId = event.task_id || newData.id || oldData.id;
      if (!taskId) continue;

      const oldActive = activeOvertime(oldData);
      const newActive = activeOvertime(newData);
      let current = active.get(taskId) || null;

      if (!oldActive && newActive) {
        current = episodeFrom(newData, event, taskMap);
        active.set(taskId, current);
        continue;
      }

      if (oldActive && newActive) {
        if (!current) current = episodeFrom(oldData, event, taskMap);

        // Moving an overtime task into another week is a separate weekly episode
        // so historical weekly metrics are not rewritten by the destination week.
        if (current.week && newData.week && current.week !== newData.week) {
          current.endedAt = event.occurred_at || "";
          episodes.push(current);
          current = episodeFrom(newData, event, taskMap);
          active.set(taskId, current);
          continue;
        }

        current.familyKey = familyKeyForSnapshot(newData, taskMap, taskId);
        current.title = newData.title || current.title;
        current.week = newData.week || current.week;
        const nextDay = dayIndex(newData.day);
        if (nextDay !== null) current.day = nextDay;
        current.quadrant = newData.quadrant || current.quadrant;
        current.area = newData.area || current.area;
        current.minutes = Number(newData.overtime_minutes || current.minutes || 0);
        active.set(taskId, current);
        continue;
      }

      if (oldActive && !newActive) {
        if (!current) current = episodeFrom(oldData, event, taskMap);
        current.familyKey = familyKeyForSnapshot(oldData, taskMap, taskId);
        current.title = oldData.title || current.title;
        current.week = oldData.week || current.week;
        const previousDay = dayIndex(oldData.day);
        if (previousDay !== null) current.day = previousDay;
        current.minutes = Number(oldData.overtime_minutes || current.minutes || 0);
        current.endedAt = event.occurred_at || "";
        episodes.push(current);
        active.delete(taskId);
      }
    }

    for (const episode of active.values()) episodes.push(episode);
    return episodes.filter((episode) => episode.week && episode.minutes > 0);
  }

  function lastMinuteFamilies(week, taskMap) {
    const families = new Set();
    const details = new Map();

    for (const event of state.events) {
      if (event.event_type !== "created") continue;
      const snapshot = event.new_data || {};
      if (isRoutineSnapshot(snapshot)) continue;
      if (snapshot.week !== week) continue;
      const day = dayIndex(snapshot.day);
      if (day === null) continue;
      const planned = plannedDate(snapshot);
      if (!planned) continue;
      const created = timestampDateKey(snapshot.created_at || event.occurred_at);
      if (!created || created !== planned) continue;

      const familyKey = familyKeyForSnapshot(snapshot, taskMap, event.task_id);
      families.add(familyKey);
      if (!details.has(familyKey)) {
        details.set(familyKey, {
          familyKey,
          title: snapshot.title || "Untitled task",
          day,
          created,
        });
      }
    }

    return { families, details };
  }

  function dashboardDenominators() {
    const cards = [...document.querySelectorAll("[data-analytics-dashboard] .execution-kpi")]
      .filter((card) => !card.hasAttribute("data-overtime-kpi"));
    const committed = Number.parseInt(cards[0]?.querySelector("strong")?.textContent || "0", 10) || 0;
    const scheduledText = cards[1]?.querySelector("small")?.textContent || "";
    const scheduled = Number.parseInt(scheduledText.match(/^(\d+)\s*\//)?.[1] || "0", 10) || 0;
    return { committed, scheduled };
  }

  function weekMetrics(week, taskMap, episodes) {
    const weekEpisodes = episodes.filter((episode) => episode.week === week);
    const grouped = new Map();
    for (const episode of weekEpisodes) {
      const key = episode.familyKey || episode.taskId;
      if (!grouped.has(key)) grouped.set(key, { ...episode, minutes: 0, episodes: 0 });
      const item = grouped.get(key);
      item.minutes += Number(episode.minutes || 0);
      item.episodes += 1;
      item.title = episode.title || item.title;
      item.day = episode.day;
    }

    const lastMinute = lastMinuteFamilies(week, taskMap);
    const overtimeKeys = new Set(grouped.keys());
    const overlap = [...lastMinute.families].filter((key) => overtimeKeys.has(key)).length;
    const overtimeMinutes = [...grouped.values()].reduce((sum, item) => sum + item.minutes, 0);

    return {
      week,
      overtimeItems: grouped.size,
      overtimeMinutes,
      overtimeRows: [...grouped.values()].sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title)),
      lastMinuteItems: lastMinute.families.size,
      lastMinuteDetails: lastMinute.details,
      overlap,
    };
  }

  function currentActionCue(metrics, committed, scheduled) {
    const overtimeRate = percent(metrics.overtimeItems, committed);
    const lastMinuteRate = percent(metrics.lastMinuteItems, scheduled);
    const byDay = new Map();
    for (const item of metrics.overtimeRows) {
      if (!Number.isInteger(item.day)) continue;
      byDay.set(item.day, (byDay.get(item.day) || 0) + item.minutes);
    }
    const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    const busiestText = busiest ? DAYS[busiest[0]] : "your busiest days";

    if (metrics.overtimeItems && metrics.overlap >= Math.ceil(metrics.overtimeItems / 2)) {
      return `Most overtime work was also added at the last minute. Keep deliberate contingency space on ${busiestText} and triage same-day requests before accepting them.`;
    }
    if (metrics.overtimeMinutes >= 300 || overtimeRate >= 15) {
      return `Overtime pressure is high for this week. Reduce baseline commitments or reserve buffer time on ${busiestText} before increasing normal planned workload.`;
    }
    if (lastMinuteRate >= 20) {
      return "Last-minute intake is high even though most work stayed within capacity. Capture incoming work earlier and protect a small daily contingency block.";
    }
    if (!metrics.overtimeItems && !metrics.lastMinuteItems) {
      return "No deliberate overtime or same-day task intake is recorded for this week. Preserve this pattern if your Weekly Balance also remains sustainable.";
    }
    return "Capacity exceptions are contained. Review the repeated days or task types below before changing your normal workload target.";
  }

  function kpiMarkup(metrics, committed, scheduled) {
    const overtimeRate = percent(metrics.overtimeItems, committed);
    const lastMinuteRate = percent(metrics.lastMinuteItems, scheduled);
    return `
      <article class="execution-kpi overtime" data-overtime-kpi="overtime">
        <strong>${overtimeRate}%</strong>
        <span>Overtime work</span>
        <small>${metrics.overtimeItems} / ${committed} committed work items required a deliberate capacity override · ${formatMinutes(metrics.overtimeMinutes)} above normal capacity</small>
      </article>
      <article class="execution-kpi last-minute" data-overtime-kpi="last-minute">
        <strong>${lastMinuteRate}%</strong>
        <span>Last-minute additions</span>
        <small>${metrics.lastMinuteItems} / ${scheduled} scheduled work items were first added on their planned day · ${metrics.overlap} also required overtime</small>
      </article>`;
  }

  function trendMarkup(rows) {
    return `
      <div class="overtime-trend">
        ${rows.map((row, index) => `
          <div class="overtime-trend-row ${index === rows.length - 1 ? "current" : ""}">
            <strong>${escapeHtml(formatWeekShort(row.week))}</strong>
            <span>${row.lastMinuteItems} last-minute</span>
            <span>${row.overtimeItems} overtime job${row.overtimeItems === 1 ? "" : "s"}</span>
            <span>${formatMinutes(row.overtimeMinutes)} overtime</span>
          </div>`).join("")}
      </div>`;
  }

  function panelMarkup(metrics, trendRows, committed, scheduled) {
    const overtimeRate = percent(metrics.overtimeItems, committed);
    const lastMinuteRate = percent(metrics.lastMinuteItems, scheduled);
    const cue = currentActionCue(metrics, committed, scheduled);
    const rows = metrics.overtimeRows.slice(0, 8);

    return `
      <article class="analytics-panel overtime-pressure-panel" data-overtime-insights>
        <div class="analytics-panel-heading">
          <div><h3>Capacity pressure & reactive work</h3><span>deliberate overtime overrides and same-day task intake · routine templates excluded from last-minute intake</span></div>
          <span>${formatMinutes(metrics.overtimeMinutes)} overtime · ${metrics.lastMinuteItems} last-minute</span>
        </div>
        <div class="overtime-insight-body">
          <div class="overtime-summary-strip">
            <span><strong>${metrics.overtimeItems}</strong> overtime work item${metrics.overtimeItems === 1 ? "" : "s"} · ${overtimeRate}% of committed</span>
            <span><strong>${metrics.lastMinuteItems}</strong> last-minute addition${metrics.lastMinuteItems === 1 ? "" : "s"} · ${lastMinuteRate}% of scheduled</span>
            <span><strong>${metrics.overlap}</strong> were both last-minute and overtime</span>
          </div>
          <p class="overtime-action-cue"><strong>Marginal-gain action:</strong> ${escapeHtml(cue)}</p>
          ${trendMarkup(trendRows)}
          <div class="overtime-current-list">
            <div class="execution-subheading"><strong>Overtime accepted this week</strong><span>${metrics.overtimeItems} work item${metrics.overtimeItems === 1 ? "" : "s"}</span></div>
            ${rows.length ? rows.map((item) => `
              <div class="overtime-current-row">
                <div><strong>${escapeHtml(item.title)}</strong><span>${Number.isInteger(item.day) ? escapeHtml(DAYS[item.day]) : "Scheduled work"}${item.quadrant ? ` · ${escapeHtml(item.quadrant.toUpperCase())}` : ""}</span></div>
                <b>+${formatMinutes(item.minutes)}</b>
              </div>`).join("") : '<p class="execution-empty">No deliberate overtime capacity overrides were recorded for this week.</p>'}
            ${metrics.overtimeRows.length > 8 ? `<p class="execution-more">+ ${metrics.overtimeRows.length - 8} more overtime work item${metrics.overtimeRows.length - 8 === 1 ? "" : "s"}</p>` : ""}
          </div>
        </div>
      </article>`;
  }

  function migrationNotice() {
    if (document.querySelector("[data-overtime-insights-migration]")) return;
    const dashboard = document.querySelector("[data-analytics-dashboard]");
    if (!dashboard) return;
    dashboard.insertAdjacentHTML("afterend", `
      <article class="analytics-panel overtime-migration-notice" data-overtime-insights-migration>
        <div class="analytics-panel-heading"><div><h3>Urgent / Overtime setup</h3><span>database update required</span></div></div>
        <div class="overtime-insight-body"><p class="overtime-action-cue">Run <strong>database/023_urgent_overtime_capacity.sql</strong> in Supabase to enable overtime overrides and capacity-pressure Insights.</p></div>
      </article>`);
  }

  async function render(force = false) {
    const dashboard = document.querySelector("[data-analytics-dashboard]");
    if (!dashboard || !document.querySelector(".insight-layout")) {
      document.querySelector("[data-overtime-insights]")?.remove();
      document.querySelector("[data-overtime-insights-migration]")?.remove();
      return;
    }
    if (!await load(force)) return;

    if (!state.schemaReady) {
      dashboard.querySelectorAll("[data-overtime-kpi]").forEach((node) => node.remove());
      document.querySelector("[data-overtime-insights]")?.remove();
      migrationNotice();
      return;
    }
    document.querySelector("[data-overtime-insights-migration]")?.remove();

    const taskMap = new Map(state.tasks.map((task) => [task.id, task]));
    const episodes = overtimeEpisodes(taskMap);
    const week = selectedWeek();
    if (!week) return;
    const current = weekMetrics(week, taskMap, episodes);
    const denominators = dashboardDenominators();
    const trendRows = [-21, -14, -7, 0].map((offset) => weekMetrics(addDays(week, offset), taskMap, episodes));
    const signature = JSON.stringify([
      week,
      denominators,
      current.overtimeItems,
      current.overtimeMinutes,
      current.lastMinuteItems,
      current.overlap,
      trendRows.map((row) => [row.week, row.overtimeItems, row.overtimeMinutes, row.lastMinuteItems]),
    ]);

    const kpiHolder = dashboard.querySelector(".execution-kpis");
    if (!kpiHolder) return;
    if (state.signature === signature && dashboard.querySelector('[data-overtime-kpi="overtime"]') && document.querySelector("[data-overtime-insights]")) return;
    state.signature = signature;

    kpiHolder.querySelectorAll("[data-overtime-kpi]").forEach((node) => node.remove());
    kpiHolder.insertAdjacentHTML("beforeend", kpiMarkup(current, denominators.committed, denominators.scheduled));

    document.querySelector("[data-overtime-insights]")?.remove();
    const detail = document.querySelector("[data-execution-detail]");
    const html = panelMarkup(current, trendRows, denominators.committed, denominators.scheduled);
    if (detail) detail.insertAdjacentHTML("afterend", html);
    else dashboard.insertAdjacentHTML("afterend", html);
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
      render(force).catch(() => {});
    });
  }

  document.addEventListener("change", (event) => {
    if (event.target?.id === "week-picker") setTimeout(() => invalidate(), 100);
  });
  const observer = new MutationObserver(() => {
    if (document.querySelector("[data-analytics-dashboard]") && !document.querySelector("[data-overtime-insights]")) schedule(false);
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  window.addEventListener("focus", () => schedule(false));
  window.addEventListener("nmplanner-tasks-changed", invalidate);
  window.addEventListener("nmplanner-analytics-changed", invalidate);
  window.addEventListener("nmplanner-followup-changed", invalidate);
  window.addEventListener("nmplanner-task-rescheduled", invalidate);
  setTimeout(() => schedule(true), 1100);
})();
