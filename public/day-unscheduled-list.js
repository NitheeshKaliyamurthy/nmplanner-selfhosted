/* global tasks */

(() => {
  const state = { scheduled: false };

  function taskFor(id) {
    return Array.isArray(tasks) ? tasks.find((task) => task.id === id) : null;
  }

  function isTimed(task) {
    return Number.isInteger(task?.planned_start_minute);
  }

  function isHistory(task) {
    try {
      if (window.NMPlannerActiveTasks?.isSuperseded) {
        return window.NMPlannerActiveTasks.isSuperseded(task);
      }
    } catch (_) {}
    return task?.superseded_by_followup === true;
  }

  function updateList(card) {
    const list = card.querySelector(".day-task-list-compact[data-timeline-task-list]");
    if (!list) return;

    const buttons = [...list.querySelectorAll(".compact-task[data-id]")];
    let untimedVisible = 0;
    let timedCount = 0;

    for (const button of buttons) {
      const task = taskFor(button.dataset.id);
      if (!task) continue;

      const timed = isTimed(task);
      button.classList.toggle("day-list-time-scheduled", timed);
      if (timed) timedCount += 1;

      const history = isHistory(task);
      if (!timed && !history && !task.completed) untimedVisible += 1;
    }

    let empty = list.querySelector(":scope > [data-unscheduled-empty]");
    if (untimedVisible === 0) {
      if (!empty) {
        empty = document.createElement("div");
        empty.dataset.unscheduledEmpty = "";
        empty.className = "day-unscheduled-empty";
        list.append(empty);
      }
      const text = timedCount
        ? "All tasks time-scheduled · drop a calendar task here to remove its time"
        : "No unscheduled tasks";
      if (empty.textContent !== text) empty.textContent = text;
    } else {
      empty?.remove();
    }

    list.dataset.unscheduledCount = String(untimedVisible);
  }

  function update() {
    document.querySelectorAll(".days-grid .day-card").forEach(updateList);
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      update();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("nmplanner-timeline-changed", schedule);
  window.addEventListener("nmplanner-task-rescheduled", schedule);
  window.addEventListener("nmplanner-followup-changed", schedule);
  window.addEventListener("nmplanner-analytics-changed", schedule);
  window.addEventListener("focus", schedule);

  setTimeout(schedule, 1300);
})();
