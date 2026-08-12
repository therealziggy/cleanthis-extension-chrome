#!/usr/bin/env node
// Renders the popup and options pages in a real browser and writes PNGs, so
// the UI can be eyeballed without clicking through by hand.
//
// Run: node build.js --dev && node test/harness/screenshot-ui.js [outDir]
// With LIVE_SCAN=1 the popup actually scans a page against the configured
// server; otherwise the scan result is faked so no quota is spent.

"use strict";

const path = require("path");
const { launchWithExtension } = require("./launch");

const EXT_DIR = path.join(__dirname, "..", "..", "dist", "chrome-dev");
const OUT = process.argv[2] || "/tmp";
const BASE = process.env.API_BASE || "http://localhost:3000";

(async () => {
  const { context, serviceWorker, cleanup } = await launchWithExtension(EXT_DIR);
  const extensionId = new URL(serviceWorker.url()).host;

  // Seed some settings + quota so the pages render their populated state.
  await serviceWorker.evaluate(async (base) => {
    self.CleanThisApi.baseUrl = base;
    await chrome.storage.local.set({
      level: "standard",
      interceptEnabled: true,
      quota_scan: { limit: 25, remaining: 22, resetEpoch: Math.floor(Date.now() / 1000) + 3600 },
      quota_upload: { limit: 50, remaining: 47, resetEpoch: Math.floor(Date.now() / 1000) + 3600 },
    });
  }, BASE);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await popup.evaluate((base) => { self.CleanThisApi.baseUrl = base; }, BASE);

  if (process.env.LIVE_SCAN === "1") {
    await popup.evaluate(() => {
      // The popup reads the active tab; in this standalone window there isn't
      // one, so point it at a fixed URL for the screenshot.
      const ext = typeof browser !== "undefined" ? browser : chrome;
      ext.tabs.query = async () => [{ url: "https://example.com" }];
    });
  } else {
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
  }

  await popup.click("#scan-page");
  await popup.waitForSelector(".verdict", { timeout: 60000 });
  await popup.setViewportSize({ width: 340, height: 460 });
  await popup.screenshot({ path: path.join(OUT, "popup-scan.png") });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "load" });
  await options.waitForTimeout(400);
  await options.setViewportSize({ width: 700, height: 900 });
  await options.screenshot({ path: path.join(OUT, "options.png"), fullPage: true });

  await cleanup();
  console.log(`wrote ${path.join(OUT, "popup-scan.png")} and ${path.join(OUT, "options.png")}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
