/* global client, session, editingTask, currentWeek, loadTasks, notify, showFormError, setFormBusy, mondayKey, DAYS */

(() => {
  const HALF_DAY_MINUTES = 300;
  const FULL_DAY_MINUTES = 540;
  const WORK_AREAS = new Set(["BCU / Teaching", "Research"]);
  const FALLBACK = {
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
    work_daily_minutes: 600,
    work_weekly_minutes: 2220,
    work_name: "Primary Work",
  };

  async function rules() {
    let settings = FALLBACK;
    try {
      if (window.NMPlannerSettings?.get) settings = await window.NMPlannerSettings.get();
    } catch (_) {}
    const q1Limit = Number(settings.q1_daily_minutes || FALLBACK.q1_daily_minutes);
    const q2Limit = Number(settings.q2_daily_minutes || FALLBACK.q2_daily_minutes);
    const workDaily = Number(settings.work_daily_minutes || FALLBACK.work_daily_minutes);
    const workWeekly = Number(settings.work_weekly_minutes || FALLBACK.work_weekly_minutes);
    return {
      q1: { label: "Q1", warning: Math.max(0, q1Limit - 60), limit: q1Limit },
      q2: { label: "Q2", warning: Math.max(0, q2Limit - 60), limit: q2Limit },
      work: {
        label: settings.work_name || FALLBACK.work_name,
        daily: workDaily,
        weekly: workWeekly,
      },
    };
  }

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function currentTaskId(form) {
    return form.querySelector('[data-action="delete"][data-id]')?.dataset.id || editingTask?.id || null;
  }

  function blockKind(minutes) {
    const value = Number(minutes || 0);
    if (value === FULL_DAY_MINUTES) return "full";
    if (value === HALF_DAY_MINUTES) return "half";
    return "standard";
  }

  function capacityContribution(task, allRules) {
    const minutes = Number(task?.minutes || 0);
    const kind = blockKind(minutes);
    if (kind === "full") return { q1: allRules.q1.limit, q2: allRules.q2.limit, kind };
    if (kind === "half") return { q1: 0, q2: allRules.q2.limit, kind };
    return {
      q1: task?.quadrant === "q1" ? minutes : 0,
      q2: task?.quadrant === "q2" ? minutes : 0,
      kind,
    };
  }

  function operational(task) {
    return task?.superseded_by_followup !== true && !task?.discarded_at;
  }

  function marginalExcess(existing, total, limit) {
    return Math.max(0, total - limit) - Math.max(0, existing - limit);
  }

  function buildDayQuery(selectFields, { week, day, excludeId }) {
    let query = client
      .from("tasks")
      .select(selectFields)
      .eq("user_id", session.user.id)
      .eq("week", week)
      .eq("day", day);
    if (excludeId) query = query.neq("id", excludeId);
    return query;
  }

  function buildWeekQuery(selectFields, { week, excludeId }) {
    let query = client
      .from("tasks")
      .select(selectFields)
      .eq("user_id", session.user.id)
      .eq("week", week);
    if (excludeId) query = query.neq("id", excludeId);
    return query;
  }

  async function existingUsage({ week, day, excludeId, allRules }) {
    if (!session || day === null) return { q1: 0, q2: 0, workDay: 0, workWeek: 0 };

    const fields = "id,quadrant,minutes,area,day,superseded_by_followup,discarded_at";
    let [dayResult, weekResult] = await Promise.all([
      buildDayQuery(fields, { week, day, excludeId }),
      buildWeekQuery(fields, { week, excludeId }),
    ]);

    if (
      (dayResult.error && /discarded_at|schema cache|column/i.test(dayResult.error.message || ""))
      || (weekResult.error && /discarded_at|schema cache|column/i.test(weekResult.error.message || ""))
    ) {
      const compatibilityFields = "id,quadrant,minutes,area,day,superseded_by_followup";
      [dayResult, weekResult] = await Promise.all([
        buildDayQuery(compatibilityFields, { week, day, excludeId }),
        buildWeekQuery(compatibilityFields, { week, excludeId }),
      ]);
    }

    if (dayResult.error) throw dayResult.error;
    if (weekResult.error) throw weekResult.error;

    const dayUsage = (dayResult.data || [])
      .filter(operational)
      .reduce((usage, task) => {
        const contribution = capacityContribution(task, allRules);
        usage.q1 += contribution.q1;
        usage.q2 += contribution.q2;
        if (WORK_AREAS.has(task.area)) usage.workDay += Number(task.minutes || 0);
        return usage;
      }, { q1: 0, q2: 0, workDay: 0 });

    const workWeek = (weekResult.data || [])
      .filter((task) => operational(task) && Number.isInteger(task.day) && WORK_AREAS.has(task.area))
      .reduce((sum, task) => sum + Number(task.minutes || 0), 0);

    return { ...dayUsage, workWeek };
  }

  function capacityBox(form) {
    let box = form.querySelector("[data-capacity-status]");
    if (!box) {
      box = document.createElement("div");
      box.dataset.capacityStatus = "";
      box.className = "capacity-status";
      box.hidden = true;
      const error = form.querySelector("#form-error");
      form.insertBefore(box, error || form.querySelector(".dialog-actions"));
    }
    return box;
  }

  function overtimeOption(form) {
    return form.querySelector("[data-overtime-option]");
  }

  function showOvertimeOption(form, show, preserveExisting = false) {
    const option = overtimeOption(form);
    if (!option) return;
    const checkbox = option.querySelector('input[name="capacity_override"]');
    const existing = form.dataset.overtimeExisting === "true";
    option.hidden = !(show || existing);
    if (!show && !existing && !preserveExisting && checkbox?.checked) {
      checkbox.checked = false;
      option.classList.remove("active");
    }
  }

  function equalAreaAllocations(selected) {
    const unique = [...new Set(selected.filter(Boolean))];
    if (unique.length < 2) return null;
    const base = Math.floor(100 / unique.length);
    let remainder = 100 - (base * unique.length);
    return Object.fromEntries(unique.map((area) => {
      const percent = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      return [area, percent];
    }));
  }

  function areaSelection(form) {
    const data = new FormData(form);
    const choice = String(data.get("area") || "");
    if (choice !== MULTI_AREA_VALUE) return { area: choice, allocations: null };
    const selected = data.getAll("area_split").map(String);
    const allocations = equalAreaAllocations(selected);
    return { area: selected[0] || "", allocations };
  }

  function splitRows(form) {
    return DAYS.map((day, index) => {
      const checked = form.querySelector(`input[name="split_day"][value="${index}"]`)?.checked;
      if (!checked) return null;
      const minutes = Number(form.querySelector(`input[name="split_minutes_${index}"]`)?.value || 0);
      return { day: index, dayName: day, minutes };
    }).filter(Boolean);
  }

  function splitDurationText(total) {
    const minutes = Math.max(0, Math.round(Number(total || 0)));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return `${m}m`;
    if (!m) return `${h}h`;
    return `${h}h ${m}m`;
  }

  async function assessSplitForm(form, allRules) {
    const rows = splitRows(form);
    const box = capacityBox(form);
    showOvertimeOption(form, false);
    const overtime = form.querySelector('input[name="capacity_override"]');
    if (overtime) overtime.checked = false;

    if (rows.length < 2) {
      box.hidden = false;
      box.className = "capacity-status warning";
      box.innerHTML = "<strong>Split across week</strong><span>Choose at least two days and set the planned minutes for each session.</span>";
      return { allowed: false, split: true, rows, overtimeMinutes: 0, message: "Choose at least two days for a split job." };
    }

    if (rows.some((row) => !Number.isInteger(row.minutes) || row.minutes < 15 || row.minutes > 720 || row.minutes % 15 !== 0)) {
      box.hidden = false;
      box.className = "capacity-status blocked";
      box.innerHTML = "<strong>Check split durations</strong><span>Each selected session must use 15-minute steps between 15 minutes and 12 hours.</span>";
      return { allowed: false, split: true, rows, overtimeMinutes: 0, message: "Check the split-session durations." };
    }

    const quadrant = form.elements.quadrant?.value || null;
    const rawWeek = form.elements.week?.value;
    if (!rawWeek) return { allowed: false, split: true, rows, overtimeMinutes: 0, message: "Choose the week." };
    const week = mondayKey(String(rawWeek));
    const selectedArea = areaSelection(form).area;
    let cumulativeWork = 0;
    const breaches = [];

    for (const row of rows) {
      const contribution = capacityContribution({ quadrant, minutes: row.minutes }, allRules);
      const workMinutes = WORK_AREAS.has(selectedArea) ? row.minutes : 0;
      const existing = await existingUsage({ week, day: row.day, excludeId: currentTaskId(form), allRules });
      const q1 = existing.q1 + contribution.q1;
      const q2 = existing.q2 + contribution.q2;
      const workDay = existing.workDay + workMinutes;
      const workWeek = existing.workWeek + cumulativeWork + workMinutes;
      const dayBreaches = [];
      if (contribution.q1 && q1 > allRules.q1.limit) dayBreaches.push(`Q1 ${formatMinutes(q1)}/${formatMinutes(allRules.q1.limit)}`);
      if (contribution.q2 && q2 > allRules.q2.limit) dayBreaches.push(`Q2 ${formatMinutes(q2)}/${formatMinutes(allRules.q2.limit)}`);
      if (workMinutes && workDay > allRules.work.daily) dayBreaches.push(`${allRules.work.label} day ${formatMinutes(workDay)}/${formatMinutes(allRules.work.daily)}`);
      if (workMinutes && workWeek > allRules.work.weekly) dayBreaches.push(`${allRules.work.label} week ${formatMinutes(workWeek)}/${formatMinutes(allRules.work.weekly)}`);
      if (dayBreaches.length) breaches.push(`${row.dayName}: ${dayBreaches.join(" · ")}`);
      cumulativeWork += workMinutes;
    }

    const total = rows.reduce((sum, row) => sum + row.minutes, 0);
    box.hidden = false;
    if (breaches.length) {
      const message = `This split still exceeds normal capacity (${breaches.join(" | ")}). Reduce or move one of the planned sessions. Overtime is not applied automatically to split work.`;
      box.className = "capacity-status blocked";
      box.innerHTML = `<strong>Split plan exceeds normal capacity</strong><span>${message}</span>`;
      return { allowed: false, split: true, rows, overtimeMinutes: 0, message };
    }

    box.className = "capacity-status healthy";
    box.innerHTML = `<strong>Planned split · ${rows.length} sessions · ${splitDurationText(total)} total</strong><span>This is one logical job scheduled across ${rows.map((row) => row.dayName).join(", ")}. The planned split is not recorded as a move or as overtime.</span>`;
    return { allowed: true, split: true, rows, overtimeMinutes: 0 };
  }

  async function assessForm(form) {
    const allRules = await rules();
    const quadrant = form.elements.quadrant?.value || null;
    const area = areaSelection(form).area;
    const rawDay = form.elements.day?.value;
    if (rawDay === SPLIT_DAY_VALUE) return assessSplitForm(form, allRules);
    const day = rawDay === "" || rawDay == null ? null : Number(rawDay);
    const rawWeek = form.elements.week?.value;
    const minutes = Number(form.elements.minutes?.value || 0);
    const overrideRequested = Boolean(form.elements.capacity_override?.checked);
    const box = capacityBox(form);
    const contribution = capacityContribution({ quadrant, minutes }, allRules);
    const workMinutes = WORK_AREAS.has(area) ? minutes : 0;

    if (day === null || !rawWeek || !minutes) {
      box.hidden = true;
      box.textContent = "";
      box.className = "capacity-status";
      showOvertimeOption(form, false);
      return { allowed: true, warning: false, overtimeMinutes: 0, overrideRequested: false };
    }

    const week = mondayKey(String(rawWeek));
    const existing = await existingUsage({ week, day, excludeId: currentTaskId(form), allRules });
    const total = {
      q1: existing.q1 + contribution.q1,
      q2: existing.q2 + contribution.q2,
      workDay: existing.workDay + workMinutes,
      workWeek: existing.workWeek + workMinutes,
    };
    const dayName = DAYS[day] || "This day";
    const breaches = [];

    if (contribution.q1 && total.q1 > allRules.q1.limit) {
      breaches.push(`Q1 ${formatMinutes(total.q1)}/${formatMinutes(allRules.q1.limit)}`);
    }
    if (contribution.q2 && total.q2 > allRules.q2.limit) {
      breaches.push(`Q2 ${formatMinutes(total.q2)}/${formatMinutes(allRules.q2.limit)}`);
    }
    if (workMinutes && total.workDay > allRules.work.daily) {
      breaches.push(`${allRules.work.label} day ${formatMinutes(total.workDay)}/${formatMinutes(allRules.work.daily)}`);
    }
    if (workMinutes && total.workWeek > allRules.work.weekly) {
      breaches.push(`${allRules.work.label} week ${formatMinutes(total.workWeek)}/${formatMinutes(allRules.work.weekly)}`);
    }

    const qOvertime = Math.max(0, marginalExcess(existing.q1, total.q1, allRules.q1.limit))
      + Math.max(0, marginalExcess(existing.q2, total.q2, allRules.q2.limit));
    const workDayOvertime = workMinutes
      ? Math.max(0, marginalExcess(existing.workDay, total.workDay, allRules.work.daily))
      : 0;
    const workWeekOvertime = workMinutes
      ? Math.max(0, marginalExcess(existing.workWeek, total.workWeek, allRules.work.weekly))
      : 0;
    const overtimeMinutes = Math.max(qOvertime, workDayOvertime, workWeekOvertime);

    box.hidden = false;

    if (breaches.length) {
      showOvertimeOption(form, true, true);
      if (overrideRequested) {
        box.className = "capacity-status overtime";
        box.innerHTML = `<strong>Urgent / Overtime override · ${formatMinutes(overtimeMinutes)} above normal capacity</strong><span>${dayName}: ${breaches.join(" · ")}. This exception will be recorded in Weekly Insights so overtime and last-minute pressure stay visible.</span>`;
        return { allowed: true, warning: true, overtimeMinutes, overrideRequested, dayName, breaches };
      }

      const message = `${dayName} is over normal planned capacity (${breaches.join(" · ")}). Move/reduce the task, or deliberately mark it Urgent / Overtime.`;
      box.className = "capacity-status blocked";
      box.innerHTML = `<strong>Normal capacity exceeded</strong><span>${message}</span>`;
      return { allowed: false, warning: false, overtimeMinutes, overrideRequested, dayName, breaches, message };
    }

    showOvertimeOption(form, false);

    if (contribution.kind === "full") {
      box.className = "capacity-status full";
      box.innerHTML = `<strong>Full Day · 9h block</strong><span>${dayName}: Q1 ${formatMinutes(allRules.q1.limit)}/${formatMinutes(allRules.q1.limit)} and Q2 ${formatMinutes(allRules.q2.limit)}/${formatMinutes(allRules.q2.limit)} will be fully reserved.</span>`;
      return { allowed: true, warning: false, overtimeMinutes: 0, overrideRequested: false, dayName, kind: contribution.kind };
    }

    if (contribution.kind === "half") {
      box.className = "capacity-status full";
      box.innerHTML = `<strong>Half Day · 5h block</strong><span>${dayName}: Q2 ${formatMinutes(allRules.q2.limit)}/${formatMinutes(allRules.q2.limit)} will be fully reserved. Q1 remains available.</span>`;
      return { allowed: true, warning: false, overtimeMinutes: 0, overrideRequested: false, dayName, kind: contribution.kind };
    }

    const rule = allRules[quadrant];
    if (rule && total[quadrant] > rule.warning) {
      box.className = "capacity-status warning";
      box.innerHTML = `<strong>Near ${rule.label} capacity</strong><span>${dayName} will reserve ${formatMinutes(total[quadrant])} of ${formatMinutes(rule.limit)} planned ${rule.label} capacity.</span>`;
      return { allowed: true, warning: true, overtimeMinutes: 0, overrideRequested: false, dayName };
    }

    if (rule) {
      box.className = "capacity-status healthy";
      box.innerHTML = `<strong>${rule.label} capacity</strong><span>${dayName}: ${formatMinutes(total[quadrant])} of ${formatMinutes(rule.limit)} planned capacity.</span>`;
    } else if (workMinutes) {
      box.className = "capacity-status healthy";
      box.innerHTML = `<strong>${allRules.work.label} capacity</strong><span>${dayName}: ${formatMinutes(total.workDay)} of ${formatMinutes(allRules.work.daily)} daily planned work · ${formatMinutes(total.workWeek)} of ${formatMinutes(allRules.work.weekly)} weekly planned work.</span>`;
    } else {
      box.hidden = true;
    }

    return { allowed: true, warning: false, overtimeMinutes: 0, overrideRequested: false, dayName };
  }

  async function saveWithCapacity(form) {
    const data = new FormData(form);
    const quadrant = data.get("quadrant") || null;
    const rawDay = data.get("day");
    const isSplit = rawDay === SPLIT_DAY_VALUE;
    const day = isSplit || rawDay === "" ? null : Number(rawDay);
    const week = mondayKey(String(data.get("week")));
    const minutes = Number(data.get("minutes") || 0);
    const rawRank = data.get("day_rank");
    const dayRank = day === null || rawRank === "" || rawRank == null ? null : Number(rawRank);
    const overrideRequested = data.get("capacity_override") === "on";

    if (dayRank !== null && (!Number.isInteger(dayRank) || dayRank < 1 || dayRank > 99)) {
      showFormError("Day order must be a whole number between 1 and 99, or left blank.");
      return;
    }

    let assessment = { allowed: true, overtimeMinutes: 0 };
    if (day !== null || isSplit) {
      try {
        assessment = await assessForm(form);
      } catch (error) {
        showFormError(`Capacity could not be checked: ${error.message}`);
        return;
      }
      if (!assessment.allowed) {
        showFormError(assessment.message || (isSplit
          ? "This split plan does not fit normal capacity. Adjust the split sessions rather than using overtime."
          : "This task does not fit normal daily capacity. Mark it Urgent / Overtime only if you intentionally need to exceed the limit."));
        return;
      }
    }

    const areaInfo = areaSelection(form);
    if (String(data.get("area") || "") === MULTI_AREA_VALUE && !areaInfo.allocations) {
      showFormError("Choose at least two focus areas for a Multiple Areas task.");
      return;
    }

    if (isSplit) {
      if (editingTask?.id) {
        showFormError("An existing task instance cannot be converted into a split job. Create a new split task instead.");
        return;
      }

      const rows = assessment.rows || splitRows(form);
      const groupId = crypto.randomUUID();
      const count = rows.length;
      const title = String(data.get("title")).trim();
      const payloadRows = rows.map((row, index) => ({
        user_id: session.user.id,
        title,
        week,
        quadrant,
        day: row.day,
        area: areaInfo.area,
        area_allocations: areaInfo.allocations,
        due: data.get("due") || null,
        minutes: row.minutes,
        notes: String(data.get("notes") || ""),
        split_group_id: groupId,
        split_instance_index: index + 1,
        split_instance_count: count,
        capacity_override: false,
      }));

      setFormBusy(true);
      const { error } = await client.from("tasks").insert(payloadRows);
      setFormBusy(false);

      if (error) {
        const capacityError = /daily capacity exceeded|weekly capacity exceeded|Q1 daily capacity|Q2 daily capacity|Work daily capacity|Work weekly capacity|Primary Work capacity/i.test(error.message || "");
        showFormError(capacityError
          ? `The split plan still exceeds capacity: ${error.message}`
          : `The split job could not be saved: ${error.message}`);
        return;
      }

      editingTask = null;
      currentWeek = week;
      const total = rows.reduce((sum, row) => sum + Number(row.minutes || 0), 0);
      notify(`Split job saved as ${count} planned sessions · ${splitDurationText(total)} total.`, "success");
      await loadTasks();
      window.dispatchEvent(new Event("nmplanner-analytics-changed"));
      return;
    }

    const payload = {
      user_id: session.user.id,
      title: String(data.get("title")).trim(),
      week,
      quadrant,
      day,
      area: areaInfo.area,
      area_allocations: areaInfo.allocations,
      due: data.get("due") || null,
      minutes,
      notes: String(data.get("notes") || ""),
    };
    if (data.has("day_rank")) payload.day_rank = dayRank;

    // Keep ordinary saves compatible while migration 023 is waiting to be run.
    // Once an existing overtime row is known, send false explicitly when the
    // user removes the override so the database can normalize it safely.
    if (
      overrideRequested
      || form.dataset.overtimeExisting === "true"
      || editingTask?.capacity_override !== undefined
    ) {
      payload.capacity_override = Boolean(overrideRequested && assessment.overtimeMinutes > 0);
    }
    if (editingTask?.id) payload.id = editingTask.id;

    setFormBusy(true);
    const query = editingTask?.id
      ? client.from("tasks").update(payload).eq("id", editingTask.id)
      : client.from("tasks").insert(payload);
    const { error } = await query;
    setFormBusy(false);

    if (error) {
      if (/capacity_override|overtime_minutes|capacity_override_at/i.test(error.message || "") && /column|schema cache/i.test(error.message || "")) {
        showFormError("Urgent / Overtime needs database migration 023. Run database/023_urgent_overtime_capacity.sql in Supabase, then try again.");
        return;
      }
      const capacityError = /daily capacity exceeded|weekly capacity exceeded|Q1 daily capacity|Q2 daily capacity|Work daily capacity|Work weekly capacity|Full Day requires|Half Day requires|Urgent \/ Overtime|Primary Work capacity/i.test(error.message || "");
      showFormError(capacityError ? error.message : `The task could not be saved: ${error.message}`);
      return;
    }

    editingTask = null;
    currentWeek = week;
    notify(assessment.overtimeMinutes > 0 ? `Task saved with ${formatMinutes(assessment.overtimeMinutes)} overtime recorded.` : "Task saved.", "success");
    await loadTasks();
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
  }

  document.addEventListener("submit", async (event) => {
    if (event.target?.id !== "task-form") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    await saveWithCapacity(event.target);
  }, true);

  let refreshTimer;
  document.addEventListener("change", (event) => {
    const form = event.target.closest?.("#task-form");
    if (!form) return;
    const name = event.target.name || "";
    if (!["quadrant", "day", "minutes", "week", "area", "capacity_override", "area_split", "split_day"].includes(name) && !name.startsWith("split_minutes_")) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => assessForm(form).catch(() => {}), 80);
  }, true);

  window.addEventListener("nmplanner-settings-changed", () => {
    const form = document.querySelector("#task-form");
    if (form) assessForm(form).catch(() => {});
  });

  const observer = new MutationObserver(() => {
    const form = document.querySelector("#task-form");
    if (!form || form.dataset.capacityReady) return;
    form.dataset.capacityReady = "true";
    assessForm(form).catch(() => {});
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
})();
