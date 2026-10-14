const CACHE = "nmplanner-shell-v92";

const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/followups.css",
  "/capacity.css",
  "/overtime.css",
  "/analytics.css",
  "/week-organizer.css",
  "/day-ranking.css",
  "/day-plan-interactions.css",
  "/day-timeline.css",
  "/day-timeline-history.css",
  "/routine-templates.css",
  "/day-unscheduled-list.css",
  "/evening-review.css",
  "/wellbeing-insights.css",
  "/planner-customization.css",
  "/insights-redesign.css",
  "/insights-execution.css",
  "/monthly-insights.css",
  "/calendar-foundation.css",
  "/external-calendar-dayplan.css",
  "/backup-v2.css",
  "/runtime.js",
  "/app.js",
  "/planner-settings.js",
  "/backup-v2.js",
  "/followups.js",
  "/duration-presets.js",
  "/overtime.js",
  "/capacity.js",
  "/capacity-ui.js",
  "/day-balance-summary.js",
  "/followup-capacity.js",
  "/analytics.js",
  "/insights-execution.js",
  "/overtime-insights.js",
  "/monthly-insights.js",
  "/insights-print.js",
  "/insights-print-actions.js",
  "/actual-time-save.js",
  "/week-organizer.js",
  "/followup-active.js",
  "/day-ranking.js",
  "/day-plan-interactions.js",
  "/day-timeline.js",
  "/day-timeline-history.js",
  "/routine-templates.js",
  "/external-calendar-dayplan.js",
  "/day-unscheduled-list.js",
  "/evening-review.js",
  "/review-analytics.js",
  "/wellbeing-insights-v3.js",
  "/calendar-foundation.js",
  "/power-automate-calendar-import.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/offline.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/config.js") {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() =>
          caches.match("/index.html")
            .then((cached) => cached || caches.match("/offline.html"))
        )
    );
    return;
  }

  if (
    url.pathname === "/runtime.js" ||
    url.pathname === "/app.js" ||
    url.pathname === "/planner-settings.js" ||
    url.pathname === "/planner-customization.css" ||
    url.pathname === "/insights-redesign.css" ||
    url.pathname === "/insights-execution.css" ||
    url.pathname === "/monthly-insights.css" ||
    url.pathname === "/calendar-foundation.css" ||
    url.pathname === "/external-calendar-dayplan.css" ||
    url.pathname === "/overtime.css" ||
    url.pathname === "/backup-v2.js" ||
    url.pathname === "/backup-v2.css" ||
    url.pathname === "/styles.css" ||
    url.pathname === "/followups.js" ||
    url.pathname === "/duration-presets.js" ||
    url.pathname === "/overtime.js" ||
    url.pathname === "/followups.css" ||
    url.pathname === "/capacity.js" ||
    url.pathname === "/capacity-ui.js" ||
    url.pathname === "/day-balance-summary.js" ||
    url.pathname === "/followup-capacity.js" ||
    url.pathname === "/capacity.css" ||
    url.pathname === "/analytics.js" ||
    url.pathname === "/insights-execution.js" ||
    url.pathname === "/overtime-insights.js" ||
    url.pathname === "/monthly-insights.js" ||
    url.pathname === "/insights-print.js" ||
    url.pathname === "/insights-print-actions.js" ||
    url.pathname === "/analytics.css" ||
    url.pathname === "/actual-time-save.js" ||
    url.pathname === "/week-organizer.js" ||
    url.pathname === "/week-organizer.css" ||
    url.pathname === "/followup-active.js" ||
    url.pathname === "/day-ranking.js" ||
    url.pathname === "/day-ranking.css" ||
    url.pathname === "/day-plan-interactions.js" ||
    url.pathname === "/day-plan-interactions.css" ||
    url.pathname === "/day-timeline.js" ||
    url.pathname === "/day-timeline.css" ||
    url.pathname === "/day-timeline-history.js" ||
    url.pathname === "/day-timeline-history.css" ||
    url.pathname === "/routine-templates.js" ||
    url.pathname === "/routine-templates.css" ||
    url.pathname === "/external-calendar-dayplan.js" ||
    url.pathname === "/external-calendar-dayplan.css" ||
    url.pathname === "/day-unscheduled-list.js" ||
    url.pathname === "/day-unscheduled-list.css" ||
    url.pathname === "/evening-review.js" ||
    url.pathname === "/evening-review.css" ||
    url.pathname === "/review-analytics.js" ||
    url.pathname === "/wellbeing-insights-v3.js" ||
    url.pathname === "/calendar-foundation.js" ||
    url.pathname === "/power-automate-calendar-import.js" ||
    url.pathname === "/wellbeing-insights.css"
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request)
    )
  );
});
