(() => {
  const state = { scheduled: false };

  function install() {
    const insightLayout = document.querySelector(".insight-layout");
    const summary = document.querySelector(".summary-grid");
    if (!insightLayout || !summary) {
      document.querySelector("[data-insights-print-toolbar]")?.remove();
      return;
    }

    document.querySelectorAll("[data-insights-print-actions]").forEach((node) => node.remove());

    let toolbar = document.querySelector("[data-insights-print-toolbar]");
    if (!toolbar) {
      toolbar = document.createElement("section");
      toolbar.className = "panel insights-print-toolbar";
      toolbar.dataset.insightsPrintToolbar = "";
      toolbar.innerHTML = `
        <div class="panel-heading">
          <div>
            <h2>Print / Save Weekly Reports</h2>
            <p>Printable views for the selected week. Use your browser print dialog to print or save as PDF.</p>
          </div>
        </div>
        <div class="button-row insights-print-toolbar-actions">
          <button type="button" class="secondary-button" data-insights-print="calendar">Print / Save PDF · Weekly Time Plan</button>
          <button type="button" class="secondary-button" data-insights-print="matrix">Print / Save PDF · Matrix + Weekly Summary</button>
        </div>`;
      summary.insertAdjacentElement("afterend", toolbar);
    } else if (toolbar.previousElementSibling !== summary) {
      summary.insertAdjacentElement("afterend", toolbar);
    }
  }

  function schedule() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      install();
    });
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector("#app") || document.body, { childList: true, subtree: true });
  window.addEventListener("focus", schedule);
  schedule();
})();
