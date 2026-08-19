// CleanThis — popup logic.
//
// The popup is scan-and-status only: scan the active tab, list anything still
// waiting on the user, show the day's allowance. File cleaning lives on its
// own tab page (clean/clean.html) — a popup dies the moment the native file
// dialog takes focus, so picking files here could never be reliable.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;

const els = {
  cleanBtn: document.getElementById("clean-file"),
  scanBtn: document.getElementById("scan-page"),
  scanResult: document.getElementById("scan-result"),
  quota: document.getElementById("quota"),
  settings: document.getElementById("settings-link"),
  pending: document.getElementById("pending"),
  pendingList: document.getElementById("pending-list"),
};

const actionStore = ext.storage.session || ext.storage.local;

// ── small helpers ─────────────────────────────────────────────

function show(el, { html, error = false } = {}) {
  el.hidden = false;
  el.classList.toggle("error", error);
  el.textContent = "";
  if (html) el.append(html);
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

// Turns an ApiError into something a person can act on.
function humanize(err) {
  if (!err) return "Something went wrong. Please try again.";
  if (err.code === "cooldown") return "Paused briefly after hitting a rate limit. Try again in a moment.";
  if (err.code === "quota") return err.message;
  if (err.code === "rate_limited") return "Too many requests just now — please wait a minute.";
  if (err.code === "network") return "Couldn't reach cleanthis.io. Check your connection.";
  if (err.code === "timeout") return "That took longer than expected. Please try again.";
  return err.message || "Something went wrong. Please try again.";
}

// ── things still waiting on the user ──────────────────────────
// Notifications can be missed — they vanish on their own, and neither browser
// will hold one open. Anything still undecided is listed here, where it stays
// until it is dealt with.

async function refreshPending() {
  let actions = {};
  try {
    ({ pendingActions: actions = {} } = await actionStore.get("pendingActions"));
  } catch (_) {
    /* nothing to show is the safe default */
  }

  const entries = Object.entries(actions);
  els.pendingList.textContent = "";
  els.pending.hidden = entries.length === 0;

  for (const [id, action] of entries) {
    const row = document.createElement("li");
    row.append(text("span", "pending-name", action.name || action.url || "A download"));
    if (action.why) row.append(text("span", "pending-why", action.why));

    const button = document.createElement("button");
    button.type = "button";
    button.className = action.label && /unsafe/i.test(action.label) ? "danger" : "";
    button.textContent = action.label || "Continue";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        // The background script owns what these actions actually do, so the
        // popup only asks — the same path a notification click takes.
        await ext.runtime.sendMessage({ type: "runAction", id });
      } catch (_) {
        /* refreshing below shows whether it worked */
      }
      await refreshPending();
    });

    row.append(button);
    els.pendingList.append(row);
  }
}

async function refreshQuota() {
  try {
    const stored = await ext.storage.local.get(["quota_scan", "quota_upload"]);
    const parts = [];
    if (stored.quota_scan) parts.push(`${stored.quota_scan.remaining} scans left today`);
    if (stored.quota_upload) parts.push(`${stored.quota_upload.remaining} files left today`);
    els.quota.textContent = parts.join(" · ");
  } catch (_) {
    /* the quota line is informational only */
  }
}

els.settings.addEventListener("click", (event) => {
  event.preventDefault();
  ext.runtime.openOptionsPage();
});

// ── clean a file: opens the dedicated tab page ────────────────

els.cleanBtn.addEventListener("click", () => {
  ext.tabs.create({ url: ext.runtime.getURL("clean/clean.html") });
  window.close();
});

// ── scan this page ────────────────────────────────────────────

const VERDICT_LABEL = {
  clean: "No known threats",
  suspicious: "Suspicious",
  malicious: "Dangerous",
  unreachable: "Couldn't load the page",
};

const SCORE_LABEL = { security: "Security", privacy: "Privacy", legitimacy: "Legitimacy" };

function renderScan(url, result) {
  const box = document.createDocumentFragment();

  const verdict = result.verdict || "unreachable";
  box.append(text("span", `verdict verdict-${verdict}`, VERDICT_LABEL[verdict] || verdict));

  const scores = result.scores || {};
  const list = text("ul", "scores");
  let anyDriver = null;
  for (const key of ["security", "privacy", "legitimacy"]) {
    const score = scores[key];
    if (!score) continue;
    const row = document.createElement("li");
    row.append(text("span", "score-name", SCORE_LABEL[key]));
    const value = score.value === null || score.value === undefined ? "—" : String(score.value);
    row.append(text("span", `score-value band-${score.band || "none"}`, value));
    list.append(row);
    if (!anyDriver && score.driver) anyDriver = score.driver;
  }
  if (list.childElementCount) box.append(list);
  if (anyDriver) box.append(text("p", "driver", anyDriver));

  const link = document.createElement("a");
  link.href = `${api.baseUrl}/webpage-scanner.html?url=${encodeURIComponent(url)}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Full report ↗";
  const linkWrap = text("p", "driver");
  linkWrap.append(link);
  box.append(linkWrap);

  show(els.scanResult, { html: box });
}

els.scanBtn.addEventListener("click", async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url;

  if (!url || !/^https?:\/\//i.test(url)) {
    show(els.scanResult, { html: text("span", null, "This page can't be scanned — open a website first."), error: true });
    return;
  }

  els.scanBtn.disabled = true;
  show(els.scanResult, { html: text("span", "progress", "Scanning…") });
  try {
    const result = await api.scanUrl(url, "standard");
    renderScan(url, result);
  } catch (err) {
    show(els.scanResult, { html: text("span", null, humanize(err)), error: true });
  } finally {
    els.scanBtn.disabled = false;
    refreshQuota();
  }
});

refreshQuota();

refreshPending();
