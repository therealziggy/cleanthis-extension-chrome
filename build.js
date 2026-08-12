#!/usr/bin/env node
// Build script for the CleanThis extension.
//
// Merges manifest/base.json with a per-browser fragment, copies src/ into
// dist/<browser>/, and (with --zip) produces store-ready zips. No bundler,
// no transpilation — the shipped code is exactly what's in src/.
//
//   node build.js            → dist/chrome/  dist/firefox/
//   node build.js --zip      → also dist/cleanthis-<browser>-v<version>.zip
//   node build.js --dev      → also dist/chrome-dev/ (adds localhost host
//                              permissions from manifest/dev.json, for running
//                              the test harnesses against a local server)

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const BROWSERS = ["chrome", "firefox"];
const wantZip = process.argv.includes("--zip");

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const base = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest", "base.json"), "utf8"));

for (const browser of BROWSERS) {
  const fragment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest", `${browser}.json`), "utf8")
  );
  const manifest = deepMerge(base, fragment);
  const outDir = path.join(ROOT, "dist", browser);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`built dist/${browser} (manifest v${manifest.version})`);

  if (wantZip) {
    const zipName = `cleanthis-${browser}-v${manifest.version}.zip`;
    const zipPath = path.join(ROOT, "dist", zipName);
    fs.rmSync(zipPath, { force: true });
    try {
      execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: outDir });
      console.log(`zipped dist/${zipName}`);
    } catch (err) {
      console.error(`zip failed for ${browser}: ${err.message} (is 'zip' installed?)`);
      process.exitCode = 1;
    }
  }
}

// Dev build: the chrome target plus localhost host permissions, so the spike
// and E2E harnesses can talk to a locally-running cleanthis instance. Never
// shipped — dist/ is gitignored and release zips come from the loop above.
if (process.argv.includes("--dev")) {
  const chromeFragment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest", "chrome.json"), "utf8")
  );
  const devFragment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest", "dev.json"), "utf8")
  );
  const manifest = deepMerge(deepMerge(base, chromeFragment), devFragment);
  const outDir = path.join(ROOT, "dist", "chrome-dev");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("built dist/chrome-dev (DEV — localhost permissions, do not ship)");
}
