"use strict";

const siteDefaultsUrl = new URL("site-defaults.json", document.currentScript.src);

async function fetchSiteDefaults() {
  const response = await fetch(siteDefaultsUrl, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

const siteDefaults = fetchSiteDefaults().catch(() => ({}));

function watchSiteDefaults(initial, apply) {
  let previous = JSON.stringify(initial);
  let pending = false;
  async function refresh() {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const settings = await fetchSiteDefaults();
      const next = JSON.stringify(settings);
      if (next !== previous) {
        apply(settings);
        previous = next;
      }
    } catch {
      // Keep the last settings if the next request fails.
    } finally {
      pending = false;
    }
  }
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pageshow", event => {
    if (event.persisted) refresh();
  });
  setInterval(refresh, 5000);
}
