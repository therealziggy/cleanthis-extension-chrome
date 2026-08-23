#!/usr/bin/env node
// End-to-end check of the built extension against a locally running
// cleanthis.io instance. Exercises the three v1 flows for real: a webpage
// scan, a file clean, and an intercepted download (plus the bypass path that
// gets the user their original file).
//
// Not part of CI — it needs a local server and a browser that can load an
// unpacked extension.
//
//   1. in the cleanthis.io checkout:  npm start
//   2. here:  node build.js --dev && node test/e2e.js
//
// API_BASE overrides the server (default http://localhost:3000).

"use strict";

const http = require("http");
const path = require("path");
const { launchWithExtension } = require("./harness/launch");

const EXT_DIR = path.join(__dirname, "..", "dist", "chrome-dev");
const BASE = process.env.API_BASE || "http://localhost:3000";
const FILE_PORT = 8080;

// Smallest thing that is genuinely a PDF, so the server runs its real PDF path.
const SAMPLE_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n"
);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function serverIsUp() {
  try {
    const res = await fetch(`${BASE}/api/form-token?purpose=scan-webpage`);
    return res.ok;
  } catch (_) {
    return false;
  }
}

// The dev build already targets the local server (build.js --dev bakes it in),
// so nothing needs pinning at runtime.
//
// The service worker sleeps when idle and is restarted on demand, so a long
// wait must never live inside one evaluate() call. These helpers re-acquire
// the worker each time and keep every call short.
async function worker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: 15000 });
}

async function pollWorker(context, fn, { timeoutMs, intervalMs = 1000, arg } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const sw = await worker(context);
    last = await sw.evaluate(fn, arg);
    if (last && last.done) return last;
    if (Date.now() > deadline) return { ...last, timeout: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

(async () => {
  if (!(await serverIsUp())) {
    console.error(`No cleanthis server answering at ${BASE} — run "npm start" in the cleanthis.io checkout first.`);
    process.exit(2);
  }

  const fileServer = http.createServer((req, res) => {
    if (req.url.startsWith("/sample.pdf")) {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="sample.pdf"',
        "Content-Length": SAMPLE_PDF.length,
      });
      res.end(SAMPLE_PDF);
      return;
    }
    // The doorway case: a flagged host that server-redirects instantly, so
    // its own URL never commits in the tab (the shape of real spamvertised
    // burner domains). Anything on the redirector host bounces to the plain
    // page on the ordinary host.
    if ((req.headers.host || "").startsWith("e2e-redirector.example")) {
      // Bounce to a host that is NOT flagged and is skipped by the checker
      // (loopback), so a warning can only come from catching the redirector
      // itself before the redirect — the thing under test.
      res.writeHead(301, { Location: `http://127.0.0.1:${FILE_PORT}/landed` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<!doctype html><title>downloads</title><a id="dl" href="/sample.pdf">get</a>');
  });
  await new Promise((resolve) => fileServer.listen(FILE_PORT, "127.0.0.1", resolve));

  const { context, cleanup } = await launchWithExtension(EXT_DIR);
  let sw = await worker(context);

  // ── 1. webpage scan ─────────────────────────────────────────
  try {
    const scan = await sw.evaluate(async () => {
      const r = await self.CleanThisApi.scanUrl("https://example.com", "light");
      return { ok: r.ok, verdict: r.verdict, hasScores: !!r.scores };
    });
    record("scan a webpage", scan.ok === true && typeof scan.verdict === "string" && scan.hasScores, `verdict=${scan.verdict}`);
  } catch (err) {
    record("scan a webpage", false, err.message);
  }

  // ── 1b. popup UI: back from verdict, deep handoff, brand link, theme seg ──
  // The popup page is driven directly (screenshot-harness pattern): verdicts
  // rendered through the __ctPopup hook, clicks and their effects for real.
  sw = await worker(context);
  try {
    const extensionId = new URL(sw.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });

    // A verdict on screen offers ‹ Back — and it returns to the idle view.
    await popup.evaluate(() => {
      self.__ctPopup.renderVerdict("https://example.com/", 1, {
        verdict: "clean",
        findings: [],
        scores: {
          security: { value: 96, band: "green", coverage: "full", driver: "No threats found" },
          privacy: { value: 88, band: "green", coverage: "full", driver: "No tracking concerns" },
          legitimacy: { value: 91, band: "green", coverage: "full", driver: "Nothing suspicious" },
        },
      });
      self.__ctPopup.showView("verdict");
    });
    await popup.click("#view-verdict .backlink", { timeout: 5000 });
    const backHome = await popup.evaluate(
      () => !document.getElementById("view-idle").hidden && document.getElementById("view-verdict").hidden
    );
    record("verdict ‹ Back returns home", backHome === true);

    // The header brand opens the website (the dev build bakes in this BASE).
    const [sitePage] = await Promise.all([
      context.waitForEvent("page"),
      popup.click("#brand", { timeout: 5000 }),
    ]);
    await urlSettles(sitePage, new RegExp(`^${BASE.replace(/[.]/g, "\\.")}/`));
    record("brand opens cleanthis.io", true, sitePage.url());
    await sitePage.close();

    // Theme seg: Dark pins, System releases — attribute, storage, seg agree.
    await popup.evaluate(() => self.__ctPopup.showView("settings"));
    await popup.click('#theme-seg button[data-theme-choice="dark"]', { timeout: 5000 });
    const darkState = await popup.evaluate(() => ({
      attr: document.documentElement.dataset.theme || null,
      stored: localStorage.getItem("ct-theme"),
      pressed: document.querySelector('#theme-seg button[aria-pressed="true"]').dataset.themeChoice,
    }));
    record(
      "theme seg pins dark",
      darkState.attr === "dark" && darkState.stored === "dark" && darkState.pressed === "dark",
      JSON.stringify(darkState)
    );
    await popup.click('#theme-seg button[data-theme-choice="system"]');
    const sysState = await popup.evaluate(() => ({
      attr: document.documentElement.dataset.theme || null,
      stored: localStorage.getItem("ct-theme"),
      pressed: document.querySelector('#theme-seg button[aria-pressed="true"]').dataset.themeChoice,
    }));
    record(
      "theme seg back to system",
      sysState.attr === null && sysState.stored === null && sysState.pressed === "system",
      JSON.stringify(sysState)
    );

    // Verdict deep link hands off to the site scanner with Deep pre-selected
    // (the verdict rendered for the ‹ Back check is still in the DOM).
    await popup.evaluate(() => self.__ctPopup.showView("verdict"));
    const deepRe = new RegExp(
      `^${BASE.replace(/[.]/g, "\\.")}/webpage-scanner\\.html\\?url=https%3A%2F%2Fexample\\.com%2F&tier=aggressive$`
    );
    const [deepPage] = await Promise.all([
      context.waitForEvent("page"),
      popup.click("#view-verdict .linklike", { timeout: 5000 }),
    ]);
    await urlSettles(deepPage, deepRe);
    record("deep handoff URL", true, deepPage.url());
    await deepPage.close();

    // The idle deep line hides when the active tab isn't scannable (here the
    // active tab is the popup page itself). A missing element throws, so this
    // can't pass vacuously; the clickable branch is covered just above.
    const idleDeepHidden = await popup.evaluate(() => document.getElementById("deep-line").hidden);
    record("idle deep link hidden off-page", idleDeepHidden === true);

    await popup.close();
  } catch (err) {
    record("popup UI", false, err.message);
  }

  // ── 2. clean a file ─────────────────────────────────────────
  sw = await worker(context);
  try {
    const clean = await sw.evaluate(async () => {
      const file = new File(["hello from the e2e run\n"], "e2e.txt", { type: "text/plain" });
      const job = await self.CleanThisApi.sanitizeFile(file, "standard");
      const done = await self.CleanThisApi.waitForJob(job.jobId, job.downloadToken, { intervalMs: 500 });
      return { state: done.state, hasUrl: !!done.downloadUrl, name: done.downloadName, error: done.error };
    });
    record("clean a file", clean.state === "completed" && clean.hasUrl, `state=${clean.state}${clean.error ? ` error=${clean.error}` : ""}`);
  } catch (err) {
    record("clean a file", false, err.message);
  }

  // ── 2b. clean via the page (the path the popup bug killed) ──
  // The v1 popup died when the file dialog took focus; the flow now lives in
  // a real tab. Playwright can't open a native dialog, but setInputFiles
  // exercises everything after it: the page-context upload, the job watch,
  // and the save-fresh-URL dance.
  try {
    sw = await worker(context);
    const extensionId = new URL(sw.url()).host;
    const cleanPage = await context.newPage();
    await cleanPage.goto(`chrome-extension://${extensionId}/clean/clean.html`, { waitUntil: "load" });
    await cleanPage.setInputFiles("#file-input", {
      name: "e2e-page.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from the clean page e2e\n"),
    });
    await cleanPage.waitForSelector("#clean-result button", { timeout: 120000 });
    const readyText = await cleanPage.textContent("#clean-result");

    // The completed response carries the sanitization report; the page must
    // show it (v0.5.3) — title plus at least one concrete change bullet.
    const reportItems = await cleanPage.locator("#clean-result .report-list li").count();
    record(
      "the result shows what was done",
      /What was done/.test(readyText || "") && reportItems > 0,
      `${reportItems} change entr${reportItems === 1 ? "y" : "ies"}`
    );

    await cleanPage.click("#clean-result button");

    // The page must own up to the outcome: "Saved." — not a port error.
    await cleanPage.waitForFunction(
      () => /Saved\./.test(document.querySelector("#clean-result .driver")?.textContent || ""),
      { timeout: 30000 }
    );

    // Playwright redirects downloads to artifact paths with opaque names, so
    // match on the signed download URL, not the filename. This is the first
    // /api/download of the run (the interception phases come later).
    const saved = await pollWorker(
      context,
      async (apiBase) => {
        const items = await chrome.downloads.search({});
        const done = items.find((d) => d.url.startsWith(`${apiBase}/api/download`) && d.state === "complete");
        return { done: !!done, url: done ? done.url.slice(0, 60) : null };
      },
      { timeoutMs: 60000, arg: BASE }
    );
    record("clean via the page and save", !saved.timeout && /Scrubbed\. All yours\./.test(readyText || ""), saved.url || readyText);
    await cleanPage.close();
  } catch (err) {
    record("clean via the page and save", false, err.message);
  }

  // ── 2c. worker death mid-clean: the page re-hands the job ──
  // The worker's copy of the handoff dies with it; from the page, a worker
  // death looks like its port dropping. The page must reconnect (which wakes
  // a fresh worker) and re-hand the job, and its handoff record must be on
  // disk while the job is unsettled. runtime.connect is stubbed so the
  // "worker death" can be staged deterministically.
  try {
    sw = await worker(context);
    const extensionId = new URL(sw.url()).host;
    const page2c = await context.newPage();
    await page2c.goto(`chrome-extension://${extensionId}/clean/clean.html`, { waitUntil: "load" });
    await page2c.evaluate(() => {
      const pageExt = typeof browser !== "undefined" ? browser : chrome;
      self.__fakePorts = [];
      pageExt.runtime.connect = () => {
        const listeners = [];
        const port = {
          messages: [],
          postMessage(msg) {
            port.messages.push(msg);
          },
          disconnect() {
            port.closed = true;
          },
          onDisconnect: { addListener: (fn) => listeners.push(fn) },
          die() {
            listeners.forEach((fn) => fn());
          },
        };
        self.__fakePorts.push(port);
        return port;
      };
      // A job that never finishes, so the page sits in the cleaning state.
      self.CleanThisApi.sanitizeFile = async () => ({ jobId: "reconnect-job", downloadToken: "dt" });
      self.CleanThisApi.waitForJob = () => new Promise(() => {});
    });
    await page2c.setInputFiles("#file-input", {
      name: "reconnect.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("port drop fixture\n"),
    });
    await page2c.waitForFunction(
      () => self.__fakePorts.length === 1 && self.__fakePorts[0].messages.some((m) => m && m.jobId),
      null,
      { timeout: 15000 }
    );

    const record2c = await page2c.evaluate(async () => {
      const pageExt = typeof browser !== "undefined" ? browser : chrome;
      const store = pageExt.storage.session || pageExt.storage.local;
      const { "pageJob:reconnect-job": row = null } = await store.get("pageJob:reconnect-job");
      return row;
    });
    record(
      "the handoff record is written for an in-flight page job",
      !!record2c && record2c.downloadToken === "dt",
      JSON.stringify(record2c)
    );

    // Stage the worker death: the page's port drops.
    await page2c.evaluate(() => self.__fakePorts[0].die());
    const reconnected = await page2c
      .waitForFunction(
        () => self.__fakePorts.length === 2 && self.__fakePorts[1].messages.some((m) => m && m.jobId === "reconnect-job"),
        null,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
    record(
      "a dropped port is reconnected and the job re-handed",
      reconnected === true,
      `ports: ${await page2c.evaluate(() => self.__fakePorts.length)}`
    );

    await page2c.close();
    sw = await worker(context);
    await sw.evaluate(async () => {
      const store = chrome.storage.session || chrome.storage.local;
      await store.remove("pageJob:reconnect-job");
    });
  } catch (err) {
    record("page job reconnect", false, err.message);
  }

  // ── 3. intercepted download ─────────────────────────────────
  sw = await worker(context);
  await sw.evaluate(() => chrome.storage.local.set({ interceptEnabled: true, level: "standard" }));

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${FILE_PORT}/`, { waitUntil: "domcontentloaded" });
  await page.click("#dl").catch(() => {});

  try {
    const outcome = await pollWorker(
      context,
      async (apiBase) => {
        const items = await chrome.downloads.search({});
        const cleaned = items.find((d) => d.url.startsWith(`${apiBase}/api/download`));
        const original = items.find((d) => d.url.includes("127.0.0.1:8080/sample.pdf"));
        return {
          done: !!(cleaned && cleaned.state === "complete"),
          cleanedName: cleaned ? cleaned.filename.split(/[\\/]/).pop() : null,
          originalState: original ? original.state : "erased",
          seen: items.map((d) => `${d.state}:${d.url.slice(0, 60)}`),
        };
      },
      { timeoutMs: 150000, arg: BASE }
    );

    // A file served from this machine sits on a private address the service
    // could never fetch, so it must be left strictly alone — interrupting it
    // would break the download for no possible benefit.
    const local = await pollWorker(
      context,
      async () => {
        const items = await chrome.downloads.search({});
        const original = items.find((d) => d.url.includes("127.0.0.1:8080/sample.pdf"));
        return {
          done: !!(original && original.state === "complete"),
          state: original ? original.state : "missing",
        };
      },
      { timeoutMs: 45000 }
    );
    record("a download from this machine is left alone", !local.timeout, `original=${local.state}`);
  } catch (err) {
    record("a download from this machine is left alone", false, err.message);
  }

  // ── 3a. a download that can't be cleaned still reaches the user ──
  try {
    sw = await worker(context);
    await sw.evaluate(async () => {
      const store = chrome.storage.session || chrome.storage.local;
      await store.set({ pendingActions: {} });
      await chrome.storage.local.set({ interceptExts: ["pdf"] });
      // A public address that 404s: the submission is accepted, the fetch
      // fails — the most common real-world failure.
      self.handleDownload({
        id: 9101,
        url: "https://cleanthis.io/no-such-file-e2e.pdf",
        filename: "no-such-file-e2e.pdf",
      });
    });

    const offered = await pollWorker(
      context,
      async () => {
        const store = chrome.storage.session || chrome.storage.local;
        const { pendingActions = {} } = await store.get("pendingActions");
        return {
          done: Object.values(pendingActions).some(
            (a) => a.kind === "download-original" && a.url.includes("no-such-file-e2e")
          ),
        };
      },
      { timeoutMs: 90000 }
    );
    record("a download that can't be cleaned is offered back", !offered.timeout);
  } catch (err) {
    record("a download that can't be cleaned is offered back", false, err.message);
  }

  // ── 3b. the cleaned file actually comes back ────────────────
  // The server won't fetch anything hosted on this machine (its SSRF guard
  // blocks loopback and private addresses), so this phase feeds the handler a
  // publicly reachable URL directly. The browser-triggered half is covered by
  // 3a; what's under test here is the full round trip: submit → clean → the
  // cleaned file arriving as a download.
  const fetchable = process.env.E2E_FETCHABLE_URL || "https://cleanthis.io/images/awareness/hero.webp";
  try {
    const fileExt = fetchable.split(/[?#]/)[0].split(".").pop().toLowerCase();
    sw = await worker(context);
    await sw.evaluate(async ({ url, fileExt: e }) => {
      await chrome.storage.local.set({ interceptExts: [e] });
      // A synthetic download item: the same shape the browser hands us, with
      // an id that no longer exists so cancel/erase are harmless no-ops.
      self.handleDownload({ id: 999999, url, filename: url.split("/").pop() });
    }, { url: fetchable, fileExt });

    const cleaned = await pollWorker(
      context,
      async (apiBase) => {
        const items = await chrome.downloads.search({});
        const done = items.find((d) => d.url.startsWith(`${apiBase}/api/download`) && d.state === "complete");
        return {
          done: !!done,
          name: done ? done.filename.split(/[\\/]/).pop() : null,
          seen: items.map((d) => `${d.state}:${d.url.slice(0, 70)}`),
        };
      },
      { timeoutMs: 150000, arg: BASE }
    );

    record(
      "receive the cleaned file",
      !cleaned.timeout,
      cleaned.timeout ? `saw ${JSON.stringify(cleaned.seen)}` : cleaned.name
    );
  } catch (err) {
    record("receive the cleaned file", false, err.message);
  }

  // Put the extension list back for the remaining phases.
  sw = await worker(context);
  await sw.evaluate(() => chrome.storage.local.remove("interceptExts"));

  // ── 4. the user can still get the original ──────────────────
  // Drives the exact path the "Download original" notification button takes:
  // it must add a bypass so the download isn't intercepted straight back, and
  // the untouched file must actually arrive.
  try {
    sw = await worker(context);
    await sw.evaluate(async () => {
      const url = "http://127.0.0.1:8080/sample.pdf";
      const store = chrome.storage.session || chrome.storage.local;
      const { pendingActions = {} } = await store.get("pendingActions");
      pendingActions["e2e-note"] = { kind: "download-original", url };
      await store.set({ pendingActions });
      await self.runAction("e2e-note");
    });

    const bypass = await pollWorker(
      context,
      async () => {
        const items = await chrome.downloads.search({});
        const original = items.find((d) => d.url === "http://127.0.0.1:8080/sample.pdf" && d.state === "complete");
        return { done: !!original, name: original ? original.filename.split(/[\\/]/).pop() : null };
      },
      { timeoutMs: 30000, intervalMs: 500 }
    );
    record("download the original anyway", !bypass.timeout, bypass.name || "");
  } catch (err) {
    record("download the original anyway", false, err.message);
  }

  // The pre-navigation check aborts the original navigation when it warns, so
  // Playwright's waitForURL (which tracks that navigation) can reject with
  // ERR_ABORTED exactly when the feature works. Poll the URL instead.
  async function urlSettles(page, re, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (re.test(page.url())) return;
      if (Date.now() > deadline) throw new Error(`url never matched ${re}: ${page.url()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── 5. flagged-site warning: warn → proceed once → warn again ──
  // The harness maps e2e-flagged.example to 127.0.0.1 (a public-looking name;
  // local addresses are skipped by design), and seeds the stored list directly
  // — hash parity with the live endpoint is pinned by unit tests on both
  // sides, so the E2E's job is the tab flow itself. The dev build carries the
  // "tabs" permission at install because the runtime prompt can't be clicked
  // from a harness.
  try {
    sw = await worker(context);
    await sw.evaluate(async (port) => {
      const hash = await self.CleanThisFlagged.hashHost("e2e-flagged.example");
      const redirectorHash = await self.CleanThisFlagged.hashHost("e2e-redirector.example");
      const softHash = await self.CleanThisFlagged.hashHost("e2e-soft.example");
      // Port is dropped from the url key, so the fixture's :8080 still matches.
      const urlHash = await self.CleanThisFlagged.hashUrl(`http://e2e-soft.example:${port}/payload.exe`);
      await chrome.storage.local.set({
        flaggedEnabled: true,
        flaggedList: {
          version: 1,
          etag: null,
          fetchedAt: Date.now(),
          entries: [
            [hash, "phishing", "2026-07"],
            [redirectorHash, "spam", "2026-07"],
          ],
          soft: [[softHash, "compromised", "2026-08"]],
          urls: [[urlHash, "malware", "2026-08"]],
        },
      });
    }, FILE_PORT);

    const page5 = await context.newPage();
    await page5.goto(`http://e2e-flagged.example:${FILE_PORT}/`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page5, /warning\/warning\.html/);
    // The URL settles at commit, before the page's own script fills #host —
    // wait for the text, not just the element (it exists empty in the markup).
    await page5.waitForFunction(() => {
      const el = document.getElementById("host");
      return !!el && el.textContent.trim().length > 0;
    }, { timeout: 5000 });
    const shownHost = await page5.textContent("#host");
    record("a flagged page is interrupted by the warning", /e2e-flagged\.example/.test(shownHost || ""), shownHost);

    await page5.click("#proceed");
    await urlSettles(page5, new RegExp(`^http:\/\/e2e-flagged\\.example:${FILE_PORT}\/$`));
    const bodyText = await page5.textContent("body");
    record("proceed anyway loads the site once", /get/.test(bodyText || ""));

    // A same-URL reload doesn't change the tab's URL, so revisit a different
    // path on the flagged host — tabs.onUpdated only carries url on change.
    await page5.goto(`http://e2e-flagged.example:${FILE_PORT}/again`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page5, /warning\/warning\.html/);
    record("the bypass is one-shot: the next visit warns again", true);

    // Go back returns to where the user was. (Playwright tabs always open on
    // about:blank, which counts as history — so the history.back() branch is
    // what runs here; the no-history branch is exercised just below.)
    const page5b = await context.newPage();
    await page5b.goto(`http://e2e-flagged.example:${FILE_PORT}/`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page5b, /warning\/warning\.html/);
    await page5b.click("#back");
    await urlSettles(page5b, /^about:blank$/, 10000);
    record("go back returns to the previous page", true);

    // The no-history fallback asks the background to close the tab; drive the
    // message directly, the same call warning.js makes.
    const closed = new Promise((resolve) => page5b.once("close", () => resolve(true)));
    await page5b.goto(`http://e2e-flagged.example:${FILE_PORT}/close-me`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page5b, /warning\/warning\.html/);
    // Fire-and-forget: the tab closing kills the evaluate round-trip, so an
    // awaited call would throw "Target closed" precisely when it works.
    page5b.evaluate(() => (typeof browser !== "undefined" ? browser : chrome).runtime.sendMessage({ type: "closeMe" })).catch(() => {});
    record("closeMe closes the warning tab", await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 10000))]));

    // The doorway case (the 2026-08-19 field report): a flagged host that
    // 301s away instantly never commits in the tab, so the commit-time check
    // alone can never see it. The warning must fire from the pre-redirect URL.
    const page5c = await context.newPage();
    await page5c.goto(`http://e2e-redirector.example:${FILE_PORT}/`, { waitUntil: "commit" }).catch(() => {});
    let redirectorWarned = false;
    try {
      await urlSettles(page5c, /warning\/warning\.html/);
      redirectorWarned = /e2e-redirector\.example/.test((await page5c.textContent("#host")) || "");
    } catch (_) {
      /* recorded below */
    }
    record(
      "a flagged host that redirects instantly still warns",
      redirectorWarned,
      redirectorWarned ? "" : `no warning — landed on ${page5c.url()}`
    );
    await page5c.close().catch(() => {});

    // ── the hybrid (2026-08-20): soft host = heads-up, its hack link = wall ──
    const page5d = await context.newPage();
    await page5d.goto(`http://e2e-soft.example:${FILE_PORT}/menu`, { waitUntil: "load" }).catch(() => {});
    await page5d.waitForTimeout(1500);
    const softBody = await page5d.textContent("body").catch(() => "");
    const softMarker = await sw.evaluate(async () => {
      const store = chrome.storage.session || chrome.storage.local;
      const { softNotifiedHosts = [] } = await store.get("softNotifiedHosts");
      return softNotifiedHosts;
    });
    record(
      "a compromised-but-legit site loads with a heads-up, no wall",
      /get/.test(softBody || "") && !/warning\.html/.test(page5d.url()) && softMarker.includes("e2e-soft.example"),
      `notified: ${JSON.stringify(softMarker)}`
    );

    await page5d.goto(`http://e2e-soft.example:${FILE_PORT}/payload.exe`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page5d, /warning\/warning\.html/);
    record("the exact dangerous link on that same site still gets the wall", true);
    await page5d.close().catch(() => {});

    await page5.close().catch(() => {});
    sw = await worker(context);
    await sw.evaluate(() => chrome.storage.local.remove(["flaggedEnabled", "flaggedList"]));
  } catch (err) {
    record("flagged-site warning flow", false, err.message);
  }

  // ── 6. opt-in document ask (v0.6.3) ────────────────────────
  // The novel logic: with the toggle on, navigating to a document URL is
  // interposed by a neutral heads-up, "Open anyway" grants a ONE-SHOT doc
  // bypass, and "Clean it first" hands the URL to the clean window. The full
  // server-fetch clean is not E2E'd here — the fixture host resolves only
  // inside the browser and the server's SSRF guard blocks loopback; URL-mode
  // completion reuses the file path's runJob (phase 2b) and the inline route
  // is proven by the server's own tests.
  try {
    sw = await worker(context);
    await sw.evaluate(() => chrome.storage.local.set({ docAskEnabled: true }));

    const page6 = await context.newPage();
    await page6.goto(`http://e2e-doc.example:${FILE_PORT}/sample.pdf`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page6, /warning\/warning\.html/);
    const title6 = await page6.textContent("#title");
    const kind6 = await page6.textContent("#reason");
    record(
      "a document link is interrupted by the document heads-up",
      /document/i.test(title6 || "") && /deliver malware/i.test(kind6 || ""),
      title6
    );

    // "Clean it first" hands the URL off (stores the intent) and opens the
    // clean window, then closes its own tab via closeMe — so read the result
    // from the worker, not the (now-gone) page. A fresh clean window opens and
    // consumes the intent on load, so accept "stored" or "already consumed",
    // never absent-from-start; assert a clean-window page appeared.
    const before = context.pages().length;
    await page6.click("#clean-first").catch(() => {});
    let cleanWindowOpened = false;
    for (let i = 0; i < 25 && !cleanWindowOpened; i++) {
      cleanWindowOpened = context.pages().some((p) => /clean\/clean\.html/.test(p.url()));
      if (!cleanWindowOpened) await new Promise((r) => setTimeout(r, 200));
    }
    record("clean it first opens the clean window with the URL", cleanWindowOpened, `pages ${before}→${context.pages().length}`);
    for (const p of context.pages()) {
      if (/clean\/clean\.html/.test(p.url())) await p.close().catch(() => {});
    }

    // "Open anyway" is one-shot: after proceeding, the document loads; a
    // different document path warns again.
    const page6b = await context.newPage();
    await page6b.goto(`http://e2e-doc.example:${FILE_PORT}/other.pdf`, { waitUntil: "commit" }).catch(() => {});
    await urlSettles(page6b, /warning\/warning\.html/);
    await page6b.click("#proceed");
    await urlSettles(page6b, /other\.pdf/);
    const proceededBody = await page6b.textContent("body").catch(() => "");
    record("open anyway lets the document through", /%PDF|get/.test(proceededBody || "") || page6b.url().includes("other.pdf"));

    await page6b.close().catch(() => {});
    await page6.close().catch(() => {});
    sw = await worker(context);
    await sw.evaluate(() => chrome.storage.local.remove("docAskEnabled"));
  } catch (err) {
    record("document ask flow", false, err.message);
  }

  await cleanup();
  fileServer.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} phases passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
