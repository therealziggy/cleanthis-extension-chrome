// CleanThis — options page.
// Settings are stored in extension storage and read by the popup and the
// background script; every change saves immediately.
//
// The file-type checkboxes render from the server's catalogue (cached by
// lib/filetypes.js). Semantics: while the user has never customised, the
// recommended set applies LIVE (no interceptExts key in storage); the first
// checkbox change freezes an explicit list. "Restore recommended" deletes the
// key, returning to live-follow.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const fileTypes = self.CleanThisFileTypes;

const els = {
  enabled: document.getElementById("intercept-enabled"),
  flagged: document.getElementById("flagged-enabled"),
  flaggedStatus: document.getElementById("flagged-status"),
  level: document.getElementById("level"),
  groups: document.getElementById("type-groups"),
  restore: document.getElementById("restore-exts"),
  quota: document.getElementById("quota"),
  version: document.getElementById("version"),
};

function describeQuota(label, quota) {
  if (!quota) return null;
  const used = Number.isFinite(quota.limit - quota.remaining) ? quota.limit - quota.remaining : "?";
  const reset = quota.resetEpoch ? new Date(quota.resetEpoch * 1000).toLocaleString() : null;
  return `${label}: ${used} of ${quota.limit} used today${reset ? ` · resets ${reset}` : ""}`;
}

// ── file-type checkbox groups ─────────────────────────────────

let catalogue = fileTypes.BAKED;

function checkedExts() {
  return [...els.groups.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.dataset.ext);
}

function renderGroups(payload, effective) {
  const chosen = new Set(effective);
  els.groups.textContent = "";

  for (const group of payload.groups) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "type-group";

    const legend = document.createElement("legend");
    legend.textContent = group.label;
    fieldset.append(legend);

    for (const extName of group.exts) {
      const label = document.createElement("label");
      label.className = "type-choice";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.ext = extName;
      box.checked = chosen.has(extName);
      box.addEventListener("change", () => {
        // The first touch freezes the choice as an explicit list.
        ext.storage.local.set({ interceptExts: checkedExts() });
      });

      const name = document.createElement("span");
      name.textContent = `.${extName}`;

      label.append(box, name);
      fieldset.append(label);
    }

    els.groups.append(fieldset);
  }
}

els.restore.addEventListener("click", async () => {
  // Deleting the key returns the user to "follow the recommended set, live".
  await ext.storage.local.remove("interceptExts");
  renderGroups(catalogue, fileTypes.recommendedUnion(catalogue));
});

// ── load ──────────────────────────────────────────────────────

async function load() {
  const stored = await ext.storage.local.get([
    "interceptEnabled",
    "flaggedEnabled",
    "level",
    "interceptExts",
    "quota_scan",
    "quota_upload",
  ]);

  els.enabled.checked = stored.interceptEnabled === true;
  els.level.value = stored.level || "standard";

  // The toggle reflects reality: enabled AND the permission still held (it
  // can be revoked from the browser's own extension settings at any time).
  let flaggedPerm = false;
  let webNavPerm = false;
  try {
    flaggedPerm = await ext.permissions.contains({ permissions: ["tabs"] });
    webNavPerm = await ext.permissions.contains({ permissions: ["webNavigation"] });
  } catch (_) {
    flaggedPerm = false;
  }
  els.flagged.checked = stored.flaggedEnabled === true && flaggedPerm;

  // Installs that granted only "tabs" (v0.5.0) miss flagged sites that
  // redirect away instantly. One off-and-on of the toggle grants the rest.
  if (els.flagged.checked && !webNavPerm) {
    els.flaggedStatus.textContent =
      "Sites that redirect immediately need one more browser permission — switch this off and back on once to add it.";
    els.flaggedStatus.hidden = false;
  }

  ({ payload: catalogue } = await fileTypes.getConfig(ext));
  renderGroups(catalogue, fileTypes.effectiveExts(stored.interceptExts, catalogue));

  const lines = [
    describeQuota("Webpage scans", stored.quota_scan),
    describeQuota("Files cleaned", stored.quota_upload),
  ].filter(Boolean);
  els.quota.textContent = lines.length ? lines.join("\n") : "No requests yet.";
  els.quota.style.whiteSpace = "pre-line";

  els.version.textContent = `Version ${ext.runtime.getManifest().version}`;
}

els.enabled.addEventListener("change", () => {
  ext.storage.local.set({ interceptEnabled: els.enabled.checked });
});

// Turning warnings on needs the optional "tabs" + "webNavigation" permissions
// (one prompt), and the request MUST run inside this change handler — the
// browser only honours it from a user gesture. Declined → toggle snaps off.
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
  // Ask the background to fetch the list right away rather than on first use.
  try {
    await ext.runtime.sendMessage({ type: "flaggedEnabled" });
  } catch (_) {
    /* the worker fetches on next wake anyway */
  }
});

els.level.addEventListener("change", () => {
  ext.storage.local.set({ level: els.level.value });
});

load();
