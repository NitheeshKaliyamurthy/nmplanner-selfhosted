/* global editingTask */

(() => {
  const overtimeClient = window.NMPlannerRuntime?.client;
  if (!overtimeClient) return;

  const state = {
    session: null,
    rows: new Map(),
    week: "",
    loadedAt: 0,
    loading: null,
    schemaReady: true,
    scheduled: false,
  };

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function currentEditingTask() {
    try {
      return editingTask || null;
    } catch (_) {
      return null;
    }
  }

  function selectedWeek() {
    return document.querySelector("#week-picker")?.value || currentEditingTask()?.week || "";
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await overtimeClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function load() {
    const week = selectedWeek();
    const appState = window.NMPlannerState;
    if (!week || !appState?.isWeekLoaded?.() || appState.getWeek?.() !== week) return false;

    const rows = appState.getTasks?.() || [];
    state.schemaReady = rows.every((row) =>
      Object.prototype.hasOwnProperty.call(row, "capacity_override")
      || Object.prototype.hasOwnProperty.call(row, "overtime_minutes")
      || Object.prototype.hasOwnProperty.call(row, "capacity_override_at")
    );
    state.rows = new Map(rows.map((row) => [String(row.id), row]));
    state.week = week;
    state.loadedAt = Date.now();
    return true;
  }

  function taskState(id) {
    const task = state.rows.get(String(id || ""));
    if (task) return task;
    const editing = currentEditingTask();
    return editing?.id === id ? editing : null;
  }

  function overtimeActive(task) {
    return Boolean(task?.capacity_override && Number(task?.overtime_minutes || 0) > 0);
  }

  function syncEditorState(form, task) {
    if (!form) return;
    const active = overtimeActive(task);
    if (state.schemaReady) form.dataset.overtimeExisting = active ? "true" : "false";

    const option = form.querySelector("[data-overtime-option]");
    const checkbox = option?.querySelector('input[name="capacity_override"]');
    if (!option || !checkbox) return;

    if (active) {
      option.hidden = false;
      if (!checkbox.checked) checkbox.checked = true;
      option.classList.add("active");
    }

    let recorded = option.querySelector("[data-overtime-recorded]");
    if (active) {
      if (!recorded) {
        recorded = document.createElement("em");
        recorded.dataset.overtimeRecorded = "";
        option.querySelector("span")?.append(recorded);
      }
      recorded.textContent = `Currently recorded as ${formatMinutes(task.overtime_minutes)} overtime.`;
    } else {
      recorded?.remove();
    }
  }

  function installTaskOption() {
    const form = document.querySelector("#task-form");
    if (!form) return;
    const taskId = form.querySelector('[data-action="delete"][data-id]')?.dataset.id || currentEditingTask()?.id || "";
    const task = taskState(taskId);

    let row = form.querySelector("[data-overtime-option]");
    if (!row) {
      row = document.createElement("label");
      row.className = "overtime-option";
      row.dataset.overtimeOption = "";
      row.hidden = !overtimeActive(task);
      row.innerHTML = `
        <input type="checkbox" name="capacity_override">
        <span>
          <strong>Urgent / Overtime</strong>
          <small>Use this only when the work genuinely must be accepted above normal Q1/Q2 or Primary Work capacity. The excess is recorded for Weekly Insights.</small>
        </span>`;
      const error = form.querySelector("#form-error");
      form.insertBefore(row, error || form.querySelector(".dialog-actions"));
      row.querySelector("input")?.addEventListener("change", (event) => {
        row.classList.toggle("active", event.target.checked);
      });
    }

    syncEditorState(form, task);
  }

  function markerFor(task) {
    if (!overtimeActive(task)) return "";
    return `OT +${formatMinutes(task.overtime_minutes)}`;
  }

  function decorateTaskRows() {
    document.querySelectorAll(".task-row").forEach((row) => {
      const id = row.querySelector("[data-id]")?.dataset.id;
      const label = markerFor(taskState(id));
      let marker = row.querySelector("[data-overtime-tag]");
      if (!label) {
        marker?.remove();
        return;
      }
      const tags = row.querySelector(".task-tags");
      if (!tags) return;
      if (!marker) {
        marker = document.createElement("span");
        marker.className = "overtime-tag";
        marker.dataset.overtimeTag = "";
        tags.prepend(marker);
      }
      if (marker.textContent !== label) marker.textContent = label;
    });

    document.querySelectorAll(".compact-task[data-id]").forEach((button) => {
      const label = markerFor(taskState(button.dataset.id));
      let marker = button.querySelector("[data-overtime-mini]");
      if (!label) {
        marker?.remove();
        return;
      }
      if (!marker) {
        marker = document.createElement("em");
        marker.className = "overtime-mini";
        marker.dataset.overtimeMini = "";
        button.append(marker);
      }
      if (marker.textContent !== label) marker.textContent = label;
    });
  }

  function paint() {
    installTaskOption();
    decorateTaskRows();
  }

  function schedule(force = false) {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      load(force).then(paint).catch(() => paint());
    });
  }

  function invalidate() {
    state.loadedAt = 0;
    schedule(true);
  }

  const observer = new MutationObserver(() => schedule(false));
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  window.addEventListener("focus", () => schedule(false));
  window.addEventListener("nmplanner-tasks-changed", () => schedule(false));
  window.addEventListener("nmplanner-analytics-changed", () => schedule(false));
  window.addEventListener("nmplanner-followup-changed", () => schedule(false));
  document.addEventListener("change", (event) => {
    if (event.target?.id === "week-picker") invalidate();
  });
  schedule(true);
})();
