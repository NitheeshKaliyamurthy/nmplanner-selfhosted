/* global client, session, tasks, editingTask */

(() => {
  let schemaReady = null;
  let schemaChecking = false;
  let scheduled = false;

  function numericRank(task) {
    const value = Number(task?.day_rank);
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
  }

  async function checkSchema() {
    if (schemaReady !== null) return schemaReady;
    if (!session || !client || schemaChecking) return false;
    schemaChecking = true;
    try {
      const { error } = await client
        .from("tasks")
        .select("day_rank")
        .eq("user_id", session.user.id)
        .limit(1);
      schemaReady = !error;
      return schemaReady;
    } finally {
      schemaChecking = false;
    }
  }

  async function installRankField() {
    const form = document.querySelector("#task-form");
    if (!form || form.querySelector('[name="day_rank"]')) return;
    if (!await checkSchema()) return;

    const grid = form.querySelector(".form-grid");
    if (!grid) return;

    const plannedDay = form.querySelector('[name="day"]')?.closest("label");
    const label = document.createElement("label");
    label.className = "field day-rank-field";
    label.innerHTML = `
      <span>Day order</span>
      <input name="day_rank" type="number" min="1" max="99" step="1" inputmode="numeric" placeholder="Optional, e.g. 1">
      <small>1 runs first, then 2, 3… Leave blank to keep the normal order.</small>`;

    if (plannedDay?.nextSibling) grid.insertBefore(label, plannedDay.nextSibling);
    else grid.append(label);

    const input = label.querySelector('input[name="day_rank"]');
    const rank = numericRank(editingTask);
    if (input && rank !== null) input.value = String(rank);
  }

  function applyRankBadge(button, rank) {
    let badge = button.querySelector(":scope > .day-rank-badge");
    if (rank === null) {
      badge?.remove();
      button.removeAttribute("data-day-rank");
      return;
    }

    button.dataset.dayRank = String(rank);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "day-rank-badge";
      button.prepend(badge);
    }
    badge.textContent = String(rank);
    badge.setAttribute("aria-label", `Day order ${rank}`);
  }

  function organiseDayCards() {
    if (!Array.isArray(tasks)) return;

    const originalIndex = new Map(tasks.map((task, index) => [task.id, index]));
    const taskMap = new Map(tasks.map((task) => [task.id, task]));

    document.querySelectorAll(".days-grid .day-card").forEach((card) => {
      const body = card.querySelector(":scope > div");
      if (!body) return;

      const buttons = [...body.querySelectorAll(":scope > .compact-task[data-id]")];
      if (!buttons.length) return;

      const sorted = [...buttons].sort((left, right) => {
        const leftTask = taskMap.get(left.dataset.id);
        const rightTask = taskMap.get(right.dataset.id);
        const leftRank = numericRank(leftTask);
        const rightRank = numericRank(rightTask);

        if (leftRank !== null && rightRank !== null) {
          return leftRank - rightRank || (originalIndex.get(left.dataset.id) ?? 0) - (originalIndex.get(right.dataset.id) ?? 0);
        }
        if (leftRank !== null) return -1;
        if (rightRank !== null) return 1;
        return (originalIndex.get(left.dataset.id) ?? 0) - (originalIndex.get(right.dataset.id) ?? 0);
      });

      const signature = sorted.map((button) => {
        const task = taskMap.get(button.dataset.id);
        return `${button.dataset.id}:${numericRank(task) ?? ""}`;
      }).join("|");

      if (body.dataset.dayRankSignature !== signature) {
        body.dataset.dayRankSignature = signature;
        for (const button of sorted) body.append(button);
      }

      for (const button of sorted) {
        applyRankBadge(button, numericRank(taskMap.get(button.dataset.id)));
      }
    });
  }

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installRankField().catch(() => {});
      organiseDayCards();
    });
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    if (schemaReady === false) schemaReady = null;
    scheduleUpdate();
  });

  scheduleUpdate();
})();
