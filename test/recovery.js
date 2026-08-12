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

  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
