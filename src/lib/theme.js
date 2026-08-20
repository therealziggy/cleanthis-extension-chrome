// CleanThis — theme override for every extension page.
//
// Default is the OS scheme (no attribute, the media queries decide) — the
// behavior the extension has always had. A click on the popup's toggle pins
// an explicit choice, stored in localStorage (shared across all pages of the
// extension origin, readable synchronously so there is no flash of the wrong
// theme). "Back to system theme" in the popup's settings clears it.
//
// Loaded FIRST in each page's <head>; also live-updates already-open pages
// via the storage event.

"use strict";

(() => {
  const KEY = "ct-theme";

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "dark" || v === "light" ? v : null;
    } catch (_) {
      return null;
    }
  }

  function apply(v) {
    if (v) document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  }

  function set(v) {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (_) {
      /* per-page apply below still works for this page's lifetime */
    }
    apply(v);
  }

  function effective() {
    return saved() || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  apply(saved());
  addEventListener("storage", (event) => {
    if (event.key === KEY) apply(saved());
  });

  self.CleanThisTheme = { saved, set, effective };
})();
