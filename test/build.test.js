// Unit tests for build.js's manifest merge.
//
// The release manifests and the dev manifest are all merged from the same
// base object, and the dev build APPENDS to its permissions. If the merge
// hands out the base's own array rather than a copy, that append reaches back
// into the base and changes what every later target inherits — which is how a
// dev-only "tabs" grant would end up in a shipped manifest. Today the release
// targets are all built before the dev block runs, so ordering hides it; these
// tests pin the property itself so a future reordering can't quietly ship it.
//
// Requiring build.js does not build (it guards on require.main), so this
// writes nothing into dist/.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { deepMerge } = require("../build.js");

test("the merged manifest never aliases the base's arrays", () => {
  const base = { permissions: ["downloads", "storage"] };
  const merged = deepMerge(base, {});

  merged.permissions.push("tabs");

  assert.deepEqual(base.permissions, ["downloads", "storage"], "the base was mutated through the merged copy");
  assert.deepEqual(merged.permissions, ["downloads", "storage", "tabs"]);
});

test("a second target is unaffected by what the first one appended", () => {
  // The exact shape of the bug: build chrome, let the dev block append to it,
  // then build firefox from the same base.
  const base = { permissions: ["downloads"], version: "1.0.0" };

  const chrome = deepMerge(base, { background: { service_worker: "background.js" } });
  chrome.permissions.push("tabs", "webNavigation");

  const firefox = deepMerge(base, { background: { scripts: ["background.js"] } });

  assert.deepEqual(firefox.permissions, ["downloads"], "the dev append leaked into a release manifest");
});

test("arrays are REPLACED by the fragment, never merged into it", () => {
  // Load-bearing: a `permissions` key in a fragment is meant to wipe the base
  // set, not extend it. Merging instead would silently widen every manifest.
  const merged = deepMerge({ permissions: ["downloads", "storage"] }, { permissions: ["storage"] });
  assert.deepEqual(merged.permissions, ["storage"]);
});

test("nested objects still merge key by key", () => {
  const merged = deepMerge(
    { action: { default_title: "CleanThis", default_popup: "popup/popup.html" } },
    { action: { theme_icons: [{ size: 16 }] } }
  );
  assert.deepEqual(merged.action, {
    default_title: "CleanThis",
    default_popup: "popup/popup.html",
    theme_icons: [{ size: 16 }],
  });
});

test("the fragment's own arrays are copied too", () => {
  const fragment = { host_permissions: ["https://cleanthis.io/*"] };
  const merged = deepMerge({}, fragment);
  merged.host_permissions.push("http://localhost:3000/*");
  assert.deepEqual(fragment.host_permissions, ["https://cleanthis.io/*"]);
});

test("package.json and the manifest agree on the version", () => {
  // CI checks the release tag against manifest/base.json only, so a drifted
  // package.json would sail through and name the wrong version in the tooling.
  // build.js refuses to build on a mismatch; this pins the current state.
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", f), "utf8")).version;

  assert.equal(read("package.json"), read("manifest/base.json"));
});
