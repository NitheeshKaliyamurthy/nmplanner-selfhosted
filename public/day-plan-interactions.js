/* global client, session, tasks, currentWeek, loadTasks, notify */

(() => {
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
    draggingId: null,
    lastDragEnd: 0,
    scheduled: false,
    pendingMove: null,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseDate(value) {
    const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    return addDays(task.week, task.day);
  }

  function targetDateForDay(day) {
    return addDays(currentWeek, day);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(parseDate(value));
  }

  function taskFor(id) {
    return Array.isArray(tasks) ? tasks.find((task) => task.id === id) : null;
  }

  function clearDropStyles() {
    document.querySelectorAll(".days-grid .day-card.day-drag-over").forEach((card) => card.classList.remove("day-drag-over"));
    document.querySelectorAll(".days-grid .compact-task.day-dragging").forEach((button) => {
      button.classList.remove("day-dragging");
      button.setAttribute("aria-grabbed", "false");
    });
  }

  function decorateDayPlan() {
    if (!Array.isArray(tasks)) return;
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const cards = [...document.querySelectorAll(".days-grid .day-card")];

    cards.forEach((card, dayIndex) => {
      card.dataset.dayIndex = String(dayIndex);
      const body = card.querySelector(":scope > div");
      if (body) body.dataset.dayDropTarget = String(dayIndex);

      card.querySelectorAll(".compact-task[data-id]").forEach((button) => {
        const task = taskMap.get(button.dataset.id);
        if (!task) return;
        const quadrant = ["q1", "q2", "q3", "q4"].includes(task.quadrant) ? task.quadrant : "none";
        button.draggable = true;
        button.dataset.dayQuadrant = quadrant;
        button.dataset.quadrantLabel = quadrant === "none" ? "–" : quadrant.toUpperCase();
        button.setAttribute("aria-grabbed", "false");
        button.title = "Drag to another day and record the rescheduling reason, or click to edit";
      });
    });
  }

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      decorateDayPlan();
    });
  }

  async function finishMove(message) {
    if (typeof loadTasks === "function") await loadTasks();
    window.dispatchEvent(new Event("nmplanner-task-rescheduled"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    if (typeof notify === "function") notify(message, "success");
    scheduleDecorate();
  }

  function reasonDialog() {
    return document.querySelector("#day-drag-reason-dialog");
  }

  function closeReasonDialog() {
    const dialog = reasonDialog();
    if (dialog?.open) dialog.close();
    dialog?.remove();
    state.pendingMove = null;
  }

  function showReasonDialog(task, targetDay) {
    closeReasonDialog();
    const fromDate = plannedDate(task);
    const toDate = targetDateForDay(targetDay);
    state.pendingMove = { task, targetDay, toDate };

    const dialog = document.createElement("dialog");
    dialog.id = "day-drag-reason-dialog";
    dialog.className = "day-drag-reason-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="day-drag-reason-card">
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">RESCHEDULE TASK</p>
            <h2>Record why this task is moving</h2>
          </div>
          <button type="button" class="icon-button" data-day-drag-action="cancel">×</button>
        </div>
        <div class="day-drag-move-summary">
          <strong>${escapeHtml(task.title)}</strong>
          <span>${escapeHtml(formatDate(fromDate))} → ${escapeHtml(formatDate(toDate))}</span>
        </div>
        <label class="field wide">
          <span>Why are you rescheduling this task?</span>
          <select data-day-drag-reason>
            <option value="">Choose a reason…</option>
            ${REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}
          </select>
        </label>
        <div class="form-error" data-day-drag-error hidden></div>
        <div class="dialog-actions">
          <div></div>
          <div>
            <button type="button" class="secondary-button" data-day-drag-action="cancel">Cancel</button>
            <button type="button" class="primary-button" data-day-drag-action="confirm">Move task</button>
          </div>
        </div>
      </form>`;

    document.body.append(dialog);
    dialog.showModal();
  }

  function showReasonError(message) {
    const box = reasonDialog()?.querySelector("[data-day-drag-error]");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function setReasonBusy(busy) {
    reasonDialog()?.querySelectorAll("[data-day-drag-action]").forEach((button) => {
      button.disabled = busy;
    });
  }

  async function confirmReasonMove() {
    const pending = state.pendingMove;
    const dialog = reasonDialog();
    if (!pending || !dialog) return;
    const reason = dialog.querySelector("[data-day-drag-reason]")?.value || "";
    if (!reason) return showReasonError("Choose a reason so this reschedule is included in your workflow analysis.");

    setReasonBusy(true);
    const { error } = await client.rpc("reschedule_planned_task", {
      p_task_id: pending.task.id,
      p_reason: reason,
      p_target_date: pending.toDate,
    });
    setReasonBusy(false);

    if (error) {
      const capacityError = /daily capacity exceeded|Q1 daily capacity|Q2 daily capacity/i.test(error.message || "");
      return showReasonError(capacityError ? error.message : `The task could not be moved: ${error.message}`);
    }

    const destination = pending.toDate;
    closeReasonDialog();
    await finishMove(`Task moved to ${formatDate(destination)} and the rescheduling reason was recorded.`);
  }

  async function handleDrop(taskId, targetDay) {
    if (!session || !client) return;
    const task = taskFor(taskId);
    if (!task || !Number.isInteger(targetDay) || targetDay < 0 || targetDay > 6) return;
    if (task.day === targetDay && task.week === currentWeek) return;

    const targetDate = targetDateForDay(targetDay);
    const today = dateKey(new Date());
    if (targetDate < today) {
      if (typeof notify === "function") notify("A task cannot be dragged into a past day. Choose today or a later day.", "error");
      return;
    }

    // Every drag-and-drop move is a deliberate reschedule, so always record why.
    showReasonDialog(task, targetDay);
  }

  document.addEventListener("dragstart", (event) => {
    const button = event.target.closest?.(".days-grid .compact-task[data-id]");
    if (!button) return;
    state.draggingId = button.dataset.id;
    button.classList.add("day-dragging");
    button.setAttribute("aria-grabbed", "true");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.draggingId);
    }
  });

  document.addEventListener("dragover", (event) => {
    const card = event.target.closest?.(".days-grid .day-card[data-day-index]");
    if (!card || !state.draggingId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".days-grid .day-card.day-drag-over").forEach((other) => {
      if (other !== card) other.classList.remove("day-drag-over");
    });
    card.classList.add("day-drag-over");
  });

  document.addEventListener("dragleave", (event) => {
    const card = event.target.closest?.(".days-grid .day-card[data-day-index]");
    if (!card) return;
    const next = event.relatedTarget;
    if (!next || !card.contains(next)) card.classList.remove("day-drag-over");
  });

  document.addEventListener("drop", (event) => {
    const card = event.target.closest?.(".days-grid .day-card[data-day-index]");
    if (!card) return;
    event.preventDefault();
    const taskId = state.draggingId || event.dataTransfer?.getData("text/plain");
    const targetDay = Number(card.dataset.dayIndex);
    clearDropStyles();
    state.lastDragEnd = Date.now();
    state.draggingId = null;
    handleDrop(taskId, targetDay).catch((error) => {
      if (typeof notify === "function") notify(error.message, "error");
    });
  });

  document.addEventListener("dragend", () => {
    clearDropStyles();
    state.lastDragEnd = Date.now();
    state.draggingId = null;
  });

  document.addEventListener("click", (event) => {
    if (Date.now() - state.lastDragEnd < 350 && event.target.closest?.(".days-grid .compact-task[data-id]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const actionButton = event.target.closest?.("[data-day-drag-action]");
    if (!actionButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (actionButton.dataset.dayDragAction === "cancel") closeReasonDialog();
    else if (actionButton.dataset.dayDragAction === "confirm") {
      confirmReasonMove().catch((error) => showReasonError(error.message));
    }
  }, true);

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", scheduleDecorate);
  scheduleDecorate();
})();
