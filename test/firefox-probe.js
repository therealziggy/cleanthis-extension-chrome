// Runs inside a real Firefox as an extra background script (probe builds only,
// never shipped). Firefox doesn't surface extension console output to the
// terminal, so the probe reports by writing its results out through the
// downloads API — a channel that needs no host permission, which matters
// because host permissions are one of the things under test.
//
// It always writes a file, even if every check fails: a missing file then
// means "the probe never ran", which is a different problem from "the checks
// failed".

"use strict";

(async () => {
  const results = [];
  const record = (name, value) => results.push({ name, value });

  const attempt = async (name, fn, expected) => {
    try {
      record(name, await fn());
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      // Some of these are checked precisely because they are known not to
      // work: recording them as expected keeps a settled decision from
      // looking like a new problem on every run.
      record(name, expected ? `${expected} — ${detail}` : `THREW: ${detail}`);
    }
  };

  await attempt("browser namespace", () => (typeof browser !== "undefined" ? "present" : "MISSING"));
  await attempt("getBrowserInfo (our Firefox detection)", async () =>
    typeof browser.runtime.getBrowserInfo === "function"
      ? `present — ${(await browser.runtime.getBrowserInfo()).name} ${(await browser.runtime.getBrowserInfo()).version}`
      : "MISSING (we would misdetect this as Chrome)"
  );

  // Do the shared libraries load at all? Firefox lists them in the manifest
  // instead of importScripts, so this is the first thing that could break.
  await attempt("lib/api.js loaded", () => (self.CleanThisApi ? `yes — baseUrl ${self.CleanThisApi.baseUrl}` : "NO"));
  await attempt("lib/intercept.js loaded", () => (self.CleanThisIntercept ? "yes" : "NO"));

  // The big architectural question: are host permissions granted at install
  // (as on Chrome), or must the user grant them afterwards?
  await attempt("host permission for cleanthis.io granted?", async () =>
    (await browser.permissions.contains({ origins: ["https://cleanthis.io/*"] })) ? "GRANTED" : "NOT GRANTED"
  );
  await attempt("permissions actually held", async () => {
    const all = await browser.permissions.getAll();
    return `api=[${(all.permissions || []).join(", ")}] origins=[${(all.origins || []).join(", ")}]`;
  });

  // Does a real request to the API work from here?
  await attempt("live GET /api/form-token", async () => {
    const r = await fetch("https://cleanthis.io/api/form-token?purpose=scan-webpage");
    return `status ${r.status}`;
  });

  await attempt("storage.session", () => (browser.storage.session ? "present" : "MISSING (falls back to local)"));

  // v0.5 flagged-site warnings: the optional "tabs" permission surface.
  // permissions.request() needs a real user gesture, so the GRANT flow is a
  // manual dogfood item — what a headless probe CAN pin down is that the
  // manifest parses with optional_permissions, contains() answers cleanly
  // pre-grant, and the tabs.onUpdated listener API is callable without it.
  await attempt("optional tabs permission: contains() pre-grant", async () => {
    const held = await browser.permissions.contains({ permissions: ["tabs"] });
    return held ? "ALREADY GRANTED (unexpected pre-grant)" : "not granted (expected pre-grant)";
  });
  await attempt("tabs.onUpdated add/removeListener callable without the permission", () => {
    const probe = () => {};
    browser.tabs.onUpdated.addListener(probe);
    const had = browser.tabs.onUpdated.hasListener(probe);
    browser.tabs.onUpdated.removeListener(probe);
    return had ? "callable" : "hasListener returned false";
  });
  await attempt("lib/flagged.js loaded", () => (self.CleanThisFlagged ? "yes" : "NO"));
  await attempt("flagged hash parity vector", async () => {
    // sha256("evil-fixture.example") first 8 bytes — must equal the server's.
    const hex = await self.CleanThisFlagged.hashHost("evil-fixture.example");
    return hex === "e00110291c85d003" ? `matches (${hex})` : `MISMATCH: ${hex}`;
  });

  // Notifications: which options does Firefox accept? Our recovery flow hangs
  // off this, so the exact constraint set matters.
  await attempt("notification, plain", async () => {
    await browser.notifications.create("probe-plain", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-128.png"),
      title: "probe",
      message: "plain",
    });
    return "accepted";
  });
  await attempt("notification WITH buttons", async () => {
    await browser.notifications.create("probe-buttons", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-128.png"),
      title: "probe",
      message: "buttons",
      buttons: [{ title: "Download original" }],
    });
    return "accepted (buttons supported)";
  }, "BY DESIGN: unsupported on Firefox, so we never send buttons on any browser");
  await attempt("notification WITH requireInteraction", async () => {
    await browser.notifications.create("probe-sticky", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-128.png"),
      title: "probe",
      message: "sticky",
      requireInteraction: true,
    });
    return "accepted";
  }, "BY DESIGN: unsupported on Firefox, so notifications are never sticky anywhere");
  await attempt("notifications.onButtonClicked", () =>
    browser.notifications.onButtonClicked ? "present" : "MISSING (no button clicks to listen for)"
  );
  await attempt("notifications.onClicked", () => (browser.notifications.onClicked ? "present" : "MISSING"));
  await attempt("notifications.onClosed", () => (browser.notifications.onClosed ? "present" : "MISSING"));

  // Downloads: the interception path.
  await attempt("downloads API", () => (browser.downloads ? "present" : "MISSING"));
  await attempt("downloads.cancel on an unknown id", async () => {
    try {
      await browser.downloads.cancel(9999999);
      return "RESOLVED (same as Chromium)";
    } catch (err) {
      return `BY DESIGN: rejects here, resolves on Chromium — we check the download's state instead (${err && err.message ? err.message : String(err)})`;
    }
  });
  await attempt("downloads.onCreated", () => (browser.downloads.onCreated ? "present" : "MISSING"));

  // The badge + popup list are what replaced notification buttons, so they
  // have to work here or the recovery design doesn't hold on Firefox.
  await attempt("action.setBadgeText", async () => {
    await browser.action.setBadgeText({ text: "1" });
    const readBack = await browser.action.getBadgeText({});
    await browser.action.setBadgeText({ text: "" });
    return `works — read back "${readBack}"`;
  });
  await attempt("action.setBadgeBackgroundColor", async () => {
    await browser.action.setBadgeBackgroundColor({ color: "#dc2626" });
    return "accepted";
  });
  await attempt("runtime.onMessage (popup → background)", () =>
    browser.runtime.onMessage ? "present" : "MISSING"
  );

  // Event-page lifetime knobs we rely on.
  await attempt("runtime.onStartup", () => (browser.runtime.onStartup ? "present" : "MISSING"));
  await attempt("runtime.onConnect (popup handover)", () => (browser.runtime.onConnect ? "present" : "MISSING"));

  const payload = {
    marker: "cleanthis-firefox-probe",
    ranAt: new Date().toISOString(),
    results,
  };

  // Write the report out. A blob URL from this context needs no permissions.
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  await browser.downloads.download({ url, filename: "cleanthis-firefox-probe.json", conflictAction: "overwrite" });
})();
