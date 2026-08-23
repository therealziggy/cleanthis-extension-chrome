// CleanThis — first-run welcome page (opened once, on install).
//
// The two toggles are the real settings, wired exactly like the options page:
// same storage keys, same permission flow. A full tab survives the browser's
// permission prompt, so none of the popup's death-on-focus-loss machinery is
// needed here.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

const els = {
  intercept: document.getElementById("welcome-intercept"),
  interceptStatus: document.getElementById("intercept-status"),
  flagged: document.getElementById("welcome-flagged"),
  flaggedStatus: document.getElementById("flagged-status"),
  settings: document.getElementById("settings-link"),
  site: document.getElementById("site-link"),
};

// Reflect reality on load: the page can be reopened (or session-restored)
// after the user already changed things elsewhere.
(async () => {
  try {
    const stored = await ext.storage.local.get(["interceptEnabled", "flaggedEnabled"]);
    els.intercept.checked = stored.interceptEnabled === true;
    let tabsPerm = false;
    try {
      tabsPerm = await ext.permissions.contains({ permissions: ["tabs"] });
    } catch (_) {
      tabsPerm = false;
    }
    els.flagged.checked = stored.flaggedEnabled === true && tabsPerm;
  } catch (_) {
    /* the toggles still work from their default state */
  }
})();

els.intercept.addEventListener("change", () => {
  ext.storage.local.set({ interceptEnabled: els.intercept.checked });
  els.interceptStatus.textContent = els.intercept.checked
    ? "On. Fine-tune which file types count under All settings."
    : "";
  els.interceptStatus.hidden = !els.intercept.checked;
});

// Same contract as the options page: the permission request MUST run inside
// the change handler (the browser only honours it from a user gesture);
// declined → the toggle snaps back off.
els.flagged.addEventListener("change", async () => {
  els.flaggedStatus.hidden = true;
  if (!els.flagged.checked) {
    await ext.storage.local.set({ flaggedEnabled: false });
    return;
  }
  let granted = false;
  try {
    granted = await ext.permissions.request({ permissions: ["tabs", "webNavigation"] });
  } catch (_) {
    granted = false;
  }
  if (!granted) {
    els.flagged.checked = false;
    els.flaggedStatus.textContent = "The browser permission was declined, so this stays off.";
    els.flaggedStatus.hidden = false;
    return;
  }
  await ext.storage.local.set({ flaggedEnabled: true });
  els.flaggedStatus.textContent = "On. The warning list is fetched and checked on this device.";
  els.flaggedStatus.hidden = false;
  // Ask the background to fetch the list right away rather than on first use.
  try {
    await ext.runtime.sendMessage({ type: "flaggedEnabled" });
  } catch (_) {
    /* the worker fetches on next wake anyway */
  }
});

els.settings.addEventListener("click", (event) => {
  event.preventDefault();
  ext.runtime.openOptionsPage();
});

els.site.href = self.CleanThisApi.baseUrl;
