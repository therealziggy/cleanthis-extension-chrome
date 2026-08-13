#!/usr/bin/env node
// Runs the Firefox build in a real Firefox and reports what the platform
// actually supports. Firefox differs from Chromium in ways that matter to this
// extension (background type, notification options, when host permissions are
// granted), and none of that is visible to a lint or to the Chromium harness.
//
// Run: node build.js && node test/firefox-check.js
//
// The extension reports through a downloaded JSON file (see firefox-probe.js);
// no file at all means the probe never ran, which this script treats as a
// failure rather than a pass.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "dist", "firefox");
const PROBE_DIR = path.join(ROOT, "dist", "firefox-probe");
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cleanthis-ff-"));
const REPORT = path.join(OUT_DIR, "cleanthis-firefox-probe.json");
const FIREFOX = process.env.FIREFOX_BIN || "/usr/bin/firefox";
const TIMEOUT_MS = 90000;

if (!fs.existsSync(SRC)) {
  console.error("dist/firefox is missing — run `node build.js` first.");
  process.exit(1);
}

// Build a probe copy: the shipped build plus one extra background script.
fs.rmSync(PROBE_DIR, { recursive: true, force: true });
fs.cpSync(SRC, PROBE_DIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "firefox-probe.js"), path.join(PROBE_DIR, "probe.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, "manifest.json"), "utf8"));
manifest.background.scripts = [...manifest.background.scripts, "probe.js"];
fs.writeFileSync(path.join(PROBE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

const webExt = path.join(ROOT, "node_modules", ".bin", "web-ext");
const child = spawn(
  webExt,
  [
    "run",
    "--source-dir", PROBE_DIR,
    "--firefox", FIREFOX,
    "--no-input",
    "--no-reload",
    "--arg=-headless",
    // Download without prompting, straight into our own directory.
    "--pref=browser.download.folderList=2",
    `--pref=browser.download.dir=${OUT_DIR}`,
    "--pref=browser.download.useDownloadDir=true",
    "--pref=browser.download.always_ask_before_handling_new_types=false",
    "--pref=browser.download.manager.showWhenStarting=false",
  ],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
);

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
child.stdout.on("data", () => {});

const started = Date.now();
const timer = setInterval(() => {
  if (fs.existsSync(REPORT)) {
    clearInterval(timer);
    finish(JSON.parse(fs.readFileSync(REPORT, "utf8")));
  } else if (Date.now() - started > TIMEOUT_MS) {
    clearInterval(timer);
    console.error("The probe never reported — no results file was written.");
    if (stderr.trim()) console.error(stderr.split("\n").slice(-8).join("\n"));
    try { child.kill("SIGTERM"); } catch (_) {}
    process.exit(1);
  }
}, 1000);

function finish(report) {
  console.log(`Firefox probe ran at ${report.ranAt}\n`);
  const flag = (v) =>
    /MISSING|NOT GRANTED|THREW|^NO$|REJECTED/.test(String(v)) ? "  ⚠️ " : "  ✓ ";
  for (const { name, value } of report.results) {
    console.log(`${flag(value)}${name}: ${value}`);
  }
  const problems = report.results.filter((r) => /MISSING|NOT GRANTED|THREW|^NO$/.test(String(r.value)));
  console.log(`\n${report.results.length - problems.length}/${report.results.length} checks clean`);
  if (problems.length) {
    console.log("\nNeeds a decision:");
    for (const p of problems) console.log(`  - ${p.name}: ${p.value}`);
  }
  try { child.kill("SIGTERM"); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
