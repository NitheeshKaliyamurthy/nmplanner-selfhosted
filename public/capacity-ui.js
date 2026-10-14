/* global tasks */

(() => {
  const HALF_DAY_MINUTES = 300;
  const FULL_DAY_MINUTES = 540;
  const FALLBACK = {
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
  };

  function formatMinutes(total) {
    const value = Math.max(0, Math.round(Number(total || 0)));
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h${minutes}m`;
  }

  function normaliseArea(area) {
    if (area === "Personal / Admin" || area === "Lunch") return "Personal Time";
    return area;
  }

  function taskAreaShares(task) {
    const raw = task?.area_allocations;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const entries = Object.entries(raw)
        .map(([area, percent]) => [normaliseArea(area), Number(percent || 0)])
        .filter(([, percent]) => Number.isFinite(percent) && percent > 0);
      if (entries.length >= 2) return entries;
    }
    return task?.area ? [[normaliseArea(task.area), 100]] : [];
  }

  function weeklyAreaTotals() {
    const totals = new Map([
      ["BCU / Teaching", 0],
      ["Research", 0],
      ["WorldSkills", 0],
      ["Family / Home", 0],
      ["Personal Time", 0],
    ]);
    for (const task of operationalRows()) {
      const minutes = Number(task.minutes || 0);
      for (const [area, percent] of taskAreaShares(task)) {
        totals.set(area, (totals.get(area) || 0) + minutes * percent / 100);
      }
    }
    return totals;
  }

  function renderWeeklyAreaStrip(settings) {
    if (!["week", "matrix", "days"].includes(typeof currentView !== "undefined" ? currentView : "")) {
      document.querySelector("[data-weekly-area-capacity]")?.remove();
      return;
    }
    const summary = document.querySelector(".summary-grid");
    if (!summary) return;

    const totals = weeklyAreaTotals();
    const workPool = (totals.get("BCU / Teaching") || 0) + (totals.get("Research") || 0);
    const items = [
      { label: settings.work_name || "Primary Work", value: totals.get("BCU / Teaching") || 0, target: Number(settings.work_weekly_minutes || 0), suffix: `Work pool ${formatMinutes(workPool)}/${formatMinutes(settings.work_weekly_minutes || 0)}` },
      { label: "Research", value: totals.get("Research") || 0, target: 0, suffix: "part of Work pool" },
      { label: settings.additional_work_name || "Additional Work", value: totals.get("WorldSkills") || 0, target: Number(settings.worldskills_weekly_minutes || 0) },
      { label: "Family", value: totals.get("Family / Home") || 0, target: Number(settings.family_daily_minutes || 0) * 7 },
      { label: "Personal", value: totals.get("Personal Time") || 0, target: Number(settings.personal_daily_minutes || 0) * 7 },
    ];

    let strip = document.querySelector("[data-weekly-area-capacity]");
    if (!strip) {
      strip = document.createElement("section");
      strip.className = "weekly-area-capacity-strip";
      strip.dataset.weeklyAreaCapacity = "";
      summary.insertAdjacentElement("afterend", strip);
    }

    const signature = JSON.stringify(items.map((item) => [item.label, Math.round(item.value), item.target, item.suffix || ""]));
    if (strip.dataset.signature === signature) return;
    strip.dataset.signature = signature;
    strip.innerHTML = `
      <div class="weekly-area-capacity-heading"><strong>Weekly area load</strong><span>scheduled hours / configured available hours</span></div>
      <div class="weekly-area-capacity-items">
        ${items.map((item) => {
          const ratio = item.target ? item.value / item.target : 0;
          const kind = item.target && ratio > 1 ? "over" : item.target && ratio >= 0.8 ? "near" : "";
          return `<span class="weekly-area-capacity-chip ${kind}"><b>${item.label}</b> ${formatMinutes(item.value)}${item.target ? `/${formatMinutes(item.target)}` : ""}<em>${item.suffix || ""}</em></span>`;
        }).join("")}
      </div>`;
  }

  function operationalRows() {
    try {
      if (window.NMPlannerActiveTasks?.current) return window.NMPlannerActiveTasks.current();
    } catch (_) {}

    const rows = Array.isArray(tasks) ? tasks : [];
    const parents = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
    return rows.filter((task) =>
      task.superseded_by_followup !== true
      && !parents.has(task.id)
      && !task.discarded_at
    );
  }

  function contribution(task, quadrant, q1Limit, q2Limit) {
    const minutes = Number(task?.minutes || 0);
    if (minutes === FULL_DAY_MINUTES) return quadrant === "q1" ? q1Limit : q2Limit;
    if (minutes === HALF_DAY_MINUTES) return quadrant === "q2" ? q2Limit : 0;
    return task?.quadrant === quadrant ? minutes : 0;
  }

  function totalFor(day, quadrant, q1Limit, q2Limit, openOnly = false) {
    return operationalRows()
      .filter((task) => task.day === day && (!openOnly || !task.completed))
      .reduce((sum, task) => sum + contribution(task, quadrant, q1Limit, q2Limit), 0);
  }

  function weeklyTotal(quadrant, q1Limit, q2Limit) {
    return operationalRows()
      .reduce((sum, task) => sum + contribution(task, quadrant, q1Limit, q2Limit), 0);
  }

  function capacityClass(total, warning, limit) {
    if (total > limit) return "overtime";
    if (total === limit) return "full";
    if (total > warning) return "near";
    return "";
  }

  function dailyCapacityText(label, planned, open, limit) {
    const completed = Math.max(0, planned - open);
    const overtime = Math.max(0, planned - limit);
    const base = `${label} ${formatMinutes(planned)}/${formatMinutes(limit)}`;
    const overtimeText = overtime ? ` (+${formatMinutes(overtime)} OT)` : "";
    return completed > 0
      ? `${base}${overtimeText} (${formatMinutes(open)} open)`
      : `${base}${overtimeText}`;
  }

  async function currentSettings() {
    try {
      if (window.NMPlannerSettings?.get) return await window.NMPlannerSettings.get();
    } catch (_) {}
    return FALLBACK;
  }

  async function updateVisibleCapacity() {
    const settings = { ...FALLBACK, ...(await currentSettings()) };
    const q1Limit = Number(settings.q1_daily_minutes || 240);
    const q2Limit = Number(settings.q2_daily_minutes || 300);
    const q1Warning = Math.max(0, q1Limit - 60);
    const q2Warning = Math.max(0, q2Limit - 60);
    const weeklyQ1 = q1Limit * 7;
    const weeklyQ2 = q2Limit * 7;

    renderWeeklyAreaStrip(settings);

    const sideNote = document.querySelector(".side-note");
    if (sideNote) {
      const strong = sideNote.querySelector("strong");
      const span = sideNote.querySelector("span");
      if (strong) strong.textContent = "Protect your daily capacity.";
      if (span) span.textContent = `Q1 maximum ${formatMinutes(q1Limit)}/day · Q2 maximum ${formatMinutes(q2Limit)}/day. Urgent / Overtime can exceed these limits deliberately, and the excess is recorded in Insights.`;
    }

    const summaryCards = document.querySelectorAll(".summary-grid article");
    if (summaryCards.length >= 3) {
      const q1Value = summaryCards[1].querySelector("strong");
      const q1Label = summaryCards[1].querySelector("small");
      const q2Value = summaryCards[2].querySelector("strong");
      const q2Label = summaryCards[2].querySelector("small");
      const q1Text = `${formatMinutes(weeklyTotal("q1", q1Limit, q2Limit))} / ${formatMinutes(weeklyQ1)}`;
      const q2Text = `${formatMinutes(weeklyTotal("q2", q1Limit, q2Limit))} / ${formatMinutes(weeklyQ2)}`;
      if (q1Value && q1Value.textContent !== q1Text) q1Value.textContent = q1Text;
      if (q1Label) q1Label.textContent = "Q1 planned capacity used / weekly capacity";
      if (q2Value && q2Value.textContent !== q2Text) q2Value.textContent = q2Text;
      if (q2Label) q2Label.textContent = "Q2 planned capacity used / weekly capacity";
    }

    document.querySelectorAll(".day-card").forEach((card, index) => {
      const badge = card.querySelector(".q1-count");
      if (!badge) return;
      const q1 = totalFor(index, "q1", q1Limit, q2Limit);
      const q2 = totalFor(index, "q2", q1Limit, q2Limit);
      const q1Open = totalFor(index, "q1", q1Limit, q2Limit, true);
      const q2Open = totalFor(index, "q2", q1Limit, q2Limit, true);
      const nextText = `${dailyCapacityText("Q1", q1, q1Open, q1Limit)} · ${dailyCapacityText("Q2", q2, q2Open, q2Limit)}`;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      badge.classList.remove("full", "near", "overtime");
      const q1Class = capacityClass(q1, q1Warning, q1Limit);
      const q2Class = capacityClass(q2, q2Warning, q2Limit);
      if (q1Class === "overtime" || q2Class === "overtime") badge.classList.add("overtime");
      else if (q1Class === "full" || q2Class === "full") badge.classList.add("full");
      else if (q1Class === "near" || q2Class === "near") badge.classList.add("near");
      const q1Done = Math.max(0, q1 - q1Open);
      const q2Done = Math.max(0, q2 - q2Open);
      const q1Overtime = Math.max(0, q1 - q1Limit);
      const q2Overtime = Math.max(0, q2 - q2Limit);
      badge.title = `Q1 capacity used ${formatMinutes(q1)} (${formatMinutes(q1Open)} open, ${formatMinutes(q1Done)} completed/reserved) of ${formatMinutes(q1Limit)}${q1Overtime ? `, ${formatMinutes(q1Overtime)} overtime` : ""}. Q2 capacity used ${formatMinutes(q2)} (${formatMinutes(q2Open)} open, ${formatMinutes(q2Done)} completed/reserved) of ${formatMinutes(q2Limit)}${q2Overtime ? `, ${formatMinutes(q2Overtime)} overtime` : ""}.`;
    });
  }

  let scheduled = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateVisibleCapacity().catch(() => {});
    });
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  window.addEventListener("focus", scheduleUpdate);
  window.addEventListener("nmplanner-settings-ready", scheduleUpdate);
  window.addEventListener("nmplanner-settings-changed", scheduleUpdate);
  window.addEventListener("nmplanner-followup-changed", scheduleUpdate);
  window.addEventListener("nmplanner-analytics-changed", scheduleUpdate);
  scheduleUpdate();
})();
