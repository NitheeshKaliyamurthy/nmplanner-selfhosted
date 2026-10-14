/* global tasks, currentWeek, loadTasks, notify */

(() => {
  const routineClient = window.NMPlannerRuntime?.client;
  if (!routineClient) return;

  const START_MINUTE = 4 * 60;
  const END_MINUTE = 22 * 60;
  const SLOT_MINUTES = 15;
  const SLOT_PX = 18;
  const ROUTINE_PREFIX = "[[NM_ROUTINE:";

  const TEMPLATES = [
    {
      key: "travel_to_work",
      colorClass: "routine-travel",
      title: "Travel: Home → Work",
      short: "Home → Work",
      area: "BCU / Teaching",
      minutes: 90,
      icon: "→",
      description: "Work-related travel",
    },
    {
      key: "travel_to_home",
      colorClass: "routine-travel",
      title: "Travel: Work → Home",
      short: "Work → Home",
      area: "BCU / Teaching",
      minutes: 90,
      icon: "←",
      description: "Work-related travel",
    },
    {
      key: "school_run",
      colorClass: "routine-school-run",
      title: "School Run",
      short: "School Run",
      area: "Family / Home",
      minutes: 30,
      icon: "⌂",
      description: "Family",
    },
    {
      key: "personal_time",
      colorClass: "routine-personal-time",
      title: "Personal Time",
      short: "Personal Time",
      area: "Personal Time",
      minutes: 60,
      icon: "○",
      description: "Shower · restroom · meditation",
    },
    {
      key: "tea",
      colorClass: "routine-personal-time",
      title: "Tea",
      short: "Tea",
      area: "Personal Time",
      minutes: 30,
      icon: "T",
      description: "Tea break",
    },
    {
      key: "breakfast",
      colorClass: "routine-personal-time",
      title: "Breakfast",
      short: "Breakfast",
      area: "Personal Time",
      minutes: 30,
      icon: "B",
      description: "Breakfast",
    },
    {
      key: "lunch",
      colorClass: "routine-personal-time",
      title: "Lunch",
      short: "Lunch",
      area: "Personal Time",
      minutes: 30,
      icon: "L",
      description: "Lunch",
    },
    {
      key: "dinner",
      colorClass: "routine-personal-time",
      title: "Dinner",
      short: "Dinner",
      area: "Personal Time",
      minutes: 60,
      icon: "D",
      description: "Dinner",
    },
  ];

  const state = {
    armedKey: null,
    draggingKey: null,
    scheduled: false,
    installing: false,
    reconciling: false,
    lastReconcileAt: 0,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function templateFor(key) {
    return TEMPLATES.find((item) => item.key === key) || null;
  }

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function formatTime(totalMinutes) {
    const value = Math.max(0, Math.round(Number(totalMinutes || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function parseDate(value) {
    const [year, month, day] = String(value || "").slice(0, 10).split("-").map(Number);
    return year && month && day ? new Date(year, month - 1, day, 0, 0, 0, 0) : null;
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

  function currentRows() {
    try {
      return Array.isArray(tasks) ? tasks : [];
    } catch (_) {
      return [];
    }
  }

  function currentWeekKey() {
    try {
      return currentWeek || document.querySelector("#week-picker")?.value || "";
    } catch (_) {
      return document.querySelector("#week-picker")?.value || "";
    }
  }

  function isRoutineTask(task) {
    return String(task?.notes || "").startsWith(ROUTINE_PREFIX);
  }

  function routineKeyForTask(task) {
    const notes = String(task?.notes || "");
    if (!notes.startsWith(ROUTINE_PREFIX)) return "";
    const end = notes.indexOf("]]");
    if (end < 0) return "";
    return notes.slice(ROUTINE_PREFIX.length, end);
  }

  function routineColorClass(task) {
    return templateFor(routineKeyForTask(task))?.colorClass || "";
  }

  function routineNote(template) {
    return `[[NM_ROUTINE:${template.key}]] Quick routine template · ${template.description}`;
  }

  function targetDate(day) {
    return addDays(currentWeekKey(), day);
  }

  function scheduledEnd(task) {
    if (
      !task?.week
      || task.day === null
      || task.day === undefined
      || task.planned_start_minute === null
      || task.planned_start_minute === undefined
      || !Number.isInteger(Number(task.day))
      || !Number.isInteger(Number(task.planned_start_minute))
    ) return null;
    const date = parseDate(task.week);
    if (!date) return null;
    date.setDate(date.getDate() + Number(task.day));
    date.setMinutes(Number(task.planned_start_minute) + Number(task.minutes || 0));
    return date;
  }

  function shouldBeCompleted(week, day, startMinute, duration) {
    const date = parseDate(week);
    if (!date) return false;
    date.setDate(date.getDate() + day);
    date.setMinutes(startMinute + duration);
    return date.getTime() <= Date.now();
  }

  async function workLabel() {
    try {
      const settings = await window.NMPlannerSettings?.get?.();
      return settings?.work_name || "Primary Work";
    } catch (_) {
      return "Primary Work";
    }
  }

  async function paletteMarkup() {
    const primaryWork = await workLabel();
    return `
      <section class="routine-template-palette" data-routine-palette>
        <div class="routine-template-heading">
          <div>
            <p class="eyebrow">QUICK ROUTINES</p>
            <h2>Reusable Day Plan blocks</h2>
            <p>Click a template, then click a time slot on any day — or drag it directly onto the calendar. Routine time is included in analysis automatically.</p>
          </div>
          <span class="routine-template-mode" data-routine-mode>Choose a routine</span>
        </div>
        <div class="routine-template-list">
          ${TEMPLATES.map((template) => {
            const area = template.area === "BCU / Teaching" ? primaryWork : template.area === "Family / Home" ? "Family" : "Personal";
            return `
              <button type="button" class="routine-template-card ${template.colorClass || ""}" draggable="true" data-routine-template="${template.key}" aria-pressed="false">
                <span class="routine-template-icon">${escapeHtml(template.icon)}</span>
                <span class="routine-template-copy">
                  <strong>${escapeHtml(template.short)}</strong>
                  <small>${escapeHtml(area)} · ${escapeHtml(formatMinutes(template.minutes))}</small>
                </span>
                <span class="routine-template-grip" aria-hidden="true">⋮⋮</span>
              </button>`;
          }).join("")}
        </div>
        <div class="routine-template-help">
          <span>Placed routines reserve their calendar time until they occur.</span>
          <span>After the scheduled block ends, NM Planner marks it completed and records the planned duration as actual time.</span>
        </div>
      </section>`;
  }

  async function installPalette() {
    if (state.installing) return;
    state.installing = true;
    try {
      const grid = document.querySelector(".days-grid");
      if (!grid) {
        state.armedKey = null;
        return;
      }
      if (document.querySelector("[data-routine-palette]")) {
        paintArmedState();
        decorateRoutineTasks();
        return;
      }

      const holder = document.createElement("div");
      holder.innerHTML = await paletteMarkup();
      const palette = holder.firstElementChild;
      if (!palette || !grid.isConnected || document.querySelector("[data-routine-palette]")) return;
      grid.insertAdjacentElement("beforebegin", palette);
      paintArmedState();
      decorateRoutineTasks();
    } finally {
      state.installing = false;
    }
  }

  function paintArmedState() {
    const palette = document.querySelector("[data-routine-palette]");
    if (!palette) return;
    palette.querySelectorAll("[data-routine-template]").forEach((button) => {
      const active = button.dataset.routineTemplate === state.armedKey;
      button.classList.toggle("armed", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const mode = palette.querySelector("[data-routine-mode]");
    const template = templateFor(state.armedKey);
    if (mode) {
      mode.textContent = template
        ? `Place ${template.short} · click a calendar time`
        : "Choose a routine";
      mode.classList.toggle("active", Boolean(template));
    }
    document.body.classList.toggle("routine-placement-active", Boolean(template));
  }

  function clearPlacement() {
    state.armedKey = null;
    paintArmedState();
    clearMarkers();
  }

  function minuteFromPointer(event, timeline, duration) {
    const rect = timeline.getBoundingClientRect();
    const rawY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const rawMinute = START_MINUTE + (rawY / SLOT_PX) * SLOT_MINUTES;
    let minute = Math.round(rawMinute / SLOT_MINUTES) * SLOT_MINUTES;
    const latestStart = END_MINUTE - Math.max(SLOT_MINUTES, Number(duration || SLOT_MINUTES));
    minute = Math.max(START_MINUTE, Math.min(latestStart, minute));
    return Math.round(minute / SLOT_MINUTES) * SLOT_MINUTES;
  }

  function showMarker(timeline, minute, duration) {
    const marker = timeline.querySelector("[data-day-timeline-marker]");
    if (!marker) return;
    const top = ((minute - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    const height = Math.max(SLOT_PX, (Number(duration || SLOT_MINUTES) / SLOT_MINUTES) * SLOT_PX);
    marker.style.top = `${top}px`;
    marker.style.height = `${height}px`;
    marker.hidden = false;
    marker.classList.add("routine-template-marker");
    const label = marker.querySelector("span");
    if (label) label.textContent = formatTime(minute);
  }

  function clearMarkers() {
    document.querySelectorAll("[data-day-timeline-marker].routine-template-marker").forEach((marker) => {
      marker.hidden = true;
      marker.classList.remove("routine-template-marker");
    });
    document.querySelectorAll(".routine-template-drop-target").forEach((node) => node.classList.remove("routine-template-drop-target"));
  }

  function capacityError(message = "") {
    return /capacity exceeded|above your .* limit|normal capacity|Urgent \/ Overtime|Full Day requires|Half Day requires/i.test(message);
  }

  function overtimeSchemaError(message = "") {
    return /capacity_override|overtime_minutes|capacity_override_at/i.test(message) && /column|schema cache/i.test(message);
  }

  async function signedInUser() {
    const { data } = await routineClient.auth.getSession();
    return data.session?.user || null;
  }

  async function insertRoutine(template, day, minute, allowOvertime = false) {
    const user = await signedInUser();
    const week = currentWeekKey();
    if (!user || !week) throw new Error("Your planner session is not ready.");
    const completeNow = shouldBeCompleted(week, day, minute, template.minutes);

    const payload = {
      user_id: user.id,
      title: template.title,
      week,
      quadrant: null,
      day,
      area: template.area,
      due: null,
      minutes: template.minutes,
      actual_minutes: completeNow ? template.minutes : null,
      planned_start_minute: minute,
      notes: routineNote(template),
      completed: completeNow,
    };
    if (allowOvertime) payload.capacity_override = true;

    return routineClient.from("tasks").insert(payload);
  }

  async function createRoutine(templateKey, day, minute) {
    const template = templateFor(templateKey);
    if (!template || !Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(minute)) return;

    let result = await insertRoutine(template, day, minute, false);
    if (result.error && capacityError(result.error.message || "")) {
      const target = targetDate(day);
      const proceed = window.confirm(
        `${template.title} does not fit normal capacity on ${target}.\n\nAdd it as Urgent / Overtime instead? Any excess above your normal limit will be recorded in Insights.`
      );
      if (proceed) result = await insertRoutine(template, day, minute, true);
    }

    if (result.error) {
      const message = overtimeSchemaError(result.error.message || "")
        ? "Urgent / Overtime needs database migration 023 before this routine can exceed normal capacity."
        : result.error.message || "The routine could not be added.";
      if (typeof notify === "function") notify(message, "error");
      return;
    }

    if (typeof loadTasks === "function") await loadTasks();
    window.dispatchEvent(new Event("nmplanner-timeline-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("nmplanner-routine-changed"));

    const completed = shouldBeCompleted(currentWeekKey(), day, minute, template.minutes);
    if (typeof notify === "function") {
      notify(
        completed
          ? `${template.title} added at ${formatTime(minute)} and logged as completed.`
          : `${template.title} added at ${formatTime(minute)}. It will complete automatically after the block ends.`,
        "success"
      );
    }
  }

  async function reconcileRoutineCompletion(force = false) {
    if (state.reconciling) return;
    if (!force && Date.now() - state.lastReconcileAt < 30000) return;
    state.reconciling = true;
    state.lastReconcileAt = Date.now();

    try {
      const user = await signedInUser();
      if (!user) return;
      const now = new Date();
      const candidates = currentRows().filter((task) =>
        isRoutineTask(task)
        && task.superseded_by_followup !== true
        && !task.discarded_at
      );
      let changed = false;

      for (const task of candidates) {
        const updates = {};
        if (task.completed && (task.actual_minutes === null || task.actual_minutes === undefined)) {
          updates.actual_minutes = Number(task.minutes || 0);
        } else if (!task.completed) {
          const end = scheduledEnd(task);
          if (end && end.getTime() <= now.getTime()) {
            updates.completed = true;
            updates.actual_minutes = Number(task.minutes || 0);
          }
        }

        if (!Object.keys(updates).length) continue;
        const { error } = await routineClient
          .from("tasks")
          .update(updates)
          .eq("id", task.id)
          .eq("user_id", user.id);
        if (!error) changed = true;
      }

      if (changed) {
        if (typeof loadTasks === "function") await loadTasks();
        window.dispatchEvent(new Event("nmplanner-timeline-changed"));
        window.dispatchEvent(new Event("nmplanner-analytics-changed"));
        window.dispatchEvent(new Event("nmplanner-routine-changed"));
      }
    } finally {
      state.reconciling = false;
    }
  }

  function decorateRoutineTasks() {
    const byId = new Map(currentRows().filter(isRoutineTask).map((task) => [String(task.id), task]));
    const selectors = [
      ".task-row",
      ".compact-task[data-id]",
      ".day-timeline-task[data-id]",
      ".day-timeline-record[data-id]",
    ].join(",");

    document.querySelectorAll(selectors).forEach((node) => {
      const id = node.dataset.id || node.querySelector?.("[data-id]")?.dataset.id;
      const task = byId.get(String(id || ""));
      const existing = node.querySelector?.("[data-routine-badge]");
      const colorClasses = ["routine-travel", "routine-school-run", "routine-personal-time"];
      if (!task) {
        node.classList.remove("routine-task", ...colorClasses);
        existing?.remove();
        return;
      }
      node.classList.remove(...colorClasses);
      node.classList.add("routine-task");
      const colorClass = routineColorClass(task);
      if (colorClass) node.classList.add(colorClass);
      if (!existing) {
        const badge = document.createElement("span");
        badge.dataset.routineBadge = "";
        badge.className = "routine-task-badge";
        badge.textContent = "Routine";
        if (node.matches(".task-row")) {
          node.querySelector(".task-tags")?.prepend(badge);
        } else {
          node.append(badge);
        }
      }
    });
  }

  function scheduleInstall() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      installPalette().catch(() => {});
      decorateRoutineTasks();
      reconcileRoutineCompletion(false).catch(() => {});
    });
  }

  document.addEventListener("click", (event) => {
    const templateButton = event.target.closest?.("[data-routine-template]");
    if (templateButton) {
      event.preventDefault();
      event.stopPropagation();
      const key = templateButton.dataset.routineTemplate;
      state.armedKey = state.armedKey === key ? null : key;
      paintArmedState();
      clearMarkers();
      return;
    }

    if (!state.armedKey) return;
    const timeline = event.target.closest?.("[data-day-timeline]");
    if (!timeline) return;
    if (event.target.closest?.(".day-timeline-task, .day-timeline-record")) return;

    const template = templateFor(state.armedKey);
    if (!template) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const day = Number(timeline.dataset.dayTimeline);
    const minute = minuteFromPointer(event, timeline, template.minutes);
    const key = state.armedKey;
    clearPlacement();
    createRoutine(key, day, minute).catch((error) => {
      if (typeof notify === "function") notify(error.message, "error");
    });
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.armedKey) clearPlacement();
  });

  document.addEventListener("dragstart", (event) => {
    const button = event.target.closest?.("[data-routine-template]");
    if (!button) return;
    const key = button.dataset.routineTemplate;
    if (!templateFor(key)) return;
    state.draggingKey = key;
    button.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", `routine:${key}`);
      try { event.dataTransfer.setData("application/x-nmplanner-routine", key); } catch (_) {}
    }
  }, true);

  document.addEventListener("dragover", (event) => {
    if (!state.draggingKey) return;
    const timeline = event.target.closest?.("[data-day-timeline]");
    if (!timeline) return;
    const template = templateFor(state.draggingKey);
    if (!template) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    clearMarkers();
    timeline.classList.add("routine-template-drop-target");
    const minute = minuteFromPointer(event, timeline, template.minutes);
    showMarker(timeline, minute, template.minutes);
  }, true);

  document.addEventListener("drop", (event) => {
    if (!state.draggingKey) return;
    const timeline = event.target.closest?.("[data-day-timeline]");
    if (!timeline) return;
    const template = templateFor(state.draggingKey);
    if (!template) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const day = Number(timeline.dataset.dayTimeline);
    const minute = minuteFromPointer(event, timeline, template.minutes);
    const key = state.draggingKey;
    state.draggingKey = null;
    document.querySelectorAll("[data-routine-template].dragging").forEach((node) => node.classList.remove("dragging"));
    clearMarkers();
    createRoutine(key, day, minute).catch((error) => {
      if (typeof notify === "function") notify(error.message, "error");
    });
  }, true);

  document.addEventListener("dragend", () => {
    state.draggingKey = null;
    document.querySelectorAll("[data-routine-template].dragging").forEach((node) => node.classList.remove("dragging"));
    clearMarkers();
  }, true);

  const observer = new MutationObserver(scheduleInstall);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    scheduleInstall();
    reconcileRoutineCompletion(true).catch(() => {});
  });
  window.addEventListener("nmplanner-timeline-changed", scheduleInstall);
  window.addEventListener("nmplanner-analytics-changed", scheduleInstall);
  window.addEventListener("nmplanner-settings-changed", scheduleInstall);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reconcileRoutineCompletion(true).catch(() => {});
  });

  setInterval(() => {
    if (!document.hidden) reconcileRoutineCompletion(false).catch(() => {});
  }, 60000);

  window.NMPlannerRoutineTemplates = Object.freeze({
    templates: TEMPLATES.map((template) => ({ ...template })),
    isRoutineTask,
  });

  setTimeout(scheduleInstall, 1100);
})();