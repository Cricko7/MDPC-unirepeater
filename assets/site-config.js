"use strict";

const siteDefaults = fetch(new URL("site-defaults.json", document.currentScript.src), { cache: "no-store" })
  .then(response => response.ok ? response.json() : {})
  .catch(() => ({}));
