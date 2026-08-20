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
        "shot-2": {
          name: "setup-helper.zip",
          why: "We couldn't clean this one. Your call.",
          label: "Download the unsafe original",
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

  // ── popup: every view, driven through the __ctPopup harness hook ──
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.evaluate((base) => { self.CleanThisApi.baseUrl = base; }, BASE);
  await popup.evaluate(() => {
    const ext = typeof browser !== "undefined" ? browser : chrome;
    ext.tabs.query = async () => [{ id: 1, url: "https://verify-human-check.top/login" }];
  });

  async function shootPopup(name) {
    await shoot(popup, name, "light", { fullPage: true });
    await shoot(popup, name, "dark", { fullPage: true });
  }

  // idle — with the two seeded pending actions on show
  await popup.evaluate(async () => {
    await self.__ctPopup.refreshPending();
    self.__ctPopup.showView("idle");
    return document.getElementById("site").textContent;
  });
  await popup.waitForTimeout(150);
  await shootPopup("popup-idle");

  // scanning — frozen mid-flight at 42%
  await popup.evaluate(() => {
    document.getElementById("scan-site").textContent = "verify-human-check.top";
    self.__ctPopup.showView("scanning");
    self.__ctPopup.setRing(42);
  });
  await shootPopup("popup-scanning");

  // verdict (clean) — through the real click path so the flow stays honest
  if (process.env.LIVE_SCAN !== "1") {
    await popup.evaluate(() => {
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
  await popup.evaluate(() => self.__ctPopup.showView("idle"));
  await popup.click("#scan-page");
  await popup.waitForSelector("#view-verdict:not([hidden]) .verdict-title", { timeout: 60000 });
  await shootPopup("popup-verdict-clean");

  // verdict (malicious) — driven directly; no server call, no quota
  await popup.evaluate(() => {
    self.__ctPopup.renderVerdict("https://verify-human-check.top/login", 1, {
      verdict: "malicious",
      scores: {
        security: {
          value: 4, band: "red", coverage: "full",
          driver: "A fake “verify you are human” page that wants you to paste a command into your terminal. Don't.",
        },
      },
    });
    self.__ctPopup.showView("verdict");
  });
  await shootPopup("popup-verdict-malicious");

  // settings
  await popup.click("#settings-btn");
  await popup.waitForSelector("#view-settings:not([hidden])");
  await shootPopup("popup-settings");

  // errors — hard (offline) and soft (quota, with a real reset time seeded)
  await popup.evaluate(async () => {
    await self.__ctPopup.renderError("offline");
    self.__ctPopup.showView("error");
  });
  await shootPopup("popup-error-offline");
  await popup.evaluate(async () => {
    await self.__ctPopup.renderError("quota");
    self.__ctPopup.showView("error");
  });
  await shootPopup("popup-error-quota");

  // ── clean page (idle drop zone) ───────────────────────────
  const clean = await context.newPage();
  await clean.goto(`chrome-extension://${extensionId}/clean/clean.html`, { waitUntil: "load" });
  await clean.setViewportSize({ width: 560, height: 660 });
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
