// CleanThis — popup logic (v0.6 redesign).
//
// One card, several views: idle | scanning | verdict | settings | error.
// Scan-and-status only, as ever: file cleaning lives in its own window
// (clean/clean.html) because a popup dies the moment the native file dialog
// takes focus. The drop zone here is an affordance that opens that window.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;

const els = {
  settingsBtn: document.getElementById("settings-btn"),
  pending: document.getElementById("pending"),
  pendingList: document.getElementById("pending-list"),
  pendingCount: document.getElementById("pending-count"),
  site: document.getElementById("site"),
  scanBtn: document.getElementById("scan-page"),
  openClean: document.getElementById("open-clean"),
  scanSite: document.getElementById("scan-site"),
  ringBar: document.getElementById("ring-bar"),
  ringPct: document.getElementById("ring-pct"),
  scanSteps: document.getElementById("scan-steps"),
  cancelScan: document.getElementById("cancel-scan"),
  verdict: document.getElementById("view-verdict"),
  error: document.getElementById("view-error"),
  settingsBack: document.getElementById("settings-back"),
  intercept: document.getElementById("intercept-enabled"),
  flagged: document.getElementById("flagged-enabled"),
  settingsStatus: document.getElementById("settings-status"),
  levelSeg: document.getElementById("level-seg"),
  openOptions: document.getElementById("open-options"),
  quotaScans: document.getElementById("quota-scans"),
  quotaFiles: document.getElementById("quota-files"),
};

const actionStore = ext.storage.session || ext.storage.local;

// ── small helpers ─────────────────────────────────────────────

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

// ── view switching ────────────────────────────────────────────

const VIEWS = ["idle", "scanning", "verdict", "settings", "error"];
let currentView = "idle";
let prevView = "idle"; // where ‹ Back from settings returns to
let pendingCount = 0;

function showView(name) {
  currentView = name;
  document.body.dataset.view = name;
  for (const view of VIEWS) {
    document.getElementById(`view-${view}`).hidden = view !== name;
  }
  // The pending block belongs to the idle view only.
  els.pending.hidden = name !== "idle" || pendingCount === 0;
  // Mid-scan the gear would stomp the ring; it comes back with the verdict.
  els.settingsBtn.disabled = name === "scanning";
}

// ── things still waiting on the user ──────────────────────────
// Notifications can be missed — they vanish on their own, and neither browser
// will hold one open. Anything still undecided is listed here until dealt with.

async function refreshPending() {
  let actions = {};
  try {
    ({ pendingActions: actions = {} } = await actionStore.get("pendingActions"));
  } catch (_) {
    /* nothing to show is the safe default */
  }

  const entries = Object.entries(actions);
  pendingCount = entries.length;
  els.pendingList.textContent = "";
  els.pendingCount.textContent = String(entries.length);
  els.pending.hidden = currentView !== "idle" || entries.length === 0;

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
    els.quotaScans.textContent = stored.quota_scan ? `${stored.quota_scan.remaining} scans left` : "";
    els.quotaFiles.textContent = stored.quota_upload ? `${stored.quota_upload.remaining} files left` : "";
  } catch (_) {
    /* the quota line is informational only */
  }
}

// ── the active tab's hostname on the idle view ────────────────

async function refreshSite() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    const url = tab && tab.url;
    if (url && /^https?:\/\//i.test(url)) {
      els.site.textContent = new URL(url).hostname;
      return;
    }
  } catch (_) {
    /* fall through to the empty line */
  }
  els.site.textContent = "";
}

// ── clean a file: opens the dedicated cleaning window ─────────
// A compact popup-type window rather than a tab: it feels like the popup
// stayed open, but being a real window it survives the file dialog (a popup
// never can — the reason cleaning left the popup in v0.4). If a cleaning
// window is already open, focus it instead of stacking another.

const CLEAN_WINDOW_KEY = "cleanWindowId";
const windowStore = ext.storage.session || ext.storage.local;

async function openCleanWindow() {
  try {
    const { [CLEAN_WINDOW_KEY]: existingId } = await windowStore.get(CLEAN_WINDOW_KEY);
    if (existingId !== undefined) {
      await ext.windows.update(existingId, { focused: true });
      window.close();
      return;
    }
  } catch (_) {
    /* window is gone — open a fresh one below */
  }

  const width = 560;
  const height = 660;
  let position = {};
  try {
    // Centre on the browser window the user is looking at.
    const current = await ext.windows.getCurrent();
    position = {
      left: Math.max(0, Math.round(current.left + (current.width - width) / 2)),
      top: Math.max(0, Math.round(current.top + (current.height - height) / 2)),
    };
  } catch (_) {
    /* the window manager's default placement is fine */
  }

  try {
    const win = await ext.windows.create({
      url: ext.runtime.getURL("clean/clean.html"),
      type: "popup",
      width,
      height,
      ...position,
    });
    await windowStore.set({ [CLEAN_WINDOW_KEY]: win.id });
  } catch (_) {
    // A window manager that refuses popup windows still gets the feature.
    ext.tabs.create({ url: ext.runtime.getURL("clean/clean.html") });
  }
  window.close();
}

els.openClean.addEventListener("click", openCleanWindow);

els.openClean.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openCleanWindow();
  }
});

// A file dropped on the popup can't cross into another window, but the drop
// must never navigate the popup either — catch it and open the real drop zone.
els.openClean.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.openClean.classList.add("over");
});
els.openClean.addEventListener("dragleave", () => els.openClean.classList.remove("over"));
els.openClean.addEventListener("drop", (event) => {
  event.preventDefault();
  els.openClean.classList.remove("over");
  openCleanWindow();
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

// ── progress ring ─────────────────────────────────────────────
// api.scanUrl is one POST with no progress events, so the ring is a bounded
// estimate: ease toward 90% over ~12s, hold there, and only complete when the
// response actually lands. Honest about what it knows, never stuck at 100%.

const RING_CIRCUMFERENCE = 345.6; // 2π × r55
let ringTimer = null;

function setRing(pct) {
  els.ringPct.textContent = `${Math.round(pct)}%`;
  els.ringBar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
  const rows = els.scanSteps.querySelectorAll("li");
  rows.forEach((li, i) => {
    const state = pct >= (i + 1) * 25 ? "done" : pct >= i * 25 ? "active" : "queued";
    li.className = state;
    li.querySelector(".mark").textContent = state === "done" ? "✓" : "";
  });
}

function startRing() {
  const startedAt = Date.now();
  setRing(0);
  ringTimer = setInterval(() => {
    const t = (Date.now() - startedAt) / 12000;
    setRing(Math.min(90, 90 * (1 - Math.exp(-2.2 * t))));
  }, 120);
}

async function finishRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  setRing(100);
  await new Promise((resolve) => setTimeout(resolve, 220));
}

function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
}

// ── scan this page ────────────────────────────────────────────

let scanController = null;
let lastScan = null; // { url, tabId } — verdict actions need both

async function startScan() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url;

  if (!url || !/^https?:\/\//i.test(url)) {
    renderError("notpage");
    showView("error");
    return;
  }

  lastScan = { url, tabId: tab.id };
  els.scanSite.textContent = new URL(url).hostname;
  scanController = new AbortController();
  showView("scanning");
  startRing();

  try {
    const result = await api.scanUrl(url, "standard", { signal: scanController.signal });
    await finishRing();
    renderVerdict(url, tab.id, result);
    showView("verdict");
  } catch (err) {
    stopRing();
    if (err && err.code === "aborted") {
      showView("idle");
    } else {
      renderError(errorKindFor(err), err);
      showView("error");
    }
  } finally {
    scanController = null;
    refreshQuota();
  }
}

els.scanBtn.addEventListener("click", startScan);

els.cancelScan.addEventListener("click", () => {
  if (scanController) scanController.abort();
});

// ── verdict rendering ─────────────────────────────────────────

const SCORE_LABEL = { security: "Security", privacy: "Privacy", legitimacy: "Legitimacy" };

const GLYPHS = {
  check: ["M20 6L9 17l-5-5"],
  warn: ["M12 4l9 16H3z", "M12 10v4", "M12 17.4h.01"],
  cross: ["M6 6l12 12", "M18 6L6 18"],
  question: ["M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.8-2.7 2.4-2.7 4", "M12 17.6h.01"],
};

// Stroked 24×24 glyph, built with DOM calls (no markup strings — the linter
// rightly dislikes innerHTML in an extension page).
function svgIcon(size, paths) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const VERDICTS = {
  clean: { tile: "green", glyph: "check", title: "Nothing nasty in here." },
  suspicious: { tile: "amber", glyph: "warn", title: "Something's off here." },
  malicious: { tile: "red", glyph: "cross", title: "Nope. Close this tab." },
  unreachable: { tile: "gray", glyph: "question", title: "Couldn't get a look at it." },
};

function tile(kind, glyph) {
  const box = text("div", `ct-tile ${kind}`);
  box.append(svgIcon(24, GLYPHS[glyph]));
  return box;
}

function reportUrl(url) {
  return `${api.baseUrl}/webpage-scanner.html?url=${encodeURIComponent(url)}`;
}

function actionButton(className, label, onClick) {
  const button = text("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function renderVerdict(url, tabId, result) {
  const verdict = VERDICTS[result.verdict] ? result.verdict : "unreachable";
  const spec = VERDICTS[verdict];
  els.verdict.textContent = "";

  const head = text("div", "verdict-head");
  head.append(tile(spec.tile, spec.glyph));
  const headText = document.createElement("div");
  headText.style.minWidth = "0";
  headText.append(text("h2", "verdict-title", spec.title));
  const sub = text("p", "verdict-sub");
  sub.append(text("span", "host", new URL(url).hostname));
  sub.append(text("span", "when", "· just now"));
  headText.append(sub);
  head.append(headText);
  els.verdict.append(head);

  const scores = result.scores || {};
  const drivers = [];
  for (const key of ["security", "privacy", "legitimacy"]) {
    const score = scores[key];
    if (score && score.driver && !drivers.includes(score.driver)) drivers.push(score.driver);
  }

  if (verdict === "clean") {
    const cells = text("div", "scorecells");
    for (const key of ["security", "privacy", "legitimacy"]) {
      const score = scores[key];
      if (!score) continue;
      const cell = text("div", `cell band-${score.band || "none"}`);
      const value = score.value === null || score.value === undefined ? "—" : String(score.value);
      cell.append(text("div", "value", value));
      cell.append(text("div", "caption", SCORE_LABEL[key]));
      cells.append(cell);
    }
    if (cells.childElementCount) els.verdict.append(cells);
  } else if (drivers.length) {
    const list = text("div", "findings");
    drivers.forEach((driver, i) => {
      const tone = verdict === "malicious" ? "red" : i === 0 ? "amber" : "";
      const row = text("div", `finding ${tone}`.trim());
      row.append(text("span", "glyph", verdict === "malicious" ? "✕" : "▲"));
      row.append(text("span", null, driver));
      list.append(row);
    });
    els.verdict.append(list);
  }

  const actions = text("div", "verdict-actions");
  if (verdict === "malicious") {
    actions.append(actionButton("primary-act danger-act", "Get me out of here", async () => {
      try {
        await ext.tabs.remove(tabId);
      } catch (_) {
        /* the tab may already be gone — that is the outcome we wanted */
      }
      window.close();
    }));
    actions.append(actionButton("secondary", "Details", () => {
      ext.tabs.create({ url: reportUrl(url) });
    }));
  } else {
    actions.append(actionButton("primary-act", "Full report ↗", () => {
      ext.tabs.create({ url: reportUrl(url) });
    }));
    actions.append(actionButton("secondary", "Rescan", startScan));
  }
  els.verdict.append(actions);

  if (verdict === "malicious") {
    els.verdict.append(text("p", "verdict-closer", "You can still proceed — we'll just look at you funny."));
  }
}

// ── error views ───────────────────────────────────────────────

function errorKindFor(err) {
  if (!err) return "generic";
  if (err.code === "quota") return "quota";
  if (err.code === "rate_limited" || err.code === "cooldown") return "ratelimited";
  if (err.code === "network" || err.code === "timeout") return "offline";
  return "generic";
}

// The quota body names the actual reset time when the server has told us one.
function quotaBody(stored) {
  const resetEpoch = stored && stored.quota_scan && stored.quota_scan.resetEpoch;
  if (resetEpoch) {
    const msLeft = resetEpoch * 1000 - Date.now();
    if (msLeft > 0) {
      const totalMinutes = Math.max(1, Math.round(msLeft / 60000));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const when = hours && minutes ? `${hours} h ${minutes} m` : hours ? `${hours} h` : `${minutes} m`;
      return `A fresh allowance lands in ${when}. We pause rather than hammer the service.`;
    }
  }
  return "Back tomorrow — we pause rather than hammer the service.";
}

async function renderError(kind, err) {
  const KINDS = {
    notpage: {
      tone: "soft",
      title: "Nothing to scan here.",
      body: "This is a browser page, not a website. Open a site with an address and try again.",
      retry: false,
    },
    quota: {
      tone: "soft",
      title: "You've used today's scans.",
      body: null, // filled from the stored quota below
      retry: false,
    },
    ratelimited: {
      tone: "soft",
      title: "Easy — one at a time.",
      body: "Paused for a few seconds after hitting a rate limit. Try again in a moment.",
      retry: true,
    },
    offline: {
      tone: "hard",
      title: "Couldn't reach cleanthis.io.",
      body: "Check your connection and try again. Nothing was sent, and nothing was scanned.",
      retry: true,
    },
    generic: {
      tone: "hard",
      title: "Couldn't finish that scan.",
      body: null, // the server's own words
      retry: true,
    },
  };

  const spec = KINDS[kind] || KINDS.generic;
  let body = spec.body;
  if (kind === "quota") {
    let stored = null;
    try {
      stored = await ext.storage.local.get(["quota_scan"]);
    } catch (_) {
      /* fall back to the timeless line */
    }
    body = quotaBody(stored);
  }
  if (kind === "generic") body = humanize(err);

  els.error.textContent = "";
  const block = text("div", `error-block ${spec.tone === "hard" ? "hard" : ""}`.trim());
  block.append(text("h2", "error-title", spec.title));
  block.append(text("p", "error-body", body));
  els.error.append(block);

  const actions = text("div", "error-actions");
  if (spec.retry) actions.append(actionButton("", "Try again", startScan));
  actions.append(actionButton("secondary", "Back", () => showView("idle")));
  els.error.append(actions);
}

// ── settings view ─────────────────────────────────────────────

function setLevelSeg(level) {
  for (const button of els.levelSeg.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.level === level));
  }
}

async function refreshSettings() {
  els.settingsStatus.hidden = true;
  try {
    const stored = await ext.storage.local.get(["interceptEnabled", "flaggedEnabled", "level"]);
    els.intercept.checked = stored.interceptEnabled === true;
    setLevelSeg(stored.level || "standard");

    // The toggle reflects reality: enabled AND the permission still held (it
    // can be revoked from the browser's own extension settings at any time).
    let tabsPerm = false;
    let webNavPerm = false;
    try {
      tabsPerm = await ext.permissions.contains({ permissions: ["tabs"] });
      webNavPerm = await ext.permissions.contains({ permissions: ["webNavigation"] });
    } catch (_) {
      tabsPerm = false;
    }
    els.flagged.checked = stored.flaggedEnabled === true && tabsPerm;

    // Installs that granted only "tabs" (v0.5.0) miss flagged sites that
    // redirect away instantly. One off-and-on of the toggle grants the rest.
    if (els.flagged.checked && !webNavPerm) {
      els.settingsStatus.textContent =
        "Sites that redirect immediately need one more browser permission — switch this off and back on once to add it.";
      els.settingsStatus.hidden = false;
    }
  } catch (_) {
    /* the view still opens; toggles just show their defaults */
  }
}

els.settingsBtn.addEventListener("click", () => {
  prevView = currentView === "settings" ? "idle" : currentView;
  refreshSettings();
  showView("settings");
});

els.settingsBack.addEventListener("click", () => showView(prevView === "settings" ? "idle" : prevView));

els.openOptions.addEventListener("click", () => ext.runtime.openOptionsPage());

els.intercept.addEventListener("change", () => {
  ext.storage.local.set({ interceptEnabled: els.intercept.checked });
});

// Turning warnings on needs the optional "tabs" + "webNavigation" permissions
// (one prompt), and the request MUST run inside this change handler — the
// browser only honours it from a user gesture. Declined → toggle snaps off.
// If the popup context can't run the request at all, the options page can.
els.flagged.addEventListener("change", async () => {
  els.settingsStatus.hidden = true;
  if (!els.flagged.checked) {
    await ext.storage.local.set({ flaggedEnabled: false });
    return;
  }
  let granted = false;
  let requestFailed = false;
  try {
    granted = await ext.permissions.request({ permissions: ["tabs", "webNavigation"] });
  } catch (_) {
    granted = false;
    requestFailed = true;
  }
  if (!granted) {
    els.flagged.checked = false;
    if (requestFailed) {
      // The prompt could not be shown from here — hand over to the options
      // page, where the same toggle is proven to work.
      ext.runtime.openOptionsPage();
      return;
    }
    els.settingsStatus.textContent = "The browser permission was declined, so this stays off.";
    els.settingsStatus.hidden = false;
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

els.levelSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-level]");
  if (!button) return;
  setLevelSeg(button.dataset.level);
  ext.storage.local.set({ level: button.dataset.level });
});

// ── screenshot-harness hook ───────────────────────────────────
// The UI harness drives the popup into each view to photograph it. Nothing
// here is reachable from web content — the popup page is extension-internal.

self.__ctPopup = { showView, setRing, renderVerdict, renderError, refreshPending };

// ── boot ──────────────────────────────────────────────────────

showView("idle");
refreshSite();
refreshQuota();
refreshPending();
