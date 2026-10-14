/* global client, session */

(() => {
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
    schemaReady: null,
    loading: false,
    signature: "",
    week: "",
    rows: [],
    loadedAt: 0,
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
    const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || "";
  }

  async function checkSchema() {
    if (state.schemaReady !== null) return state.schemaReady;
    if (!session || !client) return false;
    const { error } = await client.from("task_reviews").select("id").limit(1);
    state.schemaReady = !error;
    return state.schemaReady;
  }

  function reasonRows(rows) {
    const counts = new Map();
    for (const row of rows) {
      const code = row.reason || "other";
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, count]) => ({ code, count, label: REASON_LABELS[code] || "Other" }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function analysisCue(rows, reasons, repeated) {
    if (!rows.length) {
      return {
        title: "No unfinished-task reviews this week",
        body: "Nothing has needed an end-of-day move or discard yet. This section will build a pattern as you use the review workflow.",
      };
    }

    const top = reasons[0];
    if (top?.code === "waiting_external") {
      return {
        title: "External dependencies are the main cause",
        body: `${top.count} review${top.count === 1 ? "" : "s"} involved waiting for others. Identify approvals, replies or inputs earlier and schedule a dependency check before the work becomes blocked.`,
      };
    }
    if (top?.code === "capacity") {
      return {
        title: "Planned workload is exceeding available capacity",
        body: `${top.count} review${top.count === 1 ? "" : "s"} cited workload/capacity. Reduce planned volume slightly or leave protected buffer for unexpected work.`,
      };
    }
    if (top?.code === "priority_shift") {
      return {
        title: "Priority changes are displacing planned work",
        body: `${top.count} review${top.count === 1 ? "" : "s"} were caused by higher-priority work. Keep some uncommitted daily capacity so urgent changes do not automatically push planned tasks forward.`,
      };
    }
    if (top?.code === "personal_delay") {
      return {
        title: "Self-postponement is visible",
        body: `${top.count} review${top.count === 1 ? "" : "s"} were personally postponed. Make the first action smaller or place the task earlier in the Day order to reduce start friction.`,
      };
    }
    if (top?.code === "underestimated") {
      return {
        title: "Some estimates need more buffer",
        body: `${top.count} review${top.count === 1 ? "" : "s"} came from work taking longer than expected. Increase estimates for similar tasks and compare them with Actual Time.`,
      };
    }
    if (repeated) {
      return {
        title: "Some tasks are being carried repeatedly",
        body: `${repeated} task${repeated === 1 ? " has" : "s have"} been reviewed more than once. Consider breaking repeated carry-over work into a smaller next action or deciding whether it still deserves priority.`,
      };
    }
    return {
      title: "Use the reason pattern to refine next week",
      body: `${rows.length} unfinished-task outcome${rows.length === 1 ? " was" : "s were"} recorded. The leading reason is ${top?.label.toLowerCase() || "not yet clear"}; use that as the next marginal-gain target.`,
    };
  }

  function markup(rows) {
    const moved = rows.filter((row) => row.action === "moved").length;
    const discarded = rows.filter((row) => row.action === "discarded").length;
    const byTask = new Map();
    for (const row of rows) byTask.set(row.task_id, (byTask.get(row.task_id) || 0) + 1);
    const repeated = [...byTask.values()].filter((count) => count > 1).length;
    const reasons = reasonRows(rows);
    const cue = analysisCue(rows, reasons, repeated);

    return `
      <details class="review-analytics-panel compact-review" data-review-analytics>
        <summary class="review-analytics-heading">
          <div><h3>End-of-day outcomes</h3><span>Optional detail on unfinished work reviewed from this week</span></div>
          <span class="details-hint">Show details</span>
        </summary>
        <div class="review-analytics-grid">
          <div class="review-analytics-kpi"><strong>${moved}</strong><span>Moved to another day</span></div>
          <div class="review-analytics-kpi"><strong>${discarded}</strong><span>Discarded as not completed</span></div>
          <div class="review-analytics-kpi"><strong>${repeated}</strong><span>Tasks reviewed more than once</span></div>
          <div class="review-reasons">
            ${reasons.length
              ? reasons.map((item) => `<div class="review-reason-row"><span>${escapeHtml(item.label)}</span><strong>${item.count}</strong></div>`).join("")
              : '<div class="review-reason-row"><span>No review reasons recorded yet.</span><strong>0</strong></div>'}
          </div>
          <div class="review-analysis-cue"><strong>${escapeHtml(cue.title)}</strong><span>${escapeHtml(cue.body)}</span></div>
        </div>
      </details>`;
  }

  function placementAnchor() {
    return document.querySelector("[data-wellbeing-dashboard]")
      || document.querySelector(".insight-layout")
      || document.querySelector("[data-analytics-dashboard]");
  }

  async function renderReviewAnalytics(force = false) {
    const analytics = document.querySelector("[data-analytics-dashboard]");
    if (!analytics || !session || state.loading) return;
    if (!await checkSchema()) return;

    const week = selectedWeek();
    if (!week) return;
    const end = addDays(week, 6);

    let rows = state.rows;
    const fresh = state.week === week && Date.now() - state.loadedAt < 300000;
    if (force || !fresh) {
      state.loading = true;
      const { data, error } = await client
        .from("task_reviews")
        .select("id,task_id,action,reason,from_date,to_date,occurred_at")
        .eq("user_id", session.user.id)
        .gte("from_date", week)
        .lte("from_date", end)
        .order("occurred_at", { ascending: true });
      state.loading = false;
      if (error || !document.querySelector("[data-analytics-dashboard]")) return;
      rows = data || [];
      state.rows = rows;
      state.week = week;
      state.loadedAt = Date.now();
    }

    const signature = JSON.stringify([week, rows.map((row) => [row.id, row.action, row.reason, row.from_date, row.to_date])]);
    const existing = document.querySelector("[data-review-analytics]");
    const anchor = placementAnchor();
    if (!anchor) return;

    if (!force && existing && state.signature === signature) {
      if (existing.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", existing);
      return;
    }

    state.signature = signature;
    existing?.remove();
    anchor.insertAdjacentHTML("afterend", markup(rows));
  }

  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (document.querySelector("[data-analytics-dashboard]")) renderReviewAnalytics().catch(() => {});
    });
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector("[data-analytics-dashboard]") && !document.querySelector("[data-review-analytics]")) scheduleRender();
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("nmplanner-analytics-changed", () => {
    state.signature = "";
    if (document.querySelector("[data-analytics-dashboard]")) renderReviewAnalytics(true).catch(() => {});
  });
  window.addEventListener("focus", scheduleRender);
  window.addEventListener("nmplanner-task-rescheduled", () => {
    state.loadedAt = 0;
    state.signature = "";
    if (document.querySelector("[data-analytics-dashboard]")) renderReviewAnalytics(true).catch(() => {});
  });
  scheduleRender();
})();
