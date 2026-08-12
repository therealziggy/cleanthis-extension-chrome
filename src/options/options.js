// CleanThis — options page.
// Settings are stored in extension storage and read by the popup and the
// background script; every change saves immediately.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const { DEFAULT_EXTS } = self.CleanThisIntercept;

const els = {
  enabled: document.getElementById("intercept-enabled"),
  level: document.getElementById("level"),
  exts: document.getElementById("intercept-exts"),
  restore: document.getElementById("restore-exts"),
  quota: document.getElementById("quota"),
  version: document.getElementById("version"),
};

// "PDF, .docx , docx" → ["pdf", "docx"]
function parseExts(raw) {
  const seen = new Set();
  for (const piece of String(raw).split(",")) {
    const ext = piece.trim().toLowerCase().replace(/^\.+/, "");
    if (ext) seen.add(ext);
  }
  return [...seen];
}

function describeQuota(label, quota) {
  if (!quota) return null;
  const used = Number.isFinite(quota.limit - quota.remaining) ? quota.limit - quota.remaining : "?";
  const reset = quota.resetEpoch ? new Date(quota.resetEpoch * 1000).toLocaleString() : null;
  return `${label}: ${used} of ${quota.limit} used today${reset ? ` · resets ${reset}` : ""}`;
}

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
  els.exts.value = (stored.interceptExts && stored.interceptExts.length ? stored.interceptExts : DEFAULT_EXTS).join(", ");

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

// Normalise on the way out of the field so what's stored matches what's shown.
els.exts.addEventListener("change", () => {
  const exts = parseExts(els.exts.value);
  const effective = exts.length ? exts : DEFAULT_EXTS;
  els.exts.value = effective.join(", ");
  ext.storage.local.set({ interceptExts: effective });
});

els.restore.addEventListener("click", () => {
  els.exts.value = DEFAULT_EXTS.join(", ");
  ext.storage.local.set({ interceptExts: DEFAULT_EXTS });
});

load();
