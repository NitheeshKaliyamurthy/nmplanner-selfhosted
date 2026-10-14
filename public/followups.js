(() => {
  const followupClient = window.NMPlannerRuntime?.client;
  if (!followupClient) return;

  const state = {
    rootTaskId: null,
    familyRootTaskId: null,
    tasks: [],
    session: null,
    editorTaskId: null,
    editorParentId: null,
    loadToken: 0,
    rescheduleSchemaReady: null,
    lifecycleSchemaReady: null,
  };

  const AREAS = ["BCU / Teaching", "Research", "WorldSkills", "Family / Home", "Personal Time"];
  const QUADRANTS = [
    ["", "Decide later"],
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

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

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
    const date = value instanceof Date ? new Date(value) : parseDate(value);
    const distance = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - distance);
    return dateKey(date);
  }

  function plannedDate(task) {
    if (!task?.week || !Number.isInteger(task.day)) return "";
    const date = parseDate(task.week);
    date.setDate(date.getDate() + task.day);
    return dateKey(date);
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(parseDate(value));
  }

  function formatTime(totalMinutes) {
    if (!Number.isInteger(totalMinutes)) return "";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function reasonLabel(value) {
    return REASONS.find(([key]) => key === value)?.[1] || "";
  }

  function normaliseArea(value) {
    return value === "Personal / Admin" || value === "Lunch" ? "Personal Time" : value;
  }

  function currentTaskId() {
    return document.querySelector('#task-dialog [data-action="delete"][data-id]')?.dataset.id || null;
  }

  function taskById(id) {
    return state.tasks.find((task) => task.id === id) || null;
  }

  function familyRootId(id) {
    let cursor = id;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const task = taskById(cursor);
      if (!task?.parent_task_id) return cursor;
      cursor = task.parent_task_id;
    }
    return id;
  }

  function editorShell() {
    return `
      <div class="followup-editor" data-followup-editor hidden>
        <div class="followup-editor-heading">
          <div>
            <p class="eyebrow" data-followup-editor-kicker>NEW FOLLOW-UP</p>
            <h3 data-followup-editor-title>Add follow-up work</h3>
          </div>
          <button type="button" class="icon-button" data-followup-action="cancel-editor" aria-label="Close follow-up editor">×</button>
        </div>
        <div class="followup-form-grid">
          <label class="field wide"><span>Follow-up task</span><input data-followup-field="title" maxlength="160" placeholder="What needs to happen next?"></label>
          <label class="field"><span>Planned date</span><input data-followup-field="planned" type="date"></label>
          <label class="field"><span>Due date</span><input data-followup-field="due" type="date"></label>
          <label class="field wide"><span>Reason for follow-up</span><select data-followup-field="reason"><option value="">Choose why this follow-up is needed…</option>${REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select></label>
          <label class="field"><span>Quadrant</span><select data-followup-field="quadrant">${QUADRANTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
          <label class="field"><span>Focus area</span><select data-followup-field="area">${AREAS.map((area) => `<option>${escapeHtml(area)}</option>`).join("")}</select></label>
          <label class="field"><span>Estimated time</span><select data-followup-field="minutes">${[15, 30, 45, 60, 90, 120, 180].map((minutes) => `<option value="${minutes}">${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes > 60 ? "s" : ""}`}</option>`).join("")}</select></label>
          <label class="followup-completed"><input data-followup-field="completed" type="checkbox"> <span>Completed</span></label>
          <label class="field wide"><span>Notes</span><textarea data-followup-field="notes" maxlength="4000" placeholder="Optional detail, including context for the follow-up reason"></textarea></label>
        </div>
        <div class="followup-editor-error" data-followup-error hidden></div>
        <div class="followup-editor-actions">
          <button type="button" class="danger-button" data-followup-action="delete" hidden>Delete follow-up</button>
          <span></span>
          <button type="button" class="secondary-button" data-followup-action="cancel-editor">Cancel</button>
          <button type="button" class="primary-button" data-followup-action="save">Save follow-up</button>
        </div>
      </div>`;
  }

  function followupSection(taskId) {
    return `
      <section class="followup-section" data-followups-for="${taskId}">
        <div class="followup-heading">
          <div>
            <p class="eyebrow">TASK HISTORY</p>
            <h3>Follow-up chain</h3>
            <p>The current follow-up is the actionable task. Any earlier stage that already had a calendar time remains visible on its original Day Plan slot with a ★ follow-up marker so the historical time plan is not lost.</p>
          </div>
          <button type="button" class="secondary-button" data-followup-action="add" data-parent-id="${taskId}">＋ Add next follow-up</button>
        </div>
        <div class="followup-parent" data-followup-parent hidden></div>
        <div class="followup-tree" data-followup-tree><p class="followup-loading">Loading task chain…</p></div>
        ${editorShell()}
      </section>`;
  }

  function installSection() {
    const dialog = document.querySelector("#task-dialog");
    const form = dialog?.querySelector("#task-form");
    const taskId = currentTaskId();
    if (!dialog || !form || !taskId) return;

    const existing = dialog.querySelector(".followup-section");
    if (existing?.dataset.followupsFor === taskId) return;
    existing?.remove();

    const formError = form.querySelector("#form-error");
    const holder = document.createElement("div");
    holder.innerHTML = followupSection(taskId);
    const section = holder.firstElementChild;
    form.insertBefore(section, formError || form.querySelector(".dialog-actions"));
    loadTree(taskId);
  }

  async function getSession() {
    if (state.session) return state.session;
    const { data } = await followupClient.auth.getSession();
    state.session = data.session;
    return state.session;
  }

  function taskQuery(selectFields, session) {
    return followupClient
      .from("tasks")
      .select(selectFields)
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: true });
  }

  async function loadTree(taskId) {
    const token = ++state.loadToken;
    state.rootTaskId = taskId;
    const session = await getSession();
    const tree = document.querySelector(`[data-followups-for="${taskId}"] [data-followup-tree]`);
    if (!session || !tree) return;

    const lifecycleSelect = "id,parent_task_id,title,week,quadrant,day,area,due,minutes,notes,completed,created_at,followup_reason,rescheduled_from_week,rescheduled_to_week,planned_start_minute,superseded_by_followup,discarded_at";
    const activeLeafSelect = "id,parent_task_id,title,week,quadrant,day,area,due,minutes,notes,completed,created_at,followup_reason,rescheduled_from_week,rescheduled_to_week,planned_start_minute,superseded_by_followup";
    const rescheduleSelect = "id,parent_task_id,title,week,quadrant,day,area,due,minutes,notes,completed,created_at,followup_reason,rescheduled_from_week,rescheduled_to_week";
    const baseSelect = "id,parent_task_id,title,week,quadrant,day,area,due,minutes,notes,completed,created_at";

    let result = await taskQuery(lifecycleSelect, session);
    if (result.error && /discarded_at|schema cache|column/i.test(result.error.message || "")) {
      state.lifecycleSchemaReady = false;
      result = await taskQuery(activeLeafSelect, session);
    } else if (!result.error) {
      state.lifecycleSchemaReady = true;
    }

    if (result.error && /planned_start_minute|superseded_by_followup|schema cache|column/i.test(result.error.message || "")) {
      result = await taskQuery(rescheduleSelect, session);
    }

    if (result.error && /followup_reason|rescheduled_from_week|rescheduled_to_week|schema cache|column/i.test(result.error.message || "")) {
      state.rescheduleSchemaReady = false;
      result = await taskQuery(baseSelect, session);
    } else if (!result.error) {
      state.rescheduleSchemaReady = true;
    }

    if (token !== state.loadToken) return;
    if (result.error) {
      const missingColumn = /parent_task_id|schema cache|column/i.test(result.error.message || "");
      tree.innerHTML = missingColumn
        ? '<div class="followup-migration"><strong>Follow-up setup is ready.</strong><span>Run the required follow-up migration in Supabase to enable this feature.</span></div>'
        : `<div class="followup-migration"><strong>Follow-ups could not be loaded.</strong><span>${escapeHtml(result.error.message)}</span></div>`;
      return;
    }

    state.tasks = (result.data || []).map((task) => ({
      ...task,
      area: normaliseArea(task.area),
      followup_reason: task.followup_reason || null,
      rescheduled_from_week: task.rescheduled_from_week || null,
      rescheduled_to_week: task.rescheduled_to_week || null,
      superseded_by_followup: task.superseded_by_followup === true,
      discarded_at: task.discarded_at || null,
      planned_start_minute: Number.isInteger(task.planned_start_minute) ? task.planned_start_minute : null,
    }));
    state.familyRootTaskId = familyRootId(taskId);
    renderTree(taskId);
  }

  function renderTree(taskId) {
    const section = document.querySelector(`[data-followups-for="${taskId}"]`);
    const tree = section?.querySelector("[data-followup-tree]");
    const familyBox = section?.querySelector("[data-followup-parent]");
    if (!tree) return;

    const byParent = new Map();
    for (const task of state.tasks) {
      if (!task.parent_task_id) continue;
      if (!byParent.has(task.parent_task_id)) byParent.set(task.parent_task_id, []);
      byParent.get(task.parent_task_id).push(task);
    }
    for (const children of byParent.values()) {
      children.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    }

    const rootId = familyRootId(taskId);
    state.familyRootTaskId = rootId;
    const original = taskById(rootId);
    const hasFamily = Boolean(original && (rootId !== taskId || (byParent.get(rootId) || []).length));

    if (!hasFamily) {
      if (familyBox) {
        familyBox.hidden = true;
        familyBox.innerHTML = "";
      }
      tree.innerHTML = '<div class="followup-empty"><strong>No follow-up history yet</strong><span>Add the next action when this task needs to continue on another step or day.</span></div>';
      return;
    }

    const familyIds = new Set();
    const collect = (id) => {
      if (!id || familyIds.has(id)) return;
      familyIds.add(id);
      for (const child of byParent.get(id) || []) collect(child.id);
    };
    collect(rootId);

    const terminalTasks = [...familyIds]
      .map(taskById)
      .filter(Boolean)
      .filter((task) => !(byParent.get(task.id) || []).length);
    const operationalTerminals = terminalTasks.filter((task) => !task.discarded_at);
    const openTerminals = operationalTerminals.filter((task) => !task.completed);
    const latestOpen = [...openTerminals].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    const latestOperational = [...operationalTerminals].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    const addParent = latestOpen || latestOperational || original;
    const headerAdd = section?.querySelector('.followup-heading [data-followup-action="add"]');
    if (headerAdd && addParent) {
      headerAdd.dataset.parentId = addParent.id;
      headerAdd.disabled = Boolean(addParent.discarded_at);
    }

    if (familyBox && original) {
      familyBox.hidden = false;
      const activeText = openTerminals.length === 1
        ? "1 current task"
        : openTerminals.length > 1
          ? `${openTerminals.length} active branches`
          : "no open branch";
      const discardedCount = terminalTasks.filter((task) => task.discarded_at).length;
      const discardedText = discardedCount ? ` · ${discardedCount} discarded` : "";
      familyBox.innerHTML = `<span>Original task</span><strong>${escapeHtml(original.title)}</strong><em>${familyIds.size} step${familyIds.size === 1 ? "" : "s"} · ${activeText}${discardedText}</em>`;
    }

    function taskMeta(task, isOriginal, hasChildren) {
      const planned = plannedDate(task);
      const reason = reasonLabel(task.followup_reason);
      const moved = task.rescheduled_from_week && task.rescheduled_to_week
        ? `Moved ${formatDate(task.rescheduled_from_week)} → ${formatDate(task.rescheduled_to_week)}`
        : "";
      const status = task.discarded_at
        ? "Discarded"
        : (hasChildren || task.superseded_by_followup)
          ? "History step"
          : task.completed
            ? "Completed"
            : "Current active step";
      const start = Number.isInteger(task.planned_start_minute) ? `at ${formatTime(task.planned_start_minute)}` : "";
      return [
        isOriginal ? "Original task" : "Follow-up",
        status,
        `${Number(task.minutes || 0)}m estimate`,
        planned ? `Planned ${formatDate(planned)} ${start}`.trim() : "",
        task.due ? `Due ${formatDate(task.due)}` : "",
        task.quadrant ? task.quadrant.toUpperCase() : "",
        reason ? `Reason: ${reason}` : "",
        moved,
      ].filter(Boolean).join(" · ");
    }

    function renderNode(task, depth, isOriginal = false) {
      const children = byParent.get(task.id) || [];
      const hasChildren = children.length > 0;
      const terminal = !hasChildren;
      const actionable = terminal && !task.discarded_at;
      const selected = task.id === taskId;
      const nodeClasses = [
        "followup-node",
        hasChildren || task.superseded_by_followup ? "history" : "terminal",
        task.completed ? "completed" : "",
        task.discarded_at ? "discarded" : "",
        selected ? "selected" : "",
        isOriginal ? "original" : "",
      ].filter(Boolean).join(" ");
      const badge = task.discarded_at
        ? "Discarded"
        : isOriginal
          ? "Original"
          : selected && actionable && !task.completed
            ? "Current task"
            : (hasChildren || task.superseded_by_followup)
              ? "History"
              : task.completed
                ? "Completed"
                : "Active";
      const meta = taskMeta(task, isOriginal, hasChildren);

      const statusControl = actionable
        ? `<button type="button" class="followup-check" data-followup-action="toggle" data-id="${task.id}" aria-label="${task.completed ? "Mark incomplete" : "Mark complete"}">${task.completed ? "✓" : ""}</button>`
        : `<span class="followup-history-mark" aria-hidden="true">↳</span>`;
      const main = actionable && !isOriginal
        ? `<button type="button" class="followup-main" data-followup-action="edit" data-id="${task.id}"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(meta)}</span></button>`
        : `<div class="followup-main"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(meta)}</span></div>`;
      const add = actionable
        ? `<button type="button" class="followup-add-child" data-followup-action="add" data-parent-id="${task.id}" aria-label="Add follow-up to ${escapeHtml(task.title)}">＋</button>`
        : '<span class="followup-node-spacer"></span>';

      return `
        <div class="followup-branch">
          <div class="${nodeClasses}" style="--followup-depth:${Math.min(depth, 6)}">
            ${statusControl}
            ${main}
            <div class="followup-node-end"><span class="followup-stage-badge">${escapeHtml(badge)}</span>${add}</div>
          </div>
          ${children.map((child) => renderNode(child, depth + 1, false)).join("")}
        </div>`;
    }

    tree.innerHTML = original ? renderNode(original, 0, true) : '<div class="followup-empty"><span>The original task could not be loaded.</span></div>';
  }

  function editorElement() {
    return document.querySelector(`[data-followups-for="${state.rootTaskId}"] [data-followup-editor]`);
  }

  function field(name) {
    return editorElement()?.querySelector(`[data-followup-field="${name}"]`);
  }

  function openEditor(parentId, taskId = null) {
    const editor = editorElement();
    if (!editor) return;
    const task = taskId ? taskById(taskId) : null;
    const parent = taskById(parentId);
    if (task?.discarded_at || parent?.discarded_at) return;
    const today = dateKey(new Date());

    state.editorTaskId = taskId;
    state.editorParentId = task?.parent_task_id || parentId;
    editor.hidden = false;
    editor.querySelector("[data-followup-editor-kicker]").textContent = task ? "EDIT CURRENT FOLLOW-UP" : "NEW FOLLOW-UP";
    editor.querySelector("[data-followup-editor-title]").textContent = task ? "Update current follow-up" : `Follow up: ${parent?.title || "task"}`;
    field("title").value = task?.title || "";
    field("planned").value = task ? plannedDate(task) : today;
    field("due").value = task?.due || "";
    field("reason").value = task?.followup_reason || "";
    field("quadrant").value = task?.quadrant || "";
    field("area").value = normaliseArea(task?.area || parent?.area || "Personal Time");
    field("minutes").value = String(task?.minutes || 60);
    field("completed").checked = Boolean(task?.completed);
    field("notes").value = task?.notes || "";
    const deleteButton = editor.querySelector('[data-followup-action="delete"]');
    deleteButton.hidden = !task;
    const error = editor.querySelector("[data-followup-error]");
    error.hidden = true;
    error.textContent = "";
    field("title").focus();
    editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeEditor() {
    const editor = editorElement();
    if (editor) editor.hidden = true;
    state.editorTaskId = null;
    state.editorParentId = null;
  }

  function showEditorError(message) {
    const error = editorElement()?.querySelector("[data-followup-error]");
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  async function saveFollowup(button) {
    const session = await getSession();
    if (!session) return showEditorError("Your session has expired. Refresh NM Planner and sign in again.");
    const title = field("title")?.value.trim();
    const planned = field("planned")?.value;
    const reason = field("reason")?.value;
    if (!title) return showEditorError("Enter a follow-up task.");
    if (!planned) return showEditorError("Choose a planned date.");
    if (!reason) return showEditorError("Choose why this follow-up is needed. This keeps the task chain useful for workflow analysis.");
    if (state.rescheduleSchemaReady === false) return showEditorError("Run database/005_followup_rescheduling.sql in Supabase before saving follow-up reasons and future-week carry-forward.");

    const plannedObject = parseDate(planned);
    const day = (plannedObject.getDay() + 6) % 7;
    const payload = {
      user_id: session.user.id,
      parent_task_id: state.editorParentId,
      title,
      week: mondayKey(planned),
      day,
      due: field("due")?.value || null,
      followup_reason: reason,
      quadrant: field("quadrant")?.value || null,
      area: field("area")?.value || "Personal Time",
      minutes: Number(field("minutes")?.value || 60),
      notes: field("notes")?.value || "",
      completed: Boolean(field("completed")?.checked),
    };

    button.disabled = true;
    button.textContent = "Saving…";
    const query = state.editorTaskId
      ? followupClient.from("tasks").update(payload).eq("id", state.editorTaskId)
      : followupClient.from("tasks").insert(payload);
    const { error } = await query;
    button.disabled = false;
    button.textContent = "Save follow-up";

    if (error) return showEditorError(error.message);
    closeEditor();
    await loadTree(state.rootTaskId);
    window.dispatchEvent(new Event("nmplanner-followup-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("focus"));
  }

  async function toggleFollowup(id) {
    const task = taskById(id);
    if (!task || task.discarded_at) return;
    const { error } = await followupClient.from("tasks").update({ completed: !task.completed }).eq("id", id);
    if (error) return showEditorError(error.message);
    await loadTree(state.rootTaskId);
    window.dispatchEvent(new Event("nmplanner-followup-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("focus"));
  }

  async function deleteFollowup() {
    const id = state.editorTaskId;
    if (!id) return;
    const task = taskById(id);
    const childCount = state.tasks.filter((item) => item.parent_task_id === id).length;
    const question = childCount
      ? `Delete “${task?.title || "this follow-up"}”? Its ${childCount} direct follow-up${childCount === 1 ? "" : "s"} will remain as standalone tasks.`
      : `Delete “${task?.title || "this follow-up"}”?`;
    if (!window.confirm(question)) return;
    const { error } = await followupClient.from("tasks").delete().eq("id", id);
    if (error) return showEditorError(error.message);
    closeEditor();
    await loadTree(state.rootTaskId);
    window.dispatchEvent(new Event("nmplanner-followup-changed"));
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
    window.dispatchEvent(new Event("focus"));
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-followup-action]");
    if (!button) return;
    const action = button.dataset.followupAction;
    if (action === "add") openEditor(button.dataset.parentId);
    else if (action === "edit") openEditor(taskById(button.dataset.id)?.parent_task_id, button.dataset.id);
    else if (action === "cancel-editor") closeEditor();
    else if (action === "save") await saveFollowup(button);
    else if (action === "toggle") await toggleFollowup(button.dataset.id);
    else if (action === "delete") await deleteFollowup();
  });

  const observer = new MutationObserver(() => installSection());
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  installSection();
})();