// CleanThis — the "Clean a file" page (v0.6 redesign).
//
// This lives in its own window on purpose: a popup dies the moment the native
// file dialog (or anything else) takes focus, killing the upload before it
// starts. A real window survives focus changes, so picking a file here always
// works.
//
// The clean flow itself is unchanged underneath: a cleaning job can outlast
// this page (the window can be closed mid-clean), so the page opens a port to
// the background script and hands the job over if it is still running when
// the page goes away. What changed is the rendering: a progress ring and
// checklist while it runs, a report card when it's done, tone blocks when it
// isn't.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const els = {
  level: document.getElementById("level"),
  drop: document.getElementById("drop"),
  fileInput: document.getElementById("file-input"),
  cleanResult: document.getElementById("clean-result"),
  quota: document.getElementById("quota"),
  footStatus: document.getElementById("foot-status"),
  settings: document.getElementById("settings-link"),
};

// ── small helpers ─────────────────────────────────────────────

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function show(html) {
  els.cleanResult.hidden = false;
  els.cleanResult.textContent = "";
  if (html) els.cleanResult.append(html);
}

// The drop/level screen and the working screens swap, like the design's
// separate views — "working" hides the intake UI while a job is on screen.
function working(isWorking) {
  document.body.classList.toggle("working", isWorking);
  els.fileInput.disabled = isWorking;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function levelLabel(level) {
  return level.charAt(0).toUpperCase() + level.slice(1);
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

async function refreshQuota() {
  try {
    const stored = await ext.storage.local.get(["quota_scan", "quota_upload"]);
    const parts = [];
    if (stored.quota_scan) parts.push(`${stored.quota_scan.remaining} scans left`);
    if (stored.quota_upload) parts.push(`${stored.quota_upload.remaining} files left`);
    els.quota.textContent = parts.join(" · ");
  } catch (_) {
    /* the quota line is informational only */
  }
}

// ── level preference (shared storage key with interception) ───

let currentLevel = "standard";

function setLevel(level, persist) {
  currentLevel = level;
  for (const button of els.level.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.level === level));
  }
  if (persist) ext.storage.local.set({ level });
}

ext.storage.local.get(["level"]).then(({ level }) => setLevel(level || "standard", false));

els.level.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-level]");
  if (button) setLevel(button.dataset.level, true);
});

els.settings.addEventListener("click", (event) => {
  event.preventDefault();
  ext.runtime.openOptionsPage();
});

// ── progress ring + checklist ─────────────────────────────────
// No progress events exist for an upload-and-rebuild, so the ring is a
// bounded estimate that eases toward 90% and holds; real milestones (upload
// done, job picked up) push a floor underneath it so it never slides back.

const RING_CIRCUMFERENCE = 345.6; // 2π × r55
const STEPS = [
  "Uploaded over TLS",
  "Scanned — no virus signatures",
  "Stripping macros & metadata",
  "Rebuilding from safe content",
];
// URL mode: the file never touches this device on the way in.
const STEPS_URL = [
  "Fetched by our server — not your device",
  "Scanned — no virus signatures",
  "Stripping macros & metadata",
  "Rebuilding from safe content",
];

const SVG_NS = "http://www.w3.org/2000/svg";

function ringCircle(className, extra = {}) {
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("class", className);
  circle.setAttribute("cx", "66");
  circle.setAttribute("cy", "66");
  circle.setAttribute("r", "55");
  circle.setAttribute("stroke-width", "11");
  circle.setAttribute("fill", "none");
  for (const [name, value] of Object.entries(extra)) circle.setAttribute(name, value);
  return circle;
}

function buildRing() {
  const root = text("div", "ct-ring");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 132 132");
  svg.setAttribute("width", "132");
  svg.setAttribute("height", "132");
  svg.setAttribute("aria-hidden", "true");
  const bar = ringCircle("bar", { "stroke-dasharray": "345.6", "stroke-dashoffset": "345.6" });
  svg.append(ringCircle("track"), bar);
  root.append(svg);
  const label = text("div", "ct-ring-label");
  const pct = text("span", "pct", "0%");
  label.append(pct, text("span", "sub", `${levelLabel(currentLevel)} clean`));
  root.append(label);
  return { root, bar, pct };
}

function buildChecklist(urlMode) {
  const list = text("ul", "ct-checklist");
  for (const step of urlMode ? STEPS_URL : STEPS) {
    const row = text("li", "queued");
    row.append(text("span", "mark"), text("span", null, step));
    list.append(row);
  }
  return list;
}

function makeProgress(ring, checklist) {
  let floor = 0;
  let current = 0;
  const startedAt = Date.now();

  function paint(pct) {
    current = pct;
    ring.pct.textContent = `${Math.round(pct)}%`;
    ring.bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
    checklist.querySelectorAll("li").forEach((li, i) => {
      const state = pct >= (i + 1) * 25 ? "done" : pct >= i * 25 ? "active" : "queued";
      li.className = state;
      li.querySelector(".mark").textContent = state === "done" ? "✓" : "";
    });
  }

  const timer = setInterval(() => {
    const t = (Date.now() - startedAt) / 20000;
    paint(Math.max(floor, Math.min(90, 90 * (1 - Math.exp(-2.2 * t)))));
  }, 150);

  return {
    setFloor(value) {
      floor = Math.max(floor, value);
      if (current < floor) paint(floor);
    },
    async finish() {
      clearInterval(timer);
      paint(100);
      await new Promise((resolve) => setTimeout(resolve, 220));
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// ── state renderers ───────────────────────────────────────────

function renderCleaning(displayName, subLabel, urlMode) {
  const wrap = document.createDocumentFragment();
  const row = text("div", "clean-row");
  const ring = buildRing();
  const checklist = buildChecklist(urlMode);
  row.append(ring.root);

  const side = text("div", "clean-side");
  side.append(text("h2", "state-title", "Taking it apart, carefully."));
  side.append(text("p", "state-sub", [displayName, subLabel].filter(Boolean).join(" · ")));
  side.append(checklist);
  row.append(side);
  wrap.append(row);

  const reassure = text("div", "block");
  reassure.append(text("p", "block-title", "Close this window if you like"));
  reassure.append(text("p", "block-body",
    "The job carries on without it — you'll get a notification, and it'll be waiting in the popup."));
  wrap.append(reassure);

  show(wrap);
  return makeProgress(ring, checklist);
}

function toneBlock(tone, title, body) {
  const block = text("div", `block ${tone}`.trim());
  block.append(text("p", "block-title", title));
  if (body) block.append(text("p", "block-body", body));
  return block;
}

// ── the sanitization report ───────────────────────────────────
// The server's completed-job response has always carried the same report the
// website shows (what was stripped, what the pre-scan found, how strong the
// clean was); rendered compactly under a "What was done" rule.

const MAX_REPORT_ITEMS = 8;

function renderReport(report) {
  if (!report || !Array.isArray(report.changes) || !report.changes.length) return null;

  const box = text("div", "report");
  box.append(text("h2", "report-title", "What was done"));

  // The strength descriptor leads — it says how deep the clean could go.
  const strength = report.changes.find((c) => c && c.type === "cleaning_strength");
  if (strength && strength.label) box.append(text("p", "report-strength", strength.label));

  const rest = report.changes.filter((c) => c && c !== strength && c.label);
  const list = text("ul", "report-list");
  for (const change of rest.slice(0, MAX_REPORT_ITEMS)) {
    const row = text("li", change.danger ? "danger" : null);
    row.append(text("span", "row-glyph", change.danger ? "✕" : "•"));
    row.append(text("span", null, change.label));
    list.append(row);
  }
  if (list.childElementCount) box.append(list);
  if (rest.length > MAX_REPORT_ITEMS) {
    box.append(text("p", "report-more", `…and ${rest.length - MAX_REPORT_ITEMS} more`));
  }
  if (report.summary) box.append(text("p", "report-summary", report.summary));

  return box.childElementCount > 1 ? box : null;
}

// ── clean flow ────────────────────────────────────────────────
// One shared core for both intakes: a picked/dropped file (upload) and a
// document URL handed over by the popup or the warning page (the server
// fetches it — it never touches this device on the way in).

async function runJob({ submit, displayName, subLabel, urlMode }) {
  working(true);
  const progress = renderCleaning(displayName, subLabel, urlMode);

  // Hand the job to the background script if this page closes mid-flight.
  // The port deliberately stays OPEN while an unsaved result is on screen:
  // disconnecting is what tells the background to take the job over, so doing
  // it early would double-offer a file the page is already showing. (v1's
  // popup had exactly that bug — plus a dead-port error on a late Save click.)
  const port = ext.runtime.connect({ name: "job-watch" });
  let handedOver = false;

  // Mark the job dealt-with and close the port. A dead port means the worker
  // restarted and its recovery path owns the job now — never an error here.
  function settle() {
    try {
      port.postMessage({ done: true });
    } catch (_) {
      /* recovery owns it */
    }
    try {
      port.disconnect();
    } catch (_) {
      /* already gone */
    }
  }

  try {
    const job = await submit();

    // URL mode only: the source-reputation pre-flight can refuse to fetch —
    // an advisory gate, exactly as the website presents it.
    if (job && job.sourceWarning) {
      progress.stop();
      try {
        port.disconnect();
      } catch (_) {
        /* nothing registered */
      }
      renderSourceGate(job.sourceWarning);
      return;
    }

    port.postMessage({ jobId: job.jobId, downloadToken: job.downloadToken, name: displayName });
    handedOver = true;
    progress.setFloor(30); // uploaded / fetched

    const finished = await api.waitForJob(job.jobId, job.downloadToken, {
      onTick: (snapshot) => {
        els.footStatus.textContent = snapshot.state === "queued" ? " · Waiting for a slot…" : "";
        if (snapshot.state === "processing") progress.setFloor(45);
      },
    });
    els.footStatus.textContent = "";

    if (finished.state === "completed") {
      await progress.finish();
      renderDone(finished, displayName, subLabel, job, settle);
    } else if (finished.state === "cancelled") {
      progress.stop();
      settle();
      const wrap = document.createDocumentFragment();
      wrap.append(toneBlock("", "That job was cancelled.", "Nothing was kept on our side."));
      wrap.append(anotherButton("Clean another"));
      show(wrap);
    } else {
      // The failure is on screen already; no need for the background worker to
      // repeat it as a notification.
      progress.stop();
      settle();
      const wrap = document.createDocumentFragment();
      wrap.append(toneBlock("", "Cleaning failed.",
        `${finished.error || "The server couldn't process this one."} Your upload was erased either way.`));
      wrap.append(anotherButton("Clean another"));
      show(wrap);
    }
  } catch (err) {
    progress.stop();
    els.footStatus.textContent = "";
    const wrap = document.createDocumentFragment();
    if (handedOver) {
      // Disconnecting WITHOUT done hands the job to the background watcher;
      // say so rather than implying the job died.
      wrap.append(toneBlock("amber", "Lost the connection mid-clean.",
        "The job is still running on our side — you'll get a notification when it lands, and it'll be waiting in the popup."));
      wrap.append(anotherButton("Clean another"));
      show(wrap);
      try {
        port.disconnect();
      } catch (_) {
        /* already gone */
      }
    } else {
      wrap.append(toneBlock("hard", "That didn't work.", humanize(err)));
      wrap.append(anotherButton("Try again"));
      show(wrap);
      try {
        port.disconnect();
      } catch (_) {
        /* nothing registered — closing is just tidy */
      }
    }
  } finally {
    refreshQuota();
  }
}

async function startClean(file) {
  if (!file) return;

  if (file.size > MAX_UPLOAD_BYTES) {
    working(true);
    const wrap = document.createDocumentFragment();
    wrap.append(toneBlock("hard", "That one's too big.",
      `50 MB is the ceiling, and ${file.name} is ${fmtSize(file.size)}. Nothing was uploaded.`));
    wrap.append(anotherButton("Try a smaller file"));
    show(wrap);
    return;
  }

  await runJob({
    submit: () => api.sanitizeFile(file, currentLevel),
    displayName: file.name,
    subLabel: fmtSize(file.size),
    urlMode: false,
  });
}

let pendingUrl = null; // the URL behind the source gate's "Clean it anyway"

function displayNameForUrl(url) {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").filter(Boolean).pop();
    return base || parsed.hostname;
  } catch (_) {
    return url;
  }
}

async function startCleanFromUrl(url, acknowledgeSourceWarning) {
  if (!url) return;
  pendingUrl = url;
  await runJob({
    submit: () => api.sanitizeUrl(url, currentLevel, { acknowledgeSourceWarning: acknowledgeSourceWarning === true }),
    displayName: displayNameForUrl(url),
    subLabel: null,
    urlMode: true,
  });
}

// The source host itself is flagged — an advisory stop, never a hard block.
function renderSourceGate(message) {
  const wrap = document.createDocumentFragment();
  wrap.append(toneBlock("amber", "The source itself looks dangerous.",
    `${message} You can still have it fetched and rebuilt — nothing runs on your device either way.`));
  const actions = text("div", "done-actions");
  const anyway = text("button", null, "Clean it anyway");
  anyway.type = "button";
  anyway.addEventListener("click", () => startCleanFromUrl(pendingUrl, true));
  const never = text("button", "secondary", "Never mind");
  never.type = "button";
  never.addEventListener("click", resetToIdle);
  actions.append(anyway, never);
  wrap.append(actions);
  show(wrap);
}

function resetToIdle() {
  els.cleanResult.hidden = true;
  els.cleanResult.textContent = "";
  els.fileInput.value = "";
  working(false);
}

function anotherButton(label) {
  const row = text("div", "done-actions");
  const button = text("button", "secondary", label);
  button.type = "button";
  button.addEventListener("click", resetToIdle);
  row.append(button);
  return row;
}

function renderDone(finished, displayName, subLabel, job, settle) {
  const wrap = document.createDocumentFragment();

  const head = text("div", "done-head");
  const tile = text("div", "ct-tile green big");
  const check = document.createElementNS(SVG_NS, "svg");
  check.setAttribute("width", "26");
  check.setAttribute("height", "26");
  check.setAttribute("viewBox", "0 0 24 24");
  check.setAttribute("fill", "none");
  check.setAttribute("stroke", "currentColor");
  check.setAttribute("stroke-width", "2");
  check.setAttribute("stroke-linecap", "round");
  check.setAttribute("stroke-linejoin", "round");
  check.setAttribute("aria-hidden", "true");
  const checkPath = document.createElementNS(SVG_NS, "path");
  checkPath.setAttribute("d", "M20 6L9 17l-5-5");
  check.append(checkPath);
  tile.append(check);
  head.append(tile);
  const headText = text("div", "done-headtext");
  headText.append(text("h2", "state-title", "Scrubbed. All yours."));
  headText.append(text("p", "state-sub",
    [finished.downloadName || displayName, levelLabel(currentLevel), subLabel].filter(Boolean).join(" · ")));
  head.append(headText);
  wrap.append(head);

  const report = renderReport(finished.report);
  if (report) wrap.append(report);

  const actions = text("div", "done-actions");
  const save = text("button", null, "Save cleaned file");
  save.type = "button";
  const note = text("span", "driver");
  save.addEventListener("click", async () => {
    // Download links are signed and short-lived, so ask for a fresh one
    // at click time rather than reusing the one from completion.
    save.disabled = true;
    note.textContent = "";
    try {
      const fresh = await api.getJob(job.jobId, job.downloadToken);
      const url = fresh && fresh.state === "completed" ? api.resolveUrl(fresh.downloadUrl) : null;
      if (!url) throw new api.ApiError("Cleaned files are only kept for a few minutes. Clean it again for a fresh copy.");
      await ext.downloads.download({ url, filename: fresh.downloadName || undefined });
      // Only now is the file genuinely the user's; until this point the
      // port stays open so a closed page hands the job to the background.
      note.textContent = "Saved.";
      note.classList.add("ok");
      settle();
    } catch (err) {
      // Leave the button usable — the job is valid for a few more minutes
      // and a second click often just works.
      note.classList.remove("ok");
      note.textContent = humanize(err);
    }
    save.disabled = false;
  });

  const another = text("button", "secondary", "Clean another");
  another.type = "button";
  another.addEventListener("click", resetToIdle);

  // A cleaned PDF can open right in the browser (?inline=1 — PDF-only on the
  // server, sniffed there). Save stays the FIRST button in #clean-result.
  const isPdf = /\.pdf$/i.test(finished.downloadName || displayName || "");
  if (isPdf) {
    const open = text("button", "secondary", "Open cleaned copy");
    open.type = "button";
    open.addEventListener("click", async () => {
      open.disabled = true;
      note.classList.remove("ok");
      note.textContent = "";
      try {
        const fresh = await api.getJob(job.jobId, job.downloadToken);
        const url = fresh && fresh.state === "completed" ? api.resolveUrl(fresh.downloadUrl) : null;
        if (!url) throw new api.ApiError("Cleaned files are only kept for a few minutes. Clean it again for a fresh copy.");
        ext.tabs.create({ url: `${url}&inline=1` });
      } catch (err) {
        note.textContent = humanize(err);
      }
      open.disabled = false;
    });
    actions.append(save, open, another, note);
  } else {
    actions.append(save, another, note);
  }
  wrap.append(actions);
  show(wrap);
}

// ── URL handoff from the popup / warning page ─────────────────
// The sender stores the URL in session storage AND sends a message: a window
// that is still loading misses the message but finds the intent; an already-
// open window takes the message live. The intent is consumed either way so a
// later re-open can't replay an old clean.

const intentStore = ext.storage.session || ext.storage.local;

async function takeUrlIntent() {
  try {
    const { cleanUrlIntent } = await intentStore.get("cleanUrlIntent");
    if (typeof cleanUrlIntent === "string" && cleanUrlIntent) {
      await intentStore.remove("cleanUrlIntent");
      startCleanFromUrl(cleanUrlIntent);
    }
  } catch (_) {
    /* the drop zone still works */
  }
}

ext.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "cleanUrl" || typeof message.url !== "string") return;
  intentStore.remove("cleanUrlIntent").catch(() => {});
  if (document.body.classList.contains("working")) {
    els.footStatus.textContent = " · Finish this one first, then re-click";
    return;
  }
  startCleanFromUrl(message.url);
});

// ── picker + drag-and-drop share startClean ───────────────────

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  startClean(file);
});

els.drop.addEventListener("click", () => els.fileInput.click());

els.drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.fileInput.click();
  }
});

els.drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.drop.classList.add("over");
});

els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));

els.drop.addEventListener("drop", (event) => {
  event.preventDefault();
  els.drop.classList.remove("over");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) startClean(file);
});

refreshQuota();

takeUrlIntent();
