/* global session, tasks, currentWeek, mondayKey, renderTaskRow */

(() => {
  let scheduled = false;

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renameWeekNavigation() {
    const button = document.querySelector('.nav-button[data-view="week"]');
    if (button && !button.dataset.scheduledLabel) {
      const icon = button.querySelector("span")?.outerHTML || "<span>☷</span>";
      button.innerHTML = `${icon}Scheduled`;
      button.dataset.scheduledLabel = "true";
    }
  }

  function currentWeekPanel() {
    const panels = [...document.querySelectorAll(".workspace > .panel, .workspace section.panel")];
    return panels.find((panel) => panel.querySelector(":scope > .task-list")) || null;
  }

  function categoryMarkup(kind, title, count, body, description) {
    return `
      <section class="week-category week-category-${kind}" data-week-category="${kind}">
        <div class="week-category-heading">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>
          <span class="week-category-count">${count}</span>
        </div>
        <div class="task-list">${body}</div>
      </section>`;
  }

  function emptyCategory(title, body) {
    return `<div class="week-category-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
  }

  function operationalRows() {
    try {
      if (window.NMPlannerActiveTasks?.current) return window.NMPlannerActiveTasks.current();
    } catch (_) {}

    const rows = Array.isArray(tasks) ? tasks : [];
    const parentIds = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
    return rows.filter((task) =>
      task.superseded_by_followup !== true
      && !parentIds.has(task.id)
      && !task.discarded_at
    );
  }

  function followupRow(task) {
    const holder = document.createElement("div");
    holder.innerHTML = renderTaskRow(task);
    const row = holder.firstElementChild;
    const tags = row?.querySelector?.(".task-tags");
    if (tags && !tags.querySelector(".followup-added-tag")) {
      tags.insertAdjacentHTML("afterbegin", '<span class="followup-added-tag">Current follow-up</span>');
    }
    return row?.outerHTML || renderTaskRow(task);
  }

  function organiseWeekList() {
    renameWeekNavigation();
    if (!session || !Array.isArray(tasks)) return;

    const panel = currentWeekPanel();
    if (!panel) return;

    const operational = operationalRows();
    const openStandalone = operational.filter((task) => !task.completed && !task.parent_task_id);
    const openFollowups = operational.filter((task) => !task.completed && Boolean(task.parent_task_id));
    const completed = operational.filter((task) => task.completed);
    const isPastWeek = currentWeek < mondayKey(new Date());

    const signature = JSON.stringify({
      week: currentWeek,
      rows: operational.map((task) => [
        task.id,
        task.parent_task_id || "",
        task.completed,
        task.discarded_at || "",
        task.superseded_by_followup === true,
        task.updated_at || "",
      ]),
      past: isPastWeek,
    });
    if (panel.dataset.organizerSignature === signature) return;
    panel.dataset.organizerSignature = signature;

    panel.innerHTML = `
      <div class="panel-heading scheduled-heading">
        <div>
          <h2>Scheduled</h2>
          <p>Only current operational work is listed here. Open a follow-up to see its full task-history chain.</p>
        </div>
        <button class="secondary-button" data-action="add">＋ Quick add</button>
      </div>
      <div class="week-categories">
        ${categoryMarkup(
          "scheduled",
          "Scheduled",
          openStandalone.length,
          openStandalone.length
            ? openStandalone.map(renderTaskRow).join("")
            : emptyCategory("Nothing waiting here", "Standalone open tasks for this week will appear here."),
          isPastWeek ? "Open standalone work left from this week." : "Standalone tasks still waiting to be completed this week."
        )}
        ${categoryMarkup(
          "followup",
          "Current Follow-ups",
          openFollowups.length,
          openFollowups.length
            ? openFollowups.map(followupRow).join("")
            : emptyCategory("No current follow-up work", "Only the latest actionable follow-up from each task chain appears here."),
          "Only current actionable follow-ups are listed. Earlier steps remain available inside the task-history chain."
        )}
        ${categoryMarkup(
          "completed",
          "Completed",
          completed.length,
          completed.length
            ? completed.map((task) => task.parent_task_id ? followupRow(task) : renderTaskRow(task)).join("")
            : emptyCategory("No completed operational tasks", "Completed current work for this week will appear here."),
          "Completed operational work. Historical superseded steps and discarded tasks are not counted as current work."
        )}
      </div>`;

    if (isPastWeek) {
      panel.querySelectorAll('[data-week-category="scheduled"] .task-row, [data-week-category="followup"] .task-row').forEach((row) => {
        row.classList.add("past-incomplete");
        const tags = row.querySelector(".task-tags");
        if (tags && !tags.querySelector(".incomplete-tag")) {
          tags.insertAdjacentHTML("afterbegin", '<span class="incomplete-tag">Incomplete</span>');
        }
      });
    }
  }

  function scheduleOrganise() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      organiseWeekList();
    });
  }

  const observer = new MutationObserver(scheduleOrganise);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", scheduleOrganise);
  window.addEventListener("nmplanner-analytics-changed", scheduleOrganise);
  window.addEventListener("nmplanner-followup-changed", scheduleOrganise);
  window.addEventListener("nmplanner-task-rescheduled", scheduleOrganise);

  scheduleOrganise();
})();
