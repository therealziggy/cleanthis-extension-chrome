#!/usr/bin/env node
// Renders every extension surface (popup, clean page, options — plus the
// warning page when present) in a real browser, light and dark, and writes
// PNGs so the UI can be eyeballed without clicking through by hand.
//
// Run: node build.js --dev && node test/harness/screenshot-ui.js [outDir]
// With LIVE_SCAN=1 the popup actually scans a page against the configured
// server; otherwise the scan result is faked so no quota is spent.

"use strict";

const fs = require("fs");
const path = require("path");
const { launchWithExtension } = require("./launch");

const EXT_DIR = path.join(__dirname, "..", "..", "dist", "chrome-dev");
const OUT = process.argv[2] || "/tmp";
const BASE = process.env.API_BASE || "http://localhost:3000";

(async () => {
  const { context, serviceWorker, cleanup } = await launchWithExtension(EXT_DIR);
  const extensionId = new URL(serviceWorker.url()).host;
  const written = [];

  // Seed settings + quota + one pending action so the pages render their
  // populated state, including the "Needs your attention" card.
  await serviceWorker.evaluate(async (base) => {
    self.CleanThisApi.baseUrl = base;
    await chrome.storage.local.set({
      level: "standard",
      interceptEnabled: true,
      quota_scan: { limit: 25, remaining: 22, resetEpoch: Math.floor(Date.now() / 1000) + 3600 },
      quota_upload: { limit: 50, remaining: 47, resetEpoch: Math.floor(Date.now() / 1000) + 3600 },
    });
    const store = chrome.storage.session || chrome.storage.local;
    await store.set({
      pendingActions: {
        "shot-1": {
          name: "quarterly-report.pdf",
          why: "The clean finished after the download was cancelled.",
          label: "Save cleaned file",
        },
      },
    });
  }, BASE);

  async function shoot(page, name, scheme, { fullPage = false } = {}) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const file = path.join(OUT, `${name}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage });
    written.push(file);
  }

  // ── popup (scan result + pending card) ────────────────────
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await popup.evaluate((base) => { self.CleanThisApi.baseUrl = base; }, BASE);

  if (process.env.LIVE_SCAN !== "1") {
    await popup.evaluate(() => {
      const ext = typeof browser !== "undefined" ? browser : chrome;
      ext.tabs.query = async () => [{ url: "https://example.com" }];
      self.CleanThisApi.scanUrl = async () => ({
        ok: true,
        verdict: "clean",
        scores: {
          security: { value: 100, band: "green", coverage: "full", driver: null },
          privacy: { value: 68, band: "amber", coverage: "full", driver: "11 third-party trackers" },
          legitimacy: { value: 95, band: "green", coverage: "full", driver: null },
        },
      });
    });
  } else {
    await popup.evaluate(() => {
      const ext = typeof browser !== "undefined" ? browser : chrome;
      ext.tabs.query = async () => [{ url: "https://example.com" }];
    });
  }

  await popup.click("#scan-page");
  await popup.waitForSelector(".verdict", { timeout: 60000 });
  await popup.setViewportSize({ width: 340, height: 560 });
  await shoot(popup, "popup-scan", "light");
  await shoot(popup, "popup-scan", "dark");

  // ── clean page (idle drop zone) ───────────────────────────
  const clean = await context.newPage();
  await clean.goto(`chrome-extension://${extensionId}/clean/clean.html`, { waitUntil: "load" });
  await clean.setViewportSize({ width: 700, height: 620 });
  await shoot(clean, "clean", "light");
  await shoot(clean, "clean", "dark");

  // ── options ───────────────────────────────────────────────
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "load" });
  await options.waitForTimeout(400);
  await options.setViewportSize({ width: 700, height: 1000 });
  await shoot(options, "options", "light", { fullPage: true });
  await shoot(options, "options", "dark", { fullPage: true });

  // ── warning page (only once it exists, v0.5) ──────────────
  if (fs.existsSync(path.join(EXT_DIR, "warning", "warning.html"))) {
    const warning = await context.newPage();
    const params = "?to=https%3A%2F%2Fevil-fixture.example%2Foffer&cat=phishing&seen=2026-07";
    await warning.goto(`chrome-extension://${extensionId}/warning/warning.html${params}`, { waitUntil: "load" });
    await warning.setViewportSize({ width: 900, height: 640 });
    await shoot(warning, "warning", "light");
    await shoot(warning, "warning", "dark");
  }

  await cleanup();
  console.log(written.map((f) => `wrote ${f}`).join("\n"));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
