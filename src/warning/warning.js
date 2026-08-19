// CleanThis — flagged-site warning page.
//
// Reached only by the background redirecting a tab that matched the local
// flagged list. Never a hard block: "Proceed anyway" grants a one-shot bypass
// and re-navigates; "Go back" returns to wherever the user was (or closes a
// tab that has nowhere to go back to).

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const flagged = self.CleanThisFlagged;

const params = new URLSearchParams(location.search);
const target = params.get("to");
const cat = params.get("cat") || "other";
const seen = params.get("seen") || "";

// The host shown (and bypassed) is derived from the target URL itself, never
// from a separate parameter that could disagree with it.
let host = null;
try {
  const parsed = new URL(target);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  }
} catch (_) {
  host = null;
}

const REASONS = {
  phishing: "Reported for phishing — pages like this imitate a real login or service to steal credentials.",
  scam: "Reported as a scam site.",
  malware: "Reported for delivering malicious files.",
  spam: "Reported for large-scale spam or deceptive promotion.",
  other: "Reported as harmful.",
};

document.getElementById("host").textContent = host || "This page";
document.getElementById("reason").textContent = REASONS[cat] || REASONS.other;

if (/^\d{4}-\d{2}$/.test(seen)) {
  const [y, m] = seen.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const el = document.getElementById("seen");
  el.textContent = `Last confirmed ${month}.`;
  el.hidden = false;
}

document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) {
    history.back();
  } else {
    // A tab with no history (opened straight onto the flagged site) has
    // nowhere to go back to — ask the background to close it.
    ext.runtime.sendMessage({ type: "closeMe" }).catch(() => {});
  }
});

const proceed = document.getElementById("proceed");
if (!host || !target) {
  proceed.hidden = true;
} else {
  proceed.addEventListener("click", async () => {
    proceed.disabled = true;
    try {
      await flagged.grantBypass(ext, host);
      location.href = target;
    } catch (_) {
      proceed.disabled = false;
    }
  });
}
