(() => {
  const settingsClient = window.NMPlannerRuntime?.client;
  if (!settingsClient) return;

  const AREAS = [
    "BCU / Teaching",
    "Research",
    "WorldSkills",
    "Family / Home",
    "Personal Time",
  ];

  const DEFAULTS = Object.freeze({
    work_name: "Primary Work",
    additional_work_name: "Additional Work",
    work_weekly_minutes: 2220,
    work_daily_minutes: 600,
    q1_daily_minutes: 240,
    q2_daily_minutes: 300,
    worldskills_weekly_minutes: 1680,
    family_daily_minutes: 180,
    personal_daily_minutes: 180,
    sleep_daily_hours: 6,
    steps_per_mile: 2000,
  });

  const state = {
    session: null,
    values: { ...DEFAULTS },
    loaded: false,
    loading: null,
    schemaReady: null,
    scheduled: false,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function hours(minutes) {
    return Number(minutes || 0) / 60;
  }

  function normaliseArea(value) {
    if (value === "Personal / Admin" || value === "Lunch") return "Personal Time";
    return value;
  }

  function displayArea(value, source = state.values) {
    const area = normaliseArea(value);
    if (area === "BCU / Teaching") return source.work_name || DEFAULTS.work_name;
    if (area === "WorldSkills") return source.additional_work_name || DEFAULTS.additional_work_name;
    return area;
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await settingsClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  async function load(force = false) {
    if (!force && state.loaded) return state.values;
    if (!force && state.loading) return state.loading;

    state.loading = (async () => {
      const session = await getSession();
      if (!session) return state.values;

      let result = await settingsClient
        .from("planner_settings")
        .select("work_name,additional_work_name,work_weekly_minutes,work_daily_minutes,q1_daily_minutes,q2_daily_minutes,worldskills_weekly_minutes,family_daily_minutes,personal_daily_minutes,sleep_daily_hours,steps_per_mile")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (result.error && /work_name|additional_work_name|schema cache|column/i.test(result.error.message || "")) {
        const legacy = await settingsClient
          .from("planner_settings")
          .select("work_weekly_minutes,work_daily_minutes,q1_daily_minutes,q2_daily_minutes,worldskills_weekly_minutes,family_daily_minutes,personal_daily_minutes,sleep_daily_hours,steps_per_mile")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (!legacy.error) {
          state.schemaReady = false;
          state.values = { ...DEFAULTS, ...(legacy.data || {}) };
          state.loaded = true;
          return state.values;
        }
      }

      if (result.error) {
        state.schemaReady = false;
        state.loaded = true;
        state.values = { ...DEFAULTS };
        return state.values;
      }

      state.schemaReady = true;
      state.values = { ...DEFAULTS, ...(result.data || {}) };
      state.loaded = true;
      return state.values;
    })();

    try {
      return await state.loading;
    } finally {
      state.loading = null;
    }
  }

  async function savePatch(patch) {
    const session = await getSession();
    if (!session) throw new Error("Your session is still loading.");
    if (state.schemaReady === false) throw new Error("Run database/012_configurable_work_labels.sql in Supabase first.");

    const payload = { ...state.values, ...patch, user_id: session.user.id };
    const { error } = await settingsClient.from("planner_settings").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;

    delete payload.user_id;
    state.values = { ...DEFAULTS, ...payload };
    state.loaded = true;
    state.schemaReady = true;
    patchAreaSelectors(true);
    patchVisibleAreaLabels();
    window.dispatchEvent(new CustomEvent("nmplanner-settings-changed", { detail: { ...state.values } }));
    return state.values;
  }

  async function saveConfiguration(form) {
    const workName = String(form.elements.work_name?.value || "").trim();
    const additionalName = String(form.elements.additional_work_name?.value || "").trim();
    if (!workName || workName.length > 60) throw new Error("Work Name must be between 1 and 60 characters.");
    if (!additionalName || additionalName.length > 60) throw new Error("Additional Work Name must be between 1 and 60 characters.");
    if (workName.toLowerCase() === additionalName.toLowerCase()) throw new Error("Work Name and Additional Work Name should be different.");
    return savePatch({ work_name: workName, additional_work_name: additionalName });
  }

  async function saveTargets(form) {
    const numeric = (name, multiplier = 60) => {
      const raw = Number(form.elements[name]?.value);
      if (!Number.isFinite(raw) || raw < 0) throw new Error("Enter valid non-negative planner targets.");
      return Math.round(raw * multiplier);
    };

    const patch = {
      work_weekly_minutes: numeric("work_weekly_hours"),
      work_daily_minutes: numeric("work_daily_hours"),
      q1_daily_minutes: numeric("q1_daily_hours"),
      q2_daily_minutes: numeric("q2_daily_hours"),
      worldskills_weekly_minutes: numeric("worldskills_weekly_hours"),
      family_daily_minutes: numeric("family_daily_hours"),
      personal_daily_minutes: numeric("personal_daily_hours"),
      sleep_daily_hours: Number(form.elements.sleep_daily_hours?.value),
      steps_per_mile: Math.round(Number(form.elements.steps_per_mile?.value)),
    };

    if (patch.work_weekly_minutes < 60 || patch.work_weekly_minutes > 10080) throw new Error("Weekly work maximum must be between 1 and 168 hours.");
    if (patch.work_daily_minutes < 30 || patch.work_daily_minutes > 1440) throw new Error("Daily work maximum must be between 0.5 and 24 hours.");
    if (patch.q1_daily_minutes < 15 || patch.q1_daily_minutes > 1440 || patch.q2_daily_minutes < 15 || patch.q2_daily_minutes > 1440) throw new Error("Q1/Q2 daily limits must be between 0.25 and 24 hours.");
    if (!Number.isFinite(patch.sleep_daily_hours) || patch.sleep_daily_hours < 0 || patch.sleep_daily_hours > 24) throw new Error("Sleep target must be between 0 and 24 hours.");
    if (!Number.isFinite(patch.steps_per_mile) || patch.steps_per_mile < 500 || patch.steps_per_mile > 5000) throw new Error("Steps per mile must be between 500 and 5,000.");

    return savePatch(patch);
  }

  function patchAreaSelect(select, force = false) {
    if (!select) return;
    const isTaskEditor = select.matches('#task-form select[name="area"]');
    const signature = `${state.values.work_name}|${state.values.additional_work_name}|${isTaskEditor ? "multi" : "single"}`;
    if (!force && select.dataset.areaChoicesV4 === signature) return;

    let selected = normaliseArea(select.value || "");
    let taskUsesMultipleAreas = selected === "__multiple__";

    try {
      if (isTaskEditor && typeof editingTask !== "undefined" && editingTask) {
        const allocations = editingTask.area_allocations;
        if (allocations && typeof allocations === "object" && !Array.isArray(allocations)) {
          const activeAreas = Object.values(allocations).filter((value) => Number(value || 0) > 0);
          taskUsesMultipleAreas = activeAreas.length >= 2;
        }
        if (!taskUsesMultipleAreas && editingTask.area) selected = normaliseArea(editingTask.area);
      }
    } catch (_) {}

    const standardOptions = AREAS
      .map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(displayArea(area))}</option>`)
      .join("");
    const multiOption = isTaskEditor
      ? '<option value="__multiple__">Multiple Areas (choose 2+)</option>'
      : "";

    select.innerHTML = standardOptions + multiOption;
    if (isTaskEditor && taskUsesMultipleAreas) select.value = "__multiple__";
    else select.value = AREAS.includes(selected) ? selected : "Personal Time";

    delete select.dataset.areaChoicesV3;
    select.dataset.areaChoicesV4 = signature;
  }

  function patchAreaSelectors(force = false) {
    patchAreaSelect(document.querySelector('#task-form select[name="area"]'), force);
    patchAreaSelect(document.querySelector('[data-followup-field="area"]'), force);
  }

  function patchVisibleAreaLabels() {
    const replacements = [
      ["BCU / Teaching", state.values.work_name],
      ["WorldSkills", state.values.additional_work_name],
      ["Personal / Admin", "Personal Time"],
      ["Lunch", "Personal Time"],
    ];

    document.querySelectorAll(".task-main span").forEach((node) => {
      let text = node.textContent || "";
      for (const [from, to] of replacements) {
        if (text.startsWith(`${from} ·`) || text === from) text = text.replace(from, to);
      }
      if (node.textContent !== text) node.textContent = text;
    });
  }

  function configurationCard(values) {
    const v = { ...DEFAULTS, ...values };
    return `
      <article class="setting-card planner-targets-card" data-planner-configuration-card>
        <div class="setting-icon">⚙</div>
        <div class="planner-targets-copy">
          <h2>Planner configuration</h2>
          <p>Choose the names used for your main work and additional work. These labels appear in Focus Area, Day Plan and Insights while the underlying data remains compatible with the planner.</p>
          <form data-planner-configuration-form>
            <div class="planner-config-grid">
              <label><span>Work Name</span><input name="work_name" type="text" maxlength="60" value="${escapeHtml(v.work_name)}" placeholder="e.g. Primary Work"><small>Primary work bucket. Research shares its weekly/daily hard limit.</small></label>
              <label><span>Additional Work Name</span><input name="additional_work_name" type="text" maxlength="60" value="${escapeHtml(v.additional_work_name)}" placeholder="e.g. Additional Work"><small>Second work/commitment bucket. Recommendation only.</small></label>
            </div>
            <div class="planner-target-actions">
              <span data-planner-configuration-status>${state.schemaReady === false ? "Run database/012_configurable_work_labels.sql to enable configurable names." : "Names can be changed later without rewriting historical tasks."}</span>
              <button type="submit" class="primary-button">Save configuration</button>
            </div>
          </form>
        </div>
      </article>`;
  }

  function targetCard(values) {
    const v = { ...DEFAULTS, ...values };
    return `
      <article class="setting-card planner-targets-card" data-planner-targets-card>
        <div class="setting-icon">◎</div>
        <div class="planner-targets-copy">
          <h2>Planner targets</h2>
          <p>Hard limits protect Q1/Q2 and primary work capacity. Family and Personal Time are flexible weekly recommendations derived from the daily-average values below; individual days can vary freely.</p>
          <form data-planner-targets-form>
            <div class="planner-target-grid">
              <label><span>${escapeHtml(v.work_name)} + Research / week</span><input name="work_weekly_hours" type="number" min="1" max="168" step="0.25" value="${hours(v.work_weekly_minutes)}"><small>Hard maximum · hours/week</small></label>
              <label><span>${escapeHtml(v.work_name)} + Research / day</span><input name="work_daily_hours" type="number" min="0.5" max="24" step="0.25" value="${hours(v.work_daily_minutes)}"><small>Hard maximum · hours/day</small></label>
              <label><span>Q1 / day</span><input name="q1_daily_hours" type="number" min="0.25" max="24" step="0.25" value="${hours(v.q1_daily_minutes)}"><small>Hard maximum · hours/day</small></label>
              <label><span>Q2 / day</span><input name="q2_daily_hours" type="number" min="0.25" max="24" step="0.25" value="${hours(v.q2_daily_minutes)}"><small>Hard maximum · hours/day</small></label>
              <label><span>${escapeHtml(v.additional_work_name)} / week</span><input name="worldskills_weekly_hours" type="number" min="0" max="168" step="0.25" value="${hours(v.worldskills_weekly_minutes)}"><small>Flexible weekly recommendation</small></label>
              <label><span>Family / Home average / day</span><input name="family_daily_hours" type="number" min="0" max="24" step="0.25" value="${hours(v.family_daily_minutes)}"><small>Flexible guidance · weekly equivalent = ${hours(v.family_daily_minutes) * 7}h</small></label>
              <label><span>Personal Time average / day</span><input name="personal_daily_hours" type="number" min="0" max="24" step="0.25" value="${hours(v.personal_daily_minutes)}"><small>Includes lunch/admin · weekly equivalent = ${hours(v.personal_daily_minutes) * 7}h</small></label>
              <label><span>Sleep / day</span><input name="sleep_daily_hours" type="number" min="0" max="24" step="0.25" value="${Number(v.sleep_daily_hours)}"><small>Wellbeing target; daily variation is expected</small></label>
              <label><span>Walking conversion</span><input name="steps_per_mile" type="number" min="500" max="5000" step="50" value="${Number(v.steps_per_mile)}"><small>Estimated steps per mile</small></label>
            </div>
            <div class="planner-target-actions">
              <span data-planner-targets-status>${state.schemaReady === false ? "Run database/012_configurable_work_labels.sql after migration 011." : "Changes apply across hard limits, Day Plan and Insights."}</span>
              <button type="submit" class="primary-button">Save planner targets</button>
            </div>
          </form>
        </div>
      </article>`;
  }

  async function installSettingsCards() {
    const grid = document.querySelector(".settings-grid");
    if (!grid) return;
    const values = await load();
    const current = document.querySelector(".settings-grid");
    if (!current) return;

    if (!current.querySelector("[data-planner-targets-card]")) current.insertAdjacentHTML("afterbegin", targetCard(values));
    if (!current.querySelector("[data-planner-configuration-card]")) current.insertAdjacentHTML("afterbegin", configurationCard(values));
  }

  function handleForm(event, selector, saveFn, statusSelector, idleText, savingText) {
    const form = event.target.closest?.(selector);
    if (!form) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const status = form.querySelector(statusSelector);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = savingText;
    saveFn(form)
      .then(() => {
        if (status) status.textContent = idleText;
        document.querySelector("[data-planner-targets-card]")?.remove();
        document.querySelector("[data-planner-configuration-card]")?.remove();
        installSettingsCards().catch(() => {});
      })
      .catch((error) => {
        if (status) status.textContent = `Could not save: ${error.message}`;
      })
      .finally(() => {
        button.disabled = false;
        button.textContent = selector.includes("configuration") ? "Save configuration" : "Save planner targets";
      });
    return true;
  }

  document.addEventListener("submit", (event) => {
    if (handleForm(event, "[data-planner-configuration-form]", saveConfiguration, "[data-planner-configuration-status]", "Configuration saved.", "Saving…")) return;
    handleForm(event, "[data-planner-targets-form]", saveTargets, "[data-planner-targets-status]", "Planner targets saved.", "Saving…");
  }, true);

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      patchAreaSelectors();
      patchVisibleAreaLabels();
      installSettingsCards().catch(() => {});
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    state.session = null;
    schedule();
  });

  window.NMPlannerSettings = {
    AREAS,
    DEFAULTS,
    get: load,
    refresh: () => load(true),
    normaliseArea,
    displayArea,
  };

  load().then(() => {
    patchAreaSelectors(true);
    patchVisibleAreaLabels();
    window.dispatchEvent(new CustomEvent("nmplanner-settings-ready", { detail: { ...state.values } }));
  }).catch(() => {});
  schedule();
})();
