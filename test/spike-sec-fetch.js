#!/usr/bin/env node
// Spike: verify that fetches from the extension's background service worker
// pass the server's Sec-Fetch-Site CSRF checks.
//
// Chrome documents that requests from extension contexts holding host
// permissions for the target are privileged — the open question this spike
// settles empirically is which Sec-Fetch-Site value they carry ("none" passes
// the server check, "cross-site" would 403 on the upload routes).
//
// Run: node build.js --dev, start a local cleanthis instance on :3000, then
//      node test/spike-sec-fetch.js
//
// The echo server double-checks itself with a positive control: the same
// fetch from a normal web page MUST read "cross-site", proving the probe
// actually observes the header.

"use strict";

const http = require("http");
const path = require("path");
const { launchWithExtension } = require("./harness/launch");

const EXT_DIR = path.join(__dirname, "..", "dist", "chrome-dev");
const LOCAL = "http://localhost:3000";

const echo = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify({
      secFetchSite: req.headers["sec-fetch-site"] || null,
      secFetchMode: req.headers["sec-fetch-mode"] || null,
      origin: req.headers.origin || null,
    })
  );
});

// The control page gets its own origin (localhost:8081 → 127.0.0.1:8080 is
// cross-site) and no CSP, so nothing but the browser decides the header value.
const controlSite = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>control</title><body>control</body>");
});

(async () => {
  await new Promise((resolve) => echo.listen(8080, "127.0.0.1", resolve));
  await new Promise((resolve) => controlSite.listen(8081, "127.0.0.1", resolve));

  const { context, cleanup, browserPath } = await launchWithExtension(EXT_DIR);
  console.log(`browser: ${browserPath}`);

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

  // (a) privileged fetch from the extension service worker
  const swEcho = await sw.evaluate(async () => {
    const r = await fetch("http://127.0.0.1:8080/echo");
    return r.json();
  });

  // (b) POSITIVE CONTROL: same fetch from a normal page must read cross-site
  const page = await context.newPage();
  await page.goto("http://localhost:8081/", { waitUntil: "domcontentloaded" });
  const pageEcho = await page.evaluate(async () => {
    const r = await fetch("http://127.0.0.1:8080/echo");
    return r.json();
  });

  // (c) the real endpoints, from the service worker, against the local server
  const apiResults = await sw.evaluate(async (base) => {
    const out = {};
    const t1 = await fetch(`${base}/api/form-token?purpose=scan-webpage`);
    out.formToken = t1.status;
    const tok1 = (await t1.json()).token;

    const scan = await fetch(`${base}/api/scan-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Form-Token": tok1, "X-Form-Hp": "" },
      body: JSON.stringify({ url: "https://example.com", tier: "light" }),
    });
    out.scanUrl = scan.status;
    const scanBody = await scan.json().catch(() => null);
    out.scanVerdict = scanBody && scanBody.verdict;

    const t2 = await fetch(`${base}/api/form-token?purpose=upload`);
    const tok2 = (await t2.json()).token;
    const form = new FormData();
    form.append("file", new Blob(["spike test\n"], { type: "text/plain" }), "spike.txt");
    form.append("level", "standard");
    const san = await fetch(`${base}/api/sanitize`, {
      method: "POST",
      headers: { "X-Form-Token": tok2, "X-Form-Hp": "" },
      body: form,
    });
    out.sanitize = san.status;
    const sanBody = await san.json().catch(() => null);
    out.sanitizeKeys = sanBody ? Object.keys(sanBody) : null;
    return out;
  }, LOCAL);

  console.log("SW → echo:", swEcho);
  console.log("page → echo (control, expect cross-site):", pageEcho);
  console.log("SW → local API:", apiResults);
  console.log(`\nVERDICT — Sec-Fetch-Site from privileged extension SW: ${JSON.stringify(swEcho.secFetchSite)}`);

  const controlOk = pageEcho.secFetchSite === "cross-site";
  if (!controlOk) console.error("⚠️ CONTROL FAILED — the probe can't be trusted; investigate before drawing conclusions.");

  await cleanup();
  echo.close();
  controlSite.close();
  process.exit(controlOk ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
