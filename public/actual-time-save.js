(() => {
  const timeClient = window.NMPlannerRuntime?.client;
  if (!timeClient) return;

  let activeFollowupId = null;

  function note(input, message) {
    const small = input?.closest("label")?.querySelector("small");
    if (small) small.textContent = message;
  }

  async function saveActualMinutes(id, input) {
    if (!input) return;
    if (!id) {
      note(input, "Save this task first, then reopen it to log actual time.");
      return;
    }

    const raw = input.value.trim();
    const actualMinutes = raw === "" ? null : Math.max(0, Math.min(2880, Number(raw)));
    if (raw !== "" && !Number.isFinite(actualMinutes)) return;

    input.disabled = true;
    const { error } = await timeClient.from("tasks").update({ actual_minutes: actualMinutes }).eq("id", id);
    input.disabled = false;

    if (error) {
      note(input, `Could not save actual time: ${error.message}`);
      return;
    }

    note(input, actualMinutes === null ? "Actual time cleared." : "Actual time saved for analytics.");
    setTimeout(() => note(input, "Log this after completion to improve estimate accuracy."), 2400);
    window.dispatchEvent(new Event("nmplanner-analytics-changed"));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-followup-action]");
    if (!button) return;
    if (button.dataset.followupAction === "edit") activeFollowupId = button.dataset.id || null;
    if (button.dataset.followupAction === "add" || button.dataset.followupAction === "cancel-editor") activeFollowupId = null;
  }, true);

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input?.name === "actual_minutes") {
      const id = input.closest("#task-form")?.querySelector('[data-action="delete"][data-id]')?.dataset.id;
      saveActualMinutes(id, input);
      return;
    }
    if (input?.dataset?.followupField === "actual_minutes") {
      saveActualMinutes(activeFollowupId, input);
    }
  }, true);
})();
