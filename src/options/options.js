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
    "level",
    "interceptExts",
    "quota_scan",
    "quota_upload",
  ]);

  els.enabled.checked = stored.interceptEnabled === true;
  els.level.value = stored.level || "standard";

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

els.level.addEventListener("change", () => {
  ext.storage.local.set({ level: els.level.value });
});

load();
