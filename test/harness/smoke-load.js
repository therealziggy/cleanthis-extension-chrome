#!/usr/bin/env node
// Loads the built extension in a real browser and reports any errors from the
// background worker. Quick check that the worker parses, that the shared
// libraries are reachable from it, and that the icons resolve.
//
// Run: node build.js --dev && node test/harness/smoke-load.js

"use strict";

const path = require("path");
const { launchWithExtension } = require("./launch");

const EXT_DIR = path.join(__dirname, "..", "..", "dist", "chrome-dev");

(async () => {
  const { context, serviceWorker, cleanup, browserPath } = await launchWithExtension(EXT_DIR);
  console.log(`browser: ${browserPath}`);

  const errors = [];
  serviceWorker.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  serviceWorker.on("pageerror", (err) => errors.push(String(err)));

  const state = await serviceWorker.evaluate(async () => ({
    api: typeof self.CleanThisApi === "object" && typeof self.CleanThisApi.scanUrl === "function",
    intercept: typeof self.CleanThisIntercept === "object" && typeof self.CleanThisIntercept.decide === "function",
    baseUrl: self.CleanThisApi && self.CleanThisApi.baseUrl,
    iconStatus: (await fetch(chrome.runtime.getURL("icons/icon-128.png"))).status,
  }));

  // The popup and options pages must parse and find their scripts too.
  const extensionId = new URL(serviceWorker.url()).host;
  const pageErrors = [];
  // Every page, not just the two: a page that loses a script it needs fails
  // at load, and this is the only check in the repo that would see it.
  const PAGES = [
    "popup/popup.html",
    "options/options.html",
    "welcome/welcome.html",
    "clean/clean.html",
    "warning/warning.html?to=https%3A%2F%2Fexample.invalid%2F&kind=flagged&via=commit",
  ];
  for (const page of PAGES) {
    const tab = await context.newPage();
    tab.on("pageerror", (err) => pageErrors.push(`${page}: ${err}`));
    tab.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(`${page}: ${msg.text()}`);
    });
    await tab.goto(`chrome-extension://${extensionId}/${page}`, { waitUntil: "load" });
    await tab.waitForTimeout(500);
    await tab.close();
  }

  await cleanup();

  console.log("worker state:", state);
  const problems = [...errors, ...pageErrors];
  if (problems.length) {
    console.error("PROBLEMS:\n" + problems.join("\n"));
    process.exit(1);
  }
  const ok = state.api && state.intercept && state.iconStatus === 200;
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
