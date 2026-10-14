(() => {
  const capacityClient = window.NMPlannerRuntime?.client;
  if (!capacityClient) return;

  const HALF_DAY_MINUTES = 300;
  const FULL_DAY_MINUTES = 540;
  const FALLBACK = {
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
  };

  let pendingParentId = null;

  function parseDate(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function mondayKey(value) {
    const date = parseDate(value);
    const distance = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - distance);
    return dateKey(date);
  }

  function formatMinutes(total) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  async function rules() {
    let values = FALLBACK;
    try {
      if (window.NMPlannerSettings?.get) values = { ...FALLBACK, ...(await window.NMPlannerSettings.get()) };
    } catch (_) {}
    const q1 = Number(values.q1_daily_minutes || 240);
    const q2 = Number(values.q2_daily_minutes || 300);
    return {
      q1: { label: "Q1", warning: Math.max(0, q1 - 60), limit: q1 },
      q2: { label: "Q2", warning: Math.max(0, q2 - 60), limit: q2 },
    };
  }

  function blockKind(minutes) {
    const value = Number(minutes || 0);
    if (value === FULL_DAY_MINUTES) return "full";
    if (value === HALF_DAY_MINUTES) return "half";
    return "standard";
  }

  function contribution(task, allRules) {
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

  function ensureStatus(editor) {
    let box = editor.querySelector("[data-followup-capacity]");
    if (!box) {
      box = document.createElement("div");
      box.dataset.followupCapacity = "";
      box.className = "capacity-status";
      box.hidden = true;
      const error = editor.querySelector("[data-followup-error]");
      editor.insertBefore(box, error || editor.querySelector(".followup-editor-actions"));
    }
    return box;
  }

  function taskQuery(selectFields, userId, week, day) {
    return capacityClient
      .from("tasks")
      .select(selectFields)
      .eq("user_id", userId)
      .eq("week", week)
      .eq("day", day);
  }

  async function assess(editor) {
    if (!editor || editor.hidden) return;
    const box = ensureStatus(editor);
    const quadrant = editor.querySelector('[data-followup-field="quadrant"]')?.value || null;
    const planned = editor.querySelector('[data-followup-field="planned"]')?.value || "";
    const minutes = Number(editor.querySelector('[data-followup-field="minutes"]')?.value || 0);
    const allRules = await rules();
    const proposed = contribution({ quadrant, minutes }, allRules);
    const rule = allRules[quadrant];

    if (!planned || !minutes || (!proposed.q1 && !proposed.q2)) {
      box.hidden = true;
      return;
    }

    const editingExisting = !editor.querySelector('[data-followup-action="delete"]')?.hidden;
    if (editingExisting) {
      box.hidden = false;
      box.className = "capacity-status healthy";
      if (proposed.kind === "full") {
        box.innerHTML = `<strong>Full Day · 9h block</strong><span>Saving will require all Q1 (${formatMinutes(allRules.q1.limit)}) and Q2 (${formatMinutes(allRules.q2.limit)}) capacity on this day.</span>`;
      } else if (proposed.kind === "half") {
        box.innerHTML = `<strong>Half Day · 5h block</strong><span>Saving will require all Q2 capacity (${formatMinutes(allRules.q2.limit)}) on this day. Q1 remains available.</span>`;
      } else {
        box.innerHTML = `<strong>${rule.label} capacity check</strong><span>The daily ${rule.label} limit will be verified when this follow-up is saved.</span>`;
      }
      return;
    }

    const { data: sessionData } = await capacityClient.auth.getSession();
    const user = sessionData.session?.user;
    if (!user) return;

    const plannedDate = parseDate(planned);
    const day = (plannedDate.getDay() + 6) % 7;
    const week = mondayKey(planned);

    let result = await taskQuery(
      "id,quadrant,minutes,superseded_by_followup,discarded_at",
      user.id,
      week,
      day
    );

    if (result.error && /discarded_at|schema cache|column/i.test(result.error.message || "")) {
      result = await taskQuery(
        "id,quadrant,minutes,superseded_by_followup",
        user.id,
        week,
        day
      );
    }

    if (result.error && /superseded_by_followup|schema cache|column/i.test(result.error.message || "")) {
      result = await taskQuery("id,quadrant,minutes", user.id, week, day);
    }

    if (result.error) return;
    const existing = (result.data || [])
      .filter((task) =>
        task.id !== pendingParentId
        && task.superseded_by_followup !== true
        && !task.discarded_at
      )
      .reduce((usage, task) => {
        const part = contribution(task, allRules);
        usage.q1 += part.q1;
        usage.q2 += part.q2;
        return usage;
      }, { q1: 0, q2: 0 });

    const total = {
      q1: existing.q1 + proposed.q1,
      q2: existing.q2 + proposed.q2,
    };
    box.hidden = false;

    if (proposed.kind === "full") {
      if (total.q1 > allRules.q1.limit || total.q2 > allRules.q2.limit) {
        box.className = "capacity-status blocked";
        box.innerHTML = `<strong>Full Day cannot fit</strong><span>This day already uses ${formatMinutes(existing.q1)} Q1 and ${formatMinutes(existing.q2)} Q2. A Full Day needs both capacities fully available.</span>`;
      } else {
        box.className = "capacity-status full";
        box.innerHTML = `<strong>Full Day · 9h block</strong><span>Q1 ${formatMinutes(allRules.q1.limit)}/${formatMinutes(allRules.q1.limit)} and Q2 ${formatMinutes(allRules.q2.limit)}/${formatMinutes(allRules.q2.limit)} will be fully reserved.</span>`;
      }
      return;
    }

    if (proposed.kind === "half") {
      if (total.q2 > allRules.q2.limit) {
        box.className = "capacity-status blocked";
        box.innerHTML = `<strong>Half Day cannot fit</strong><span>This day already uses ${formatMinutes(existing.q2)} Q2. A Half Day needs all Q2 capacity available.</span>`;
      } else {
        box.className = "capacity-status full";
        box.innerHTML = `<strong>Half Day · 5h block</strong><span>Q2 ${formatMinutes(allRules.q2.limit)}/${formatMinutes(allRules.q2.limit)} will be fully reserved. Q1 remains available.</span>`;
      }
      return;
    }

    if (!rule) {
      box.hidden = true;
      return;
    }

    const bucketTotal = total[quadrant];
    if (bucketTotal > rule.limit) {
      box.className = "capacity-status blocked";
      box.innerHTML = `<strong>${rule.label} capacity exceeded</strong><span>This active follow-up would bring planned capacity to ${formatMinutes(bucketTotal)}. Maximum: ${formatMinutes(rule.limit)}.</span>`;
    } else if (bucketTotal > rule.warning) {
      box.className = "capacity-status warning";
      box.innerHTML = `<strong>Near ${rule.label} capacity</strong><span>This active follow-up would bring planned capacity to ${formatMinutes(bucketTotal)} of ${formatMinutes(rule.limit)}.</span>`;
    } else {
      box.className = "capacity-status healthy";
      box.innerHTML = `<strong>${rule.label} capacity</strong><span>${formatMinutes(bucketTotal)} of ${formatMinutes(rule.limit)} planned capacity. Earlier follow-up stages remain history and are not counted again.</span>`;
    }
  }

  document.addEventListener("click", (event) => {
    const add = event.target.closest?.('[data-followup-action="add"][data-parent-id]');
    if (add) pendingParentId = add.dataset.parentId || null;
  }, true);

  let timer;
  document.addEventListener("change", (event) => {
    const editor = event.target.closest?.("[data-followup-editor]");
    if (!editor || !event.target.matches('[data-followup-field="quadrant"], [data-followup-field="planned"], [data-followup-field="minutes"]')) return;
    clearTimeout(timer);
    timer = setTimeout(() => assess(editor).catch(() => {}), 80);
  }, true);

  const observer = new MutationObserver(() => {
    document.querySelectorAll("[data-followup-editor]:not([hidden])").forEach((editor) => {
      if (editor.dataset.capacityObserved === "true") return;
      editor.dataset.capacityObserved = "true";
      assess(editor).catch(() => {});
    });
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("nmplanner-settings-changed", () => {
    document.querySelectorAll("[data-followup-editor]:not([hidden])").forEach((editor) => assess(editor).catch(() => {}));
  });
})();
