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
  importScripts("lib/api.js", "lib/intercept.js", "lib/filetypes.js", "lib/flagged.js", "lib/docs.js", "lib/scantarget.js");
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
// still waiting for a decision, and the popup lists them. A file we could not
// clean outranks everything — red "!", not a number; never both at once.
async function refreshBadge() {
  try {
    const { [ACTIONS_KEY]: actions = {} } = await actionStore.get(ACTIONS_KEY);
    const entries = Object.values(actions);
    const failed = entries.some((a) => a && a.kind === "download-original");
    const text = failed ? "!" : entries.length ? String(entries.length) : "";
    await ext.action.setBadgeText({ text });
    if (text) await ext.action.setBadgeBackgroundColor({ color: failed ? "#dc2626" : "#d97706" });
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
    } catch (_) {
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
    } catch (_) {
      await notify("Couldn't fetch the cleaned file", "Please try again in a moment.");
    }
  }
}

// Declining is a decision too. The popup row's Dismiss drops the offer
// without carrying it out: nothing downloads, no bypass is granted, and the
// badge is recounted. A change of heart only costs a re-clean — cleaned
// copies expire on the server within minutes anyway.
function dismissAction(notificationId) {
  ext.notifications.clear(notificationId);
  return clearAction(notificationId);
}

// The whole notification is the click target — the one gesture both browsers
// agree on.
ext.notifications.onClicked.addListener((notificationId) => {
  runAction(notificationId).finally(() => ext.notifications.clear(notificationId));
});

// A dismissed notification must NOT drop the offer: the popup is now where it
// lives, and dismissing a toast isn't a decision about the file. The entry is
// only cleared once its action has been carried out — or explicitly declined
// through the popup row's Dismiss, which is one.

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

// ── page-job handoff records ──────────────────────────────────
// The port protocol above the connect handler is not enough on its own: this
// worker's copy of a handed-over job dies with the worker (an idle port does
// not keep an MV3 worker alive), and a page that closes just then would tell
// no one. So the page also writes a per-job record BEFORE announcing the job
// (`pageJob:<jobId>`, in the same session-preferring store — a browser
// restart wipes it, correctly: the job would be long expired), reconnects
// when its port drops, and removes the record when it settles. Here, claims
// are exclusive (serialized on storageChain, marked rather than deleted so a
// worker that dies mid-watch leaves a claim another sweep can re-take), and
// a start-time sweep picks up orphans.

const PAGE_JOB_PREFIX = "pageJob:";
const PAGE_JOB_MAX_AGE_MS = 30 * 60 * 1000;
const PAGE_JOB_CLAIM_MS = 2 * 60 * 1000;
const PAGE_JOB_SWEEP_DELAY_MS = 5000;

// Jobs whose page is connected to THIS worker instance. The sweep leaves
// those to their page.
const liveJobPorts = new Map();
// Harness hook (the __ctPopup pattern): recovery.js needs to stage a live
// port without opening a real page.
self.__ctJobs = { liveJobPorts };

function claimPageJob(jobId) {
  const key = PAGE_JOB_PREFIX + jobId;
  let result = { absent: true };
  storageChain = storageChain
    .catch(() => {})
    .then(async () => {
      const stored = await actionStore.get(key);
      const row = stored[key];
      if (!row) {
        result = { absent: true };
        return;
      }
      if (Number.isFinite(row.claimedAt) && Date.now() - row.claimedAt < PAGE_JOB_CLAIM_MS) {
        result = { held: true };
        return;
      }
      result = { job: row };
      await actionStore.set({ [key]: { ...row, claimedAt: Date.now() } });
    });
  return storageChain.then(() => result);
}

function releasePageJob(jobId) {
  const key = PAGE_JOB_PREFIX + jobId;
  storageChain = storageChain.catch(() => {}).then(() => actionStore.remove(key));
  return storageChain;
}

// watchJob never throws (every outcome ends in a notification), so the
// release always runs — on failure too: the failure was announced, which is
// as dealt-with as a job gets.
function watchPageJob(job) {
  return watchJob(job).then(
    () => releasePageJob(job.jobId).catch(() => {}),
    () => releasePageJob(job.jobId).catch(() => {})
  );
}

async function recoverPageJobs() {
  let all = {};
  try {
    all = await actionStore.get(null);
  } catch (_) {
    return;
  }
  const watches = [];
  for (const [key, row] of Object.entries(all)) {
    if (!key.startsWith(PAGE_JOB_PREFIX)) continue;
    const jobId = key.slice(PAGE_JOB_PREFIX.length);
    if (liveJobPorts.has(jobId)) continue; // its page is alive and polling
    if (!row || !Number.isFinite(row.at) || Date.now() - row.at > PAGE_JOB_MAX_AGE_MS) {
      // Signed links and job rows are long gone server-side; announcing
      // anything about this job now would be a lie. Drop it silently.
      watches.push(releasePageJob(jobId).catch(() => {}));
      continue;
    }
    const claim = await claimPageJob(jobId);
    if (claim.job) watches.push(watchPageJob(claim.job));
  }
  await Promise.all(watches);
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "job-watch") return;
  let pending = null;
  let handledByPopup = false;

  port.onMessage.addListener((msg) => {
    if (msg && msg.done) {
      handledByPopup = true;
      if (pending) liveJobPorts.delete(pending.jobId);
    } else if (msg && msg.jobId) {
      pending = msg;
      liveJobPorts.set(msg.jobId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (pending) liveJobPorts.delete(pending.jobId);
    if (!pending || handledByPopup) return;
    const job = pending;
    claimPageJob(job.jobId)
      .then((claim) => {
        // A held claim means another path is already watching. No record at
        // all usually means the page's write failed — and with nothing
        // stored there is also nothing a sweep could double-announce, so the
        // in-memory copy is safe to act on.
        if (claim.job) return watchPageJob(claim.job);
        if (claim.absent) return watchJob(job);
        return undefined;
      })
      .catch(() => {});
  });
});

// Orphan sweep, once per worker start, after a grace period: the wake that
// runs this is usually caused by the page's own reconnect, and that port has
// to register in liveJobPorts before the sweep decides who owns which job.
setTimeout(() => {
  recoverPageJobs().catch(() => {});
}, PAGE_JOB_SWEEP_DELAY_MS);

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

// A filename delta can race the initial consideration of the same row; one
// look at a time, the loser dropped — a doubled look could submit twice.
const consideringDownloads = new Set();

async function handleDownload(item) {
  // Our own downloads (the cleaned file, or one the user asked for untouched)
  // must never come back through here. This check is what actually prevents
  // the loop — the waiver added before the download is the belt to its
  // braces — but the waiver has now done its job, so spend it here. Left
  // behind, it would wave through the NEXT deliberate download of the same
  // address too, which is the opposite of what a one-shot waiver means.
  if (item.byExtensionId && item.byExtensionId === ext.runtime.id) {
    await consumeBypass(item.url);
    return;
  }
  if (handledDownloads.has(item.id)) return;
  if (consideringDownloads.has(item.id)) return;

  consideringDownloads.add(item.id);
  try {
    await considerDownload(item);
  } finally {
    consideringDownloads.delete(item.id);
  }
}

async function considerDownload(item) {
  // Only a download that is genuinely STARTING is ours to step into. Browsers
  // re-deliver old rows in several ways — restored interrupted downloads at
  // startup, session restore, auto-resume — and every such replay carries a
  // terminal/stale state or an old startTime. Without these two guards a
  // browser start could sweep the download history into the cleaning service
  // (observed in the field 2026-08-20: days-old files re-submitted at boot,
  // six failure offers on one startup). A real new download is always
  // in_progress with a startTime of "just now"; anything else is history.
  if (item.state && item.state !== "in_progress") return;
  if (item.startTime) {
    const started = Date.parse(item.startTime);
    if (Number.isFinite(started) && Date.now() - started > 60 * 1000) return;
  }

  const settings = await getSettings();
  const decision = intercept.decide(item, settings, await getBypass(), api.baseUrl);
  if (!decision.intercept) {
    // The waiver covered this one download; spend it so a later, deliberate
    // download of the same address is cleaned again. The row is marked
    // handled at the same time: its spent waiver would otherwise be invisible
    // to a later filename delta, which would re-decide the very download the
    // user asked to keep untouched.
    if (decision.reason === "bypassed") {
      handledDownloads.add(item.id);
      await consumeBypass(item.url);
    }
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
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;
  if (message.type === "runAction") {
    runAction(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "dismissAction") {
    dismissAction(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "flaggedEnabled") {
    // The options page just turned warnings on: attach the pre-navigation
    // listener (the permission was granted moments ago) and fetch the list.
    // Forced: a user flipping the toggle deserves an immediate try even if a
    // recent background attempt failed.
    syncWebNavListener();
    refreshFlaggedList({ force: true })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "closeMe" && sender.tab && sender.tab.id !== undefined) {
    // The warning page asked to close its own tab (no history to go back to).
    ext.tabs.remove(sender.tab.id).catch(() => {});
    return undefined;
  }
  if (message.type === "docProceed" && typeof message.host === "string") {
    // Document ask "Open anyway": a one-shot doc bypass so the re-navigation
    // isn't re-asked. Deliberately NOT a flagged bypass.
    grantDocBypass(message.host)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});

ext.downloads.onCreated.addListener((item) => {
  handleDownload(item).catch(() => {
    /* handleDownload reports its own failures to the user */
  });
});

// Chromium often creates a download before it has determined the filename: a
// Content-Disposition name on a download.php-style URL arrives moments later
// as an onChanged delta, and that delta is the only chance to intercept those
// (the URL itself carries no suffix to match). handleDownload's own guards —
// already-handled rows, stale replays, the spent-waiver mark, the cooldown —
// make the second look safe to take. Firefox names rows before onCreated, so
// the delta path is a no-op there.
async function handleDownloadDelta(delta) {
  if (!delta || !delta.filename || !delta.filename.current) return;
  const [row] = await ext.downloads.search({ id: delta.id });
  if (row) await handleDownload(row);
}

ext.downloads.onChanged.addListener((delta) => {
  handleDownloadDelta(delta).catch(() => {
    /* handleDownload reports its own failures to the user */
  });
});

// The popup re-focuses an already-open cleaning window by its stored id;
// forget the id the moment that window closes so a stale one can never
// focus something unrelated.
ext.windows.onRemoved.addListener(async (windowId) => {
  try {
    const store = ext.storage.session || ext.storage.local;
    const { cleanWindowId } = await store.get("cleanWindowId");
    if (cleanWindowId === windowId) await store.remove("cleanWindowId");
  } catch (_) {
    /* the popup's focus attempt self-heals by opening a fresh window */
  }
});

// ── flagged-site warnings (opt-in, default OFF) ───────────────
// The visited address is checked ON THIS DEVICE against a downloaded list —
// it never leaves the machine. tabs.onUpdated itself needs no permission;
// the optional "tabs" permission is what makes changeInfo.url visible, so
// before the user opts in (and grants it) this listener sees no URLs at all.
// Registration stays top-level and unconditional: MV3 workers must register
// listeners synchronously at startup for wake-up delivery.

const flagged = self.CleanThisFlagged;

// The decoded list is rebuilt only when the stored version changes.
let flaggedIndex = { version: null, index: null };

let flaggedRefreshInFlight = null;
// A forced call joining an unforced in-flight fetch just joins it — a fetch
// is happening either way, which is all "force" asks for.
function refreshFlaggedList(opts) {
  if (!flaggedRefreshInFlight) {
    flaggedRefreshInFlight = flagged
      .refreshList(ext, opts)
      .finally(() => {
        flaggedRefreshInFlight = null;
      });
  }
  return flaggedRefreshInFlight;
}

async function maybeRefreshFlaggedList({ force = false } = {}) {
  const stored = await ext.storage.local.get(["flaggedEnabled", flagged.LIST_KEY]);
  if (stored.flaggedEnabled !== true) return;
  if (flagged.listStale(stored[flagged.LIST_KEY])) await refreshFlaggedList({ force });
}

// One navigation crosses BOTH checkpoints below (pre-navigation, then
// commit), so a proceed-anyway grant is PEEKED at the first and CONSUMED only
// at the second — consuming twice would warn straight after every proceed.
async function flaggedVerdictFor(url, { consume }) {
  const host = flagged.canonicalHost(url);
  if (!host) return null;

  const stored = await ext.storage.local.get(["flaggedEnabled", flagged.LIST_KEY]);
  if (stored.flaggedEnabled !== true) return null;

  const list = stored[flagged.LIST_KEY];
  if (flagged.listStale(list)) refreshFlaggedList(); // background top-up; this check uses what's here
  if (!list || !Array.isArray(list.entries) || !list.entries.length) return null;

  if (flaggedIndex.version !== list.version || !flaggedIndex.indexes) {
    flaggedIndex = { version: list.version, indexes: flagged.buildIndexes(list) };
  }

  const hit = await flagged.check(url, flaggedIndex.indexes);
  if (!hit) return null;

  // The proceed-anyway bypass exists for walls; a soft heads-up never blocks
  // anything, so there is nothing to bypass.
  if (hit.level === "wall") {
    const bypassed = consume ? await flagged.takeBypass(ext, host) : await flagged.peekBypass(ext, host);
    if (bypassed) return null;
  }

  return hit;
}

// ── opt-in "ask before opening document links" (default OFF) ──
// A SEPARATE bypass namespace from the flagged wall: a document proceed must
// never bypass a flagged wall (different risk, different consent). Same
// one-shot short-lived shape.
const docs = self.CleanThisDocs;
const DOC_BYPASS_KEY = "docBypass";
const DOC_BYPASS_TTL_MS = 30 * 1000;
const docBypassStore = ext.storage.session || ext.storage.local;

async function grantDocBypass(host) {
  try {
    await docBypassStore.set({ [DOC_BYPASS_KEY]: { host, until: Date.now() + DOC_BYPASS_TTL_MS } });
  } catch (_) {
    /* the worst case is one extra ask */
  }
}

async function takeDocBypass(host) {
  let grant = null;
  try {
    ({ [DOC_BYPASS_KEY]: grant = null } = await docBypassStore.get(DOC_BYPASS_KEY));
  } catch (_) {
    return false;
  }
  if (!grant || grant.host !== host || grant.until < Date.now()) return false;
  try {
    await docBypassStore.remove(DOC_BYPASS_KEY);
  } catch (_) {
    /* consumed either way */
  }
  return true;
}

// Should we interrupt this navigation with the document ask? Only when the
// toggle is on, the target is a document/archive on a public host, and no
// fresh doc-bypass covers it. The flagged wall is checked FIRST by the caller
// and outranks this.
async function docAskFor(url, { consume }) {
  let enabled = false;
  try {
    ({ docAskEnabled: enabled = false } = await ext.storage.local.get("docAskEnabled"));
  } catch (_) {
    return false;
  }
  if (enabled !== true) return false;
  if (!docs.isBlanketDocUrl(url)) return false;
  let host;
  try {
    // Trailing dot stripped to match the key the warning page grants under
    // (warning.js derives its host the same way, as does flagged.canonicalHost).
    // Without this, "Open anyway" on host. grants `host` while the next check
    // looks up `host.` — and the ask returns forever, which is exactly the
    // never-loop guard rail this feature is bound by.
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return false;
  }
  if (host === new URL(api.baseUrl).hostname) return false;
  const bypassed = consume ? await takeDocBypass(host) : await docBypassStoreHas(host);
  return !bypassed;
}

// Peek (no consume) for the pre-navigation checkpoint — the commit-time check
// is the single consumer, mirroring the flagged peek/take split.
async function docBypassStoreHas(host) {
  let grant = null;
  try {
    ({ [DOC_BYPASS_KEY]: grant = null } = await docBypassStore.get(DOC_BYPASS_KEY));
  } catch (_) {
    return false;
  }
  return !!grant && grant.host === host && grant.until >= Date.now();
}

async function warnDocTab(tabId, url, via) {
  const params = new URLSearchParams({ to: url, kind: "document", via });
  try {
    await ext.tabs.update(tabId, { url: `${ext.runtime.getURL("warning/warning.html")}?${params}` });
  } catch (_) {
    /* tab already gone */
  }
}

// The hybrid's soft tier (2026-08-20): a one-time heads-up notification,
// never a wall. Two flavours since v0.6.9 — a hacked-but-legitimate site,
// and a site the list knows only for spam promotion (the wall is reserved
// for sites reported as dangerous in themselves; the shipped category says
// which flavour this is).
async function softHeadsUp(hit) {
  if (await flagged.softAlreadyShown(ext, hit.host)) return;
  const message =
    hit.cat === "compromised"
      ? `Pages on ${hit.host} have been reported as compromised. Be careful with downloads and login forms.`
      : `${hit.host} is known mainly for being promoted through spam campaigns. Nothing is blocked — just be careful with anything it offers.`;
  await notify("Heads up about this site", message);
}

// `via` tells the warning page how the flagged URL sits in history: a
// commit-time warn is layered ON TOP of the flagged entry (go back = -2),
// a pre-navigation warn replaced a navigation that never committed (-1).
async function warnTab(tabId, url, hit, via) {
  const params = new URLSearchParams({ to: url, cat: hit.cat, via });
  if (hit.seen) params.set("seen", hit.seen);
  try {
    await ext.tabs.update(tabId, { url: `${ext.runtime.getURL("warning/warning.html")}?${params}` });
  } catch (_) {
    /* tab already gone */
  }
}

// Commit-time check: catches flagged hosts the user actually lands on.
async function onTabUpdated(tabId, changeInfo) {
  if (!changeInfo || !changeInfo.url) return;
  const hit = await flaggedVerdictFor(changeInfo.url, { consume: true });
  if (hit) {
    if (hit.level === "soft") return softHeadsUp(hit);
    return warnTab(tabId, changeInfo.url, hit, "commit");
  }
  // Not flagged — the opt-in document ask gets the next say (consumes here,
  // the single spend point across both checkpoints).
  if (await docAskFor(changeInfo.url, { consume: true })) {
    await warnDocTab(tabId, changeInfo.url, "commit");
  }
}

// Pre-navigation check: sees the REQUESTED url before the server answers —
// the only view that catches flagged hosts which redirect away instantly
// (spamvertised burner domains 301 elsewhere, so their URL never commits and
// tabs.onUpdated alone is blind to them — 2026-08-19 field report).
async function onBeforeNavigate(details) {
  if (!details || details.frameId !== 0 || !details.url) return;
  const hit = await flaggedVerdictFor(details.url, { consume: false });
  if (hit) {
    if (hit.level === "soft") return softHeadsUp(hit);
    return warnTab(details.tabId, details.url, hit, "nav");
  }
  if (await docAskFor(details.url, { consume: false })) {
    await warnDocTab(details.tabId, details.url, "nav");
  }
}

// webNavigation is an OPTIONAL permission: its namespace may be missing until
// granted (and, on some builds, until the worker restarts after the grant).
// Registration is therefore defensive-but-eager: top level for wake-safety,
// again on grant, and again when the options page announces the toggle.
function syncWebNavListener() {
  const api = ext.webNavigation;
  if (!api || !api.onBeforeNavigate) return; // not granted (or not yet visible)
  if (!api.onBeforeNavigate.hasListener(onBeforeNavigate)) {
    api.onBeforeNavigate.addListener(onBeforeNavigate);
  }
}

ext.tabs.onUpdated.addListener(onTabUpdated);
syncWebNavListener();
// The popup's flagged toggle records intent BEFORE calling
// permissions.request(): the browser's grant prompt steals focus, which kills
// the popup, so the toggle handler's continuation (the part that would write
// flaggedEnabled) can die even though the user clicked Allow. When the grant
// lands, onAdded fires HERE — and the background finishes the job the popup
// started. Freshness-bounded so an abandoned prompt from days ago can't
// activate anything; a grant with no recorded intent changes nothing.
const FLAGGED_INTENT_MS = 5 * 60 * 1000;

async function completeFlaggedIntent() {
  try {
    const { flaggedPendingAt } = await ext.storage.local.get("flaggedPendingAt");
    if (flaggedPendingAt === undefined) return;
    await ext.storage.local.remove("flaggedPendingAt");
    if (Date.now() - flaggedPendingAt > FLAGGED_INTENT_MS) return;
    const granted = await ext.permissions.contains({ permissions: ["tabs"] });
    if (!granted) return;
    await ext.storage.local.set({ flaggedEnabled: true });
    syncWebNavListener();
    await maybeRefreshFlaggedList({ force: true });
  } catch (_) {
    /* the popup path or the next toggle still enables it */
  }
}

if (ext.permissions && ext.permissions.onAdded) {
  ext.permissions.onAdded.addListener(() => {
    syncWebNavListener();
    completeFlaggedIntent().catch(() => {});
  });
}
maybeRefreshFlaggedList().catch(() => {});
if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(() => {
    syncWebNavListener();
    maybeRefreshFlaggedList().catch(() => {});
  });
}

ext.runtime.onInstalled.addListener((details) => {
  // First install only — not updates, and not Firefox temporary add-ons
  // (details.temporary), which re-fire "install" on every about:debugging
  // load and would grow a welcome tab each time.
  if (details && details.reason === "install" && !details.temporary) {
    Promise.resolve(ext.tabs.create({ url: ext.runtime.getURL("welcome/welcome.html") })).catch(() => {
      /* the popup and options still introduce the features */
    });
  }
});

// ---- Right-click "Scan with CleanThis" --------------------------------------
//
// One item for both links and selections. One, not two: right-clicking a
// *selected link* activates both contexts at once, and Chrome folds multiple
// visible items into a "CleanThis ▸" submenu — a single top-level item keeps
// the extension icon beside it instead. No targetUrlPatterns either: how it
// interacts with plain selections (which have no target URL) is unspecified,
// so scheme filtering lives in the click handler — one code path for both.
//
// Registration is idempotent (removeAll → create) and runs at top level on
// every worker start as well as on install: Chrome persists menus, but
// Firefox event pages can lose them across browser restarts, and unpacked
// reloads re-fire onInstalled — the same defensive-but-eager posture as
// syncWebNavListener above.
const SCAN_MENU_ID = "cleanthis-scan";

function registerScanMenu() {
  if (!ext.contextMenus) return;
  const item = { id: SCAN_MENU_ID, title: "Scan with CleanThis", contexts: ["link", "selection"] };
  // Firefox draws no icon on context items by default; `icons` is its
  // menus-API extra, and Chrome's strict schema rejects unknown keys.
  if (typeof browser !== "undefined" && browser.menus) item.icons = { 16: "icons/icon-16.png" };
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create(item, () => {
      void ext.runtime.lastError; // duplicate-id during a racing wake — harmless
    });
  });
}

// Prefers the actual link target; a right-click on a mailto: link with URL
// text selected still scans the selection. Prefill-only — the scanner page
// never auto-submits — so a misclick costs a tab, not a scan.
async function handleContextScan(info) {
  const resolveTarget = self.CleanThisScanTarget.resolve;
  const hit = [info.linkUrl, info.selectionText].map(resolveTarget).find((r) => r.ok);
  if (!hit) {
    await notify("CleanThis", "Couldn't find a web address in that selection.");
    return { opened: false };
  }
  await ext.tabs.create({ url: `${api.baseUrl}/webpage-scanner.html?url=${encodeURIComponent(hit.url)}` });
  return { opened: true, url: hit.url };
}

if (ext.contextMenus) {
  ext.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === SCAN_MENU_ID) handleContextScan(info).catch(() => {});
  });
}
ext.runtime.onInstalled.addListener(registerScanMenu);
registerScanMenu();
