/* global client, session, loadTasks, notify */

(() => {
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  let patchScheduled = false;
  let busy = false;

  function canonicalize(value) {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Backup contains a non-finite number.");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    }
    throw new Error("Backup contains an unsupported JSON value.");
  }

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(canonicalize(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function setStatus(message, kind = "info") {
    const status = document.querySelector("[data-backup-v2-status]");
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll("[data-backup-v2-action]").forEach((button) => {
      button.disabled = disabled;
    });
  }

  function formatCounts(counts = {}) {
    return [
      `${Number(counts.tasks || 0)} tasks`,
      `${Number(counts.task_reviews || 0)} reviews`,
      `${Number(counts.task_events || 0)} history events`,
      `${Number(counts.wellbeing_daily || 0)} sleep records`,
      `${Number(counts.walking_logs || 0)} walking records`,
    ].join(" · ");
  }

  function rpcMissing(error) {
    const text = `${error?.message || ""} ${error?.details || ""}`;
    return /export_full_backup_v2|restore_full_backup_v2|schema cache|could not find the function/i.test(text);
  }

  function rpcErrorMessage(error) {
    if (rpcMissing(error)) return "Full Backup v2 needs database migration 018. Run database/018_full_backup_v2.sql in Supabase once.";
    let detail = error?.details;
    if (typeof detail === "string") {
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.code === "NMV2_CURRENT_STATE_CHANGED") return "The planner changed after the backup preview. Please choose the backup again so it can be rechecked safely.";
        if (parsed?.code === "NMV2_CONFIRMATION_REQUIRED") return "Restore confirmation did not match the selected backup.";
        if (parsed?.code === "NMV2_POST_VERIFY_FAILED") return `Restore verification failed (${parsed.check || "integrity check"}). Your previous planner data was kept.`;
        if (parsed?.code) return `${parsed.code}: ${parsed.message || "Restore could not be completed."}`;
      } catch (_) {}
    }
    return error?.message || "The backup operation could not be completed.";
  }

  function browserEnvelopeError(backup) {
    if (!backup || typeof backup !== "object" || Array.isArray(backup)) return "The selected file is not a valid NM Planner backup object.";
    if (backup.backup_format !== "nmplanner.full-backup") return "This is not an NM Planner Full Backup file.";
    if (backup.backup_version !== 2 || backup.backup_revision !== 0) return "This backup version is not supported by this NM Planner build.";
    if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) return "The backup data section is missing.";
    for (const name of ["tasks", "task_reviews", "task_events", "planner_settings", "wellbeing_daily", "walking_logs"]) {
      if (!Array.isArray(backup.data[name])) return `The backup dataset “${name}” is missing or invalid.`;
    }
    if (backup.integrity?.algorithm !== "SHA-256" || backup.integrity?.canonicalization !== "RFC8785" || backup.integrity?.scope !== "data") {
      return "The backup integrity metadata is missing or unsupported.";
    }
    if (!/^[0-9a-f]{64}$/i.test(String(backup.integrity?.sha256 || ""))) return "The backup checksum is missing or invalid.";
    return "";
  }

  async function downloadBackup() {
    if (busy || !session || !client) return;
    busy = true;
    setButtonsDisabled(true);
    setStatus("Preparing complete backup…");
    try {
      const { data, error } = await client.rpc("export_full_backup_v2");
      if (error) throw error;
      const backup = data;
      if (!backup?.data) throw new Error("Supabase returned an incomplete backup package.");

      backup.integrity = {
        algorithm: "SHA-256",
        canonicalization: "RFC8785",
        scope: "data",
        sha256: await sha256Hex(backup.data),
      };

      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nmplanner-full-backup-v2-${stamp}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus(`Backup downloaded · ${formatCounts(backup.record_counts)}`, "success");
      if (typeof notify === "function") notify("Full Backup v2 downloaded.", "success");
    } catch (error) {
      const message = rpcErrorMessage(error);
      setStatus(message, "error");
      if (typeof notify === "function") notify(message, "error");
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  async function restoreBackup(file) {
    if (busy || !file || !session || !client) return;
    if (file.size > MAX_FILE_BYTES) {
      setStatus("Backup file is larger than the supported 50 MB limit.", "error");
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setStatus("Checking backup integrity…");
    try {
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch (_) {
        throw new Error("The selected file is not valid JSON.");
      }

      const envelopeError = browserEnvelopeError(backup);
      if (envelopeError) throw new Error(envelopeError);

      const calculated = await sha256Hex(backup.data);
      if (calculated.toLowerCase() !== String(backup.integrity.sha256).toLowerCase()) {
        throw new Error("Backup integrity check failed. The file may be incomplete, damaged or modified.");
      }

      setStatus("Backup checksum verified · running safe preflight…");
      const { data: preflight, error: preflightError } = await client.rpc("restore_full_backup_v2", {
        p_backup: backup,
        p_dry_run: true,
        p_confirmation_backup_id: null,
        p_expected_current_state_hash: null,
      });
      if (preflightError) throw preflightError;

      if (!preflight?.ready_to_restore) {
        const errors = preflight?.validation?.errors || [];
        const message = errors.length
          ? errors.map((item) => item.message || item.code).join(" ")
          : "The backup failed server-side validation.";
        throw new Error(message);
      }

      const incoming = preflight.incoming?.record_counts || backup.record_counts || {};
      const current = preflight.current_state?.record_counts || {};
      const warnings = preflight.validation?.warnings || [];
      const exported = backup.exported_at ? new Date(backup.exported_at).toLocaleString("en-GB") : "unknown date";
      const warningText = warnings.length ? `\n\nWarnings:\n${warnings.map((item) => `• ${item.message || item.code}`).join("\n")}` : "";
      const confirmation = window.confirm(
        `Restore NM Planner from this Full Backup v2?\n\nBackup exported: ${exported}\nIncoming: ${formatCounts(incoming)}\nCurrent planner: ${formatCounts(current)}\n\nThis will REPLACE the current planner data for your signed-in account. The restore is atomic: if verification fails, your current planner remains unchanged.${warningText}`
      );
      if (!confirmation) {
        setStatus("Restore cancelled. No data was changed.");
        return;
      }

      setStatus("Restoring and verifying planner…");
      const { data: restored, error: restoreError } = await client.rpc("restore_full_backup_v2", {
        p_backup: backup,
        p_dry_run: false,
        p_confirmation_backup_id: backup.backup_id,
        p_expected_current_state_hash: preflight.current_state?.state_hash || null,
      });
      if (restoreError) throw restoreError;
      if (!restored?.ok || restored?.status !== "committed" || !restored?.verification?.passed) {
        throw new Error("Supabase did not confirm a verified restore.");
      }

      const restoredCounts = restored.restore?.restored_record_counts || incoming;
      setStatus(`Restore verified · ${formatCounts(restoredCounts)}`, "success");
      window.alert(`Full Backup v2 restored successfully.\n\n${formatCounts(restoredCounts)}\n\nNM Planner will reload now.`);
      window.location.reload();
    } catch (error) {
      const message = rpcErrorMessage(error);
      setStatus(message, "error");
      if (typeof notify === "function") notify(message, "error");
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  function installCard() {
    if (!session) return;
    const cards = [...document.querySelectorAll(".settings-grid .setting-card")];
    const card = cards.find((item) => item.querySelector("h2")?.textContent.trim() === "Backup and transfer");
    if (!card || card.dataset.backupV2Ready === "true") return;

    const body = card.children[1];
    if (!body) return;
    body.innerHTML = `
      <h2>Backup and transfer</h2>
      <p>Full Backup v2 preserves tasks, follow-up chains, calendar times, review/history records, planner settings, sleep and walking data in one verified JSON file.</p>
      <div class="button-row backup-v2-actions">
        <button type="button" class="secondary-button" data-backup-v2-action="download">Download Full Backup v2</button>
        <button type="button" class="secondary-button" data-backup-v2-action="choose-restore">Restore Full Backup v2</button>
        <input type="file" accept="application/json,.json" data-backup-v2-file hidden>
      </div>
      <small class="backup-v2-status" data-backup-v2-status>No manual SQL or table export is required for normal backups.</small>`;
    card.dataset.backupV2Ready = "true";
  }

  function scheduleInstall() {
    if (patchScheduled) return;
    patchScheduled = true;
    queueMicrotask(() => {
      patchScheduled = false;
      installCard();
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-backup-v2-action]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = button.dataset.backupV2Action;
    if (action === "download") downloadBackup();
    if (action === "choose-restore") document.querySelector("[data-backup-v2-file]")?.click();
  }, true);

  document.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-backup-v2-file]");
    if (!input) return;
    event.stopImmediatePropagation();
    const file = input.files?.[0];
    input.value = "";
    restoreBackup(file);
  }, true);

  const observer = new MutationObserver(scheduleInstall);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  window.addEventListener("nmplanner-settings-changed", scheduleInstall);
  scheduleInstall();
})();
