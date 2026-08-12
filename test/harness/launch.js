// Shared launcher for the manual browser harnesses (spike + E2E).
//
// Loading an unpacked extension from the command line needs a Chromium build
// that still supports --load-extension. Recent Google Chrome releases removed
// that switch outright, so we probe the installed Chromium-family browsers and
// use the first one that actually surfaces the extension. Set BROWSER_BIN to
// pin a specific binary.
//
// Not part of CI — CI only builds and lints. These harnesses are run by hand
// against a local cleanthis instance.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const CANDIDATES = [
  process.env.BROWSER_BIN,
  "/usr/bin/brave-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);

async function tryLaunch(browserPath, extDir) {
  // Chromium 137+ only honours --load-extension when the profile has developer
  // mode enabled, so seed a throwaway profile with it.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanthis-ext-"));
  fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } })
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: browserPath,
    headless: false,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
  }

  const cleanup = async () => {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  if (!sw) {
    await cleanup();
    return null;
  }
  return { context, serviceWorker: sw, cleanup, browserPath };
}

async function launchWithExtension(extDir) {
  const tried = [];
  for (const browserPath of CANDIDATES) {
    if (!fs.existsSync(browserPath)) continue;
    tried.push(browserPath);
    const result = await tryLaunch(browserPath, extDir);
    if (result) return result;
  }
  throw new Error(
    `No installed browser could load the unpacked extension (tried: ${tried.join(", ") || "none found"}). ` +
      "Recent Google Chrome builds dropped --load-extension; install Brave or Chromium, or set BROWSER_BIN."
  );
}

module.exports = { launchWithExtension };
