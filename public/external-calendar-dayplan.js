/* global tasks, currentWeek, loadTasks, notify */

(() => {
  const calendarClient = window.NMPlannerRuntime?.client;
  if (!calendarClient) return;

  const START_MINUTE = 4 * 60;
  const END_MINUTE = 22 * 60;
  const SLOT_MINUTES = 15;
  const SLOT_PX = 18;
  const AREAS = [
    ["", "Unclassified"],
    ["BCU / Teaching", "Primary Work"],
    ["Research", "Research"],
    ["WorldSkills", "Additional Work"],
    ["Family / Home", "Family"],
    ["Personal Time", "Personal"],
  ];
  const QUADRANTS = [
    ["", "No quadrant"],
    ["q1", "Q1 · Urgent + Important"],
    ["q2", "Q2 · Important + Not urgent"],
    ["q3", "Q3 · Urgent + Not important"],
    ["q4", "Q4 · Not urgent + Not important"],
  ];

  const state = {
    week: "",
    events: [],
    overrides: new Set(),
    loading: false,
    scheduled: false,
    schemaReady: null,
    lastLoadedAt: 0,
    materializing: false,
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
    return y && m && d ? new Date(y, m - 1, d, 0, 0, 0, 0) : null;
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    if (!date) return "";
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function selectedWeek() {
    try {
      return currentWeek || document.querySelector("#week-picker")?.value || "";
    } catch (_) {
      return document.querySelector("#week-picker")?.value || "";
    }
  }

  function formatTime(minute) {
    const value = Math.max(0, Math.round(Number(minute || 0)));
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }

  function dayIndexFor(date) {
    const week = parseDate(selectedWeek());
    if (!week || !(date instanceof Date)) return -1;
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = Math.round((target.getTime() - week.getTime()) / 86400000);
    return diff >= 0 && diff <= 6 ? diff : -1;
  }

  function eventParts(event) {
    if (event.event_state === "cancelled") return [];
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

    const parts = [];
    for (let day = 0; day < 7; day += 1) {
      const key = addDays(selectedWeek(), day);
      const dayStart = parseDate(key);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const overlapStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
      const overlapEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
      if (overlapEnd <= overlapStart) continue;

      if (event.is_all_day) {
        parts.push({ day, allDay: true, start: START_MINUTE, end: START_MINUTE });
        continue;
      }

      const startMinute = overlapStart.getHours() * 60 + overlapStart.getMinutes();
      const endMinute = overlapEnd.getTime() === dayEnd.getTime()
        ? 24 * 60
        : overlapEnd.getHours() * 60 + overlapEnd.getMinutes();
      const clippedStart = Math.max(START_MINUTE, startMinute);
      const clippedEnd = Math.min(END_MINUTE, endMinute);
      if (clippedEnd > clippedStart) parts.push({ day, allDay: false, start: clippedStart, end: clippedEnd });
    }
    return parts;
  }

  function operationalTasks() {
    const rows = Array.isArray(tasks) ? tasks : [];
    try {
      if (window.NMPlannerActiveTasks?.open) return window.NMPlannerActiveTasks.open();
    } catch (_) {}
    const parents = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
    return rows.filter((task) =>
      !task.completed
      && task.superseded_by_followup !== true
      && !parents.has(task.id)
      && !task.discarded_at
    );
  }

  function overrideKey(eventId, taskId) {
    return `${eventId}:${taskId}`;
  }

  function eventTaskSchedule(event) {
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;

    const day = (start.getDay() + 6) % 7;
    const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
    monday.setDate(monday.getDate() - day);
    const week = dateKey(monday);

    const rawStart = start.getHours() * 60 + start.getMinutes();
    const roundedStart = Math.round(rawStart / SLOT_MINUTES) * SLOT_MINUTES;
    const plannedStart = roundedStart >= START_MINUTE && roundedStart <= 1305 ? roundedStart : null;
    const minutes = Math.max(5, Math.min(720, Math.round((end.getTime() - start.getTime()) / 60000)));

    return { week, day, plannedStart, minutes };
  }

  function taskLinksEvent(task, eventId) {
    return task?.external_calendar_event_id != null
      && String(task.external_calendar_event_id) === String(eventId);
  }

  function hasManualConflict(event) {
    for (const part of eventParts(event)) {
      if (part.allDay) continue;
      for (const task of operationalTasks()) {
        if (task.week !== selectedWeek() || task.day !== part.day || !Number.isInteger(task.planned_start_minute)) continue;
        if (taskLinksEvent(task, event.id)) continue;
        const start = Number(task.planned_start_minute);
        const end = start + Number(task.minutes || 0);
        if (start < part.end && part.start < end) return true;
      }
    }
    return false;
  }

  async function ensureScheduledTasks(user) {
    if (state.materializing || !user) return false;
    const candidates = state.events.filter((event) =>
      event.event_state !== "cancelled"
      && !event.is_all_day
      && Boolean(event.area)
      && Boolean(event.quadrant)
      && eventTaskSchedule(event)
    );
    if (!candidates.length) return false;

    state.materializing = true;
    try {
      const appState = window.NMPlannerState;
      let existingRows = null;
      if (appState?.isWeekLoaded?.() && appState.getWeek?.() === selectedWeek()) {
        existingRows = appState.getTasks?.() || [];
      } else {
        const ids = candidates.map((event) => event.id);
        const result = await calendarClient
          .from("tasks")
          .select("id,external_calendar_event_id")
          .eq("user_id", user.id)
          .in("external_calendar_event_id", ids);
        if (result.error) throw result.error;
        existingRows = result.data || [];
      }

      const existing = new Set((existingRows || [])
        .map((row) => row.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String));
      const rows = candidates
        .filter((event) => !existing.has(String(event.id)))
        .map((event) => {
          const schedule = eventTaskSchedule(event);
          return {
            user_id: user.id,
            title: String(event.title || "Calendar event").slice(0, 160),
            week: schedule.week,
            quadrant: event.quadrant,
            day: schedule.day,
            area: event.area,
            due: null,
            minutes: schedule.minutes,
            notes: "",
            completed: false,
            created_at: event.created_at || new Date().toISOString(),
            planned_start_minute: schedule.plannedStart,
            external_calendar_event_id: event.id,
          };
        });

      if (!rows.length) return false;
      const { error } = await calendarClient.from("tasks").insert(rows);
      if (error) throw error;

      if (typeof loadTasks === "function") await loadTasks();
      window.dispatchEvent(new Event("nmplanner-analytics-changed"));
      return true;
    } finally {
      state.materializing = false;
    }
  }

  function conflicts() {
    const items = [];
    const timedTasks = operationalTasks().filter((task) =>
      task.week === selectedWeek()
      && Number.isInteger(task.day)
      && Number.isInteger(task.planned_start_minute)
    );

    for (const event of state.events) {
      for (const part of eventParts(event)) {
        if (part.allDay) continue;
        for (const task of timedTasks) {
          if (task.day !== part.day) continue;
          if (taskLinksEvent(task, event.id)) continue;
          if (state.overrides.has(overrideKey(event.id, task.id))) continue;
          const start = Number(task.planned_start_minute);
          const end = start + Number(task.minutes || 0);
          if (start < part.end && part.start < end) {
            items.push({ event, part, task, overlap: Math.min(end, part.end) - Math.max(start, part.start) });
          }
        }
      }
    }
    return items;
  }

  async function load(force = false) {
    const week = selectedWeek();
    if (!week) return false;
    if (!force && state.week === week && Date.now() - state.lastLoadedAt < 300000) return state.schemaReady === true;
    if (state.loading) return false;
    state.loading = true;

    try {
      const { data: auth } = await calendarClient.auth.getSession();
      const user = auth.session?.user;
      if (!user) return false;
      const start = parseDate(week);
      const end = parseDate(addDays(week, 7));
      const eventResult = await calendarClient
        .from("external_calendar_events")
        .select("id,provider,external_event_id,series_id,starts_at,ends_at,is_all_day,title,event_state,area,quadrant,source_modified_at,created_at")
        .eq("user_id", user.id)
        .lt("starts_at", end.toISOString())
        .gt("ends_at", start.toISOString())
        .order("starts_at", { ascending: true });

      if (eventResult.error) {
        state.schemaReady = false;
        state.events = [];
        state.overrides = new Set();
        state.week = week;
        state.lastLoadedAt = Date.now();
        return false;
      }

      state.schemaReady = true;
      state.events = eventResult.data || [];
      const ids = state.events.map((event) => event.id);
      if (ids.length) {
        const overrideResult = await calendarClient
          .from("calendar_overlap_overrides")
          .select("external_event_id,task_id")
          .eq("user_id", user.id)
          .in("external_event_id", ids);
        state.overrides = new Set((overrideResult.data || []).map((row) => overrideKey(row.external_event_id, row.task_id)));
      } else {
        state.overrides = new Set();
      }
      state.week = week;
      state.lastLoadedAt = Date.now();
      await ensureScheduledTasks(user);
      return true;
    } finally {
      state.loading = false;
    }
  }

  function classificationLabel(event) {
    const area = event.area
      ? AREAS.find(([value]) => value === event.area)?.[1] || event.area
      : "Unclassified";
    const quadrant = event.quadrant ? event.quadrant.toUpperCase() : "No Q";
    return `${area} · ${quadrant}`;
  }

  function eventBlock(event, part) {
    const top = ((part.start - START_MINUTE) / SLOT_MINUTES) * SLOT_PX;
    const height = Math.max(SLOT_PX - 1, ((part.end - part.start) / SLOT_MINUTES) * SLOT_PX - 2);
    const q = ["q1","q2","q3","q4"].includes(event.quadrant) ? event.quadrant : "none";
    return `
      <button type="button" class="external-calendar-event q-${q} ${event.area ? "" : "unclassified"}"
        data-external-event-id="${event.id}" style="top:${top}px;height:${height}px"
        title="${escapeHtml(formatTime(part.start))}–${escapeHtml(formatTime(part.end))} · ${escapeHtml(event.title || "Microsoft calendar event")}">
        <span class="external-calendar-provider">Calendar</span>
        <span class="external-calendar-time">${formatTime(part.start)}–${formatTime(part.end)}</span>
        <strong>${escapeHtml(event.title || "Calendar event")}</strong>
        <small>${escapeHtml(classificationLabel(event))}</small>
      </button>`;
  }

  function ensureLayer(timeline, day) {
    let layer = timeline.querySelector(`[data-external-calendar-layer="${day}"]`);
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "external-calendar-layer";
    layer.dataset.externalCalendarLayer = String(day);
    const eventLayer = timeline.querySelector("[data-day-timeline-events]");
    timeline.insertBefore(layer, eventLayer || null);
    return layer;
  }

  function renderAllDay(card, day, events) {
    let holder = card.querySelector("[data-external-all-day]");
    const allDay = events.filter(({ part }) => part.day === day && part.allDay);
    if (!allDay.length) {
      holder?.remove();
      return;
    }
    if (!holder) {
      holder = document.createElement("div");
      holder.dataset.externalAllDay = "";
      holder.className = "external-calendar-all-day";
      const board = card.querySelector("[data-day-timeboard]");
      card.insertBefore(holder, board || null);
    }
    const signature = allDay.map(({ event }) => `${event.id}:${event.title}:${event.area}:${event.quadrant}`).join("|");
    if (holder.dataset.signature === signature) return;
    holder.dataset.signature = signature;
    holder.innerHTML = allDay.map(({ event }) => `
      <button type="button" data-external-event-id="${event.id}">
        <b>Calendar · All day</b><span>${escapeHtml(event.title || "Calendar event")}</span>
      </button>`).join("");
  }

  function renderDayPlan() {
    const grid = document.querySelector(".days-grid");
    if (!grid || state.schemaReady !== true) {
      document.querySelector("[data-calendar-conflicts]")?.remove();
      return;
    }

    const linkedEventIds = new Set(
      (Array.isArray(tasks) ? tasks : [])
        .map((task) => task.external_calendar_event_id)
        .filter((value) => value !== null && value !== undefined)
        .map(String)
    );
    const parts = state.events
      .filter((event) => !(event.area && event.quadrant && linkedEventIds.has(String(event.id))))
      .flatMap((event) => eventParts(event).map((part) => ({ event, part })));
    [...grid.querySelectorAll(".day-card")].forEach((card, day) => {
      const timeline = card.querySelector(`[data-day-timeline="${day}"]`);
      if (!timeline) return;
      const layer = ensureLayer(timeline, day);
      const dayItems = parts.filter(({ part }) => part.day === day && !part.allDay);
      const signature = dayItems.map(({ event, part }) => `${event.id}:${part.start}:${part.end}:${event.title}:${event.area}:${event.quadrant}`).join("|");
      if (layer.dataset.signature !== signature) {
        layer.dataset.signature = signature;
        layer.innerHTML = dayItems.map(({ event, part }) => eventBlock(event, part)).join("");
      }
      renderAllDay(card, day, parts);
    });

    renderConflictPanel(grid);
  }

  function renderConflictPanel(grid) {
    const list = conflicts();
    let panel = document.querySelector("[data-calendar-conflicts]");
    if (!list.length) {
      panel?.remove();
      return;
    }

    const signature = list.map((item) => `${item.event.id}:${item.task.id}:${item.overlap}`).join("|");
    if (panel?.dataset.signature === signature) return;
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "calendar-conflict-panel";
      panel.dataset.calendarConflicts = "";
      grid.insertAdjacentElement("beforebegin", panel);
    }
    panel.dataset.signature = signature;
    panel.innerHTML = `
      <div class="calendar-conflict-heading">
        <div><p class="eyebrow">CALENDAR CONFLICT REVIEW</p><h2>${list.length} planner task${list.length === 1 ? "" : "s"} clash with imported calendar time</h2></div>
        <span>Resolve duplicates or overlaps before finalising the day</span>
      </div>
      <p class="calendar-conflict-explainer">NM Planner will not move or delete your task automatically. Resolve each clash explicitly.</p>
      <div class="calendar-conflict-list">${list.map((item) => `
        <div class="calendar-conflict-row">
          <div>
            <strong>${escapeHtml(item.task.title)}</strong>
            <span>${formatTime(item.task.planned_start_minute)}–${formatTime(Number(item.task.planned_start_minute) + Number(item.task.minutes || 0))} conflicts with imported “${escapeHtml(item.event.title || "Calendar event")}” · ${item.overlap}m overlap</span>
          </div>
          <div class="calendar-conflict-actions">
            <button type="button" class="secondary-button" data-calendar-conflict-action="find-slot" data-task-id="${item.task.id}" data-event-id="${item.event.id}">Next free slot</button>
            <button type="button" class="secondary-button" data-calendar-conflict-action="clear-time" data-task-id="${item.task.id}">Keep day, clear time</button>
            <button type="button" class="secondary-button" data-calendar-conflict-action="keep-overlap" data-task-id="${item.task.id}" data-event-id="${item.event.id}">Keep overlap</button>
            <button type="button" class="secondary-button" data-calendar-conflict-action="merge" data-task-id="${item.task.id}" data-event-id="${item.event.id}">Merge duplicate</button>
            <button type="button" class="secondary-button conflict-delete" data-calendar-conflict-action="delete-task" data-task-id="${item.task.id}" data-event-id="${item.event.id}">Delete planner task</button>
            <button type="button" class="secondary-button conflict-delete" data-calendar-conflict-action="delete-event" data-task-id="${item.task.id}" data-event-id="${item.event.id}">Delete imported event</button>
          </div>
        </div>`).join("")}</div>`;
  }

  function classificationDialog(event) {
    document.querySelector("#external-calendar-dialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "external-calendar-dialog";
    dialog.className = "external-calendar-dialog";
    dialog.innerHTML = `
      <form method="dialog">
        <div class="dialog-heading">
          <div><p class="eyebrow">IMPORTED CALENDAR</p><h2>Classify fixed commitment</h2></div>
          <button type="button" class="icon-button" data-calendar-action="cancel">×</button>
        </div>
        <div class="external-calendar-event-summary">
          <strong>${escapeHtml(event.title || "Calendar event")}</strong>
          <span>${new Intl.DateTimeFormat("en-GB", { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }).format(new Date(event.starts_at))}</span>
        </div>
        <div class="form-grid">
          <label class="field"><span>Area</span><select data-calendar-area>
            ${AREAS.map(([value,label]) => `<option value="${value}" ${event.area === value || (!event.area && !value) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
          </select></label>
          <label class="field"><span>Priority</span><select data-calendar-quadrant>
            ${QUADRANTS.map(([value,label]) => `<option value="${value}" ${event.quadrant === value || (!event.quadrant && !value) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
          </select></label>
        </div>
        <label class="external-calendar-remember">
          <input type="checkbox" data-calendar-remember ${event.series_id ? "" : ""}>
          <span><strong>Remember this classification</strong><small>${event.series_id ? "Apply to this recurring calendar series." : "Apply to future events with this exact title."}</small></span>
        </label>
        <div class="form-error" data-calendar-error hidden></div>
        <div class="dialog-actions"><div></div><div>
          <button type="button" class="secondary-button" data-calendar-action="cancel">Cancel</button>
          <button type="button" class="primary-button" data-calendar-action="save" data-event-id="${event.id}">Save classification</button>
        </div></div>
      </form>`;
    document.body.append(dialog);
    dialog.showModal();
  }

  function showDialogError(message) {
    const box = document.querySelector("#external-calendar-dialog [data-calendar-error]");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  async function saveClassification(eventId) {
    const event = state.events.find((row) => String(row.id) === String(eventId));
    const dialog = document.querySelector("#external-calendar-dialog");
    if (!event || !dialog) return;
    const area = dialog.querySelector("[data-calendar-area]")?.value || null;
    const quadrant = dialog.querySelector("[data-calendar-quadrant]")?.value || null;
    const remember = Boolean(dialog.querySelector("[data-calendar-remember]")?.checked);
    const { data: auth } = await calendarClient.auth.getSession();
    const user = auth.session?.user;
    if (!user) return;

    const { error } = await calendarClient
      .from("external_calendar_events")
      .update({ area, quadrant })
      .eq("id", event.id)
      .eq("user_id", user.id);
    if (error) return showDialogError(error.message);

    if (remember) {
      if (!area) return showDialogError("Choose an area before saving a reusable classification rule.");
      const ruleType = event.series_id ? "series" : "title_exact";
      const matchValue = event.series_id || event.title;
      const ruleResult = await calendarClient.from("calendar_classification_rules").upsert({
        user_id: user.id,
        provider: "microsoft",
        rule_type: ruleType,
        match_value: matchValue,
        area,
        quadrant,
      }, { onConflict: "user_id,provider,rule_type,match_value" });
      if (ruleResult.error) return showDialogError(ruleResult.error.message);

      let query = calendarClient
        .from("external_calendar_events")
        .update({ area, quadrant })
        .eq("user_id", user.id)
        .eq("provider", "microsoft_power_automate");
      query = event.series_id ? query.eq("series_id", event.series_id) : query.eq("title", event.title);
      await query;
    }

    dialog.close();
    dialog.remove();
    await load(true);
    renderDayPlan();
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("nmplanner-calendar-changed"));
  }

  function busyIntervals(day, excludingTaskId) {
    const intervals = [];
    for (const event of state.events) {
      for (const part of eventParts(event)) {
        if (part.day === day && !part.allDay) intervals.push([part.start, part.end]);
      }
    }
    for (const task of operationalTasks()) {
      if (task.id === excludingTaskId || task.week !== selectedWeek() || task.day !== day || !Number.isInteger(task.planned_start_minute)) continue;
      intervals.push([task.planned_start_minute, task.planned_start_minute + Number(task.minutes || 0)]);
    }
    return intervals.sort((a,b) => a[0] - b[0]);
  }

  function nextFreeStart(task, afterMinute) {
    const duration = Number(task.minutes || 0);
    const intervals = busyIntervals(task.day, task.id);
    let start = Math.max(START_MINUTE, Math.ceil(Number(afterMinute || START_MINUTE) / SLOT_MINUTES) * SLOT_MINUTES);
    while (start + duration <= END_MINUTE) {
      const end = start + duration;
      const clash = intervals.some(([busyStart, busyEnd]) => start < busyEnd && busyStart < end);
      if (!clash) return start;
      start += SLOT_MINUTES;
    }
    return null;
  }

  async function refreshTasksAndCalendar(message) {
    if (typeof loadTasks === "function") await loadTasks();
    await load(true);
    renderDayPlan();
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("nmplanner-calendar-changed"));
    if (typeof notify === "function" && message) notify(message, "success");
  }

  async function deletePlannerConflictTask(task, user) {
    const title = task?.title || "this planner task";
    if (!window.confirm(`Delete “${title}” from NM Planner permanently? The imported calendar event will remain.`)) return;
    const { error } = await calendarClient
      .from("tasks")
      .delete()
      .eq("id", task.id)
      .eq("user_id", user.id);
    if (error) throw error;
    await refreshTasksAndCalendar(`Deleted planner task “${title}”. Imported calendar event kept.`);
  }

  async function deleteImportedConflictEvent(event, user) {
    const title = event?.title || "this imported calendar event";
    const warning = `Delete imported event “${title}” from NM Planner?\n\nAny scheduled-task copy will be kept as a normal NM Planner task. If the same event is present in a future calendar.json import, it can be imported again.`;
    if (!window.confirm(warning)) return;

    const { error: unlinkError } = await calendarClient
      .from("tasks")
      .update({ external_calendar_event_id: null })
      .eq("user_id", user.id)
      .eq("external_calendar_event_id", event.id);
    if (unlinkError) throw unlinkError;

    const { error } = await calendarClient
      .from("external_calendar_events")
      .delete()
      .eq("id", event.id)
      .eq("user_id", user.id);
    if (error) throw error;
    await refreshTasksAndCalendar(`Deleted imported event “${title}”. Scheduled work was kept.`);
  }

  async function mergeConflictDuplicate(task, event, user) {
    const taskTitle = task?.title || "planner task";
    const eventTitle = event?.title || "imported calendar event";
    const question = `Merge “${taskTitle}” with imported “${eventTitle}”?\n\nNM Planner will keep one scheduled item, link it to the imported calendar event, and preserve the existing task history.`;
    if (!window.confirm(question)) return;

    const eventUpdates = {};
    if (!event.area && task.area) eventUpdates.area = task.area;
    if (!event.quadrant && task.quadrant) eventUpdates.quadrant = task.quadrant;

    if (Object.keys(eventUpdates).length) {
      const { error: eventError } = await calendarClient
        .from("external_calendar_events")
        .update(eventUpdates)
        .eq("id", event.id)
        .eq("user_id", user.id);
      if (eventError) throw eventError;
    }

    const schedule = eventTaskSchedule(event);
    const taskUpdates = { external_calendar_event_id: event.id };
    if (schedule) {
      taskUpdates.week = schedule.week;
      taskUpdates.day = schedule.day;
      taskUpdates.planned_start_minute = schedule.plannedStart;
      taskUpdates.minutes = schedule.minutes;
    }
    if (event.title) taskUpdates.title = String(event.title).slice(0, 160);
    if (event.area) taskUpdates.area = event.area;
    if (event.quadrant) taskUpdates.quadrant = event.quadrant;

    const { error: taskError } = await calendarClient
      .from("tasks")
      .update(taskUpdates)
      .eq("id", task.id)
      .eq("user_id", user.id);
    if (taskError) throw taskError;

    await refreshTasksAndCalendar(`Merged “${taskTitle}” with the imported calendar event.`);
  }

  async function resolveConflict(action, taskId, eventId) {
    const task = (Array.isArray(tasks) ? tasks : []).find((row) => row.id === taskId);
    const event = state.events.find((row) => String(row.id) === String(eventId));
    const { data: auth } = await calendarClient.auth.getSession();
    const user = auth.session?.user;
    if (!task || !user) return;

    if (action === "delete-task") {
      return deletePlannerConflictTask(task, user);
    }

    if (action === "delete-event") {
      if (!event) return;
      return deleteImportedConflictEvent(event, user);
    }

    if (action === "merge") {
      if (!event) return;
      return mergeConflictDuplicate(task, event, user);
    }

    if (action === "clear-time") {
      const { error } = await calendarClient.from("tasks")
        .update({ planned_start_minute: null })
        .eq("id", task.id)
        .eq("user_id", user.id);
      if (error) return window.alert(error.message);
      return refreshTasksAndCalendar(`${task.title} kept on the day with no fixed time.`);
    }

    if (action === "keep-overlap") {
      if (!event) return;
      const { error } = await calendarClient.from("calendar_overlap_overrides").upsert({
        user_id: user.id,
        external_event_id: event.id,
        task_id: task.id,
      }, { onConflict: "user_id,external_event_id,task_id" });
      if (error) return window.alert(error.message);
      return refreshTasksAndCalendar("Overlap kept deliberately. It will remain visible in workload analysis.");
    }

    if (action === "find-slot") {
      if (!event) return;
      const part = eventParts(event).find((row) => row.day === task.day && !row.allDay);
      const start = nextFreeStart(task, part?.end || task.planned_start_minute);
      if (start === null) {
        if (typeof notify === "function") notify("No free slot remains on this day. Clear the task time, or move it to another day using the normal reschedule workflow.", "error");
        return;
      }
      const { error } = await calendarClient.from("tasks")
        .update({ planned_start_minute: start })
        .eq("id", task.id)
        .eq("user_id", user.id);
      if (error) return window.alert(error.message);
      return refreshTasksAndCalendar(`${task.title} moved to the next free slot at ${formatTime(start)}.`);
    }
  }

  async function render(force = false) {
    if (!document.querySelector(".days-grid")) return;
    await load(force);
    renderDayPlan();
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
    const eventButton = event.target.closest?.("[data-external-event-id]");
    if (eventButton && !eventButton.closest("[data-calendar-conflicts]")) {
      const item = state.events.find((row) => String(row.id) === String(eventButton.dataset.externalEventId));
      if (item) {
        event.preventDefault();
        event.stopImmediatePropagation();
        classificationDialog(item);
      }
      return;
    }

    const dialogAction = event.target.closest?.("[data-calendar-action]");
    if (dialogAction) {
      event.preventDefault();
      if (dialogAction.dataset.calendarAction === "cancel") {
        const dialog = document.querySelector("#external-calendar-dialog");
        dialog?.close();
        dialog?.remove();
      } else if (dialogAction.dataset.calendarAction === "save") {
        saveClassification(dialogAction.dataset.eventId).catch((error) => showDialogError(error.message));
      }
      return;
    }

    const conflictAction = event.target.closest?.("[data-calendar-conflict-action]");
    if (conflictAction) {
      event.preventDefault();
      resolveConflict(
        conflictAction.dataset.calendarConflictAction,
        conflictAction.dataset.taskId,
        conflictAction.dataset.eventId
      ).catch((error) => {
        if (typeof notify === "function") notify(error.message, "error");
      });
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (event.target?.matches?.("#week-picker")) {
      state.lastLoadedAt = 0;
      schedule(true);
    }
  }, true);

  window.addEventListener("nmplanner-timeline-changed", () => schedule(false));
  window.addEventListener("nmplanner-calendar-changed", () => schedule(true));
  window.addEventListener("focus", () => schedule(false));
  window.addEventListener("nmplanner-tasks-changed", () => {
    if (document.querySelector(".days-grid")) renderDayPlan();
  });

  const observer = new MutationObserver(() => {
    if (!document.querySelector(".days-grid")) return;
    if (state.week !== selectedWeek() || !document.querySelector("[data-external-calendar-layer]")) schedule(false);
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  setTimeout(() => schedule(true), 1800);
})();
