// Unit tests for src/lib/intercept.js — pure decision logic, no browser APIs.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/intercept.js");
const { decide, extOf, DEFAULT_EXTS } = self.CleanThisIntercept;

const BASE = "https://cleanthis.io";
const ON = { interceptEnabled: true, interceptExts: ["pdf", "docx", "zip"] };
const NONE = new Set();

test("nothing is intercepted while the feature is off", () => {
  const result = decide({ url: "https://example.com/a.pdf" }, { interceptEnabled: false }, NONE, BASE);
  assert.equal(result.intercept, false);
  assert.equal(result.reason, "disabled");
});

test("a matching download is intercepted and reports its extension", () => {
  const result = decide({ url: "https://example.com/report.pdf" }, ON, NONE, BASE);
  assert.deepEqual(result, { intercept: true, reason: "matched", ext: "pdf" });
});

test("only http and https downloads are eligible", () => {
  for (const url of ["data:text/plain,hi", "blob:https://example.com/abc", "ftp://example.com/a.pdf"]) {
    const result = decide({ url }, ON, NONE, BASE);
    assert.equal(result.intercept, false, url);
    assert.equal(result.reason, "non-http", url);
  }
});

test("junk that isn't a url at all is skipped", () => {
  const result = decide({ url: "not a url" }, ON, NONE, BASE);
  assert.equal(result.intercept, false);
  assert.equal(result.reason, "non-http");
});

test("an http url the parser rejects is skipped rather than crashing", () => {
  const result = decide({ url: "https://" }, ON, NONE, BASE);
  assert.equal(result.intercept, false);
  assert.equal(result.reason, "bad-url");
});

test("a missing url is skipped", () => {
  assert.equal(decide({}, ON, NONE, BASE).intercept, false);
});

test("our own downloads are never re-intercepted", () => {
  const own = decide({ url: "https://cleanthis.io/api/download/j1?sig=x" }, ON, NONE, BASE);
  assert.equal(own.reason, "own-host");

  const sub = decide({ url: "https://www.cleanthis.io/api/download/j1.pdf" }, ON, NONE, BASE);
  assert.equal(sub.reason, "own-host");
});

test("host matching ignores the port so a local dev server is still recognised", () => {
  const local = "http://localhost:3000";
  const same = decide({ url: "http://localhost:3000/api/download/j1.pdf" }, ON, NONE, local);
  assert.equal(same.reason, "own-host");

  const otherPort = decide({ url: "http://localhost:9999/a.pdf" }, ON, NONE, local);
  assert.equal(otherPort.reason, "own-host");
});

test("a hostname merely ending in the base domain is not treated as ours", () => {
  const result = decide({ url: "https://notcleanthis.io/a.pdf" }, ON, NONE, BASE);
  assert.equal(result.intercept, true);
});

test("downloads from this machine or this network are left alone", () => {
  // The service fetches downloads from its own location and can never reach a
  // private address, so intercepting would break the download and send an
  // internal address off the machine for nothing.
  for (const url of [
    "http://192.168.1.10/share/report.pdf",
    "http://10.0.0.5/report.pdf",
    "http://172.16.4.4/report.pdf",
    "http://127.0.0.1:8080/report.pdf",
    "http://169.254.1.1/report.pdf",
    "http://nas/report.pdf",
    "http://printer.local/report.pdf",
  ]) {
    const result = decide({ url }, ON, NONE, BASE);
    assert.equal(result.intercept, false, url);
    assert.equal(result.reason, "local-address", url);
  }
});

test("public addresses that merely look similar are still intercepted", () => {
  for (const url of ["https://172.32.0.1/a.pdf", "https://11.0.0.1/a.pdf", "https://notlocal.com/a.pdf"]) {
    assert.equal(decide({ url }, ON, NONE, BASE).intercept, true, url);
  }
});

test("a link carrying credentials is never sent to the service", () => {
  const result = decide({ url: "https://user:secret@example.com/report.pdf" }, ON, NONE, BASE);
  assert.equal(result.intercept, false);
  assert.equal(result.reason, "credentials");
});

test("a url the user chose to download untouched is left alone", () => {
  const bypass = new Set(["https://example.com/report.pdf"]);
  const result = decide({ url: "https://example.com/report.pdf" }, ON, bypass, BASE);
  assert.equal(result.reason, "bypassed");
});

test("the bypass list is also checked against the post-redirect url", () => {
  const bypass = new Set(["https://cdn.example.com/final.pdf"]);
  const item = { url: "https://example.com/start.pdf", finalUrl: "https://cdn.example.com/final.pdf" };
  assert.equal(decide(item, ON, bypass, BASE).reason, "bypassed");
});

test("the browser's filename wins over the url path when deciding the type", () => {
  const item = { url: "https://example.com/download.php?id=9", filename: "invoice.pdf" };
  assert.deepEqual(decide(item, ON, NONE, BASE), { intercept: true, reason: "matched", ext: "pdf" });
});

test("extensions that are not on the list are left alone", () => {
  const result = decide({ url: "https://example.com/video.mp4" }, ON, NONE, BASE);
  assert.equal(result.intercept, false);
  assert.equal(result.reason, "ext-not-matched");
});

test("a download with no recognisable extension is left alone", () => {
  assert.equal(decide({ url: "https://example.com/stream" }, ON, NONE, BASE).reason, "ext-not-matched");
});

test("an explicit empty extension list matches nothing", () => {
  // Empty is a choice the checkbox UI can express: every box unticked.
  const settings = { interceptEnabled: true, interceptExts: [] };
  assert.equal(decide({ url: "https://example.com/a.pdf" }, settings, NONE, BASE).intercept, false);
});

test("a missing extension list falls back to the defaults", () => {
  const settings = { interceptEnabled: true };
  assert.equal(decide({ url: "https://example.com/a.pdf" }, settings, NONE, BASE).intercept, true);
  assert.ok(DEFAULT_EXTS.includes("pdf"));
});

test("extOf reads the extension from names, paths and query strings", () => {
  assert.equal(extOf("report.PDF"), "pdf");
  assert.equal(extOf("/files/report.pdf?token=abc#page2"), "pdf");
  assert.equal(extOf("archive.tar.gz"), "gz");
  assert.equal(extOf("noextension"), null);
  assert.equal(extOf(""), null);
  assert.equal(extOf(null), null);
});
