/* global client, session, tasks, currentWeek, loadTasks, notify */

(() => {
  const START_MINUTE = 4 * 60;
  const END_MINUTE = 22 * 60;
  const SLOT_MINUTES = 15;
  const SLOT_PX = 18;
  const REASONS = [
    ["waiting_external", "Waiting for others / external dependency"],
    ["priority_shift", "Higher-priority work took over"],
    ["capacity", "Workload / capacity exceeded"],
    ["personal_delay", "Personally postponed / delayed by me"],
    ["underestimated", "Task took longer than expected"],
    ["scope_change", "Scope changed / more work discovered"],
    ["planned_continuation", "Planned continuation / staged work"],
    ["other", "Other"],
  ];

  const state = {
    schemaReady: null,
    schemaError: "",
    checkingSchema: null,
    draggingId: null,
    sourceDay: null,
    sourceTimed: false,
    pendingMove: null,
    scheduled: false,
    initialScrollDone: new Set(),
    lastDragEnd: 0,
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

  function formatDate(value) {
    const date = parseDate(value);
    if (!date) return value;
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function formatTime(totalMinutes) {
    const minutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function formatDuration(totalMinutes) {
    const minutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest}m`;
    if (!rest) return `${hours}h`;
    return `${hours}h${rest}m`;
  }

  function currentMinuteOfDay(now = new Date()) {
    return now.getHours() * 60 + now.getMinutes();
  }

  function isTodayDay(day, now = new Date()) {
    return targetDate(day) === dateKey(now);
  }

  function taskFor(id) {
    return Array.isArray(tasks) ? tasks.find((task) => task.id === id) : null;
  }

  function normaliseArea(area) {
    if (area === "Personal / Admin" || area === "Lunch") return "Personal Time";
    return area || "";
  }

  function taskAreaClass(task) {
    const area = normaliseArea(task?.area);
    if (area === "BCU / Teaching") return "area-bcu";
    if (area === "Research") return "area-research";
    if (area === "WorldSkills") return "area-worldskills";
    if (area === "Family / Home") return "area-family";
    if (area === "Personal Time") return "area-personal";
    return "area-other";
  }

  function hasMultipleAreas(task) {
    const raw = task?.area_allocations;
    return Boolean(raw && typeof raw === "object" && !Array.isArray(raw)
      && Object.values(raw).filter((value) => Number(value) > 0).length >= 2);
  }

  function targetDate(day) {
    return addDays(currentWeek, day);
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  async function checkSchema(force = false) {
    if (!force && state.schemaReady !== null) return state.schemaReady;
    if (!force && state.checkingSchema) return state.checkingSchema;
    if (!client || !session) return false;

    state.checkingSchema = (async () => {
      const { error } = await client
        .from("tasks")
        .select("id,planned_start_minute")
        .eq("user_id", session.user.id)
        .limit(1);
      state.schemaReady = !error;
      state.schemaError = error?.message || "";
      return state.schemaReady;
    })();

    try {
      return await state.checkingSchema;
    } finally {
      state.checkingSchema = null;
    }
  }

  function showMigrationNote() {
    const grid = document.querySelector(".days-grid");
    if (!grid) return;
    let note = document.querySelector("[data-day-timeline-migration]");
    if (!note) {
      note = document.createElement("div");
      note.dataset.dayTimelineMigration = "";
      note.className = "day-timeline-migration";
      grid.insertAdjacentElement("beforebegin", note);
    }
    const signature = state.schemaError || "missing";
    if (note.dataset.signature === signature) return;
    note.dataset.signature = signature;
    note.innerHTML = `<strong>Day timeline setup required</strong><span>Run <code>database/013_day_timeline.sql</code> in Supabase to enable 15-minute scheduling.${state.schemaError ? ` ${escapeHtml(state.schemaError)}` : ""}</span>`;
  }

  function removeMigrationNote() {
    document.querySelector("[data-day-timeline-migration]")?.remove();
  }

  function hourLabels() {
    const parts = [];
    for (let minute = START_MINUTE; minute <= END_MINUTE; minute += 60) {
      const top = ((minute - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
      parts.push(`<span class="day-timeline-hour" style="top:${top}px">${formatTime(minute)}</span>`);
    }
    return parts.join("");
  }

  function timelineShell(day) {
    return `
      <section class="day-timeboard" data-day-timeboard="${day}">
        <div class="day-timeboard-heading">
          <strong>Time plan</strong>
          <span>04:00–22:00 · 15 min</span>
        </div>
        <div class="day-timeline-viewport" data-day-timeline-viewport="${day}">
          <div class="day-timeline" data-day-timeline="${day}" style="--slot-px:${SLOT_PX}px;--hour-px:${SLOT_PX * 4}px;--timeline-height:${((END_MINUTE - START_MINUTE) / SLOT_MINUTES) * SLOT_PX}px">
            <div class="day-timeline-hours" aria-hidden="true">${hourLabels()}</div>
            <div class="day-timeline-now" data-day-timeline-now="${day}" hidden><span></span></div>
            <div class="day-timeline-events" data-day-timeline-events="${day}"></div>
            <div class="day-timeline-drop-marker" data-day-timeline-marker="${day}" hidden><span></span></div>
          </div>
        </div>
        <small class="day-timeboard-help">Drag a task here to assign a time. Drag a timed block within this day to reshuffle it. Drag it back to this day's task list to clear only the time.</small>
      </section>`;
  }

  function taskBlock(task) {
    const start = Number(task.planned_start_minute);
    const top = ((start - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    const height = Math.max(SLOT_PX - 1, (Number(task.minutes || 0) / SLOT_MINUTES) * SLOT_PX - 2);
    const quadrant = ["q1", "q2", "q3", "q4"].includes(task.quadrant) ? task.quadrant : "none";
    const end = start + Number(task.minutes || 0);
    const areaClass = taskAreaClass(task);
    const multiClass = hasMultipleAreas(task) ? " area-multiple" : "";
    return `
      <button type="button" class="day-timeline-task q-${quadrant} ${areaClass}${multiClass}" draggable="true" data-action="edit" data-id="${task.id}" data-timeline-task="${task.id}" style="top:${top}px;height:${height}px" title="${escapeHtml(formatTime(start))}–${escapeHtml(formatTime(end))} · ${escapeHtml(task.title)}">
        <span class="day-timeline-task-time">${formatTime(start)}–${formatTime(end)}</span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${formatDuration(task.minutes)}</small>
      </button>`;
  }

  function decorateCompactList(card, day) {
    const body = card.querySelector(":scope > div[data-day-drop-target], :scope > div:not(.day-balance-strip)");
    if (!body) return;
    body.classList.add("day-task-list-compact");
    body.dataset.timelineTaskList = String(day);

    body.querySelectorAll(".compact-task[data-id]").forEach((button) => {
      const task = taskFor(button.dataset.id);
      if (!task) return;
      button.classList.remove("area-bcu", "area-research", "area-worldskills", "area-family", "area-personal", "area-other", "area-multiple");
      button.classList.add(taskAreaClass(task));
      if (hasMultipleAreas(task)) button.classList.add("area-multiple");
      const start = Number(task.planned_start_minute);
      let badge = button.querySelector("[data-task-start-badge]");
      if (Number.isFinite(start) && start >= START_MINUTE) {
        if (!badge) {
          badge = document.createElement("span");
          badge.dataset.taskStartBadge = "";
          badge.className = "day-task-start-badge";
          button.append(badge);
        }
        badge.textContent = formatTime(start);
        button.classList.add("has-planned-time");
      } else {
        badge?.remove();
        button.classList.remove("has-planned-time");
      }
      button.title = Number.isFinite(start) && start >= START_MINUTE
        ? `Planned ${formatTime(start)}. Drag within the day to change time; drag to another day to reschedule.`
        : "Drag onto this day's time grid to assign a start time, or drag to another day to reschedule.";
    });
  }

  function renderCurrentTime(card, day, now = new Date()) {
    const marker = card.querySelector(`[data-day-timeline-now="${day}"]`);
    if (!marker) return;

    if (!isTodayDay(day, now)) {
      marker.hidden = true;
      return;
    }

    const minute = currentMinuteOfDay(now);
    if (minute < START_MINUTE || minute > END_MINUTE) {
      marker.hidden = true;
      return;
    }

    const top = ((minute - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    marker.style.top = `${top}px`;
    marker.hidden = false;
    const label = marker.querySelector("span");
    if (label) label.textContent = `Now ${formatTime(minute)}`;
  }

  function renderTimedTasks(card, day) {
    const layer = card.querySelector(`[data-day-timeline-events="${day}"]`);
    if (!layer) return;
    const timed = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task.week === currentWeek && task.day === day && !task.completed && Number.isInteger(task.planned_start_minute))
      .sort((a, b) => a.planned_start_minute - b.planned_start_minute || String(a.title).localeCompare(String(b.title)));
    const signature = timed.map((task) => `${task.id}:${task.planned_start_minute}:${task.minutes}:${task.title}:${task.quadrant}:${task.area}:${JSON.stringify(task.area_allocations || null)}`).join("|");
    if (layer.dataset.signature !== signature) {
      layer.dataset.signature = signature;
      layer.innerHTML = timed.map(taskBlock).join("");
    }

    const viewport = card.querySelector(`[data-day-timeline-viewport="${day}"]`);
    const scrollKey = `${currentWeek}:${day}`;
    if (viewport && !state.initialScrollDone.has(scrollKey)) {
      const now = new Date();
      const currentMinute = currentMinuteOfDay(now);
      const today = isTodayDay(day, now) && currentMinute >= START_MINUTE && currentMinute <= END_MINUTE;
      const earliest = timed.length ? timed[0].planned_start_minute : 8 * 60;
      const desired = today
        ? Math.max(START_MINUTE, currentMinute - 120)
        : Math.max(START_MINUTE, earliest - 60);
      viewport.scrollTop = ((desired - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
      state.initialScrollDone.add(scrollKey);
    }

    renderCurrentTime(card, day);
  }

  async function render() {
    const grid = document.querySelector(".days-grid");
    if (!grid) {
      removeMigrationNote();
      return;
    }
    if (!await checkSchema()) {
      showMigrationNote();
      return;
    }
    removeMigrationNote();

    [...grid.querySelectorAll(".day-card")].forEach((card, day) => {
      decorateCompactList(card, day);
      let board = card.querySelector(`:scope > [data-day-timeboard="${day}"]`);
      if (!board) {
        const holder = document.createElement("div");
        holder.innerHTML = timelineShell(day);
        board = holder.firstElementChild;
        card.append(board);
      }
      renderTimedTasks(card, day);
    });
  }

  function scheduleRender() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      render().catch(() => {});
    });
  }

  function minuteFromPointer(event, timeline, duration) {
    const rect = timeline.getBoundingClientRect();
    const rawY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const rawMinute = START_MINUTE + (rawY / SLOT_PX) * SLOT_MINUTES;
    let minute = Math.round(rawMinute / SLOT_MINUTES) * SLOT_MINUTES;
    minute = Math.max(START_MINUTE, Math.min(END_MINUTE - SLOT_MINUTES, minute));
    const latestStart = END_MINUTE - Math.max(0, Number(duration || 0));
    if (minute > latestStart) minute = Math.floor(latestStart / SLOT_MINUTES) * SLOT_MINUTES;
    return Math.max(START_MINUTE, minute);
  }

  function markerFor(timeline) {
    return timeline.querySelector("[data-day-timeline-marker]");
  }

  function showMarker(timeline, minute, duration) {
    const marker = markerFor(timeline);
    if (!marker) return;
    const top = ((minute - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    const height = Math.max(SLOT_PX, (Number(duration || SLOT_MINUTES) / SLOT_MINUTES) * SLOT_PX);
    marker.style.top = `${top}px`;
    marker.style.height = `${height}px`;
    marker.querySelector("span").textContent = formatTime(minute);
    marker.hidden = false;
  }

  function hideMarkers() {
    document.querySelectorAll("[data-day-timeline-marker]").forEach((marker) => { marker.hidden = true; });
    document.querySelectorAll(".day-task-list-compact.timeline-list-drop").forEach((list) => list.classList.remove("timeline-list-drop"));
  }

  function clearDragVisuals() {
    hideMarkers();
    document.querySelectorAll(".day-timeline-task.timeline-dragging").forEach((task) => task.classList.remove("timeline-dragging"));
  }

  async function refreshAfterTimeChange(message) {
    if (typeof loadTasks === "function") await loadTasks();
    window.dispatchEvent(new Event("nmplanner-timeline-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    if (typeof notify === "function") notify(message, "success");
    scheduleRender();
  }

  async function assignSameDayTime(task, minute) {
    if (!client || !session) return;
    const { error } = await client
      .from("tasks")
      .update({ planned_start_minute: minute })
      .eq("id", task.id)
      .eq("user_id", session.user.id);
    if (error) {
      if (typeof notify === "function") notify(error.message, "error");
      return;
    }
    await refreshAfterTimeChange(`${task.title} scheduled at ${formatTime(minute)}.`);
  }

  async function clearSameDayTime(task) {
    if (!client || !session || task.planned_start_minute == null) return;
    const { error } = await client
      .from("tasks")
      .update({ planned_start_minute: null })
      .eq("id", task.id)
      .eq("user_id", session.user.id);
    if (error) {
      if (typeof notify === "function") notify(error.message, "error");
      return;
    }
    await refreshAfterTimeChange(`${task.title} is still on this day, with no fixed start time.`);
  }

  function reasonDialog() {
    return document.querySelector("#timeline-reschedule-dialog");
  }

  function closeReasonDialog() {
    const dialog = reasonDialog();
    if (dialog?.open) dialog.close();
    dialog?.remove();
    state.pendingMove = null;
  }

  function showReasonDialog(task, targetDay, minute) {
    closeReasonDialog();
    const fromDate = plannedDate(task);
    const toDate = targetDate(targetDay);
    state.pendingMove = { task, targetDay, minute, toDate };

    const dialog = document.createElement("dialog");
    dialog.id = "timeline-reschedule-dialog";
    dialog.className = "day-drag-reason-dialog timeline-reschedule-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="day-drag-reason-card">
        <div class="dialog-heading">
          <div><p class="eyebrow">RESCHEDULE TIMED TASK</p><h2>Record why this task is moving</h2></div>
          <button type="button" class="icon-button" data-timeline-action="cancel">×</button>
        </div>
        <div class="day-drag-move-summary">
          <strong>${escapeHtml(task.title)}</strong>
          <span>${escapeHtml(formatDate(fromDate))} → ${escapeHtml(formatDate(toDate))} at ${formatTime(minute)}</span>
        </div>
        <label class="field wide">
          <span>Why are you rescheduling this task?</span>
          <select data-timeline-reason>
            <option value="">Choose a reason…</option>
            ${REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}
          </select>
        </label>
        <div class="form-error" data-timeline-error hidden></div>
        <div class="dialog-actions"><div></div><div>
          <button type="button" class="secondary-button" data-timeline-action="cancel">Cancel</button>
          <button type="button" class="primary-button" data-timeline-action="confirm">Move to ${formatTime(minute)}</button>
        </div></div>
      </form>`;
    document.body.append(dialog);
    dialog.showModal();
  }

  function showReasonError(message) {
    const box = reasonDialog()?.querySelector("[data-timeline-error]");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function setReasonBusy(busy) {
    reasonDialog()?.querySelectorAll("[data-timeline-action]").forEach((button) => { button.disabled = busy; });
  }

  async function confirmCrossDayMove() {
    const pending = state.pendingMove;
    const dialog = reasonDialog();
    if (!pending || !dialog) return;
    const reason = dialog.querySelector("[data-timeline-reason]")?.value || "";
    if (!reason) return showReasonError("Choose a reason so this move is included in your rescheduling analysis.");

    setReasonBusy(true);
    const { error } = await client.rpc("reschedule_timed_task", {
      p_task_id: pending.task.id,
      p_reason: reason,
      p_target_date: pending.toDate,
      p_start_minute: pending.minute,
    });
    setReasonBusy(false);

    if (error) return showReasonError(error.message || "The task could not be moved.");
    const title = pending.task.title;
    const destination = pending.toDate;
    const minute = pending.minute;
    closeReasonDialog();
    await refreshAfterTimeChange(`${title} moved to ${formatDate(destination)} at ${formatTime(minute)} and the reason was recorded.`);
  }

  async function handleTimelineDrop(task, targetDay, minute) {
    if (!task || !Number.isInteger(targetDay)) return;
    const sameDay = task.week === currentWeek && task.day === targetDay;
    if (sameDay) {
      await assignSameDayTime(task, minute);
      return;
    }

    const destination = targetDate(targetDay);
    const today = dateKey(new Date());
    if (destination < today) {
      if (typeof notify === "function") notify("A task cannot be moved into a past day.", "error");
      return;
    }
    showReasonDialog(task, targetDay, minute);
  }

  document.addEventListener("dragstart", (event) => {
    const source = event.target.closest?.(".days-grid .compact-task[data-id], .day-timeline-task[data-id]");
    if (!source) return;
    const task = taskFor(source.dataset.id);
    if (!task) return;
    state.draggingId = task.id;
    state.sourceDay = task.day;
    state.sourceTimed = source.matches(".day-timeline-task");
    if (state.sourceTimed) source.classList.add("timeline-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      try { event.dataTransfer.setData("application/x-nmplanner-task", task.id); } catch (_) {}
    }
  }, true);

  document.addEventListener("dragover", (event) => {
    if (!state.draggingId) return;
    const timeline = event.target.closest?.("[data-day-timeline]");
    if (timeline) {
      const task = taskFor(state.draggingId);
      if (!task) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const minute = minuteFromPointer(event, timeline, task.minutes);
      hideMarkers();
      showMarker(timeline, minute, task.minutes);
      return;
    }

    const list = event.target.closest?.(".day-task-list-compact[data-timeline-task-list]");
    if (list && state.sourceTimed && Number(list.dataset.timelineTaskList) === state.sourceDay) {
      event.preventDefault();
      event.stopPropagation();
      hideMarkers();
      list.classList.add("timeline-list-drop");
    }
  }, true);

  document.addEventListener("drop", (event) => {
    if (!state.draggingId) return;
    const task = taskFor(state.draggingId);
    if (!task) return;

    const timeline = event.target.closest?.("[data-day-timeline]");
    if (timeline) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const targetDay = Number(timeline.dataset.dayTimeline);
      const minute = minuteFromPointer(event, timeline, task.minutes);
      clearDragVisuals();
      state.lastDragEnd = Date.now();
      state.draggingId = null;
      handleTimelineDrop(task, targetDay, minute).catch((error) => {
        if (typeof notify === "function") notify(error.message, "error");
      });
      return;
    }

    const list = event.target.closest?.(".day-task-list-compact[data-timeline-task-list]");
    if (list && state.sourceTimed && Number(list.dataset.timelineTaskList) === task.day && task.week === currentWeek) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearDragVisuals();
      state.lastDragEnd = Date.now();
      state.draggingId = null;
      clearSameDayTime(task).catch((error) => {
        if (typeof notify === "function") notify(error.message, "error");
      });
    }
  }, true);

  document.addEventListener("dragend", () => {
    clearDragVisuals();
    state.lastDragEnd = Date.now();
    state.draggingId = null;
    state.sourceDay = null;
    state.sourceTimed = false;
  }, true);

  document.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-timeline-action]");
    if (action) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action.dataset.timelineAction === "cancel") closeReasonDialog();
      else if (action.dataset.timelineAction === "confirm") confirmCrossDayMove().catch((error) => showReasonError(error.message));
      return;
    }

    if (Date.now() - state.lastDragEnd < 350 && event.target.closest?.(".day-timeline-task")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    if (state.schemaReady === false) checkSchema(true).then(scheduleRender).catch(() => {});
    else scheduleRender();
  });
  window.addEventListener("nmplanner-settings-changed", scheduleRender);
  window.addEventListener("nmplanner-task-rescheduled", scheduleRender);
  window.addEventListener("nmplanner-timeline-changed", scheduleRender);

  setInterval(() => {
    if (document.visibilityState === "visible" && document.querySelector(".days-grid")) {
      document.querySelectorAll(".days-grid .day-card").forEach((card, day) => renderCurrentTime(card, day));
    }
  }, 30000);

  setTimeout(scheduleRender, 1200);
})();
