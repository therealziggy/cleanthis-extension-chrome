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
  importScripts("lib/api.js", "lib/intercept.js", "lib/filetypes.js");
}

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;
const intercept = self.CleanThisIntercept;
const fileTypes = self.CleanThisFileTypes;

const DEFAULT_SETTINGS = {
  interceptEnabled: false,
  level: "standard",
};

async function getSettings() {
  const stored = await ext.storage.local.get([
    ...Object.keys(DEFAULT_SETTINGS),
    "interceptExts",
    fileTypes.CACHE_KEY,
  ]);
  const catalogue = stored[fileTypes.CACHE_KEY] && stored[fileTypes.CACHE_KEY].payload;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Missing key = follow the recommended set (from the cached catalogue if
    // present, else the baked snapshot); a stored array is the user's choice.
    // The worker never fetches the catalogue — the options page owns refresh,
    // so interception stays fast and offline-safe.
    interceptExts: fileTypes.effectiveExts(stored.interceptExts, catalogue),
  };
}

// ── pending notification actions ──────────────────────────────
// storage.session keeps these out of the profile on disk; older Firefox
// builds lack it, so fall back to local storage.
const actionStore = ext.storage.session || ext.storage.local;
const ACTIONS_KEY = "pendingActions";
const INFLIGHT_KEY = "inflightDownloads";

// Every update here is a read-modify-write on a shared object, and two
// downloads failing at once would otherwise overwrite each other's recovery
// offer. Chaining the updates keeps them ordered.
let storageChain = Promise.resolve();

function updateStore(key, mutate, fallback) {
  storageChain = storageChain
    .catch(() => {})
    .then(async () => {
      const stored = await actionStore.get(key);
      const current = stored[key] === undefined ? fallback : stored[key];
      await actionStore.set({ [key]: mutate(current) });
    });
  return storageChain;
}

function rememberAction(notificationId, action) {
  return updateStore(ACTIONS_KEY, (actions) => ({ ...actions, [notificationId]: action }), {}).then(refreshBadge);
}

async function peekAction(notificationId) {
  const { [ACTIONS_KEY]: actions = {} } = await actionStore.get(ACTIONS_KEY);
  return actions[notificationId] || null;
}

// Actions are only dropped once they have actually been carried out — a click
// that fails must leave the offer in place rather than consume it.
function clearAction(notificationId) {
  return updateStore(
    ACTIONS_KEY,
    (actions) => {
      const next = { ...actions };
      delete next[notificationId];
      return next;
    },
    {}
  ).then(refreshBadge);
}

// ── notifications ─────────────────────────────────────────────

let notificationSeq = 0;

// One notification shape for every browser. Firefox supports neither buttons
// nor a notification that waits for the user, so relying on either would mean
// two designs and a promise we could only keep on Chrome. Instead the
// notification is a nudge that may well be missed, and anything the user still
// needs to act on stays on the toolbar badge and in the popup until it is
// dealt with.
async function notify(title, message, action) {
  const id = `cleanthis-${Date.now()}-${notificationSeq++}`;
  const options = {
    type: "basic",
    iconUrl: ext.runtime.getURL("icons/icon-128.png"),
    title,
    message: action
      ? `${message}\n(Click here to ${(action.label || "continue").toLowerCase()}, or open CleanThis.)`
      : message,
  };

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

// The badge is the part that doesn't disappear: it says how many things are
// still waiting for a decision, and the popup lists them.
async function refreshBadge() {
  try {
    const { [ACTIONS_KEY]: actions = {} } = await actionStore.get(ACTIONS_KEY);
    const count = Object.keys(actions).length;
    await ext.action.setBadgeText({ text: count ? String(count) : "" });
    if (count) await ext.action.setBadgeBackgroundColor({ color: "#dc2626" });
  } catch (_) {
    /* the badge is a convenience; never let it break the flow */
  }
}

// ── running a remembered action ───────────────────────────────

async function runAction(notificationId) {
  const action = await peekAction(notificationId);
  if (!action) return;

  if (action.kind === "download-original") {
    // Mark the choice so the download we are about to start isn't intercepted
    // straight back into the cleaner.
    await addBypass(action.url);
    try {
      await ext.downloads.download({ url: action.url });
      await clearAction(notificationId);
    } catch (err) {
      // Keep the offer alive and say so, rather than silently consuming the
      // user's only route back to their file.
      await notify("Couldn't start that download", "Please try again, or copy the link from the page.");
    }
    return;
  }

  if (action.kind === "download-cleaned") {
    // Signed download links expire, so ask for a fresh one at click time.
    try {
      const job = await api.getJob(action.jobId, action.token);
      if (job && job.state === "completed" && job.downloadUrl) {
        await ext.downloads.download({
          url: api.resolveUrl(job.downloadUrl),
          filename: job.downloadName || undefined,
        });
        await clearAction(notificationId);
      } else {
        await clearAction(notificationId);
        await notify(
          "That cleaned file has expired",
          "Cleaned files are only kept for a few minutes. Clean it again to get a fresh copy."
        );
      }
    } catch (err) {
      await notify("Couldn't fetch the cleaned file", "Please try again in a moment.");
    }
  }
}

// The whole notification is the click target — the one gesture both browsers
// agree on.
ext.notifications.onClicked.addListener((notificationId) => {
  runAction(notificationId).finally(() => ext.notifications.clear(notificationId));
});

// A dismissed notification must NOT drop the offer: the popup is now where it
// lives, and dismissing a toast isn't a decision about the file. The entry is
// only cleared once its action has actually been carried out.

// ── bypass list ───────────────────────────────────────────────
// URLs the user chose to download untouched. Capped so a long session can't
// grow it without bound.

const BYPASS_KEY = "bypassUrls";
const BYPASS_MAX = 200;

async function getBypass() {
  const { [BYPASS_KEY]: urls = [] } = await actionStore.get(BYPASS_KEY);
  return new Set(urls);
}

function addBypass(url) {
  return updateStore(
    BYPASS_KEY,
    (urls) => [...urls.filter((u) => u !== url), url].slice(-BYPASS_MAX),
    []
  );
}

// A bypass covers exactly the one download the user asked to keep untouched.
// Consuming it means a later, deliberate download of the same address is
// cleaned again rather than silently waved through for the rest of the session.
function consumeBypass(url) {
  return updateStore(BYPASS_KEY, (urls) => urls.filter((u) => u !== url), []);
}

// ── watching a job the popup handed over ──────────────────────
// The popup polls while it is open. If the user closes it first, it hands the
// job here so the result still reaches them.

// Chrome shuts a background worker down after ~30 seconds of inactivity, and
// only an extension API call resets that timer — fetch and setTimeout do not.
// Waiting for a job is nothing but fetch and setTimeout, so a clean that takes
// longer than half a minute (a large file, or a queue) would be killed
// mid-flight with the download already cancelled. Touching storage on each
// poll keeps the worker awake for as long as we are genuinely working.
// (Anything that still gets past this — a crash, a browser restart — is caught
// by the in-flight record and recoverInterrupted below.)
// The key read is deliberately its own name rather than a value we happen to
// need: it makes the keepalive visible as itself, so a test can tell a real
// keepalive from incidental storage traffic.
const KEEPALIVE_KEY = "keepAlivePing";

function keepAlive() {
  return () => {
    try {
      actionStore.get(KEEPALIVE_KEY).catch(() => {});
    } catch (_) {
      /* keeping the worker alive must never break the wait */
    }
  };
}

async function watchJob({ jobId, downloadToken, name }) {
  try {
    const job = await api.waitForJob(jobId, downloadToken, { onTick: keepAlive() });
    if (job.state === "completed") {
      await notify("File cleaned ✓", `${name || "Your file"} is ready.`, {
        kind: "download-cleaned",
        jobId,
        token: downloadToken,
        label: "Save file",
        name: name || "Your cleaned file",
        why: "Cleaned and ready to save.",
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

// ── download interception ─────────────────────────────────────
// Opt-in. When a download matches, we stop it, have the server fetch and clean
// the file, and hand back the cleaned copy. Every failure ends with the user
// being offered the original — the extension must never be the reason someone
// can't get their file.

const handledDownloads = new Set();

// Did this download complete despite the cancel? Treated as "yes" only on a
// definite answer — if the lookup itself fails we carry on with the clean,
// because the alternative is skipping silently.
async function alreadyOnDisk(id) {
  try {
    const [row] = await ext.downloads.search({ id });
    return !!row && row.state === "complete";
  } catch (_) {
    return false;
  }
}

function offerOriginal(url, message, title = "Couldn't clean this download", label = "Download original", name) {
  return notify(title, message, {
    kind: "download-original",
    url,
    label,
    // What the popup shows for this row, so a missed notification still leaves
    // the user something they can recognise.
    name: name || fileNameOf(url),
    why: message,
  });
}

function fileNameOf(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch (_) {
    return url;
  }
}

async function handleDownload(item) {
  // Our own downloads (the cleaned file, or one the user asked for untouched)
  // must never come back through here.
  if (item.byExtensionId && item.byExtensionId === ext.runtime.id) return;
  if (handledDownloads.has(item.id)) return;

  const settings = await getSettings();
  const decision = intercept.decide(item, settings, await getBypass(), api.baseUrl);
  if (!decision.intercept) {
    // The waiver covered this one download; spend it so a later, deliberate
    // download of the same address is cleaned again.
    if (decision.reason === "bypassed") await consumeBypass(item.url);
    return;
  }

  // If the service is already refusing requests — daily allowance spent, or a
  // rate-limit cooldown in effect — stepping in would cancel the download only
  // to hand it straight back. Leave it alone instead: a normal download beats
  // an interrupted one plus a notification the user has to click.
  if (api._cooldownRemaining() > 0) return;

  handledDownloads.add(item.id);
  const url = item.url;
  const label = item.filename ? item.filename.split(/[\\/]/).pop() : url;

  // Stop the browser's own copy: the point is that the raw file never lands on
  // disk. The cancelled row is deliberately LEFT in the downloads list — it is
  // the browser's own retry affordance, and it stays as a second way back to
  // the file if anything below goes wrong or this worker is shut down.
  try {
    await ext.downloads.cancel(item.id);
  } catch (_) {
    /* whether this throws is browser-specific; the state check below decides */
  }

  // Ask what actually happened rather than trusting the call: cancelling a
  // download that already finished throws on Firefox but resolves on Chromium,
  // so the return value alone would mean two different things. If the file
  // landed anyway, leave it — the user has it, and quietly cleaning behind a
  // file they can already see would be worse than doing nothing.
  if (await alreadyOnDisk(item.id)) return;

  // Note the work before the long wait. If the worker is suspended mid-clean,
  // the next startup finds this record and offers the original.
  await updateStore(INFLIGHT_KEY, (rows) => ({ ...rows, [url]: { label, at: Date.now() } }), {});
  const finish = () => updateStore(INFLIGHT_KEY, (rows) => {
    const next = { ...rows };
    delete next[url];
    return next;
  }, {});

  await notify("Cleaning download…", label);

  try {
    const submission = await api.sanitizeUrl(url, settings.level);

    if (submission && submission.sourceWarning) {
      await finish();
      // The file is still the user's to take, but nothing here should read as
      // a neutral "carry on" — the action says plainly what it does.
      await offerOriginal(
        url,
        `${submission.sourceWarning} We strongly recommend not downloading it.`,
        "⚠️ Dangerous download stopped",
        "Download anyway (unsafe)",
        label
      );
      return;
    }

    if (!submission || !submission.jobId) {
      await finish();
      await offerOriginal(url, "The cleaning service couldn't take this file.", undefined, undefined, label);
      return;
    }

    const job = await api.waitForJob(submission.jobId, submission.downloadToken, {
      onTick: keepAlive(),
    });

    if (job.state !== "completed" || !job.downloadUrl) {
      await finish();
      await offerOriginal(url, job.error || "The file couldn't be cleaned.", undefined, undefined, label);
      return;
    }

    // downloads.download resolves once the download has STARTED, so the
    // notification says what is actually true at that point.
    await ext.downloads.download({
      url: api.resolveUrl(job.downloadUrl),
      filename: job.downloadName || undefined,
    });
    await finish();
    await notify("Download cleaned ✓", `Saving ${job.downloadName || label}.`);
  } catch (err) {
    await finish();
    await offerOriginal(url, err.message || "The cleaning service didn't respond.", undefined, undefined, label);
  }
}

// Anything still marked in-flight when the worker starts was interrupted —
// its download is already cancelled, so hand the user their original back.
async function recoverInterrupted() {
  const { [INFLIGHT_KEY]: rows = {} } = await actionStore.get(INFLIGHT_KEY);
  const urls = Object.keys(rows);
  if (!urls.length) return;
  await actionStore.set({ [INFLIGHT_KEY]: {} });
  for (const url of urls) {
    await offerOriginal(url, `Cleaning ${rows[url].label || "your download"} was interrupted.`, undefined, undefined, rows[url].label);
  }
}

recoverInterrupted().catch(() => {});
refreshBadge();
if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(() => recoverInterrupted().catch(() => {}));

// The popup lists whatever is still pending and asks us to carry it out, so
// the actual doing stays here in one place whether it was started from a
// notification or from the popup.
ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "runAction") return undefined;
  runAction(message.id)
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

ext.downloads.onCreated.addListener((item) => {
  handleDownload(item).catch(() => {
    /* handleDownload reports its own failures to the user */
  });
});

ext.runtime.onInstalled.addListener(() => {
  console.log("CleanThis installed");
});
