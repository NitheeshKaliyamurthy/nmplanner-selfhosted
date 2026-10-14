/* global client, session, tasks, loadTasks, notify */

(() => {
  const QUADRANTS = [
    ["q1", "Q1 · Urgent + Important"],
    ["q2", "Q2 · Important + Not urgent"],
    ["q3", "Q3 · Urgent + Not important"],
    ["q4", "Q4 · Not urgent + Not important"],
  ];

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
    checking: false,
    candidates: [],
    currentIndex: 0,
    queueLoaded: false,
    boundaryTimer: null,
    retryTimer: null,
    bannerScheduled: false,
    candidatesLoadedAt: 0,
    candidatesLoading: null,
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

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(parseDate(value));
  }

  function formatMinutes(total) {
    const minutes = Number(total || 0);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  async function checkSchema() {
    if (!session || !client) return false;
    if (state.schemaReady === null) state.schemaReady = true;
    return state.schemaReady;
  }

  function isEligible(task, now = new Date()) {
    if (task?.completed || task?.superseded_by_followup === true || task?.discarded_at) return false;
    const planned = plannedDate(task);
    if (!planned) return false;
    const today = dateKey(now);
    if (planned < today) return true;
    return planned === today && now.getHours() >= 18;
  }

  function bannerElement() {
    return document.querySelector("#evening-review-banner");
  }

  function bannerAnchor() {
    return document.querySelector(".workspace .summary-grid");
  }

  function renderReviewBanner() {
    const anchor = bannerAnchor();
    const existing = bannerElement();
    if (!anchor) {
      existing?.remove();
      return;
    }

    if (!state.queueLoaded) {
      existing?.remove();
      return;
    }

    const eligible = state.candidates;
    if (!eligible.length) {
      existing?.remove();
      return;
    }

    const today = dateKey(new Date());
    const overdue = eligible.filter((task) => plannedDate(task) < today).length;
    const count = eligible.length;
    const headline = `${count} unfinished task${count === 1 ? "" : "s"} need review`;
    const detail = overdue
      ? `${overdue} overdue task${overdue === 1 ? " is" : "s are"} still assigned to an earlier day.`
      : "Mark complete, move unfinished work with a reason, or discard it as not completed.";
    const signature = `${today}|${count}|${overdue}|${eligible.map((task) => task.id).sort().join(",")}`;

    let banner = existing;
    if (!banner) {
      banner = document.createElement("section");
      banner.id = "evening-review-banner";
      banner.className = "evening-review-banner";
      anchor.insertAdjacentElement("afterend", banner);
    }

    if (banner.dataset.reviewSignature === signature) return;
    banner.dataset.reviewSignature = signature;
    banner.innerHTML = `
      <div class="evening-review-banner-copy">
        <span class="evening-review-banner-kicker">END-OF-DAY REVIEW</span>
        <strong>${escapeHtml(headline)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
      <button type="button" class="primary-button" data-review-action="open">Review unfinished tasks</button>`;
  }

  function scheduleBanner() {
    if (state.bannerScheduled) return;
    state.bannerScheduled = true;
    requestAnimationFrame(() => {
      state.bannerScheduled = false;
      renderReviewBanner();
    });
  }

  function candidateQuery(selectFields) {
    return client
      .from("tasks")
      .select(selectFields)
      .eq("user_id", session.user.id)
      .eq("completed", false)
      .not("day", "is", null)
      .order("week", { ascending: true })
      .order("day", { ascending: true });
  }

  async function loadCandidates(force = false) {
    if (!session || !await checkSchema()) {
      state.queueLoaded = false;
      return [];
    }
    if (!force && state.queueLoaded && Date.now() - state.candidatesLoadedAt < 300000) {
      return state.candidates;
    }
    if (state.candidatesLoading) return state.candidatesLoading;

    state.candidatesLoading = (async () => {
      let result = await candidateQuery("id,title,week,day,quadrant,minutes,area,due,day_rank,parent_task_id,superseded_by_followup,discarded_at");

    // Compatibility while migration 016 is waiting to be applied.
    if (result.error && /discarded_at|schema cache|column/i.test(result.error.message || "")) {
      result = await candidateQuery("id,title,week,day,quadrant,minutes,area,due,day_rank,parent_task_id,superseded_by_followup");
    }
    if (result.error && /superseded_by_followup|schema cache|column/i.test(result.error.message || "")) {
      result = await candidateQuery("id,title,week,day,quadrant,minutes,area,due,day_rank,parent_task_id");
    }

    if (result.error) {
      state.schemaError = result.error.message || "";
      state.queueLoaded = false;
      return [];
    }

      state.queueLoaded = true;
      state.candidatesLoadedAt = Date.now();
      return (result.data || []).filter((task) => isEligible(task));
    })();

    try {
      return await state.candidatesLoading;
    } finally {
      state.candidatesLoading = null;
    }
  }

  function dialogElement() {
    return document.querySelector("#evening-review-dialog");
  }

  function removeDialog() {
    const dialog = dialogElement();
    if (dialog?.open) dialog.close();
    dialog?.remove();
  }

  function minimumMoveDate(task, now = new Date()) {
    const today = dateKey(now);
    const planned = plannedDate(task);
    // An overdue task reviewed before 18:00 can be deliberately brought into
    // today. At/after 18:00 every move must leave today's queue, so use tomorrow.
    if (planned < today && now.getHours() < 18) return today;
    return addDays(today, 1);
  }

  function normaliseCurrentIndex() {
    if (!state.candidates.length) {
      state.currentIndex = 0;
      return;
    }
    state.currentIndex = Math.max(0, Math.min(state.currentIndex, state.candidates.length - 1));
  }

  function renderCurrent() {
    removeDialog();
    if (!state.candidates.length) return;

    normaliseCurrentIndex();
    const task = state.candidates[state.currentIndex];
    const currentDate = plannedDate(task);
    const minDate = minimumMoveDate(task);
    const position = state.currentIndex + 1;
    const total = state.candidates.length;
    const dialog = document.createElement("dialog");
    dialog.id = "evening-review-dialog";
    dialog.className = "evening-review-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="evening-review-card">
        <div class="evening-review-heading">
          <div>
            <p class="eyebrow">END-OF-DAY REVIEW</p>
            <h2>What should happen to this unfinished task?</h2>
          </div>
          <span class="evening-review-progress">${position} of ${total}</span>
        </div>

        <div class="evening-review-task">
          <strong>${escapeHtml(task.title)}</strong>
          <span>${escapeHtml(task.area || "Uncategorised")} · ${formatDate(currentDate)} · ${task.quadrant ? task.quadrant.toUpperCase() : "No quadrant"} · ${formatMinutes(task.minutes)}</span>
        </div>

        <div class="evening-review-nav" aria-label="Review queue navigation">
          <button type="button" class="secondary-button" data-review-action="previous" ${state.currentIndex === 0 ? "disabled" : ""}>‹ Previous</button>
          <span>Task ${position} of ${total}</span>
          <button type="button" class="secondary-button" data-review-action="next" ${state.currentIndex >= total - 1 ? "disabled" : ""}>Next ›</button>
        </div>

        <label class="field wide">
          <span>Why was this not completed as planned?</span>
          <select data-review-reason>
            <option value="">Choose a reason…</option>
            ${REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}
          </select>
        </label>

        <section class="evening-review-move-settings" aria-label="Move settings">
          <div class="evening-review-move-grid">
            <label class="field">
              <span>Priority on new day</span>
              <select data-review-quadrant>
                <option value="" ${task.quadrant ? "" : "selected"}>Choose Q1-Q4…</option>
                ${QUADRANTS.map(([value, label]) => `<option value="${value}" ${task.quadrant === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
              </select>
              <small>You can deliberately change the task from Q1-Q4 while moving it.</small>
            </label>

            <label class="field evening-review-date">
              <span>Move to</span>
              <input type="date" data-review-date min="${minDate}" value="${minDate}">
              <small>Moving resets the Day order so you can rank it again on the new day.</small>
            </label>
          </div>

          <label class="overtime-option evening-review-overtime">
            <input type="checkbox" data-review-overtime>
            <span>
              <strong>Urgent / Overtime</strong>
              <small>Allow this move even if the target day exceeds normal Q1/Q2 or Primary Work capacity. If the task still fits, no overtime will be recorded.</small>
              <em>Use this only when the work genuinely needs to sit above your planned capacity.</em>
            </span>
          </label>
        </section>

        <div class="evening-review-error" data-review-error hidden></div>

        <div class="evening-review-actions">
          <button type="button" class="secondary-button" data-review-action="later">Review later</button>
          <div>
            <button type="button" class="review-complete-button" data-review-action="complete">Mark complete</button>
            <button type="button" class="danger-button" data-review-action="discard">Discard as not completed</button>
            <button type="button" class="primary-button" data-review-action="move">Move task</button>
          </div>
        </div>
      </form>`;

    document.body.append(dialog);
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.showModal();
  }

  function showError(message) {
    const box = dialogElement()?.querySelector("[data-review-error]");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function setBusy(busy) {
    dialogElement()?.querySelectorAll("[data-review-action]").forEach((button) => {
      button.disabled = busy;
    });
  }

  function moveWithinQueue(direction) {
    if (!state.candidates.length) return;
    const nextIndex = state.currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= state.candidates.length) return;
    state.currentIndex = nextIndex;
    renderCurrent();
  }

  function reviewLater() {
    if (!state.candidates.length) return;
    state.currentIndex = (state.currentIndex + 1) % state.candidates.length;
    renderCurrent();
  }

  async function openReview() {
    if (!session) {
      if (typeof notify === "function") notify("Your session is still loading. Try the review again in a moment.", "error");
      return;
    }

    state.schemaReady = null;
    state.queueLoaded = false;
    state.candidates = await loadCandidates(true);
    state.currentIndex = 0;
    if (state.schemaReady === false) {
      if (typeof notify === "function") notify(`End-of-day review is not enabled in Supabase yet. ${state.schemaError || "Run database/008_daily_review.sql."}`, "error");
      return;
    }
    if (!state.candidates.length) {
      if (typeof notify === "function") notify(state.schemaError || "There are no unfinished dated tasks requiring review.", "error");
      scheduleBanner();
      return;
    }
    scheduleBanner();
    renderCurrent();
  }

  async function refreshAfterResolution(message) {
    if (typeof loadTasks === "function") await loadTasks();
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    if (typeof notify === "function") notify(message, "success");

    const previousIndex = state.currentIndex;
    state.candidates = await loadCandidates(true);
    state.currentIndex = Math.min(previousIndex, Math.max(0, state.candidates.length - 1));
    scheduleBanner();
    if (state.candidates.length) renderCurrent();
    else removeDialog();
  }

  async function completeCurrentTask() {
    normaliseCurrentIndex();
    const task = state.candidates[state.currentIndex];
    if (!task) return;

    setBusy(true);
    const { error } = await client
      .from("tasks")
      .update({ completed: true })
      .eq("id", task.id)
      .eq("user_id", session.user.id);
    setBusy(false);

    if (error) return showError(`The task could not be completed: ${error.message}`);
    await refreshAfterResolution("Task marked complete.");
  }

  async function performReview(action) {
    normaliseCurrentIndex();
    const task = state.candidates[state.currentIndex];
    const dialog = dialogElement();
    if (!task || !dialog) return;

    const reason = dialog.querySelector("[data-review-reason]")?.value || "";
    if (!reason) return showError("Choose a reason so this outcome can be included in your workflow analysis.");

    let targetDate = null;
    let targetQuadrant = task.quadrant || null;
    let capacityOverride = false;
    if (action === "moved") {
      targetDate = dialog.querySelector("[data-review-date]")?.value || "";
      targetQuadrant = dialog.querySelector("[data-review-quadrant]")?.value || null;
      capacityOverride = Boolean(dialog.querySelector("[data-review-overtime]")?.checked);
      if (!targetDate) return showError("Choose the new planned date.");
      if (!targetQuadrant) return showError("Choose the Q1-Q4 priority for the new day.");
      const minimum = minimumMoveDate(task);
      if (targetDate < minimum) return showError(`Choose ${formatDate(minimum)} or a later date.`);
    }

    if (action === "discarded" && !window.confirm(`Discard “${task.title}” as not completed? It will leave the active planner but remain in your review history.`)) return;

    setBusy(true);
    const rpcArgs = action === "moved"
      ? {
          p_task_id: task.id,
          p_action: action,
          p_reason: reason,
          p_target_date: targetDate || null,
          p_quadrant: targetQuadrant,
          p_capacity_override: capacityOverride,
        }
      : {
          p_task_id: task.id,
          p_action: action,
          p_reason: reason,
          p_target_date: null,
        };
    const { data: result, error } = await client.rpc("review_unfinished_task", rpcArgs);
    setBusy(false);

    if (error) {
      const message = error.message || "";
      const missingMigration = /review_unfinished_task|function .* does not exist|schema cache/i.test(message)
        && /p_capacity_override|p_quadrant|review_unfinished_task/i.test(message);
      if (missingMigration) {
        return showError("Run database/025_end_of_day_move_priority_overtime.sql in Supabase to enable priority changes and Urgent / Overtime during End-of-Day moves.");
      }

      const capacityError = /daily capacity exceeded|weekly capacity exceeded|Q1 daily capacity|Q2 daily capacity|primary work|normal .*capacity/i.test(message);
      if (capacityError && action === "moved") {
        const overtime = dialog.querySelector("[data-review-overtime]");
        overtime?.focus();
        overtime?.closest(".overtime-option")?.classList.add("attention");
        return showError(`${message} Tick “Urgent / Overtime” below and try Move task again, or choose a different date/priority.`);
      }
      return showError(`The review could not be saved: ${message}`);
    }

    const movedMessage = action === "moved"
      ? result?.capacity_override && Number(result?.overtime_minutes || 0) > 0
        ? `Task moved to ${targetQuadrant.toUpperCase()} with ${formatMinutes(result.overtime_minutes)} recorded as Urgent / Overtime.`
        : `Task moved to ${targetQuadrant.toUpperCase()} and review reason recorded.`
      : "Task discarded as not completed and recorded in review history.";
    await refreshAfterResolution(movedMessage);
  }

  async function checkForReview() {
    if (state.checking || !session) {
      scheduleBanner();
      return;
    }
    if (dialogElement()?.open || document.querySelector("#task-dialog[open]")) return;

    state.checking = true;
    try {
      state.candidates = await loadCandidates();
      state.currentIndex = 0;
      scheduleBanner();
      if (state.candidates.length) renderCurrent();
    } finally {
      state.checking = false;
    }
  }

  function scheduleSixPmBoundary() {
    clearTimeout(state.boundaryTimer);
    const now = new Date();
    const next = new Date(now);
    next.setHours(18, 0, 5, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    state.boundaryTimer = setTimeout(() => {
      checkForReview().catch(() => {});
      scheduleSixPmBoundary();
    }, Math.max(1000, next.getTime() - now.getTime()));
  }

  function startRetryLoop() {
    clearInterval(state.retryTimer);
    state.retryTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      checkForReview().catch(() => {});
    }, 600000);
  }

  document.addEventListener("change", (event) => {
    if (event.target?.matches?.("[data-review-overtime]")) {
      const option = event.target.closest(".overtime-option");
      option?.classList.toggle("active", Boolean(event.target.checked));
      option?.classList.remove("attention");
    }
    if (event.target?.matches?.("[data-review-quadrant], [data-review-date]")) {
      event.target.closest(".evening-review-card")?.querySelector(".evening-review-overtime")?.classList.remove("attention");
    }
  }, true);

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-review-action]");
    if (!button) return;
    const action = button.dataset.reviewAction;
    if (action === "open") openReview().catch((error) => {
      if (typeof notify === "function") notify(error.message, "error");
    });
    else if (action === "complete") completeCurrentTask().catch((error) => showError(error.message));
    else if (action === "move") performReview("moved").catch((error) => showError(error.message));
    else if (action === "discard") performReview("discarded").catch((error) => showError(error.message));
    else if (action === "previous") moveWithinQueue(-1);
    else if (action === "next") moveWithinQueue(1);
    else if (action === "later") reviewLater();
  }, true);

  window.addEventListener("focus", () => {
    if (state.schemaReady === false) state.schemaReady = null;
    setTimeout(() => checkForReview().catch(() => {}), 300);
  });

  window.addEventListener("nmplanner-task-rescheduled", () => {
    state.candidatesLoadedAt = 0;
    setTimeout(() => checkForReview().catch(() => {}), 100);
  });

  window.addEventListener("nmplanner-tasks-changed", () => {
    state.candidatesLoadedAt = 0;
    setTimeout(() => checkForReview().catch(() => {}), 150);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (state.schemaReady === false) state.schemaReady = null;
      setTimeout(() => checkForReview().catch(() => {}), 300);
    }
  });

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target.closest?.("#evening-review-banner"))) return;
    scheduleBanner();
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  localStorage.removeItem("nmplanner-evening-review-snooze");
  scheduleSixPmBoundary();
  startRetryLoop();
  scheduleBanner();
  setTimeout(() => checkForReview().catch(() => {}), 1200);
})();