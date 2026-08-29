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

// Arrays are REPLACED, never merged: a `permissions` key in a fragment wipes
// the base set rather than adding to it. Every array is also COPIED on the way
// out — `{ ...base }` is shallow, so without this the merged manifest and the
// base share one array, and a caller that appends to the result reaches back
// into `base` and changes what the next target inherits. Today the release
// targets are all built before the dev block appends anything, so nothing
// leaks; the copy is what keeps that true when this file is next reordered.
function deepMerge(base, extra) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      out[key] = [...value];
    } else if (
      value !== null &&
      typeof value === "object" &&
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

// The manifest version is the one that matters — it names the zips and CI
// checks the release tag against it. package.json carries its own copy for the
// tooling, hand-synced, with nothing until now to notice when the two drift.
// A mismatch surfaces at release time as a tag that matches one file and not
// the other, so it is worth failing the build over.
function checkVersionsAgree() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest", "base.json"), "utf8")).version;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  if (manifest !== pkg) {
    console.error(
      `version mismatch: manifest/base.json is ${manifest}, package.json is ${pkg} — set both to the version you are releasing.`
    );
    process.exit(1);
  }
  return manifest;
}

function build() {
  checkVersionsAgree();
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
    // The shipped build asks for "tabs" at runtime (optional_permissions), but a
    // permission prompt can't be clicked from the E2E harness — so the dev build
    // grants it at install. Dev-only; the release manifests are untouched.
    for (const p of ["tabs", "webNavigation"]) if (!manifest.permissions.includes(p)) manifest.permissions.push(p);
    const outDir = path.join(ROOT, "dist", "chrome-dev");
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(path.join(ROOT, "src"), outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    // Point the dev build at the local server permanently. Setting it at runtime
    // isn't enough: the service worker is restarted freely, which would reset it
    // and quietly send test traffic to production.
    const devBase = process.env.API_BASE || "http://localhost:3000";
    const apiPath = path.join(outDir, "lib", "api.js");
    const source = fs.readFileSync(apiPath, "utf8");
    const patched = source.replace('baseUrl: "https://cleanthis.io"', `baseUrl: ${JSON.stringify(devBase)}`);
    if (patched === source) {
      console.error("dev build: could not rewrite the API base URL — has lib/api.js changed shape?");
      process.exit(1);
    }
    fs.writeFileSync(apiPath, patched);
    console.log(`built dist/chrome-dev (DEV — ${devBase}, do not ship)`);
  }
}

// Running this file builds; requiring it (the unit tests) only borrows the
// helpers, so `npm test` never writes into dist/.
if (require.main === module) build();

module.exports = { deepMerge, checkVersionsAgree };
