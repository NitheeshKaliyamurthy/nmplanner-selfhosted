/* global tasks */

(() => {
  const state = { scheduled: false };

  function currentTasks() {
    return Array.isArray(tasks) ? tasks : [];
  }

  function parentIds(rows = currentTasks()) {
    return new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
  }

  function isSuperseded(task, parents = parentIds()) {
    if (!task) return false;
    return task.superseded_by_followup === true || parents.has(task.id);
  }

  function isDiscarded(task) {
    return Boolean(task?.discarded_at);
  }

  function isOperational(task, parents = parentIds()) {
    return Boolean(task) && !isSuperseded(task, parents) && !isDiscarded(task);
  }

  // Operational includes completed work because completed tasks remain part of
  // the day's planned-capacity history. Open is the actionable subset.
  function operationalTasks(rows = currentTasks()) {
    const parents = parentIds(rows);
    return rows.filter((task) => isOperational(task, parents));
  }

  function openTasks(rows = currentTasks()) {
    return operationalTasks(rows).filter((task) => !task.completed);
  }

  function taskById(id) {
    return currentTasks().find((task) => task.id === id) || null;
  }

  function elementTaskId(element) {
    return element?.dataset?.id
      || element?.querySelector?.("[data-id]")?.dataset?.id
      || "";
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function patchTaskElements() {
    const parents = parentIds();

    document.querySelectorAll(".task-row").forEach((row) => {
      const task = taskById(elementTaskId(row));
      if (!task) return;
      const hiddenFromOperationalViews = !isOperational(task, parents);
      row.hidden = hiddenFromOperationalViews;
      row.dataset.followupHistory = hiddenFromOperationalViews ? "true" : "false";
    });

    document.querySelectorAll(".compact-task[data-id]").forEach((button) => {
      const task = taskById(button.dataset.id);
      if (!task) return;
      const hiddenFromOperationalViews = !isOperational(task, parents);
      button.hidden = hiddenFromOperationalViews;
      button.dataset.followupHistory = hiddenFromOperationalViews ? "true" : "false";
    });

    document.querySelectorAll(".day-timeline-task[data-id]").forEach((block) => {
      const task = taskById(block.dataset.id);
      if (!task) return;
      block.hidden = !isOperational(task, parents) || task.completed;
    });

    document.querySelectorAll(".followup-family-root").forEach((holder) => {
      const task = taskById(elementTaskId(holder));
      holder.hidden = Boolean(task && !isOperational(task, parents));
    });

    document.querySelectorAll(".followup-family-child").forEach((holder) => {
      const id = holder.dataset.familyChild || elementTaskId(holder);
      const task = taskById(id);
      if (!task) return;
      holder.hidden = !isOperational(task, parents);
    });

    // The family context is available inside the task editor; it is not another
    // actionable row in the week list.
    document.querySelectorAll(".followup-family-context").forEach((context) => {
      context.hidden = true;
    });

    document.querySelectorAll(".followup-family").forEach((family) => {
      const visibleRows = [...family.querySelectorAll(".task-row")].filter((row) => !row.hidden);
      family.hidden = visibleRows.length === 0;
      const summary = family.querySelector(".followup-family-summary");
      const openVisible = visibleRows.filter((row) => !row.classList.contains("completed")).length;
      const text = openVisible === 1
        ? "Current follow-up"
        : openVisible > 1
          ? `${openVisible} active follow-up branches`
          : "Follow-up completed";
      setText(summary, text);
    });
  }

  function patchSummary() {
    // In Insights, the weekly execution module owns the first/fourth summary
    // metrics so they describe committed work and on-plan completion rather than
    // the live operational subset. Other planner views keep the operational view.
    if (
      document.querySelector(".insight-layout")
      && document.querySelector('[data-analytics-dashboard][data-execution-version="1"]')
    ) return;

    const operational = operationalTasks();
    const open = operational.filter((task) => !task.completed);
    const done = operational.filter((task) => task.completed).length;
    const cards = document.querySelectorAll(".summary-grid article");
    if (cards.length < 4) return;

    setText(cards[0].querySelector("strong"), String(open.length));
    setText(cards[0].querySelector("small"), "Open tasks this week");
    setText(cards[3].querySelector("strong"), `${operational.length ? Math.round(done / operational.length * 100) : 0}%`);
  }

  function patchMatrix() {
    const open = openTasks();
    const quadrants = ["q1", "q2", "q3", "q4"];
    document.querySelectorAll(".matrix-grid .quadrant-card").forEach((card, index) => {
      const key = quadrants[index];
      if (!key) return;
      const count = open.filter((task) => task.quadrant === key).length;
      setText(card.querySelector("header > strong"), String(count));
    });
  }

  function patchCoreInsights() {
    const operational = operationalTasks();
    const completed = operational.filter((task) => task.completed);
    const quadrantKeys = ["q1", "q2", "q3", "q4"];

    document.querySelectorAll(".bars > div").forEach((row, index) => {
      const key = quadrantKeys[index];
      if (!key) return;
      const count = operational.filter((task) => task.quadrant === key).length;
      const percent = operational.length ? Math.round(count / operational.length * 100) : 0;
      setText(row.querySelector("span > strong"), `${percent}%`);
      const em = row.querySelector("i > em");
      if (em && em.style.width !== `${percent}%`) em.style.width = `${percent}%`;
    });

    const ring = document.querySelector(".score-ring");
    if (ring) {
      const completion = operational.length ? Math.round(completed.length / operational.length * 100) : 0;
      const score = `${completion * 3.6}deg`;
      if (ring.style.getPropertyValue("--score") !== score) ring.style.setProperty("--score", score);
      setText(ring.querySelector("strong"), `${completion}%`);
    }
  }

  function patchWeekCategories() {
    const operational = operationalTasks();
    const openFollowups = operational.filter((task) => !task.completed && Boolean(task.parent_task_id));
    const followupCategory = document.querySelector('[data-week-category="followup"]');
    setText(followupCategory?.querySelector(".week-category-count"), String(openFollowups.length));

    const completedSummary = document.querySelector(".completed-section > summary");
    if (completedSummary) {
      const completed = operational.filter((task) => task.completed).length;
      setText(completedSummary, `${completed} completed`);
    }
  }

  function patch() {
    patchTaskElements();
    patchSummary();
    patchMatrix();
    patchCoreInsights();
    patchWeekCategories();
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      patch();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("nmplanner-followup-changed", schedule);
  window.addEventListener("nmplanner-analytics-changed", schedule);
  window.addEventListener("focus", schedule);

  window.NMPlannerActiveTasks = {
    // Backward-compatible name: current() means all operational rows, including
    // completed planned work used by capacity summaries.
    current: operationalTasks,
    open: openTasks,
    isOperational: (task) => isOperational(task, parentIds()),
    isSuperseded: (task) => !isOperational(task, parentIds()),
  };

  schedule();
})();
