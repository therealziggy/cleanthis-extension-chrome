// Every page must load exactly the libraries it needs — no more, no fewer.
//
// The pages are classic scripts sharing one global scope, wired together by
// literal `self.CleanThisX` references (verified: src/ contains no dynamic
// `self[...]` lookup, so this analysis is complete, not a heuristic). That
// makes the dependency graph statically decidable — and it needs to be, because
// nothing else in the repo catches a wrong include list:
//
//   A MISSING library fails silently at load. Pages capture their modules
//   lazily — warning.js only touches self.CleanThisApi inside the report-submit
//   handler — so dropping lib/api.js from warning.html throws nothing until the
//   user presses Send. The smoke harness loads every page and sees nothing
//   (confirmed by removing that include and watching it pass).
//
//   An UNUSED library is dead weight in every page load, and quietly grows.
//
// So this file is the guard for both directions.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

// theme.js earns its place by running, not by being referenced: it applies the
// saved theme before first paint. Every page loads it and no page names it.
const SIDE_EFFECT_ONLY = new Set(["theme.js"]);

const PAGES = ["popup/popup.html", "options/options.html", "clean/clean.html", "welcome/welcome.html", "warning/warning.html"];

function scriptsIn(htmlRelPath) {
  const html = fs.readFileSync(path.join(SRC, htmlRelPath), "utf8");
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

// Globals a file reads, minus the ones it defines itself.
function globalsUsed(absPath) {
  const source = fs.readFileSync(absPath, "utf8");
  const defined = new Set([...source.matchAll(/self\.(CleanThis[A-Za-z]*)\s*=/g)].map((m) => m[1]));
  const used = new Set([...source.matchAll(/\bCleanThis[A-Za-z]*/g)].map((m) => m[0]));
  for (const name of defined) used.delete(name);
  used.delete("CleanThis");
  return used;
}

// Which library file provides which global.
const PROVIDER = new Map();
for (const file of fs.readdirSync(path.join(SRC, "lib")).filter((f) => f.endsWith(".js"))) {
  const source = fs.readFileSync(path.join(SRC, "lib", file), "utf8");
  for (const m of source.matchAll(/self\.(CleanThis[A-Za-z]+)\s*=/g)) PROVIDER.set(m[1], file);
}

// Transitive closure: a page needs what its own script names, plus whatever
// those libraries name in turn.
function librariesNeededBy(pageRelPath) {
  const dir = path.dirname(pageRelPath);
  const own = scriptsIn(pageRelPath).find((s) => !s.startsWith("../lib/"));
  const pending = [...globalsUsed(path.join(SRC, dir, own))];
  const files = new Set();
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const provider = PROVIDER.get(name);
    if (!provider) continue;
    files.add(provider);
    for (const next of globalsUsed(path.join(SRC, "lib", provider))) pending.push(next);
  }
  return files;
}

test("the provider map found every shared library", () => {
  // Guards the analysis itself: if the `self.CleanThisX =` convention ever
  // changes, PROVIDER silently empties and every assertion below passes
  // vacuously.
  assert.ok(PROVIDER.size >= 7, `expected the lib/ globals to be discovered, found ${PROVIDER.size}`);
  assert.equal(PROVIDER.get("CleanThisApi"), "api.js");
});

for (const page of PAGES) {
  test(`${page} loads exactly the libraries it needs`, () => {
    const included = new Set(
      scriptsIn(page).filter((s) => s.startsWith("../lib/")).map((s) => path.basename(s))
    );
    const needed = librariesNeededBy(page);

    for (const file of needed) {
      assert.ok(included.has(file), `${page} uses lib/${file} but does not load it`);
    }
    for (const file of included) {
      if (SIDE_EFFECT_ONLY.has(file)) continue;
      assert.ok(needed.has(file), `${page} loads lib/${file} but nothing on the page uses it`);
    }
  });
}
