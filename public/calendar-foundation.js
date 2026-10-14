(() => {
  const calendarClient = window.NMPlannerRuntime?.client;
  const config = window.NMPLANNER_CONFIG || {};
  if (!calendarClient) return;

  const state = {
    loading: false,
    scheduled: false,
    session: null,
    profile: null,
    syncState: null,
    schemaReady: null,
  };

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function humanBytes(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    const date = new Date(y, m - 1, d, 12);
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
  }

  async function load(force = false) {
    if (state.loading) return;
    if (!force && state.profile && state.syncState) return;
    state.loading = true;
    try {
      const { data: auth } = await calendarClient.auth.getSession();
      state.session = auth.session;
      if (!state.session) return;

      const [profileResult, syncResult] = await Promise.all([
        calendarClient.rpc("nmplanner_storage_profile"),
        calendarClient
          .from("calendar_sync_state")
          .select("provider,last_synced_at,last_range_start,last_range_end,sync_horizon_weeks,detail_retention_months,storage_archive_threshold_mb,sunday_planning_enabled")
          .eq("user_id", state.session.user.id)
          .eq("provider", "microsoft")
          .maybeSingle(),
      ]);

      if (profileResult.error || syncResult.error) {
        state.schemaReady = false;
        state.profile = null;
        state.syncState = null;
        return;
      }

      state.schemaReady = true;
      state.profile = profileResult.data || {};
      state.syncState = syncResult.data || {
        provider: "microsoft",
        sync_horizon_weeks: 6,
        detail_retention_months: 6,
        storage_archive_threshold_mb: 25,
        sunday_planning_enabled: true,
      };
    } finally {
      state.loading = false;
    }
  }

  function calendarUploadMarkup() {
    const ready = state.schemaReady === true;
    const statusClass = ready ? "active" : "pending";
    const statusText = ready ? "Ready · calendar.json upload" : "Database foundation pending";

    return `
      <div class="setting-icon calendar-upload-icon">C</div>
      <div class="calendar-foundation-copy calendar-upload-copy">
        <div class="calendar-upload-heading">
          <div>
            <h2>Work / Personal / Other Calendars</h2>
            <p>Upload a <code>calendar.json</code> file to add fixed commitments to your plan.</p>
          </div>
          <span class="status ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <div data-power-automate-calendar-controls></div>
      </div>`;
  }

  function profileMarkup() {
    if (state.schemaReady === false) {
      return `
        <article class="setting-card data-lifecycle-card" data-data-lifecycle>
          <div class="setting-icon">◫</div>
          <div>
            <h2>Data retention & archive</h2>
            <p>Run <code>database/026_calendar_monthly_archive_foundation.sql</code> to enable compact calendar storage, monthly summaries and storage monitoring.</p>
            <span class="status pending">Migration 026 required</span>
          </div>
        </article>`;
    }

    const profile = state.profile || {};
    const rows = profile.rows || {};
    const sync = state.syncState || {};
    const retention = Number(sync.detail_retention_months || profile.detail_retention_months || 6);
    const threshold = Number(sync.storage_archive_threshold_mb || profile.archive_threshold_mb || 25);
    const totalRows = Object.values(rows).reduce((sum, value) => sum + Number(value || 0), 0);
    const recommendation = profile.archive_recommended
      ? `Archive review recommended. Detailed data before ${formatDate(profile.archive_before)} is eligible after a local archive is created.`
      : `No archive is needed. Detailed data is below the ${threshold} MB review threshold.`;

    return `
      <article class="setting-card data-lifecycle-card" data-data-lifecycle>
        <div class="setting-icon">◫</div>
        <div>
          <h2>Data retention & archive</h2>
          <p>Detailed records stay available for active analysis. Older detail is only archived when storage grows; compact monthly summaries are retained long-term.</p>
          <div class="storage-profile">
            <div><strong>${humanBytes(profile.approx_bytes)}</strong><span>Approx. planner detail</span></div>
            <div><strong>${totalRows}</strong><span>Measured rows</span></div>
            <div><strong>${rows.monthly_summaries || 0}</strong><span>Monthly summaries</span></div>
          </div>
          <div class="retention-controls">
            <label><span>Detailed history</span>
              <select data-retention-months>
                ${[3,6,9,12].map((value) => `<option value="${value}" ${retention === value ? "selected" : ""}>${value} months</option>`).join("")}
              </select>
            </label>
            <label><span>Archive review threshold</span>
              <select data-archive-threshold>
                ${[10,25,50,100].map((value) => `<option value="${value}" ${threshold === value ? "selected" : ""}>${value} MB</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="calendar-foundation-actions">
            <button type="button" class="secondary-button" data-lifecycle-action="refresh">Refresh usage</button>
            <button type="button" class="secondary-button" data-lifecycle-action="save">Save retention policy</button>
            ${profile.archive_recommended ? '<button type="button" class="secondary-button" data-lifecycle-action="archive">Download eligible archive</button>' : ""}
          </div>
          <div class="archive-guidance ${profile.archive_recommended ? "attention" : ""}">
            <strong>${profile.archive_recommended ? "Archive review" : "Storage healthy"}</strong>
            <span>${escapeHtml(recommendation)}</span>
          </div>
          <small class="storage-privacy-note">Archive files are intended to be downloaded locally. NM Planner stores only a tiny archive ledger and monthly summaries — not the archive file itself.</small>
        </div>
      </article>`;
  }

  async function install(force = false) {
    const grid = document.querySelector(".settings-grid");
    if (!grid) return;
    await load(force);

    const calendarCard = [...grid.querySelectorAll(".setting-card")].find((card) => {
      const heading = card.querySelector("h2")?.textContent || "";
      return card.dataset.calendarFoundation === "true"
        || /Microsoft 365.*calendar/i.test(heading)
        || /Work\s*\/\s*Personal\s*\/\s*Other Calendars Upload/i.test(heading);
    });
    if (calendarCard) {
      const calendarHtml = calendarUploadMarkup();
      const calendarSignature = `${state.schemaReady}|calendar-json-only`;
      if (calendarCard.dataset.calendarFoundationSignature !== calendarSignature) {
        calendarCard.dataset.calendarFoundation = "true";
        calendarCard.dataset.calendarFoundationSignature = calendarSignature;
        calendarCard.innerHTML = calendarHtml;
      }
    }

    const existing = grid.querySelector("[data-data-lifecycle]");
    const lifecycleHtml = profileMarkup();
    const lifecycleSignature = JSON.stringify({
      ready: state.schemaReady,
      bytes: state.profile?.approx_bytes || 0,
      archive: state.profile?.archive_recommended || false,
      before: state.profile?.archive_before || "",
      retention: state.syncState?.detail_retention_months || state.profile?.detail_retention_months || 6,
      threshold: state.syncState?.storage_archive_threshold_mb || state.profile?.archive_threshold_mb || 25,
      summaries: state.profile?.rows?.monthly_summaries || 0,
    });
    if (existing?.dataset.lifecycleSignature === lifecycleSignature) return;

    const holder = document.createElement("div");
    holder.innerHTML = lifecycleHtml;
    const card = holder.firstElementChild;
    if (card) {
      card.dataset.lifecycleSignature = lifecycleSignature;
      if (existing) existing.replaceWith(card);
      else {
        const account = [...grid.querySelectorAll(".setting-card")].find((node) => node.classList.contains("danger-zone"));
        if (account) grid.insertBefore(card, account);
        else grid.append(card);
      }
    }
  }

  async function fetchPaged(table, selectFields, applyFilter) {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      let query = calendarClient
        .from(table)
        .select(selectFields)
        .eq("user_id", state.session.user.id)
        .range(from, from + pageSize - 1);
      query = applyFilter(query);
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function archiveCutoffIso(cutoff) {
    const [year, month, day] = String(cutoff).split("-").map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
  }

  async function downloadEligibleArchive() {
    if (!state.session || state.schemaReady !== true || !state.profile?.archive_recommended) return;
    const cutoff = state.profile.archive_before;
    if (!cutoff) return;

    const proceed = window.confirm(
      `Create a local archive of detailed NM Planner records before ${formatDate(cutoff)}? Nothing will be deleted from Supabase.`
    );
    if (!proceed) return;

    const cutoffIso = archiveCutoffIso(cutoff);
    const [
      taskRows,
      eventRows,
      reviewRows,
      wellbeingRows,
      walkingRows,
      calendarRows,
      monthlyRows,
      settingsRows,
    ] = await Promise.all([
      fetchPaged("tasks", "*", (query) => query.lt("week", cutoff).order("week")),
      fetchPaged("task_events", "*", (query) => query.lt("occurred_at", cutoffIso).order("occurred_at")),
      fetchPaged("task_reviews", "*", (query) => query.lt("from_date", cutoff).order("from_date")),
      fetchPaged("wellbeing_daily", "*", (query) => query.lt("entry_date", cutoff).order("entry_date")),
      fetchPaged("walking_logs", "*", (query) => query.lt("walk_date", cutoff).order("walk_date")),
      fetchPaged("external_calendar_events", "*", (query) => query.lt("ends_at", cutoffIso).order("ends_at")),
      fetchPaged("monthly_summaries", "*", (query) => query.lt("month_start", cutoff).order("month_start")),
      fetchPaged("planner_settings", "*", (query) => query),
    ]);

    const datasets = {
      tasks: taskRows,
      task_events: eventRows,
      task_reviews: reviewRows,
      wellbeing_daily: wellbeingRows,
      walking_logs: walkingRows,
      external_calendar_events: calendarRows,
      monthly_summaries: monthlyRows,
      planner_settings: settingsRows,
    };
    const counts = Object.fromEntries(Object.entries(datasets).map(([name, rows]) => [name, rows.length]));
    const archive = {
      archive_format: "nmplanner.detail-archive",
      archive_version: 1,
      created_at: new Date().toISOString(),
      detail_before: cutoff,
      deletion_performed: false,
      note: "Local archive candidate only. Creating this file does not delete cloud data.",
      row_counts: counts,
      data: datasets,
    };
    const canonical = JSON.stringify(archive);
    const hash = await sha256Hex(canonical);
    const finalArchive = { ...archive, sha256: hash };
    const fileText = JSON.stringify(finalArchive, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `nmplanner-detail-archive-before-${cutoff}-created-${stamp}.json`;

    const blob = new Blob([fileText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    const periodStarts = [
      taskRows.map((row) => row.week),
      reviewRows.map((row) => row.from_date),
      wellbeingRows.map((row) => row.entry_date),
      walkingRows.map((row) => row.walk_date),
      monthlyRows.map((row) => row.month_start),
    ].flat().filter(Boolean).sort();
    const periodStart = periodStarts[0] || cutoff;

    await calendarClient.from("archive_log").insert({
      user_id: state.session.user.id,
      period_start: periodStart,
      period_end: new Date(new Date(cutoffIso).getTime() - 86400000).toISOString().slice(0, 10),
      file_name: fileName,
      sha256: hash,
      row_counts: counts,
    });

    window.alert("Archive downloaded. No cloud data was deleted. Keep the archive file somewhere safe before any future cleanup.");
    state.profile = null;
    await install(true);
  }

  async function savePolicy() {
    if (!state.session || state.schemaReady !== true) return;
    const retention = Number(document.querySelector("[data-retention-months]")?.value || 6);
    const threshold = Number(document.querySelector("[data-archive-threshold]")?.value || 25);
    const payload = {
      user_id: state.session.user.id,
      provider: "microsoft",
      sync_horizon_weeks: Number(state.syncState?.sync_horizon_weeks || 6),
      detail_retention_months: retention,
      storage_archive_threshold_mb: threshold,
      sunday_planning_enabled: state.syncState?.sunday_planning_enabled !== false,
    };
    const { error } = await calendarClient.from("calendar_sync_state").upsert(payload, { onConflict: "user_id,provider" });
    if (error) {
      window.alert(`Retention settings could not be saved: ${error.message}`);
      return;
    }
    state.profile = null;
    state.syncState = null;
    await install(true);
    window.dispatchEvent(new Event("nmplanner-settings-changed"));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-lifecycle-action]");
    if (!button) return;
    if (button.dataset.lifecycleAction === "refresh") {
      state.profile = null;
      install(true).catch(() => {});
    } else if (button.dataset.lifecycleAction === "save") {
      savePolicy().catch(() => {});
    } else if (button.dataset.lifecycleAction === "archive") {
      downloadEligibleArchive().catch((error) => window.alert(`Archive could not be created: ${error.message}`));
    }
  }, true);

  const observer = new MutationObserver(() => {
    if (!document.querySelector(".settings-grid")) return;
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      install(false).catch(() => {});
    });
  });
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  setTimeout(() => install(false).catch(() => {}), 1400);
})();
