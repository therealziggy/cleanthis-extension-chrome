#!/usr/bin/env node
// Checks the promises the extension makes when interception goes wrong. These
// need a real extension context (storage, downloads, notifications), so they
// live here rather than in the unit tests.
//
// Run: node build.js --dev && node test/recovery.js
// No cleanthis server needed — the API is stubbed inside the worker.

"use strict";

const path = require("path");
const { launchWithExtension } = require("./harness/launch");

const EXT_DIR = path.join(__dirname, "..", "dist", "chrome-dev");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

(async () => {
  const { context, cleanup } = await launchWithExtension(EXT_DIR);
  const sw = context.serviceWorkers()[0];
  sw.on("pageerror", (err) => console.log("[sw error]", String(err)));

  // 1. The service refusing the job must still leave the user a way to the file.
  const offered = await sw.evaluate(async () => {
    await chrome.storage.local.set({ interceptEnabled: true, level: "standard", interceptExts: ["pdf"] });
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ pendingActions: {}, inflightDownloads: [] });
    const real = self.CleanThisApi.sanitizeUrl;
    self.CleanThisApi.sanitizeUrl = async () => { throw new Error("service unavailable"); };
    await self.handleDownload({ id: 7001, url: "https://example.com/x.pdf", filename: "x.pdf" });
    self.CleanThisApi.sanitizeUrl = real;
    const { pendingActions = {} } = await store.get("pendingActions");
    return Object.values(pendingActions).filter((a) => a.kind === "download-original").map((a) => a.url);
  });
  record("a failed clean offers the original", offered.includes("https://example.com/x.pdf"), offered.join(","));

  // 2. A click that fails must not consume the offer — it is the only way back.
  const survived = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ pendingActions: { n1: { kind: "download-original", url: "https://example.com/x.pdf" } } });
    const realDownload = chrome.downloads.download;
    chrome.downloads.download = async () => { throw new Error("disk full"); };
    await self.runAction("n1");
    chrome.downloads.download = realDownload;
    const { pendingActions = {} } = await store.get("pendingActions");
    return !!pendingActions.n1;
  });
  record("a failed click keeps the offer alive", survived === true);

  // 3. A successful click consumes it (no duplicate downloads on a second click).
  const consumed = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ pendingActions: { n2: { kind: "download-original", url: "https://example.com/y.pdf" } } });
    const realDownload = chrome.downloads.download;
    let calls = 0;
    chrome.downloads.download = async () => { calls++; return 1; };
    await self.runAction("n2");
    await self.runAction("n2"); // second click: nothing left to do
    chrome.downloads.download = realDownload;
    const { pendingActions = {} } = await store.get("pendingActions");
    return { gone: !pendingActions.n2, calls };
  });
  record("a successful click is not repeatable", consumed.gone === true && consumed.calls === 1, `downloads started: ${consumed.calls}`);

  // 4. Work interrupted by a worker shutdown is recovered on the next start.
  const recovered = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({
      pendingActions: {},
      inflightDownloads: { "https://example.com/interrupted.pdf": { label: "interrupted.pdf", at: Date.now() } },
    });
    await self.recoverInterrupted();
    const { pendingActions = {}, inflightDownloads = {} } = await store.get(["pendingActions", "inflightDownloads"]);
    return {
      offered: Object.values(pendingActions).some((a) => a.url === "https://example.com/interrupted.pdf"),
      cleared: Object.keys(inflightDownloads).length === 0,
    };
  });
  record("an interrupted clean is recovered on restart", recovered.offered && recovered.cleared);

  // 4b. Re-delivered HISTORY must never be intercepted. Browsers replay old
  // download rows in several ways (startup restore, session restore,
  // auto-resume); every replay carries a terminal state or an old startTime.
  // Field report 2026-08-20: a browser start swept days-old rows into the
  // cleaning service — six failure offers on one boot.
  const staleSkipped = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await chrome.storage.local.set({ interceptEnabled: true, level: "standard", interceptExts: ["pdf"] });
    await store.set({ pendingActions: {} });
    const real = self.CleanThisApi.sanitizeUrl;
    let submissions = 0;
    self.CleanThisApi.sanitizeUrl = async () => {
      submissions++;
      throw new Error("must never be reached for stale rows");
    };
    // A restored interrupted row (terminal state, old start).
    await self.handleDownload({
      id: 7201,
      url: "https://example.com/old-a.pdf",
      filename: "old-a.pdf",
      state: "interrupted",
      startTime: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    });
    // A replay that LIES about state but carries its original old startTime.
    await self.handleDownload({
      id: 7202,
      url: "https://example.com/old-b.pdf",
      filename: "old-b.pdf",
      state: "in_progress",
      startTime: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    });
    const staleSubs = submissions;
    // POSITIVE CONTROL: a genuinely new download (fresh start, in_progress)
    // must still be intercepted — proves the guards discriminate rather than
    // switching interception off.
    await self.handleDownload({
      id: 7203,
      url: "https://example.com/new-c.pdf",
      filename: "new-c.pdf",
      state: "in_progress",
      startTime: new Date().toISOString(),
    });
    self.CleanThisApi.sanitizeUrl = real;
    const { pendingActions = {} } = await store.get("pendingActions");
    const staleOffers = Object.values(pendingActions).filter((a) => /old-[ab]/.test(a.url || "")).length;
    return { staleSubs, freshSubs: submissions - staleSubs, staleOffers };
  });
  record(
    "re-delivered old downloads are left alone",
    staleSkipped.staleSubs === 0 && staleSkipped.staleOffers === 0,
    `stale submissions: ${staleSkipped.staleSubs}, stale offers: ${staleSkipped.staleOffers}`
  );
  record(
    "a genuinely new download is still intercepted",
    staleSkipped.freshSubs === 1,
    `fresh submissions: ${staleSkipped.freshSubs}`
  );

  // 5. The waiver covers one download, not every future one.
  const oneShot = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ bypassUrls: ["https://example.com/z.pdf"] });
    await self.handleDownload({ id: 7002, url: "https://example.com/z.pdf", filename: "z.pdf" });
    const { bypassUrls = [] } = await store.get("bypassUrls");
    return bypassUrls;
  });
  record("a waiver is spent after the download it covers", !oneShot.includes("https://example.com/z.pdf"), JSON.stringify(oneShot));

  // 6. Concurrent failures must not overwrite each other's offer.
  const concurrent = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ pendingActions: {} });
    const real = self.CleanThisApi.sanitizeUrl;
    self.CleanThisApi.sanitizeUrl = async () => { throw new Error("nope"); };
    await Promise.all([
      self.handleDownload({ id: 7101, url: "https://example.com/a1.pdf", filename: "a1.pdf" }),
      self.handleDownload({ id: 7102, url: "https://example.com/a2.pdf", filename: "a2.pdf" }),
      self.handleDownload({ id: 7103, url: "https://example.com/a3.pdf", filename: "a3.pdf" }),
    ]);
    self.CleanThisApi.sanitizeUrl = real;
    const { pendingActions = {} } = await store.get("pendingActions");
    return Object.values(pendingActions).filter((a) => a.kind === "download-original").length;
  });
  record("three failures at once produce three offers", concurrent === 3, `offers: ${concurrent}`);

  // 7. A long clean must keep the worker awake.
  //
  // Chrome only resets its ~30s idle timer on extension API calls; fetch and
  // setTimeout don't count. Waiting for a job is otherwise pure fetch and
  // setTimeout, so without a deliberate touch per poll the worker is killed
  // mid-clean with the download already cancelled.
  //
  // Termination itself can't be provoked here (the debugger attachment that
  // lets this script run also keeps the worker alive), so what this checks is
  // the mechanism: that each poll really does call an extension API. Removing
  // the onTick keepalive in background.js drops this count to zero.
  const keptAwake = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await chrome.storage.local.set({ interceptEnabled: true, level: "standard", interceptExts: ["pdf"] });

    const realFetch = self.fetch;
    const realDownload = chrome.downloads.download;
    const realGet = store.get.bind(store);

    let polls = 0;
    let polling = false;
    let touchesWhilePolling = 0;

    // Count only the keepalive's own read, so incidental storage traffic
    // can't make this look like it is working when it isn't.
    store.get = (...args) => {
      if (polling && args[0] === "keepAlivePing") touchesWhilePolling++;
      return realGet(...args);
    };
    chrome.downloads.download = async () => 1;

    // Stub the network, not the client, so the real polling loop runs and the
    // keepalive is exercised exactly as it would be in production.
    const reply = (body) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    });
    self.fetch = async (url) => {
      if (url.includes("/api/form-token")) return reply({ token: "t", ttl: 300 });
      if (url.includes("/api/sanitize-url")) return reply({ jobId: "keepalive-job", downloadToken: "d" });
      if (url.includes("/api/job/")) {
        polling = true;
        polls++;
        return reply(
          polls < 4
            ? { state: "processing" }
            : { state: "completed", downloadUrl: "https://cleanthis.io/api/download/x", downloadName: "x.pdf" }
        );
      }
      return reply({});
    };

    await self.handleDownload({ id: 7300, url: "https://example.com/slow.pdf", filename: "slow.pdf" });

    store.get = realGet;
    self.fetch = realFetch;
    chrome.downloads.download = realDownload;
    return { polls, touchesWhilePolling };
  });
  record(
    "a long clean keeps the worker awake",
    // The poll count is asserted too: a run that never polled would otherwise
    // "pass" while testing nothing.
    keptAwake.polls >= 3 && keptAwake.touchesWhilePolling >= keptAwake.polls - 1,
    `${keptAwake.touchesWhilePolling} extension-API touches over ${keptAwake.polls} polls`
  );

  // 8. Notifications are a nudge, not the only route.
  //
  // Neither browser will hold a notification open until the user acts, so a
  // pending offer has to outlive the toast: it stays on the badge and in the
  // popup's list until it is dealt with.
  const outlivesToast = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({ pendingActions: {} });

    const real = self.CleanThisApi.sanitizeUrl;
    self.CleanThisApi.sanitizeUrl = async () => { throw new Error("service down"); };
    await self.handleDownload({ id: 7400, url: "https://example.com/toast.pdf", filename: "toast.pdf" });
    self.CleanThisApi.sanitizeUrl = real;

    const { pendingActions = {} } = await store.get("pendingActions");
    const [id] = Object.keys(pendingActions);
    const badgeAfterOffer = await chrome.action.getBadgeText({});

    // The user closes the toast without acting on it.
    if (id) await new Promise((r) => chrome.notifications.clear(id, () => r()));
    const { pendingActions: afterDismiss = {} } = await store.get("pendingActions");

    // …and later opens the popup and uses the row.
    const realDownload = chrome.downloads.download;
    let started = null;
    chrome.downloads.download = async (opts) => { started = opts.url; return 1; };
    if (id) await self.runAction(id);
    chrome.downloads.download = realDownload;

    const { pendingActions: afterUse = {} } = await store.get("pendingActions");
    const badgeAfterUse = await chrome.action.getBadgeText({});

    return {
      offerHasName: !!(id && pendingActions[id].name),
      badgeAfterOffer,
      survivedDismissal: !!(id && afterDismiss[id]),
      started,
      clearedAfterUse: !(id && afterUse[id]),
      badgeAfterUse,
    };
  });
  record(
    "an offer survives a dismissed notification",
    outlivesToast.survivedDismissal === true && outlivesToast.offerHasName === true
  );
  record(
    // This offer is a failed clean (download-original), so the badge escalates
    // to the red "!" tier rather than showing a count.
    "the badge flags what is waiting, and clears when it is dealt with",
    outlivesToast.badgeAfterOffer === "!" && outlivesToast.badgeAfterUse === "",
    `badge "${outlivesToast.badgeAfterOffer}" → "${outlivesToast.badgeAfterUse}"`
  );
  record(
    "the popup's row does the same thing the notification would",
    outlivesToast.started === "https://example.com/toast.pdf" && outlivesToast.clearedAfterUse === true
  );

  // The flagged-toggle grant can outlive the popup: the browser's permission
  // prompt steals focus, the popup dies, and the change handler's continuation
  // (which would write flaggedEnabled) never runs even though the user clicked
  // Allow. The popup records intent BEFORE requesting; the background completes
  // it on permissions.onAdded. (The dev build holds "tabs" from install, so
  // permissions.contains is true here — exactly the post-grant world.)
  const intent = await sw.evaluate(async () => {
    const out = {};
    await chrome.storage.local.remove(["flaggedEnabled", "flaggedPendingAt"]);
    // 1. No intent recorded → a grant alone must not enable the feature.
    await self.completeFlaggedIntent();
    out.noIntent = (await chrome.storage.local.get("flaggedEnabled")).flaggedEnabled === undefined;
    // 2. Fresh intent + grant → the background finishes the job.
    await chrome.storage.local.set({ flaggedPendingAt: Date.now() });
    await self.completeFlaggedIntent();
    const after = await chrome.storage.local.get(["flaggedEnabled", "flaggedPendingAt"]);
    out.enabled = after.flaggedEnabled === true;
    out.cleared = after.flaggedPendingAt === undefined;
    // 3. A stale intent (user walked away mid-prompt days ago) only gets swept.
    await chrome.storage.local.remove("flaggedEnabled");
    await chrome.storage.local.set({ flaggedPendingAt: Date.now() - 10 * 60 * 1000 });
    await self.completeFlaggedIntent();
    const stale = await chrome.storage.local.get(["flaggedEnabled", "flaggedPendingAt"]);
    out.staleIgnored = stale.flaggedEnabled === undefined && stale.flaggedPendingAt === undefined;
    await chrome.storage.local.remove(["flaggedEnabled", "flaggedPendingAt"]);
    return out;
  });
  record("flagged grant: no recorded intent → not enabled", intent.noIntent === true);
  record("flagged grant: fresh intent completes after the popup died", intent.enabled === true && intent.cleared === true);
  record("flagged grant: a stale intent is swept, not activated", intent.staleIgnored === true);

  // The document-ask bypass is a SEPARATE namespace from the flagged wall's:
  // a document "Open anyway" must never let the user through a flagged wall,
  // and vice-versa. Prove both directions + the one-shot consume.
  const docBypass = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    await store.remove(["docBypass", "flaggedBypass"]);
    const out = {};
    // 1. A doc grant is consumed once, and only for its host.
    await self.grantDocBypass("evil.example");
    out.wrongHost = (await self.takeDocBypass("other.example")) === false;
    out.firstTake = (await self.takeDocBypass("evil.example")) === true;
    out.secondTake = (await self.takeDocBypass("evil.example")) === false;
    // 2. A doc grant does NOT satisfy the flagged consume (isolation).
    await store.remove(["docBypass", "flaggedBypass"]);
    await self.grantDocBypass("evil.example");
    out.flaggedUnaffected = (await self.CleanThisFlagged.takeBypass(chrome, "evil.example")) === false;
    // 3. …and a flagged grant does NOT satisfy the doc consume.
    await store.remove(["docBypass", "flaggedBypass"]);
    await self.CleanThisFlagged.grantBypass(chrome, "evil.example");
    out.docUnaffected = (await self.takeDocBypass("evil.example")) === false;
    await store.remove(["docBypass", "flaggedBypass"]);
    return out;
  });
  record("doc bypass: wrong host isn't honoured", docBypass.wrongHost === true);
  record("doc bypass: consumed exactly once", docBypass.firstTake === true && docBypass.secondTake === true);
  record("doc bypass never satisfies a flagged wall", docBypass.flaggedUnaffected === true);
  record("a flagged bypass never satisfies the doc ask", docBypass.docUnaffected === true);

  // Badge tiers: amber count for waiting decisions; a failed clean outranks
  // the count with a red "!" — never both at once.
  const badgeTiers = await sw.evaluate(async () => {
    const store = chrome.storage.session || chrome.storage.local;
    const read = async () => ({
      text: await chrome.action.getBadgeText({}),
      color: Array.from(await chrome.action.getBadgeBackgroundColor({})),
    });
    const out = {};
    await store.set({ pendingActions: {} });
    await self.refreshBadge();
    out.empty = await read();
    await store.set({ pendingActions: {
      a: { kind: "download-cleaned", url: "u1" },
      b: { kind: "download-cleaned", url: "u2" },
    } });
    await self.refreshBadge();
    out.pending = await read();
    await store.set({ pendingActions: {
      a: { kind: "download-cleaned", url: "u1" },
      b: { kind: "download-original", url: "u2" },
    } });
    await self.refreshBadge();
    out.failed = await read();
    return out;
  });
  record("badge: an empty list clears it", badgeTiers.empty.text === "");
  record(
    "badge: pending-only shows an amber count",
    badgeTiers.pending.text === "2" && badgeTiers.pending.color[0] === 217,
    JSON.stringify(badgeTiers.pending)
  );
  record(
    "badge: a failed clean shows a red !",
    badgeTiers.failed.text === "!" && badgeTiers.failed.color[0] === 220,
    JSON.stringify(badgeTiers.failed)
  );

  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
