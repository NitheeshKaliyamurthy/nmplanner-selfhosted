/* global client, session, tasks, currentWeek */

(() => {
  const START_MINUTE = 4 * 60;
  const END_MINUTE = 22 * 60;
  const SLOT_MINUTES = 15;
  const SLOT_PX = 18;

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
    scheduled: false,
    dirty: true,
    loadedWeek: "",
    reviews: [],
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

  function dayIndex(value) {
    const start = parseDate(currentWeek);
    const date = parseDate(value);
    if (!start || !date) return -1;
    return Math.round((date.getTime() - start.getTime()) / 86400000);
  }

  function formatTime(totalMinutes) {
    const minutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function formatShortDate(value) {
    const date = parseDate(value);
    if (!date) return value || "";
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(date);
  }

  function validStart(value) {
    const minute = Number(value);
    return Number.isInteger(minute) && minute >= START_MINUTE && minute < END_MINUTE;
  }

  function isHistoryNode(task) {
    try {
      if (window.NMPlannerActiveTasks?.isSuperseded) {
        return window.NMPlannerActiveTasks.isSuperseded(task);
      }
    } catch (_) {}
    return task?.superseded_by_followup === true;
  }

  async function loadReviewHistory() {
    if (!client || !session || !currentWeek) return;
    if (!state.dirty && state.loadedWeek === currentWeek) return;
    if (state.loading) return state.loading;

    const requestedWeek = currentWeek;
    const weekEnd = addDays(requestedWeek, 6);

    state.loading = (async () => {
      const { data, error } = await client
        .from("task_reviews")
        .select("id,task_id,task_snapshot,action,reason,from_date,to_date,occurred_at")
        .eq("user_id", session.user.id)
        .in("action", ["moved", "discarded"])
        .gte("from_date", requestedWeek)
        .lte("from_date", weekEnd)
        .order("occurred_at", { ascending: true });

      if (requestedWeek !== currentWeek) return;
      if (error) {
        // Review history is supplementary to the timeline. Never break Day Plan
        // if an older installation has not yet created task_reviews.
        state.reviews = [];
      } else {
        state.reviews = data || [];
      }
      state.loadedWeek = requestedWeek;
      state.dirty = false;
    })();

    try {
      await state.loading;
    } finally {
      state.loading = null;
    }
  }

  function completedEntries(day) {
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) =>
        task.week === currentWeek
        && task.day === day
        && task.completed
        && !isHistoryNode(task)
        && validStart(task.planned_start_minute)
      )
      .map((task) => ({
        key: `completed:${task.id}`,
        kind: "completed",
        taskId: task.id,
        title: task.title || "Completed task",
        quadrant: task.quadrant || "none",
        start: Number(task.planned_start_minute),
        duration: Math.max(SLOT_MINUTES, Number(task.minutes || SLOT_MINUTES)),
        status: "Completed",
        detail: "Completed",
        editable: true,
      }));
  }

  function directChildren(parentId) {
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task.parent_task_id === parentId)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  }

  function followupEntries(day) {
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) =>
        task.week === currentWeek
        && task.day === day
        && isHistoryNode(task)
        && !task.discarded_at
        && validStart(task.planned_start_minute)
      )
      .map((task) => {
        const children = directChildren(task.id);
        const first = children[0] || null;
        const destination = first?.week && Number.isInteger(first.day)
          ? formatShortDate(addDays(first.week, first.day))
          : "";
        const reason = first?.followup_reason
          ? REASON_LABELS[first.followup_reason] || first.followup_reason
          : "";
        const detail = children.length > 1
          ? `★ ${children.length} follow-ups`
          : destination
            ? `★ Follow-up ${destination}`
            : "★ Follow-up created";
        return {
          key: `followup:${task.id}`,
          kind: "followup",
          taskId: task.id,
          title: task.title || "Original task",
          quadrant: task.quadrant || "none",
          start: Number(task.planned_start_minute),
          duration: Math.max(SLOT_MINUTES, Number(task.minutes || SLOT_MINUTES)),
          status: "Follow-up created",
          detail,
          reason,
          editable: false,
        };
      });
  }

  function reviewEntries(day) {
    return state.reviews
      .filter((review) => dayIndex(review.from_date) === day)
      .map((review) => {
        const snapshot = review.task_snapshot && typeof review.task_snapshot === "object"
          ? review.task_snapshot
          : {};
        const start = Number(snapshot.planned_start_minute);
        if (!validStart(start)) return null;
        const moved = review.action === "moved";
        const destination = moved && review.to_date ? formatShortDate(review.to_date) : "";
        const reason = REASON_LABELS[review.reason] || review.reason || "Reason recorded";
        return {
          key: `review:${review.id}`,
          kind: moved ? "moved" : "discarded",
          taskId: review.task_id,
          title: snapshot.title || "Reviewed task",
          quadrant: snapshot.quadrant || "none",
          start,
          duration: Math.max(SLOT_MINUTES, Number(snapshot.minutes || SLOT_MINUTES)),
          status: moved ? "Moved · incomplete" : "Not completed",
          detail: moved ? `Moved to ${destination}` : "Discarded at review",
          reason,
          editable: false,
        };
      })
      .filter(Boolean);
  }

  function recordMarkup(entry) {
    const top = ((entry.start - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    const height = Math.max(SLOT_PX - 1, (entry.duration / SLOT_MINUTES) * SLOT_PX - 2);
    const quadrant = ["q1", "q2", "q3", "q4"].includes(entry.quadrant) ? entry.quadrant : "none";
    const title = `${formatTime(entry.start)} · ${entry.title} · ${entry.status}${entry.reason ? ` · ${entry.reason}` : ""}`;
    const tag = entry.kind === "completed" ? "✓" : entry.kind === "moved" ? "↗" : entry.kind === "followup" ? "★" : "!";
    const content = `
      <span class="day-timeline-task-time">${formatTime(entry.start)}</span>
      <strong>${escapeHtml(entry.title)}</strong>
      <small>${tag} ${escapeHtml(entry.detail)}</small>`;

    if (entry.editable) {
      return `<button type="button" class="day-timeline-record is-${entry.kind} q-${quadrant}" data-action="edit" data-id="${entry.taskId}" data-calendar-record="${escapeHtml(entry.key)}" data-start="${entry.start}" data-end="${entry.start + entry.duration}" style="top:${top}px;height:${height}px" title="${escapeHtml(title)}">${content}</button>`;
    }

    return `<div class="day-timeline-record is-${entry.kind} q-${quadrant}" role="group" data-calendar-record="${escapeHtml(entry.key)}" data-start="${entry.start}" data-end="${entry.start + entry.duration}" style="top:${top}px;height:${height}px" title="${escapeHtml(title)}">${content}</div>`;
  }

  function ensureHistoryLayer(timeline, day) {
    let layer = timeline.querySelector(`[data-day-timeline-history="${day}"]`);
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "day-timeline-history-events";
    layer.dataset.dayTimelineHistory = String(day);
    const marker = timeline.querySelector("[data-day-timeline-marker]");
    timeline.insertBefore(layer, marker || null);
    return layer;
  }

  function activeLayoutItems(card) {
    return [...card.querySelectorAll(".day-timeline-task[data-id]")]
      .map((node) => {
        const task = (Array.isArray(tasks) ? tasks : []).find((item) => item.id === node.dataset.id);
        if (!task || !validStart(task.planned_start_minute)) return null;
        return {
          node,
          start: Number(task.planned_start_minute),
          end: Number(task.planned_start_minute) + Math.max(SLOT_MINUTES, Number(task.minutes || SLOT_MINUTES)),
        };
      })
      .filter(Boolean);
  }

  function historyLayoutItems(card) {
    return [...card.querySelectorAll("[data-calendar-record]")]
      .map((node) => ({
        node,
        start: Number(node.dataset.start),
        end: Number(node.dataset.end),
      }))
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
  }

  function applyGroupLayout(group) {
    const laneEnds = [];
    for (const item of group) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      item.lane = lane;
    }

    const laneCount = Math.max(1, laneEnds.length);
    for (const item of group) {
      if (laneCount === 1) {
        item.node.style.left = "0";
        item.node.style.right = "0";
        item.node.style.width = "100%";
      } else {
        item.node.style.left = `calc(${item.lane} * (100% / ${laneCount}) + 1px)`;
        item.node.style.right = "auto";
        item.node.style.width = `calc(100% / ${laneCount} - 2px)`;
      }
    }
  }

  function layoutCalendar(card) {
    const items = [...activeLayoutItems(card), ...historyLayoutItems(card)]
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (!items.length) return;

    let group = [];
    let groupEnd = -1;
    for (const item of items) {
      if (group.length && item.start >= groupEnd) {
        applyGroupLayout(group);
        group = [];
        groupEnd = -1;
      }
      group.push(item);
      groupEnd = Math.max(groupEnd, item.end);
    }
    if (group.length) applyGroupLayout(group);
  }

  function renderDay(card, day) {
    const timeline = card.querySelector(`[data-day-timeline="${day}"]`);
    if (!timeline) return;
    const layer = ensureHistoryLayer(timeline, day);
    const entries = [...completedEntries(day), ...followupEntries(day), ...reviewEntries(day)]
      .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    const signature = entries
      .map((entry) => `${entry.key}:${entry.kind}:${entry.start}:${entry.duration}:${entry.title}:${entry.detail}:${entry.reason || ""}`)
      .join("|");

    if (layer.dataset.signature !== signature) {
      layer.dataset.signature = signature;
      layer.innerHTML = entries.map(recordMarkup).join("");
    }
    layoutCalendar(card);
  }

  async function render() {
    const grid = document.querySelector(".days-grid");
    if (!grid || !client || !session) return;
    await loadReviewHistory();
    [...grid.querySelectorAll(".day-card")].forEach((card, day) => renderDay(card, day));
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      render().catch(() => {});
    });
  }

  function invalidate() {
    state.dirty = true;
    schedule();
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("nmplanner-analytics-changed", invalidate);
  window.addEventListener("nmplanner-task-rescheduled", invalidate);
  window.addEventListener("nmplanner-timeline-changed", schedule);
  window.addEventListener("nmplanner-followup-changed", invalidate);
  window.addEventListener("focus", invalidate);

  setTimeout(schedule, 1500);
})();
