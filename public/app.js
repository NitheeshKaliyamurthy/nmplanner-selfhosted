/* global supabase */

const root = document.querySelector("#app");
const config = window.NMPLANNER_CONFIG || {};
const QUADRANTS = {
  q1: { title: "Urgent + Important", short: "Do", color: "#c94040" },
  q2: { title: "Important + Not urgent", short: "Plan", color: "#2f855a" },
  q3: { title: "Urgent + Not important", short: "Delegate", color: "#d97706" },
  q4: { title: "Not urgent + Not important", short: "Reduce", color: "#64748b" },
};
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const AREAS = ["BCU / Teaching", "Research", "WorldSkills", "Family / Home", "Personal / Admin"];
const MULTI_AREA_VALUE = "__multiple__";
const SPLIT_DAY_VALUE = "__split__";
const MULTI_AREA_CHOICES = [
  ["BCU / Teaching", "BCU / Work"],
  ["Research", "Research"],
  ["WorldSkills", "WorldSkills"],
  ["Family / Home", "Family / Home"],
  ["Personal / Admin", "Personal"],
];
const DISPLAY_FIELDS = [
  "id",
  "title",
  "week",
  "quadrant",
  "day",
  "area",
  "due",
  "minutes",
  "notes",
  "completed",
  "created_at",
  "updated_at",
  "completed_at",
  "parent_task_id",
  "superseded_by_followup",
  "discarded_at",
  "actual_minutes",
  "followup_reason",
  "rescheduled_from_week",
  "rescheduled_to_week",
  "day_rank",
  "planned_start_minute",
  "external_calendar_event_id",
  "area_allocations",
  "split_group_id",
  "split_instance_index",
  "split_instance_count",
  "capacity_override",
  "overtime_minutes",
  "capacity_override_at",
];

let client;
let session;
let tasks = [];
let currentWeek = mondayKey(new Date());
let loadedTaskWeek = null;
let currentView = "week";
let editingTask = null;
let settingsOpen = false;
let installPrompt = null;
let lastSynced = null;
let syncTimer = null;
let refreshTimer = null;
let realtimeChannel = null;
let toastTimer = null;

window.NMPlannerState = Object.freeze({
  getTasks: () => tasks.map((task) => ({ ...task })),
  getWeek: () => currentWeek,
  getView: () => currentView,
  getSession: () => session,
  isWeekLoaded: () => loadedTaskWeek === currentWeek,
});

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

function parseKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function mondayKey(input) {
  const date = input instanceof Date ? new Date(input) : parseKey(input);
  const distance = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - distance);
  return dateKey(date);
}

function shiftWeek(amount) {
  const date = parseKey(currentWeek);
  date.setDate(date.getDate() + amount * 7);
  currentWeek = dateKey(date);
  loadTasks();
}

function formatDate(value, options = { day: "numeric", month: "short" }) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", options).format(parseKey(value));
}

function formatWeek(value) {
  const start = parseKey(value);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startText = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(start);
  const endText = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(end);
  return `${startText} – ${endText}`;
}

function taskFor(id) {
  return tasks.find((task) => task.id === id);
}

function taskAreaEntries(task) {
  const raw = task?.area_allocations;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = MULTI_AREA_CHOICES
      .map(([area]) => [area, Number(raw[area] || 0)])
      .filter(([, percent]) => Number.isFinite(percent) && percent > 0);
    if (entries.length >= 2) return entries;
  }
  return task?.area ? [[task.area, 100]] : [];
}

function taskAreaLabel(task) {
  const entries = taskAreaEntries(task);
  if (entries.length < 2) return entries[0]?.[0] || task?.area || "Unclassified";
  const names = entries.map(([area]) =>
    MULTI_AREA_CHOICES.find(([value]) => value === area)?.[1] || area
  );
  return `Multiple Areas · ${names.join(" + ")}`;
}

function equalAreaAllocations(selected) {
  const unique = MULTI_AREA_CHOICES.map(([area]) => area).filter((area) => selected.includes(area));
  if (unique.length < 2) return null;
  const base = Math.floor(100 / unique.length);
  let remainder = 100 - (base * unique.length);
  return Object.fromEntries(unique.map((area) => {
    const percent = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return [area, percent];
  }));
}

function syncMultiAreaPicker() {
  const form = document.querySelector("#task-form");
  if (!form) return;
  const select = form.querySelector('select[name="area"]');
  const picker = form.querySelector("[data-multi-area-picker]");
  if (!select || !picker) return;
  picker.hidden = select.value !== MULTI_AREA_VALUE;
}

function splitTaskLabel(task) {
  if (!task?.split_group_id || !task?.split_instance_index || !task?.split_instance_count) return "";
  return `Split ${task.split_instance_index}/${task.split_instance_count}`;
}

function splitRowsFromForm(form) {
  if (!form) return [];
  return DAYS.map((day, index) => {
    const checkbox = form.querySelector(`input[name="split_day"][value="${index}"]`);
    const minutesInput = form.querySelector(`input[name="split_minutes_${index}"]`);
    if (!checkbox?.checked) return null;
    const minutes = Number(minutesInput?.value || 0);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720 || minutes % 15 !== 0) return { day: index, minutes: NaN, label: day };
    return { day: index, minutes, label: day };
  }).filter(Boolean);
}

function splitTotalMinutes(rows) {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.minutes) ? row.minutes : 0), 0);
}

function splitDurationText(minutes) {
  const value = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return `${rest}m`;
  if (!rest) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

function syncSplitPicker() {
  const form = document.querySelector("#task-form");
  if (!form) return;
  const daySelect = form.querySelector('select[name="day"]');
  const picker = form.querySelector("[data-split-day-picker]");
  const durationField = form.querySelector("[data-single-duration]");
  if (!daySelect || !picker) return;
  const split = daySelect.value === SPLIT_DAY_VALUE;
  picker.hidden = !split;
  if (durationField) durationField.hidden = split;

  picker.querySelectorAll(".split-day-row").forEach((row) => {
    const checkbox = row.querySelector('input[name="split_day"]');
    const minutesInput = row.querySelector('input[name^="split_minutes_"]');
    if (!checkbox || !minutesInput) return;
    minutesInput.disabled = !split || !checkbox.checked;
    row.classList.toggle("active", split && checkbox.checked);
  });

  const total = picker.querySelector("[data-split-total]");
  if (total) {
    const rows = splitRowsFromForm(form);
    total.textContent = rows.length ? `${rows.length} sessions · ${splitDurationText(splitTotalMinutes(rows))} total` : "Choose at least two days.";
  }
}

function taskSignature(list, week) {
  const rows = (Array.isArray(list) ? list : []).map((task) => {
    const row = {};
    for (const field of DISPLAY_FIELDS) row[field] = task?.[field] ?? null;
    return row;
  });
  return `${week || ""}|${JSON.stringify(rows)}`;
}

function scheduleTaskRefresh(delay = 150) {
  if (!session) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (session) loadTasks();
  }, delay);
}

function notify(message, type = "info") {
  let toast = document.querySelector("#toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.append(toast);
  }
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function showConfigurationError() {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-card">
        <div class="brand-mark large">N</div>
        <h1>NM Planner needs configuration</h1>
        <p>The Supabase project URL and publishable key have not yet been added to the hosting environment.</p>
        <div class="callout">Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in Cloudflare Pages, then redeploy.</div>
      </section>
    </main>`;
}

function renderLogin() {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-card">
        <div class="brand-mark large">N</div>
        <p class="eyebrow">PRIVATE WEEKLY PLANNER</p>
        <h1>Plan what matters.</h1>
        <p>Capture the week, organise it into four quadrants, and protect your daily focus.</p>
        <button class="google-button" data-action="login">
          <span class="google-g">G</span> Continue with Google
        </button>
        <small>Only your identity and email address are requested. NM Planner cannot read your Gmail.</small>
      </section>
    </main>`;
}

function renderBlocked() {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-card">
        <div class="brand-mark large">N</div>
        <h1>Account not authorised</h1>
        <p>This private planner is not available to <strong>${escapeHtml(session?.user?.email)}</strong>.</p>
        <button class="secondary-button" data-action="logout">Sign out</button>
      </section>
    </main>`;
}

function navButton(view, label, icon) {
  return `<button class="nav-button ${currentView === view ? "active" : ""}" data-view="${view}"><span>${icon}</span>${label}</button>`;
}

function renderApp() {
  const done = tasks.filter((task) => task.completed).length;
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">N</span><strong>NM Planner</strong></div>
        <nav>
          ${navButton("week", "Week list", "☷")}
          ${navButton("matrix", "Matrix", "▦")}
          ${navButton("days", "Day plan", "▣")}
          ${navButton("insights", "Insights", "↗")}
        </nav>
        <button class="nav-button settings-link ${settingsOpen ? "active" : ""}" data-action="settings"><span>⚙</span>Settings</button>
        <div class="side-note"><strong>Two Q1 tasks. No more.</strong><span>Protect important work before it becomes urgent.</span></div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">WEEKLY EISENHOWER PLANNER</p>
            <h1>${settingsOpen ? "Settings" : viewTitle()}</h1>
          </div>
          <div class="top-actions">
            <div class="week-switcher" ${settingsOpen ? "hidden" : ""}>
              <button aria-label="Previous week" data-action="previous-week">‹</button>
              <button class="week-label" data-action="week-picker">${formatWeek(currentWeek)}</button>
              <input id="week-picker" type="date" value="${currentWeek}" aria-label="Choose week" />
              <button aria-label="Next week" data-action="next-week">›</button>
            </div>
            ${settingsOpen ? "" : '<button class="primary-button" data-action="add">＋ Add task</button>'}
          </div>
        </header>

        ${settingsOpen ? renderSettings() : `
          <section class="summary-grid">
            <article><span class="summary-dot blue"></span><strong>${tasks.length}</strong><small>Tasks this week</small></article>
            <article><span class="summary-dot red"></span><strong>${tasks.filter((task) => task.quadrant === "q1").length}</strong><small>Q1 commitments</small></article>
            <article><span class="summary-dot green"></span><strong>${tasks.filter((task) => task.quadrant === "q2").length}</strong><small>Q2 investment</small></article>
            <article><span class="summary-dot gold"></span><strong>${tasks.length ? Math.round(done / tasks.length * 100) : 0}%</strong><small>Completed</small></article>
          </section>
          ${renderView()}
        `}
      </main>
    </div>
    ${renderEditor()}`;

  if (editingTask) {
    document.querySelector("#task-dialog")?.showModal();
    syncMultiAreaPicker();
    syncSplitPicker();
  }
}

function viewTitle() {
  if (currentView === "matrix") return "Four-quadrant matrix";
  if (currentView === "days") return "Plan each day";
  if (currentView === "insights") return "Weekly effectiveness";
  return "What will you accomplish?";
}

function renderView() {
  if (currentView === "matrix") return renderMatrix();
  if (currentView === "days") return renderDays();
  if (currentView === "insights") return renderInsights();
  return renderWeekList();
}

function renderWeekList() {
  const openTasks = tasks.filter((task) => !task.completed);
  const completedTasks = tasks.filter((task) => task.completed);
  return `
    <section class="panel">
      <div class="panel-heading"><div><h2>Week list</h2><p>Add everything first. You can classify and schedule it afterwards.</p></div><button class="secondary-button" data-action="add">＋ Quick add</button></div>
      <div class="task-list">
        ${openTasks.length ? openTasks.map(renderTaskRow).join("") : renderEmpty("No tasks in this week yet", "Add your first weekly task without worrying about the day.")}
      </div>
      ${completedTasks.length ? `<details class="completed-section"><summary>${completedTasks.length} completed</summary>${completedTasks.map(renderTaskRow).join("")}</details>` : ""}
    </section>`;
}

function renderTaskRow(task) {
  const quadrant = task.quadrant ? QUADRANTS[task.quadrant] : null;
  const day = Number.isInteger(task.day) ? DAYS[task.day] : "Unscheduled";
  return `
    <article class="task-row ${task.completed ? "completed" : ""}">
      <button class="check-button" data-action="toggle" data-id="${task.id}" aria-label="${task.completed ? "Mark incomplete" : "Complete task"}">${task.completed ? "✓" : ""}</button>
      <button class="task-main" data-action="edit" data-id="${task.id}">
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(taskAreaLabel(task))} · ${day}${task.due ? ` · Due ${formatDate(task.due)}` : ""}</span>
      </button>
      <div class="task-tags">
        ${task.split_group_id ? `<span class="split-task-tag">${escapeHtml(splitTaskLabel(task))}</span>` : ""}
        ${quadrant ? `<span class="quadrant-tag" style="--tag:${quadrant.color}">${task.quadrant.toUpperCase()} · ${quadrant.short}</span>` : '<span class="muted-tag">Decide later</span>'}
        <span class="time-tag">${task.minutes}m</span>
      </div>
    </article>`;
}

function renderMatrix() {
  return `<section class="matrix-grid">${Object.entries(QUADRANTS).map(([key, quadrant]) => {
    const quadrantTasks = tasks.filter((task) => task.quadrant === key && !task.completed);
    return `<article class="quadrant-card" style="--quadrant:${quadrant.color}">
      <header><div><span>${key.toUpperCase()} · ${quadrant.short}</span><h2>${quadrant.title}</h2></div><strong>${quadrantTasks.length}</strong></header>
      <div>${quadrantTasks.length ? quadrantTasks.map(renderCompactTask).join("") : '<p class="empty-small">No tasks here</p>'}</div>
    </article>`;
  }).join("")}</section>`;
}

function renderCompactTask(task) {
  const split = splitTaskLabel(task);
  return `<button class="compact-task" data-action="edit" data-id="${task.id}"><strong>${escapeHtml(task.title)}</strong><span>${Number.isInteger(task.day) ? DAYS[task.day] : "Unscheduled"} · ${task.minutes}m${split ? ` · ${escapeHtml(split)}` : ""}</span></button>`;
}

function renderDays() {
  return `<section class="days-grid">${DAYS.map((day, index) => {
    const dayTasks = tasks.filter((task) => task.day === index && !task.completed);
    const q1Count = dayTasks.filter((task) => task.quadrant === "q1").length;
    return `<article class="day-card">
      <header><div><span>${formatDayDate(index)}</span><h2>${day}</h2></div><span class="q1-count ${q1Count >= 2 ? "full" : ""}">Q1 ${q1Count}/2</span></header>
      <div>${dayTasks.length ? dayTasks.map(renderCompactTask).join("") : '<p class="empty-small">Nothing planned</p>'}</div>
    </article>`;
  }).join("")}</section>`;
}

function formatDayDate(index) {
  const date = parseKey(currentWeek);
  date.setDate(date.getDate() + index);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}

function renderInsights() {
  const completed = tasks.filter((task) => task.completed);
  const completion = tasks.length ? Math.round(completed.length / tasks.length * 100) : 0;
  const q2 = completed.filter((task) => task.quadrant === "q2").length;
  const q2Share = completed.length ? Math.round(q2 / completed.length * 100) : 0;
  const q1 = tasks.filter((task) => task.quadrant === "q1").length;
  const advice = insightAdvice(completion, q2Share, q1);
  return `
    <section class="insight-layout">
      <article class="panel">
        <div class="panel-heading"><div><h2>Quadrant balance</h2><p>Distribution of this week's planned work.</p></div></div>
        <div class="bars">${Object.entries(QUADRANTS).map(([key, quadrant]) => {
          const count = tasks.filter((task) => task.quadrant === key).length;
          const percent = tasks.length ? Math.round(count / tasks.length * 100) : 0;
          return `<div><span><b>${key.toUpperCase()}</b> ${quadrant.title}<strong>${percent}%</strong></span><i><em style="width:${percent}%;background:${quadrant.color}"></em></i></div>`;
        }).join("")}</div>
      </article>
      <article class="panel insight-card"><p class="eyebrow">PLANNER INSIGHT</p><h2>${advice.title}</h2><p>${advice.body}</p><div class="score-ring" style="--score:${completion * 3.6}deg"><strong>${completion}%</strong><span>completion</span></div></article>
      <article class="panel habits"><div class="panel-heading"><div><h2>Habits for next week</h2><p>Small adjustments that reduce preventable urgency.</p></div></div>
        <ul><li><strong>Review on Sunday evening</strong><span>Move unfinished work deliberately and prepare the next week.</span></li><li><strong>Protect Q2 time</strong><span>Reserve focused time before important work reaches Q1.</span></li><li><strong>Choose tomorrow's Q1 tasks tonight</strong><span>Maximum two; keep the rest realistic.</span></li></ul>
      </article>
    </section>`;
}

function insightAdvice(completion, q2Share, q1) {
  if (!tasks.length) return { title: "Start with the week", body: "Add the outcomes you want from this week. The dashboard will become useful as you plan and complete work." };
  if (q1 > 8) return { title: "Your week looks reactive", body: "A high Q1 load can signal that important work is being identified too late. Move repeatable preparation into Q2 next week." };
  if (q2Share < 30) return { title: "Protect more proactive time", body: "Your completed work contains relatively little Q2. Schedule preparation, research and planning before adding lower-value urgent work." };
  if (completion < 60) return { title: "Plan closer to your capacity", body: "Reduce the number of weekly commitments and carry forward only tasks you still intend to complete." };
  return { title: "A healthy planning pattern", body: "You are completing a realistic share of the week while preserving important, non-urgent work. Keep the two-Q1 limit." };
}

function renderSettings() {
  return `
    <section class="settings-grid">
      <article class="setting-card"><div class="setting-icon cloud">☁</div><div><h2>Secure synchronisation</h2><p>Connected as ${escapeHtml(session.user.email)}. Tasks refresh automatically across signed-in devices.</p><span class="status active">Active${lastSynced ? ` · ${lastSynced}` : ""}</span></div></article>
      <article class="setting-card"><div class="setting-icon">⇩</div><div><h2>Backup and transfer</h2><p>Download all of your tasks as JSON, or import a previous NM Planner backup.</p><div class="button-row"><button class="secondary-button" data-action="export">Download backup</button><label class="secondary-button file-button">Import backup<input type="file" accept="application/json,.json" data-action="import"></label></div></div></article>
      <article class="setting-card"><div class="setting-icon">▣</div><div><h2>Install NM Planner</h2><p>Install the planner from your browser for an app-like window and home-screen icon.</p><button class="secondary-button" data-action="install">${installPrompt ? "Install now" : "Show install guidance"}</button></div></article>
      <article class="setting-card"><div class="setting-icon microsoft">M</div><div><h2>BCU Microsoft 365 calendar</h2><p>The calendar connection will be added after the private planner deployment is complete.</p><span class="status pending">Not connected</span></div></article>
      <article class="setting-card danger-zone"><div class="setting-icon">↪</div><div><h2>Account</h2><p>Signing out leaves your centrally stored tasks unchanged.</p><button class="secondary-button" data-action="logout">Sign out</button></div></article>
    </section>`;
}

function renderEditor() {
  if (!editingTask) return "";
  const task = editingTask;
  const areaEntries = taskAreaEntries(task);
  const isMultiArea = areaEntries.length >= 2;
  const selectedAreas = new Set(areaEntries.map(([area]) => area));
  const selectedAreaValue = isMultiArea ? MULTI_AREA_VALUE : (task.area || AREAS[0]);
  return `<dialog id="task-dialog" class="task-dialog">
    <form id="task-form">
      <div class="dialog-heading"><div><p class="eyebrow">${task.id ? "EDIT TASK" : "NEW TASK"}</p><h2>${task.id ? "Update the plan" : "Add to the week"}</h2></div><button type="button" class="icon-button" data-action="close-editor">×</button></div>
      <label class="field wide"><span>Task</span><input name="title" required maxlength="160" value="${escapeHtml(task.title || "")}" placeholder="What needs to be done?"></label>
      <div class="form-grid">
        <label class="field"><span>Quadrant</span><select name="quadrant"><option value="">Decide later</option>${Object.entries(QUADRANTS).map(([key, value]) => `<option value="${key}" ${task.quadrant === key ? "selected" : ""}>${key.toUpperCase()} · ${value.title}</option>`).join("")}</select></label>
        <label class="field"><span>Planned day</span><select name="day"><option value="">Not assigned</option>${DAYS.map((day, index) => `<option value="${index}" ${task.day === index ? "selected" : ""}>${day}</option>`).join("")}${!task.id ? `<option value="${SPLIT_DAY_VALUE}">Split across week</option>` : ""}</select><small class="field-help">${task.split_group_id ? `This is ${escapeHtml(splitTaskLabel(task))} of a split job. Move this instance independently if needed.` : "Use Split across week for work that can be completed in planned sessions on different days."}</small></label>
        <label class="field"><span>Focus area</span><select name="area">
          ${AREAS.map((area) => `<option value="${area}" ${selectedAreaValue === area ? "selected" : ""}>${area === "Personal / Admin" ? "Personal" : area === "BCU / Teaching" ? "BCU / Work" : area}</option>`).join("")}
          <option value="${MULTI_AREA_VALUE}" ${isMultiArea ? "selected" : ""}>Multiple Areas (choose 2+)</option>
        </select><small class="field-help">Choose “Multiple Areas” when the task genuinely spans more than one focus area.</small></label>
        <label class="field"><span>Due date</span><input name="due" type="date" value="${task.due || ""}"></label>
        <label class="field" data-single-duration><span>Estimated time</span><select name="minutes">${[15, 30, 45, 60, 90, 120, 180].map((minutes) => `<option value="${minutes}" ${task.minutes === minutes ? "selected" : ""}>${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes > 60 ? "s" : ""}`}</option>`).join("")}</select></label>
        <label class="field"><span>Week containing</span><input name="week" type="date" required value="${task.week || currentWeek}"></label>
      </div>
      <fieldset class="multi-area-picker" data-multi-area-picker ${isMultiArea ? "" : "hidden"}>
        <legend>Areas covered by this task</legend>
        <div class="multi-area-options">
          ${MULTI_AREA_CHOICES.map(([value, label]) => `<label><input type="checkbox" name="area_split" value="${value}" ${selectedAreas.has(value) ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("")}
        </div>
        <small>Select at least two. NM Planner counts the task once, then splits its time equally across the selected areas in Insights.</small>
      </fieldset>
      ${!task.id ? `<fieldset class="split-day-picker" data-split-day-picker hidden>
        <legend>Split this job across the week</legend>
        <div class="split-day-options">
          ${DAYS.map((day, index) => `<label class="split-day-row">
            <input type="checkbox" name="split_day" value="${index}">
            <span>${day}</span>
            <input type="number" name="split_minutes_${index}" min="15" max="720" step="15" value="30" aria-label="${day} minutes" disabled>
            <em>minutes</em>
          </label>`).join("")}
        </div>
        <div class="split-day-summary"><strong data-split-total>Choose at least two days.</strong><span>Each session becomes its own scheduled instance, but Insights treats the instances as one logical job. Planned splitting is not counted as moving the job or as overtime.</span></div>
      </fieldset>` : ""}
      <label class="field wide"><span>Notes</span><textarea name="notes" maxlength="4000" placeholder="A short note, link or reminder">${escapeHtml(task.notes || "")}</textarea></label>
      <div id="form-error" class="form-error" hidden></div>
      <div class="dialog-actions"><div>${task.id ? `<button type="button" class="danger-button" data-action="delete" data-id="${task.id}">Delete</button>` : ""}</div><div><button type="button" class="secondary-button" data-action="close-editor">Cancel</button><button class="primary-button" type="submit">Save task</button></div></div>
    </form>
  </dialog>`;
}

function renderEmpty(title, body) {
  return `<div class="empty-state"><span>✓</span><h3>${title}</h3><p>${body}</p><button class="primary-button" data-action="add">Add task</button></div>`;
}

async function handleSession(nextSession) {
  session = nextSession;
  clearInterval(syncTimer);
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (realtimeChannel && client) await client.removeChannel(realtimeChannel);
  realtimeChannel = null;

  if (!session) {
    tasks = [];
    loadedTaskWeek = null;
    renderLogin();
    return;
  }

  const email = (session.user.email || "").toLowerCase();
  if (config.allowedEmail && email !== config.allowedEmail) {
    renderBlocked();
    return;
  }

  if (!editingTask) renderApp();
  await loadTasks();
  syncTimer = setInterval(() => {
    if (!document.hidden && session) scheduleTaskRefresh(0);
  }, 600000);
  realtimeChannel = client.channel(`tasks-${session.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${session.user.id}` }, () => scheduleTaskRefresh())
    .subscribe();
}

async function loadTasks() {
  if (!session) return;

  const requestedWeek = currentWeek;
  const previousLoadedWeek = loadedTaskWeek;
  const previousSignature = taskSignature(tasks, previousLoadedWeek || requestedWeek);

  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("user_id", session.user.id)
    .eq("week", requestedWeek)
    .order("created_at", { ascending: true });

  if (error) {
    notify(`Tasks could not be synchronised: ${error.message}`, "error");
    return;
  }

  // A slower response for an old week must never replace the week the user is
  // currently viewing.
  if (requestedWeek !== currentWeek) return;

  const nextTasks = data || [];
  const nextSignature = taskSignature(nextTasks, requestedWeek);
  const changed = previousLoadedWeek !== requestedWeek || nextSignature !== previousSignature;

  lastSynced = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  loadedTaskWeek = requestedWeek;

  if (!changed) return;

  tasks = nextTasks;
  if (!editingTask) renderApp();
  window.dispatchEvent(new CustomEvent("nmplanner-tasks-changed", {
    detail: { week: requestedWeek, taskCount: tasks.length },
  }));
}

async function saveTask(form) {
  const data = new FormData(form);
  const quadrant = data.get("quadrant") || null;
  const rawDay = data.get("day");
  const isSplit = rawDay === SPLIT_DAY_VALUE;
  const day = isSplit || rawDay === "" ? null : Number(rawDay);
  const week = mondayKey(String(data.get("week")));

  if (quadrant === "q1" && day !== null) {
    const q1Count = tasks.filter((task) => task.quadrant === "q1" && task.day === day && task.id !== editingTask?.id).length;
    if (q1Count >= 2 && week === currentWeek) {
      showFormError(`${DAYS[day]} already has two Urgent + Important tasks. Choose another day or quadrant.`);
      return;
    }
  }

  const areaChoice = String(data.get("area") || "");
  let area = areaChoice;
  let areaAllocations = null;
  if (areaChoice === MULTI_AREA_VALUE) {
    const selectedAreas = data.getAll("area_split").map(String);
    areaAllocations = equalAreaAllocations(selectedAreas);
    if (!areaAllocations) {
      showFormError("Choose at least two focus areas for a Multiple Areas task.");
      return;
    }
    // Keep a primary area for backwards-compatible capacity safeguards.
    // Insights use area_allocations, so the task's minutes are not double-counted.
    area = MULTI_AREA_CHOICES.find(([value]) => Object.hasOwn(areaAllocations, value))?.[0] || selectedAreas[0];
  }

  if (isSplit && editingTask?.id) {
    showFormError("An existing task instance cannot be converted into a split job. Create a new split task instead.");
    return;
  }

  if (isSplit) {
    const splitRows = splitRowsFromForm(form);
    if (splitRows.length < 2) {
      showFormError("Choose at least two days for a split job.");
      return;
    }
    if (splitRows.some((row) => !Number.isFinite(row.minutes))) {
      showFormError("Each selected split session must be in 15-minute steps between 15 minutes and 12 hours.");
      return;
    }
    const groupId = crypto.randomUUID();
    const count = splitRows.length;
    const title = String(data.get("title")).trim();
    const rows = splitRows.map((row, index) => ({
      user_id: session.user.id,
      title,
      week,
      quadrant,
      day: row.day,
      area,
      area_allocations: areaAllocations,
      due: data.get("due") || null,
      minutes: row.minutes,
      notes: String(data.get("notes") || ""),
      split_group_id: groupId,
      split_instance_index: index + 1,
      split_instance_count: count,
    }));

    setFormBusy(true);
    const { error } = await client.from("tasks").insert(rows);
    setFormBusy(false);
    if (error) {
      showFormError(`The split job could not be saved: ${error.message}`);
      return;
    }
    editingTask = null;
    currentWeek = week;
    notify(`Split job saved as ${count} planned sessions · ${splitDurationText(splitTotalMinutes(splitRows))} total.`, "success");
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
    area,
    area_allocations: areaAllocations,
    due: data.get("due") || null,
    minutes: Number(data.get("minutes")),
    notes: String(data.get("notes") || ""),
  };
  if (editingTask?.id) payload.id = editingTask.id;

  setFormBusy(true);
  const query = editingTask?.id
    ? client.from("tasks").update(payload).eq("id", editingTask.id)
    : client.from("tasks").insert(payload);
  const { error } = await query;
  setFormBusy(false);

  if (error) {
    showFormError(error.message.includes("two Urgent") ? error.message : `The task could not be saved: ${error.message}`);
    return;
  }
  editingTask = null;
  currentWeek = week;
  notify("Task saved.", "success");
  await loadTasks();
}

function showFormError(message) {
  const element = document.querySelector("#form-error");
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
}

function setFormBusy(busy) {
  const button = document.querySelector('#task-form button[type="submit"]');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? "Saving…" : "Save task";
}

async function toggleTask(id) {
  const task = taskFor(id);
  if (!task) return;
  const { error } = await client.from("tasks").update({ completed: !task.completed }).eq("id", id);
  if (error) notify(error.message, "error");
  else await loadTasks();
}

async function deleteTask(id) {
  if (!window.confirm("Delete this task permanently?")) return;
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) notify(error.message, "error");
  else {
    editingTask = null;
    notify("Task deleted.", "success");
    await loadTasks();
  }
}

async function exportBackup() {
  const { data, error } = await client.from("tasks").select("*").eq("user_id", session.user.id).order("created_at");
  if (error) return notify(`Backup failed: ${error.message}`, "error");
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), tasks: data }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `nmplanner-${dateKey(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  notify("Backup downloaded.", "success");
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 1000) : [];
    if (!incoming.length) return notify("The backup contains no tasks.");
    if (!window.confirm(`Import ${incoming.length} task${incoming.length === 1 ? "" : "s"}? Existing matching task IDs will be left unchanged.`)) return;
    const rows = incoming.map((task) => {
      const hasDay = task.day !== null && task.day !== undefined && task.day !== "";
      const parsedDay = Number(task.day);
      return {
      id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id || "") ? task.id : crypto.randomUUID(),
      user_id: session.user.id,
      title: String(task.title || "").slice(0, 160),
      week: mondayKey(task.week),
      quadrant: ["q1", "q2", "q3", "q4"].includes(task.quadrant) ? task.quadrant : null,
      day: hasDay && Number.isInteger(parsedDay) && parsedDay >= 0 && parsedDay <= 6 ? parsedDay : null,
      area: String(task.area || "Personal / Admin").slice(0, 80),
      area_allocations: task.area_allocations && typeof task.area_allocations === "object" && !Array.isArray(task.area_allocations)
        ? task.area_allocations
        : null,
      split_group_id: task.split_group_id || null,
      split_instance_index: task.split_instance_index || null,
      split_instance_count: task.split_instance_count || null,
      due: /^\d{4}-\d{2}-\d{2}$/.test(task.due || "") ? task.due : null,
      minutes: Math.max(5, Math.min(720, Number(task.minutes) || 60)),
      notes: String(task.notes || "").slice(0, 4000),
      completed: Boolean(task.completed),
      };
    }).filter((task) => task.title.trim());
    const { error } = await client.from("tasks").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
    notify(`${rows.length} tasks imported.`, "success");
    await loadTasks();
  } catch (error) {
    notify(`Import failed: ${error.message}`, "error");
  }
}

root.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  const view = button.dataset.view;

  if (view) {
    currentView = view;
    settingsOpen = false;
    renderApp();
  } else if (action === "login") {
    const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) notify(error.message, "error");
  } else if (action === "logout") {
    await client.auth.signOut();
  } else if (action === "previous-week") {
    shiftWeek(-1);
  } else if (action === "next-week") {
    shiftWeek(1);
  } else if (action === "week-picker") {
    document.querySelector("#week-picker")?.showPicker?.();
  } else if (action === "settings") {
    settingsOpen = !settingsOpen;
    renderApp();
  } else if (action === "add") {
    editingTask = { title: "", week: currentWeek, quadrant: null, day: null, area: "Personal / Admin", due: null, minutes: 60, notes: "" };
    renderApp();
  } else if (action === "edit") {
    editingTask = { ...taskFor(button.dataset.id) };
    renderApp();
  } else if (action === "close-editor") {
    editingTask = null;
    renderApp();
  } else if (action === "toggle") {
    await toggleTask(button.dataset.id);
  } else if (action === "delete") {
    await deleteTask(button.dataset.id);
  } else if (action === "export") {
    await exportBackup();
  } else if (action === "install") {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      renderApp();
    } else {
      notify("Use your browser menu and choose ‘Install app’ or ‘Add to Home Screen’. ");
    }
  }
});

root.addEventListener("submit", async (event) => {
  if (event.target.id !== "task-form") return;
  event.preventDefault();
  await saveTask(event.target);
});

root.addEventListener("change", async (event) => {
  if (event.target.matches?.('#task-form select[name="area"]')) {
    syncMultiAreaPicker();
    return;
  }
  if (event.target.matches?.('#task-form select[name="day"]') || event.target.matches?.('#task-form input[name="split_day"]') || event.target.matches?.('#task-form input[name^="split_minutes_"]')) {
    syncSplitPicker();
    return;
  }
  if (event.target.id === "week-picker") {
    currentWeek = mondayKey(event.target.value);
    await loadTasks();
  } else if (event.target.dataset.action === "import") {
    await importBackup(event.target.files?.[0]);
    event.target.value = "";
  }
});

window.addEventListener("focus", () => { if (session) scheduleTaskRefresh(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && session) scheduleTaskRefresh(); });
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  if (session && !editingTask) renderApp();
});

async function start() {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return showConfigurationError();
  if (!window.supabase) {
    root.innerHTML = '<main class="auth-screen"><section class="auth-card"><h1>NM Planner could not start</h1><p>The secure database library did not load. Check your connection and try again.</p></section></main>';
    return;
  }

  client = window.NMPlannerRuntime?.client;
  if (!client) {
    root.innerHTML = '<main class="auth-screen"><section class="auth-card"><h1>NM Planner could not start</h1><p>The shared secure database client did not initialise. Refresh the page and try again.</p></section></main>';
    return;
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const { data } = await client.auth.getSession();
  await handleSession(data.session);
  client.auth.onAuthStateChange((_event, nextSession) => {
    if (nextSession?.access_token !== session?.access_token) handleSession(nextSession);
  });
}

start();