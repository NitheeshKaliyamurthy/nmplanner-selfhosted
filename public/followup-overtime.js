(() => {
  const overtimeClient = window.NMPlannerRuntime?.client;
  if (!overtimeClient) return;

  const HALF_DAY_MINUTES = 300;
  const FULL_DAY_MINUTES = 540;
  const WORK_AREAS = new Set(["BCU / Teaching", "Research"]);
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const FALLBACK = {
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
    work_daily_minutes: 600,
    work_weekly_minutes: 2220,
    work_name: "Primary Work",
  };

  const state = {
    session: null,
    parentId: null,
    taskId: null,
    existingTask: null,
    assessTimer: null,
    lastAssessment: null,
    scheduled: false,
  };

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

  function mondayKey(value) {
    const date = parseDate(value);
    if (!date) return "";
    const distance = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - distance);
    return dateKey(date);
  }

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function operational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  function blockKind(minutes) {
    const value = Number(minutes || 0);
    if (value === FULL_DAY_MINUTES) return "full";
    if (value === HALF_DAY_MINUTES) return "half";
    return "standard";
  }

  function contribution(task, limits) {
    const minutes = Number(task?.minutes || 0);
    const kind = blockKind(minutes);
    if (kind === "full") return { q1: limits.q1, q2: limits.q2 };
    if (kind === "half") return { q1: 0, q2: limits.q2 };
    return {
      q1: task?.quadrant === "q1" ? minutes : 0,
      q2: task?.quadrant === "q2" ? minutes : 0,
    };
  }

  function marginalExcess(existing, total, limit) {
    return Math.max(0, total - limit) - Math.max(0, existing - limit);
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await overtimeClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function settings() {
    try {
      if (window.NMPlannerSettings?.get) return { ...FALLBACK, ...(await window.NMPlannerSettings.get()) };
    } catch (_) {}
    return FALLBACK;
  }

  function editor() {
    return document.querySelector("[data-followup-editor]:not([hidden])");
  }

  function field(target, name) {
    return target?.querySelector(`[data-followup-field="${name}"]`);
  }

  function errorBox(target) {
    return target?.querySelector("[data-followup-error]");
  }

  function showError(target, message) {
    const box = errorBox(target);
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function optionRow(target) {
    let row = target?.querySelector("[data-followup-overtime-option]");
    if (row || !target) return row;

    row = document.createElement("label");
    row.className = "overtime-option followup-overtime-option";
    row.dataset.followupOvertimeOption = "";
    row.hidden = true;
    row.innerHTML = `
      <input type="checkbox" data-followup-overtime-checkbox>
      <span>
        <strong>Urgent / Overtime</strong>
        <small>Use this only when this follow-up genuinely must be accepted above normal Q1/Q2 or Primary Work capacity. The excess is recorded in Weekly Insights.</small>
      </span>`;

    const error = errorBox(target);
    target.insertBefore(row, error || target.querySelector(".followup-editor-actions"));
    row.querySelector("[data-followup-overtime-checkbox]")?.addEventListener("change", () => {
      row.classList.toggle("active", row.querySelector("[data-followup-overtime-checkbox]")?.checked === true);
      scheduleAssess(0);
    });
    return row;
  }

  function statusBox(target) {
    let box = target?.querySelector("[data-followup-overtime-status]");
    if (box || !target) return box;
    box = document.createElement("div");
    box.className = "capacity-status";
    box.dataset.followupOvertimeStatus = "";
    box.hidden = true;
    const error = errorBox(target);
    target.insertBefore(box, error || target.querySelector(".followup-editor-actions"));
    return box;
  }

  function setStatus(box, className, title, text) {
    if (!box) return;
    box.hidden = false;
    box.className = `capacity-status ${className}`;
    box.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = text;
    box.append(strong, span);
  }

  async function loadExistingTask(taskId) {
    if (!taskId) {
      state.existingTask = null;
      return null;
    }
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await overtimeClient
      .from("tasks")
      .select("id,parent_task_id,capacity_override,overtime_minutes,capacity_override_at")
      .eq("user_id", session.user.id)
      .eq("id", taskId)
      .maybeSingle();
    if (error) return null;
    state.existingTask = data || null;
    if (data?.parent_task_id) state.parentId = data.parent_task_id;
    return state.existingTask;
  }

  async function assess(target = editor()) {
    if (!target || target.hidden) return null;
    const planned = field(target, "planned")?.value || "";
    const parsed = parseDate(planned);
    const minutes = Number(field(target, "minutes")?.value || 0);
    const quadrant = field(target, "quadrant")?.value || null;
    const area = field(target, "area")?.value || "";
    const option = optionRow(target);
    const checkbox = option?.querySelector("[data-followup-overtime-checkbox]");
    const box = statusBox(target);
    const legacyBox = target.querySelector("[data-followup-capacity]");

    if (!planned || !parsed || !minutes) {
      option.hidden = true;
      box.hidden = true;
      state.lastAssessment = null;
      return null;
    }

    const session = await getSession();
    if (!session) return null;
    const cfg = await settings();
    const limits = {
      q1: Number(cfg.q1_daily_minutes || FALLBACK.q1_daily_minutes),
      q2: Number(cfg.q2_daily_minutes || FALLBACK.q2_daily_minutes),
      workDay: Number(cfg.work_daily_minutes || FALLBACK.work_daily_minutes),
      workWeek: Number(cfg.work_weekly_minutes || FALLBACK.work_weekly_minutes),
      workName: cfg.work_name || FALLBACK.work_name,
    };
    const week = mondayKey(planned);
    const day = (parsed.getDay() + 6) % 7;
    const excluded = new Set([state.taskId, state.taskId ? null : state.parentId].filter(Boolean));

    const { data, error } = await overtimeClient
      .from("tasks")
      .select("id,week,day,quadrant,area,minutes,superseded_by_followup,discarded_at")
      .eq("user_id", session.user.id)
      .eq("week", week);
    if (error) return null;

    const rows = (data || []).filter((task) => operational(task) && !excluded.has(task.id));
    const dayRows = rows.filter((task) => task.day === day);
    const existing = dayRows.reduce((acc, task) => {
      const part = contribution(task, limits);
      acc.q1 += part.q1;
      acc.q2 += part.q2;
      if (WORK_AREAS.has(task.area)) acc.workDay += Number(task.minutes || 0);
      return acc;
    }, { q1: 0, q2: 0, workDay: 0 });
    existing.workWeek = rows
      .filter((task) => Number.isInteger(task.day) && WORK_AREAS.has(task.area))
      .reduce((sum, task) => sum + Number(task.minutes || 0), 0);

    const part = contribution({ quadrant, minutes }, limits);
    const workMinutes = WORK_AREAS.has(area) ? minutes : 0;
    const total = {
      q1: existing.q1 + part.q1,
      q2: existing.q2 + part.q2,
      workDay: existing.workDay + workMinutes,
      workWeek: existing.workWeek + workMinutes,
    };

    const breaches = [];
    if (part.q1 && total.q1 > limits.q1) breaches.push(`Q1 ${formatMinutes(total.q1)}/${formatMinutes(limits.q1)}`);
    if (part.q2 && total.q2 > limits.q2) breaches.push(`Q2 ${formatMinutes(total.q2)}/${formatMinutes(limits.q2)}`);
    if (workMinutes && total.workDay > limits.workDay) breaches.push(`${limits.workName} day ${formatMinutes(total.workDay)}/${formatMinutes(limits.workDay)}`);
    if (workMinutes && total.workWeek > limits.workWeek) breaches.push(`${limits.workName} week ${formatMinutes(total.workWeek)}/${formatMinutes(limits.workWeek)}`);

    const qOvertime = Math.max(0, marginalExcess(existing.q1, total.q1, limits.q1))
      + Math.max(0, marginalExcess(existing.q2, total.q2, limits.q2));
    const workDayOvertime = workMinutes ? Math.max(0, marginalExcess(existing.workDay, total.workDay, limits.workDay)) : 0;
    const workWeekOvertime = workMinutes ? Math.max(0, marginalExcess(existing.workWeek, total.workWeek, limits.workWeek)) : 0;
    const overtimeMinutes = Math.max(qOvertime, workDayOvertime, workWeekOvertime);
    const existingActive = Boolean(state.existingTask?.capacity_override && Number(state.existingTask?.overtime_minutes || 0) > 0);
    const requested = checkbox?.checked === true;

    option.hidden = !(breaches.length || existingActive);
    if (existingActive && !checkbox.checked) {
      checkbox.checked = true;
      option.classList.add("active");
      let recorded = option.querySelector("[data-followup-overtime-recorded]");
      if (!recorded) {
        recorded = document.createElement("em");
        recorded.dataset.followupOvertimeRecorded = "";
        option.querySelector("span")?.append(recorded);
      }
      recorded.textContent = `Currently recorded as ${formatMinutes(state.existingTask.overtime_minutes)} overtime.`;
    }

    if (!breaches.length && !existingActive) {
      if (checkbox?.checked) checkbox.checked = false;
      option.classList.remove("active");
      box.hidden = true;
      if (legacyBox) legacyBox.hidden = false;
      state.lastAssessment = { allowed: true, overtimeMinutes: 0, week, day, breaches: [] };
      return state.lastAssessment;
    }

    if (breaches.length) {
      if (legacyBox) legacyBox.hidden = true;
      if (requested || checkbox?.checked) {
        setStatus(
          box,
          "overtime",
          `Urgent / Overtime override · ${formatMinutes(overtimeMinutes)} above normal capacity`,
          `${DAYS[day]}: ${breaches.join(" · ")}. This follow-up will be counted in Weekly Insights.`
        );
        state.lastAssessment = { allowed: true, overtimeMinutes, week, day, breaches };
        return state.lastAssessment;
      }
      setStatus(
        box,
        "blocked",
        "Normal capacity exceeded",
        `${DAYS[day]} is over normal planned capacity (${breaches.join(" · ")}). Move/reduce the follow-up or deliberately mark it Urgent / Overtime.`
      );
      state.lastAssessment = { allowed: false, overtimeMinutes, week, day, breaches };
      return state.lastAssessment;
    }

    // An existing overtime follow-up may now fit because its plan changed. Keep
    // the option visible so saving can explicitly clear the historical live flag.
    if (legacyBox) legacyBox.hidden = false;
    box.hidden = true;
    state.lastAssessment = { allowed: true, overtimeMinutes: 0, week, day, breaches: [] };
    return state.lastAssessment;
  }

  function scheduleAssess(delay = 80) {
    clearTimeout(state.assessTimer);
    state.assessTimer = setTimeout(() => assess().catch(() => {}), delay);
  }

  async function saveOvertimeFollowup(target, button) {
    const session = await getSession();
    if (!session) return showError(target, "Your session has expired. Refresh NM Planner and sign in again.");
    const title = field(target, "title")?.value.trim();
    const planned = field(target, "planned")?.value || "";
    const reason = field(target, "reason")?.value || "";
    if (!title) return showError(target, "Enter a follow-up task.");
    if (!planned) return showError(target, "Choose a planned date.");
    if (!reason) return showError(target, "Choose why this follow-up is needed.");

    if (state.taskId && !state.existingTask) await loadExistingTask(state.taskId);
    const parentId = state.taskId ? state.existingTask?.parent_task_id : state.parentId;
    if (!parentId) return showError(target, "The follow-up parent could not be determined. Close and reopen the task, then try again.");

    const assessment = await assess(target);
    if (!assessment) return showError(target, "Capacity could not be checked. Try again.");
    const option = optionRow(target);
    const requested = option?.querySelector("[data-followup-overtime-checkbox]")?.checked === true;
    if (!assessment.allowed && !requested) {
      return showError(target, "This follow-up exceeds normal capacity. Move/reduce it or deliberately mark it Urgent / Overtime.");
    }

    const plannedObject = parseDate(planned);
    const day = (plannedObject.getDay() + 6) % 7;
    const payload = {
      user_id: session.user.id,
      parent_task_id: parentId,
      title,
      week: mondayKey(planned),
      day,
      due: field(target, "due")?.value || null,
      followup_reason: reason,
      quadrant: field(target, "quadrant")?.value || null,
      area: field(target, "area")?.value || "Personal Time",
      minutes: Number(field(target, "minutes")?.value || 60),
      notes: field(target, "notes")?.value || "",
      completed: Boolean(field(target, "completed")?.checked),
      capacity_override: Boolean(requested && assessment.overtimeMinutes > 0),
    };

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Saving…";
    const query = state.taskId
      ? overtimeClient.from("tasks").update(payload).eq("id", state.taskId)
      : overtimeClient.from("tasks").insert(payload);
    const { error } = await query;
    button.disabled = false;
    button.textContent = originalText || "Save follow-up";

    if (error) {
      if (/capacity_override|overtime_minutes|capacity_override_at/i.test(error.message || "") && /column|schema cache/i.test(error.message || "")) {
        return showError(target, "Urgent / Overtime needs database migration 023. Run database/023_urgent_overtime_capacity.sql in Supabase, then try again.");
      }
      return showError(target, error.message);
    }

    target.hidden = true;
    state.taskId = null;
    state.parentId = null;
    state.existingTask = null;
    state.lastAssessment = null;
    window.dispatchEvent(new Event("nmplanner-followup-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("focus"));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-followup-action]");
    if (!button) return;
    const action = button.dataset.followupAction;

    if (action === "add") {
      state.parentId = button.dataset.parentId || null;
      state.taskId = null;
      state.existingTask = null;
      state.lastAssessment = null;
      setTimeout(() => scheduleAssess(0), 0);
      return;
    }

    if (action === "edit") {
      state.taskId = button.dataset.id || null;
      state.parentId = null;
      state.existingTask = null;
      state.lastAssessment = null;
      loadExistingTask(state.taskId).finally(() => setTimeout(() => scheduleAssess(0), 0));
      return;
    }

    if (action === "cancel-editor" || action === "delete") {
      state.lastAssessment = null;
      return;
    }

    if (action !== "save") return;
    const target = editor();
    const option = target?.querySelector("[data-followup-overtime-option]");
    if (!target || !option || option.hidden) return;

    // Visible means the follow-up either exceeds capacity or already carries an
    // overtime flag. Handle this save here so capacity_override is persisted or
    // cleared explicitly. Normal follow-ups continue through followups.js.
    event.preventDefault();
    event.stopImmediatePropagation();
    saveOvertimeFollowup(target, button).catch((error) => showError(target, error.message));
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target.closest?.("[data-followup-editor]");
    if (!target || !event.target.matches('[data-followup-field="planned"], [data-followup-field="quadrant"], [data-followup-field="area"], [data-followup-field="minutes"], [data-followup-overtime-checkbox]')) return;
    scheduleAssess();
  }, true);

  const observer = new MutationObserver(() => {
    const target = editor();
    if (!target) return;
    optionRow(target);
    statusBox(target);
    scheduleAssess(0);
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("nmplanner-settings-changed", () => scheduleAssess(0));
})();
