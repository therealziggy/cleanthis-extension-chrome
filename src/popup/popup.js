// CleanThis — popup logic (v0.6 redesign).
//
// One card, several views: idle | scanning | verdict | settings | error.
// Scan-and-status only, as ever: file cleaning lives in its own window
// (clean/clean.html) because a popup dies the moment the native file dialog
// takes focus. The drop zone here is an affordance that opens that window.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;
const vlib = self.CleanThisVerdict;
const docs = self.CleanThisDocs;
const fileTypes = self.CleanThisFileTypes;
const theme = self.CleanThisTheme;

const els = {
  brand: document.getElementById("brand"),
  themeBtn: document.getElementById("theme-btn"),
  themeSeg: document.getElementById("theme-seg"),
  siteHost: document.getElementById("site-host"),
  deepLine: document.getElementById("deep-line"),
  deepScan: document.getElementById("deep-scan"),
  cleanUrl: document.getElementById("clean-url"),
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

    // Declining is a decision the row must allow too — without it, an ignored
    // offer sits on the badge for the rest of the session.
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "secondary pending-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", async () => {
      dismiss.disabled = true;
      try {
        await ext.runtime.sendMessage({ type: "dismissAction", id });
      } catch (_) {
        /* refreshing below shows whether it worked */
      }
      await refreshPending();
    });

    const actions = document.createElement("div");
    actions.className = "pending-actions";
    actions.append(button, dismiss);
    row.append(actions);
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

// ── the active tab on the idle view: globe + host, clean-this-file ──

let idleTabUrl = null; // the scannable active-tab URL, for the idle deep link

async function refreshSite() {
  let url = null;
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    url = tab && tab.url;
  } catch (_) {
    /* fall through to the hidden block */
  }

  if (url && /^https?:\/\//i.test(url)) {
    els.site.textContent = new URL(url).hostname;
    els.siteHost.hidden = false;
    idleTabUrl = url;
    els.deepLine.hidden = false;
  } else {
    els.site.textContent = "";
    els.siteHost.hidden = true;
    idleTabUrl = null;
    els.deepLine.hidden = true;
  }

  // "Clean this .pdf" — only when the tab itself IS a cleanable document on a
  // public host that isn't ours. The URL leaves the device only on click.
  els.cleanUrl.hidden = true;
  if (url) {
    try {
      const { payload } = await fileTypes.getConfig(ext);
      const cleanableExt = docs.cleanableExtFor(url, payload, api.baseUrl);
      if (cleanableExt) {
        els.cleanUrl.textContent = `Clean this .${cleanableExt} ↗`;
        els.cleanUrl.hidden = false;
        els.cleanUrl.onclick = async () => {
          try {
            await windowStore.set({ cleanUrlIntent: url });
            ext.runtime.sendMessage({ type: "cleanUrl", url }).catch(() => {});
          } catch (_) {
            /* the clean window still opens; the user can re-click there */
          }
          openCleanWindow();
        };
      }
    } catch (_) {
      /* no catalogue → no offer; the drop zone still works */
    }
  }
}

// ── theme toggle (system default, explicit override) ──────────

const THEME_GLYPHS = {
  // shown = what a click switches TO
  sun: ["M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z", "M12 4V2", "M12 22v-2", "M4 12H2", "M22 12h-2",
    "M5.6 5.6 4.2 4.2", "M19.8 19.8l-1.4-1.4", "M18.4 5.6l1.4-1.4", "M4.2 19.8l1.4-1.4"],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
};

// One painter for both controls, so the header glyph and the settings seg
// can never disagree about the current choice.
function syncThemeUi() {
  els.themeBtn.textContent = "";
  els.themeBtn.append(svgIcon(18, theme.effective() === "dark" ? THEME_GLYPHS.sun : THEME_GLYPHS.moon));
  const choice = theme.saved() || "system";
  for (const button of els.themeSeg.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  }
}

els.themeBtn.addEventListener("click", () => {
  theme.set(theme.effective() === "dark" ? "light" : "dark");
  syncThemeUi();
});

els.themeSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-theme-choice]");
  if (!button) return;
  theme.set(button.dataset.themeChoice === "system" ? null : button.dataset.themeChoice);
  syncThemeUi();
});

// ── header brand: opens the website ───────────────────────────
// Same convention as "Full report ↗": open the tab, let the popup close
// itself when focus moves (an explicit close would break the harness page).

els.brand.addEventListener("click", () => ext.tabs.create({ url: api.baseUrl }));

els.deepScan.addEventListener("click", () => {
  if (idleTabUrl) ext.tabs.create({ url: deepUrl(idleTabUrl) });
});

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

async function startScan(bypass) {
  // A deliberate Rescan asks the server for a fresh run instead of the 24h
  // cached result — same contract as the website's Re-scan button.
  const fresh = bypass === true;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url;

  if (!url || !/^https?:\/\//i.test(url)) {
    renderError("notpage");
    showView("error");
    return;
  }

  els.scanSite.textContent = new URL(url).hostname;
  scanController = new AbortController();
  showView("scanning");
  startRing();

  try {
    const result = await api.scanUrl(url, "standard", { signal: scanController.signal, bypassCache: fresh });
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

els.scanBtn.addEventListener("click", () => startScan(false));

els.cancelScan.addEventListener("click", () => {
  if (scanController) scanController.abort();
});

// ── verdict rendering ─────────────────────────────────────────

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

// One score wheel — the site's ring-gauge geometry (72×72, r=30, stroke 7),
// DOM-built like every other SVG here. Band color rides a class on the wrap;
// the arc and number pick it up via currentColor.
function wheel(state, name) {
  const NS = "http://www.w3.org/2000/svg";
  const wrap = text("div", `wheel band-${state.band}`);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 72 72");
  svg.setAttribute("width", "72");
  svg.setAttribute("height", "72");
  svg.setAttribute("aria-hidden", "true");
  const circumference = 2 * Math.PI * 30;

  const track = document.createElementNS(NS, "circle");
  for (const [attr, val] of [["cx", "36"], ["cy", "36"], ["r", "30"], ["fill", "none"], ["stroke-width", "7"]]) {
    track.setAttribute(attr, val);
  }
  track.setAttribute("class", "wheel-track");
  svg.append(track);

  if (!state.none) {
    const arc = document.createElementNS(NS, "circle");
    for (const [attr, val] of [["cx", "36"], ["cy", "36"], ["r", "30"], ["fill", "none"], ["stroke-width", "7"], ["stroke-linecap", "round"]]) {
      arc.setAttribute(attr, val);
    }
    arc.setAttribute("class", "wheel-arc");
    const filled = (circumference * Math.max(0, Math.min(100, Number(state.value)))) / 100;
    arc.setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${circumference.toFixed(1)}`);
    arc.setAttribute("transform", "rotate(-90 36 36)");
    svg.append(arc);
  }

  const num = document.createElementNS(NS, "text");
  num.setAttribute("x", "36");
  num.setAttribute("y", "41");
  num.setAttribute("text-anchor", "middle");
  num.setAttribute("class", "wheel-num");
  num.textContent = state.value;
  svg.append(num);

  if (!state.none) {
    const denom = document.createElementNS(NS, "text");
    denom.setAttribute("x", "36");
    denom.setAttribute("y", "52");
    denom.setAttribute("text-anchor", "middle");
    denom.setAttribute("class", "wheel-denom");
    denom.textContent = "/ 100";
    svg.append(denom);
  }

  wrap.append(svg);
  wrap.append(text("div", "wheel-name", name));
  const driver = text("div", "wheel-driver", state.driver);
  if (state.suffix) driver.append(text("span", "wheel-cov", state.suffix));
  wrap.append(driver);
  return wrap;
}

function reportUrl(url) {
  return `${api.baseUrl}/webpage-scanner.html?url=${encodeURIComponent(url)}`;
}

// The site's scanner prefills from these params and pre-selects Deep; it
// deliberately never auto-submits, so the user starts the scan there.
function deepUrl(url) {
  return `${api.baseUrl}/webpage-scanner.html?url=${encodeURIComponent(url)}&tier=aggressive`;
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

  // The one view that had no way home (error and settings both have one).
  els.verdict.append(actionButton("backlink", "‹ Back", () => showView("idle")));

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

  // The site's three score wheels, always — per-axis reason under each wheel,
  // one overall statement below (same strings as the website's report).
  const scores = result.scores || {};
  const wheels = text("div", "wheels");
  for (const [key, name] of [["security", "Security"], ["privacy", "Privacy"], ["legitimacy", "Legitimacy"]]) {
    wheels.append(wheel(vlib.wheelState(scores[key]), name));
  }
  els.verdict.append(wheels);

  const statement = vlib.statementFor(verdict, result.findings);
  els.verdict.append(text("p", `statement ${statement.strong ? "strong" : ""}`.trim(), statement.text));

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
    actions.append(actionButton("secondary", "Rescan", () => startScan(true)));
  }
  els.verdict.append(actions);

  if (verdict === "malicious") {
    els.verdict.append(text("p", "verdict-closer", "You can still proceed — we'll just look at you funny."));
  } else {
    // The moment deep matters is right after quick results — the wheels above
    // may already say "limited (Quick scan)". Malicious keeps its two actions.
    const deep = text("p", "deep-line");
    deep.append("Need a deeper look? ");
    deep.append(actionButton("linklike", "Deep scan ↗", () => {
      ext.tabs.create({ url: deepUrl(url) });
    }));
    els.verdict.append(deep);
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
  if (spec.retry) actions.append(actionButton("", "Try again", () => startScan(false)));
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
  // Record the intent BEFORE requesting: the browser's grant prompt steals
  // focus and can kill this popup mid-await — the user clicks Allow, the
  // permission lands, but the code below never runs. The background's
  // permissions.onAdded listener sees this marker and finishes the enable
  // (completeFlaggedIntent in background.js). If we survive, we clear it and
  // proceed normally; both paths are idempotent.
  try {
    await ext.storage.local.set({ flaggedPendingAt: Date.now() });
  } catch (_) {
    /* worst case we're back to the popup-only flow */
  }
  let granted = false;
  let requestFailed = false;
  try {
    granted = await ext.permissions.request({ permissions: ["tabs", "webNavigation"] });
  } catch (_) {
    granted = false;
    requestFailed = true;
  }
  try {
    await ext.storage.local.remove("flaggedPendingAt");
  } catch (_) {
    /* the background sweeps stale intents anyway */
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

self.__ctPopup = { showView, setRing, renderVerdict, renderError, refreshPending, refreshSite };

// ── boot ──────────────────────────────────────────────────────

showView("idle");
syncThemeUi();
refreshSite();
refreshQuota();
refreshPending();
