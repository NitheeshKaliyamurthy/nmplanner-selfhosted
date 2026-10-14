(() => {
  const STANDARD = [15, 30, 45, 60, 90, 120, 180];
  const HALF_DAY = 300;
  const FULL_DAY = 540;
  const state = { scheduled: false };

  function formatDuration(minutes) {
    const value = Number(minutes || 0);
    if (value < 60) return `${value} minutes`;
    const hours = value / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} hour${hours === 1 ? "" : "s"}`;
  }

  function optionMarkup(value, label, selected) {
    return `<option value="${value}" ${String(value) === String(selected) ? "selected" : ""}>${label}</option>`;
  }

  function selectedDuration(select) {
    if (select?.name === "minutes") {
      try {
        if (typeof editingTask !== "undefined" && editingTask?.minutes) return String(editingTask.minutes);
      } catch (_) {}
    }
    return select?.value || "60";
  }

  function patchSelect(select) {
    if (!select) return;
    const selected = selectedDuration(select);
    const signature = selected;
    if (select.dataset.durationPresets === signature) return;

    const selectedNumber = Number(selected);
    const customPart = Number.isFinite(selectedNumber)
      && selectedNumber > 0
      && !STANDARD.includes(selectedNumber)
      && selectedNumber !== HALF_DAY
      && selectedNumber !== FULL_DAY
        ? optionMarkup(selectedNumber, `Current · ${formatDuration(selectedNumber)}`, selected)
        : "";

    const standardPart = STANDARD.map((minutes) => optionMarkup(minutes, formatDuration(minutes), selected)).join("");
    const halfPart = optionMarkup(HALF_DAY, "Half Day · 5 hours (reserves all Q2 capacity)", selected);
    const fullPart = optionMarkup(FULL_DAY, "Full Day · 9 hours (reserves all Q1 + Q2 capacity)", selected);

    select.innerHTML = `${standardPart}${customPart}${halfPart}${fullPart}`;
    select.value = selected;
    select.dataset.durationPresets = signature;
    select.title = "Half Day counts as 5 hours and fully reserves Q2 capacity. Full Day counts as 9 hours and fully reserves both Q1 and Q2 capacity for that day.";
  }

  function patch() {
    patchSelect(document.querySelector('#task-form select[name="minutes"]'));
    patchSelect(document.querySelector('[data-followup-field="minutes"]'));
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      patch();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });

  schedule();
})();
