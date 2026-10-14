(() => {
  const client = window.NMPlannerRuntime?.client;
  if (!client) return;

  const PROVIDER = "microsoft_power_automate";
  const MAX_EVENTS = 500;
  const MAX_RANGE_DAYS = 93;
  const MAX_FILE_BYTES = 512 * 1024;
  const ALLOWED_KEYS = new Set([
    "external_event_id",
    "series_id",
    "title",
    "starts_at",
    "ends_at",
    "is_all_day",
    "source_modified_at",
  ]);

  let importing = false;

  function asDate(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function cleanText(value, max, required = false) {
    if (value === null || value === undefined) return required ? null : "";
    if (typeof value !== "string") return null;
    const text = value.trim();
    if ((required && !text) || text.length > max) return null;
    return text;
  }

  function notify(message, type = "success") {
    if (typeof window.notify === "function") {
      window.notify(message, type);
      return;
    }
    window.alert(message);
  }

  function controlsMarkup() {
    return `
      <div class="calendar-import-block calendar-import-compact">
        <div class="calendar-import-actions">
          <label class="primary-button calendar-file-button">
            Choose calendar.json
            <input type="file" accept=".json,application/json" data-power-automate-calendar-file hidden>
          </label>
          <span class="calendar-import-status" data-power-automate-calendar-status>No calendar imported yet.</span>
        </div>
        <small>Accepted format: <code>calendar.json</code>. The file is read locally and is not stored.</small>
      </div>`;
  }

  function installControls() {
    const host = document.querySelector("[data-power-automate-calendar-controls]");
    if (!host || host.dataset.ready === "true") return;
    host.dataset.ready = "true";
    host.innerHTML = controlsMarkup();
  }

  async function importFile(file) {
    if (importing) return;
    importing = true;
    const status = document.querySelector("[data-power-automate-calendar-status]");

    try {
      if (!file) throw new Error("Choose a calendar.json file.");
      if (file.size > MAX_FILE_BYTES) throw new Error("Calendar snapshot is unexpectedly large.");

      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch (_) {
        throw new Error("The selected file is not valid JSON.");
      }

      const rangeStart = asDate(payload?.range_start);
      const rangeEnd = asDate(payload?.range_end);
      if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) {
        throw new Error("The file must contain valid range_start and range_end values.");
      }
      const rangeDays = (rangeEnd.getTime() - rangeStart.getTime()) / 86400000;
      if (rangeDays > MAX_RANGE_DAYS) throw new Error(`Calendar range cannot exceed ${MAX_RANGE_DAYS} days.`);

      if (!Array.isArray(payload.events)) throw new Error("The file must contain an events array.");
      if (payload.events.length > MAX_EVENTS) throw new Error(`At most ${MAX_EVENTS} events can be imported at once.`);

      const { data: auth } = await client.auth.getSession();
      const user = auth.session?.user;
      if (!user) throw new Error("Sign in to NM Planner before importing the calendar snapshot.");

      const now = new Date().toISOString();
      const seen = new Set();
      const rows = [];

      for (let i = 0; i < payload.events.length; i += 1) {
        const raw = payload.events[i];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error(`events[${i}] must be an object.`);
        }
        const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key));
        if (unknown.length) {
          throw new Error(`events[${i}] contains unsupported fields: ${unknown.join(", ")}.`);
        }

        const externalId = cleanText(raw.external_event_id, 255, true);
        const seriesId = raw.series_id == null ? "" : cleanText(raw.series_id, 255, false);
        const title = cleanText(raw.title, 240, false);
        const startsAt = asDate(raw.starts_at);
        const endsAt = asDate(raw.ends_at);
        const modifiedAt = raw.source_modified_at == null ? null : asDate(raw.source_modified_at);

        if (!externalId) throw new Error(`events[${i}].external_event_id is invalid.`);
        if (seriesId === null) throw new Error(`events[${i}].series_id is invalid.`);
        if (title === null) throw new Error(`events[${i}].title is invalid.`);
        if (!startsAt || !endsAt || endsAt <= startsAt) {
          throw new Error(`events[${i}] has an invalid start/end range.`);
        }
        if (!(startsAt < rangeEnd && endsAt > rangeStart)) {
          throw new Error(`events[${i}] is outside the declared calendar range.`);
        }
        if (raw.source_modified_at != null && !modifiedAt) {
          throw new Error(`events[${i}].source_modified_at is invalid.`);
        }
        if (seen.has(externalId)) throw new Error(`Duplicate event id found at events[${i}].`);
        seen.add(externalId);

        rows.push({
          user_id: user.id,
          provider: PROVIDER,
          external_event_id: externalId,
          series_id: seriesId || null,
          title: title || "",
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          is_all_day: raw.is_all_day === true,
          source_modified_at: modifiedAt?.toISOString() || null,
          event_state: "active",
          last_seen_at: now,
          area: null,
          quadrant: null,
        });
      }

      const ids = rows.map((row) => row.external_event_id);
      const [rulesResult, existingResult] = await Promise.all([
        client
          .from("calendar_classification_rules")
          .select("rule_type,match_value,area,quadrant")
          .eq("user_id", user.id)
          .eq("provider", "microsoft"),
        ids.length
          ? client
              .from("external_calendar_events")
              .select("external_event_id,area,quadrant")
              .eq("user_id", user.id)
              .eq("provider", PROVIDER)
              .in("external_event_id", ids)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (rulesResult.error || existingResult.error) {
        throw new Error("Could not load existing calendar classifications.");
      }

      const rules = rulesResult.data || [];
      const existing = new Map((existingResult.data || []).map((row) => [row.external_event_id, row]));

      for (const row of rows) {
        const seriesRule = row.series_id
          ? rules.find((rule) => rule.rule_type === "series" && rule.match_value === row.series_id)
          : null;
        const matched = seriesRule || rules.find(
          (rule) => rule.rule_type === "title_exact" && rule.match_value === row.title
        );
        const previous = existing.get(row.external_event_id);
        row.area = matched?.area ?? previous?.area ?? null;
        row.quadrant = matched?.quadrant ?? previous?.quadrant ?? null;
      }

      if (rows.length) {
        const { error } = await client
          .from("external_calendar_events")
          .upsert(rows, { onConflict: "user_id,provider,external_event_id" });
        if (error) throw error;
      }

      const { data: inRange, error: rangeError } = await client
        .from("external_calendar_events")
        .select("external_event_id")
        .eq("user_id", user.id)
        .eq("provider", PROVIDER)
        .lt("starts_at", rangeEnd.toISOString())
        .gt("ends_at", rangeStart.toISOString());

      if (rangeError) throw rangeError;

      const staleIds = (inRange || [])
        .map((row) => row.external_event_id)
        .filter((id) => !seen.has(id));

      if (staleIds.length) {
        const { error } = await client
          .from("external_calendar_events")
          .update({ event_state: "cancelled", last_seen_at: now })
          .eq("user_id", user.id)
          .eq("provider", PROVIDER)
          .in("external_event_id", staleIds);
        if (error) throw error;
      }

      const { error: stateError } = await client
        .from("calendar_sync_state")
        .upsert({
          user_id: user.id,
          provider: PROVIDER,
          last_synced_at: now,
          last_range_start: rangeStart.toISOString().slice(0, 10),
          last_range_end: rangeEnd.toISOString().slice(0, 10),
        }, { onConflict: "user_id,provider" });

      if (stateError) throw stateError;

      if (status) status.textContent = `${rows.length} events imported · ${staleIds.length} cancelled/removed · ${new Date().toLocaleString("en-GB")}`;
      notify(`Calendar updated: ${rows.length} events imported.`);
      window.dispatchEvent(new Event("nmplanner-calendar-changed"));
      window.dispatchEvent(new Event("nmplanner-analytics-changed"));
      window.dispatchEvent(new Event("nmplanner-settings-changed"));
    } catch (error) {
      if (status) status.textContent = `Import failed: ${error.message}`;
      notify(`Calendar import failed: ${error.message}`, "error");
    } finally {
      importing = false;
    }
  }

  document.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-power-automate-calendar-file]");
    if (!input) return;
    const file = input.files?.[0];
    importFile(file).finally(() => {
      input.value = "";
    });
  }, true);

  const observer = new MutationObserver(() => installControls());
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  setTimeout(installControls, 1600);
})();