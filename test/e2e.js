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

  await cleanup();
  fileServer.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} phases passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
