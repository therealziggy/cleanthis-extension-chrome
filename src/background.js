// CleanThis — background script.
// Service worker on Chromium browsers, event page on Firefox.
//
// Owns everything that outlives the popup: watching a cleaning job the user
// started and then closed the popup on, intercepting downloads, and the
// notifications that let the user act on the result.
//
// The service worker can be shut down between events, so nothing important
// lives in memory alone — pending notification actions go to storage.

"use strict";

// Chrome loads the shared libraries into the worker here; Firefox lists them
// in the manifest instead (event pages have no importScripts).
if (typeof importScripts === "function") {
  importScripts("lib/api.js", "lib/intercept.js");
}

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;
const intercept = self.CleanThisIntercept;

// Firefox notifications support neither buttons nor a "requireInteraction"
// flag, so there the whole notification body is the click target.
const IS_FIREFOX = typeof browser !== "undefined" && typeof browser.runtime.getBrowserInfo === "function";

const DEFAULT_SETTINGS = {
  interceptEnabled: false,
  level: "standard",
  interceptExts: intercept.DEFAULT_EXTS,
};

async function getSettings() {
  const stored = await ext.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ── pending notification actions ──────────────────────────────
// storage.session keeps these out of the profile on disk; older Firefox
// builds lack it, so fall back to local storage.
const actionStore = ext.storage.session || ext.storage.local;
const ACTIONS_KEY = "pendingActions";

async function rememberAction(notificationId, action) {
  const { [ACTIONS_KEY]: actions = {} } = await actionStore.get(ACTIONS_KEY);
  actions[notificationId] = action;
  await actionStore.set({ [ACTIONS_KEY]: actions });
}

async function takeAction(notificationId) {
  const { [ACTIONS_KEY]: actions = {} } = await actionStore.get(ACTIONS_KEY);
  const action = actions[notificationId];
  if (action) {
    delete actions[notificationId];
    await actionStore.set({ [ACTIONS_KEY]: actions });
  }
  return action || null;
}

// ── notifications ─────────────────────────────────────────────

let notificationSeq = 0;

async function notify(title, message, action) {
  const id = `cleanthis-${Date.now()}-${notificationSeq++}`;
  const options = {
    type: "basic",
    iconUrl: ext.runtime.getURL("icons/icon-128.png"),
    title,
    message,
  };
  // The button label doubles as the hint for Firefox, where the message has
  // to carry the call to action itself.
  if (action && !IS_FIREFOX) {
    options.buttons = [{ title: action.label || "Download" }];
    options.requireInteraction = true;
  } else if (action && IS_FIREFOX) {
    options.message = `${message}\n(Click this notification to ${(action.label || "continue").toLowerCase()}.)`;
  }

  await new Promise((resolve) => {
    try {
      ext.notifications.create(id, options, () => resolve());
    } catch (_) {
      resolve();
    }
  });

  if (action) await rememberAction(id, action);
  return id;
}

// ── running a remembered action ───────────────────────────────

async function runAction(notificationId) {
  const action = await takeAction(notificationId);
  if (!action) return;

  if (action.kind === "download-original") {
    // Remember the choice so the download we are about to start isn't
    // intercepted straight back into the cleaner.
    await addBypass(action.url);
    ext.downloads.download({ url: action.url }).catch(() => {});
    return;
  }

  if (action.kind === "download-cleaned") {
    // Signed download links expire, so ask for a fresh one at click time.
    try {
      const job = await api.getJob(action.jobId, action.token);
      if (job && job.state === "completed" && job.downloadUrl) {
        ext.downloads.download({
          url: api.baseUrl + job.downloadUrl,
          filename: job.downloadName || undefined,
        }).catch(() => {});
      } else {
        await notify("Cleaned file no longer available", "Cleaned files are kept briefly. Please run it through again.");
      }
    } catch (err) {
      await notify("Couldn't fetch the cleaned file", err.message || "Please try again.");
    }
  }
}

ext.notifications.onButtonClicked.addListener((notificationId) => {
  runAction(notificationId);
  ext.notifications.clear(notificationId);
});

ext.notifications.onClicked.addListener((notificationId) => {
  // Chrome has explicit buttons; a body click there is just a dismissal.
  if (IS_FIREFOX) runAction(notificationId);
  ext.notifications.clear(notificationId);
});

// ── bypass list ───────────────────────────────────────────────
// URLs the user chose to download untouched. Capped so a long session can't
// grow it without bound.

const BYPASS_KEY = "bypassUrls";
const BYPASS_MAX = 200;

async function getBypass() {
  const { [BYPASS_KEY]: urls = [] } = await actionStore.get(BYPASS_KEY);
  return new Set(urls);
}

async function addBypass(url) {
  const { [BYPASS_KEY]: urls = [] } = await actionStore.get(BYPASS_KEY);
  const next = urls.filter((u) => u !== url);
  next.push(url);
  await actionStore.set({ [BYPASS_KEY]: next.slice(-BYPASS_MAX) });
}

// ── watching a job the popup handed over ──────────────────────
// The popup polls while it is open. If the user closes it first, it hands the
// job here so the result still reaches them.

async function watchJob({ jobId, downloadToken, name }) {
  try {
    const job = await api.waitForJob(jobId, downloadToken);
    if (job.state === "completed") {
      await notify("File cleaned ✓", `${name || "Your file"} is ready.`, {
        kind: "download-cleaned",
        jobId,
        token: downloadToken,
        label: "Save file",
      });
    } else if (job.state === "failed") {
      await notify("Cleaning failed", job.error || "Please try again.");
    }
  } catch (err) {
    await notify("Cleaning failed", err.message || "Please try again.");
  }
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "job-watch") return;
  let pending = null;
  let handledByPopup = false;

  port.onMessage.addListener((msg) => {
    if (msg && msg.done) handledByPopup = true;
    else if (msg && msg.jobId) pending = msg;
  });

  port.onDisconnect.addListener(() => {
    if (pending && !handledByPopup) watchJob(pending);
  });
});

ext.runtime.onInstalled.addListener(() => {
  console.log("CleanThis installed");
});
