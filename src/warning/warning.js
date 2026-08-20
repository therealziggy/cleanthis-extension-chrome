// CleanThis — flagged-site warning page.
//
// Reached only by the background redirecting a tab that matched the local
// flagged list. Never a hard block: "Proceed anyway" grants a one-shot bypass
// and re-navigates; "Go back" returns to wherever the user was (or closes a
// tab that has nowhere to go back to).

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const flagged = self.CleanThisFlagged;
const docs = self.CleanThisDocs;

const params = new URLSearchParams(location.search);
const target = params.get("to");
const cat = params.get("cat") || "other";
const seen = params.get("seen") || "";
const kind = params.get("kind") || "flagged"; // "flagged" | "document"

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

// Open the clean window for `target` in URL mode (the popup uses the identical
// handoff: store the intent, send a message for an already-open window).
async function openCleanWindowFor(url) {
  const store = ext.storage.session || ext.storage.local;
  try {
    await store.set({ cleanUrlIntent: url });
    ext.runtime.sendMessage({ type: "cleanUrl", url }).catch(() => {});
  } catch (_) {
    /* the window still opens and can be re-driven */
  }
  try {
    await ext.windows.create({
      url: ext.runtime.getURL("clean/clean.html"),
      type: "popup",
      width: 560,
      height: 660,
    });
  } catch (_) {
    ext.tabs.create({ url: ext.runtime.getURL("clean/clean.html") });
  }
  ext.runtime.sendMessage({ type: "closeMe" }).catch(() => {});
}

// ── document mode: a neutral "this is a document" heads-up ────
if (kind === "document") {
  document.getElementById("title").textContent = "Hold on — this link is a document.";
  document.getElementById("host").textContent = host || "This link";
  document.getElementById("reason").textContent =
    "Documents are a common way to deliver malware — opening one can be enough to run it.";
  document.getElementById("explain").textContent =
    "You can open a rebuilt, safe copy instead — cleanthis.io fetches and reconstructs it, so nothing dangerous reaches your device.";
  document.getElementById("badge").classList.add("neutral");
  document.getElementById("proceed").textContent = "Open anyway";
  document.getElementById("fineprint").textContent =
    "Opening loads the original once. You can turn this off in settings.";
}

const cleanFirst = document.getElementById("clean-first");
// "Clean it first" shows when the target is a cleanable document. In document
// mode it always is; in flagged mode only when the blocked URL points at one.
if (host && target && (kind === "document" || docs.isBlanketDocUrl(target))) {
  cleanFirst.hidden = false;
  cleanFirst.classList.toggle("primary", kind === "document");
  cleanFirst.addEventListener("click", () => {
    cleanFirst.disabled = true;
    openCleanWindowFor(target);
  });
}

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
  // How far back is "back" depends on how we got here (the background says,
  // via the `via` param): a commit-time warn sits ON TOP of the flagged
  // entry — going back one would land there and re-warn in a loop, so skip
  // two. A pre-navigation warn replaced a navigation that never committed,
  // so one step is exactly right. If there's nothing that far back, go()
  // does nothing: this page is then still here after the grace period, and
  // the right move is to close the tab.
  history.go(params.get("via") === "commit" ? -2 : -1);
  const fallback = setTimeout(() => {
    ext.runtime.sendMessage({ type: "closeMe" }).catch(() => {});
  }, 1500);
  // A successful back-navigation hides this document; only a no-op go()
  // leaves it standing, and then closing the tab is the honest "back".
  addEventListener("pagehide", () => clearTimeout(fallback), { once: true });
});

const proceed = document.getElementById("proceed");
if (!host || !target) {
  proceed.hidden = true;
} else {
  proceed.addEventListener("click", async () => {
    proceed.disabled = true;
    try {
      // A document proceed grants a DOCUMENT bypass (via the background), never
      // a flagged one — the two must stay separate.
      if (kind === "document") {
        await ext.runtime.sendMessage({ type: "docProceed", host });
      } else {
        await flagged.grantBypass(ext, host);
      }
      location.href = target;
    } catch (_) {
      proceed.disabled = false;
    }
  });
}
