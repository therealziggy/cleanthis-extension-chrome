// Unit tests for src/lib/report.js — what a finished clean is allowed to
// claim. The rules are the website's own (its result card): a file that still
// carries a link to a flagged site never wears "CLEAN", a format that is only
// scanned never wears it either, and a failure says whether a retry can help.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/report.js");
const r = self.CleanThisReport;

const BAD = { url: "https://bad.example/login", where: "page 2", kind: "link", verdict: "malicious" };
const FINE = { url: "https://fine.example/", where: "page 1", kind: "link", verdict: "not_flagged" };

// ── badLinks ──────────────────────────────────────────────────

test("badLinks returns only the links flagged as malicious", () => {
  const report = { links: { items: [FINE, BAD, { ...BAD, verdict: "suspicious" }] } };
  assert.deepEqual(r.badLinks(report), [BAD]);
});

test("badLinks is empty for a report with no link check at all", () => {
  assert.deepEqual(r.badLinks(undefined), []);
  assert.deepEqual(r.badLinks({}), []);
  assert.deepEqual(r.badLinks({ links: { items: "nope" } }), []);
  assert.deepEqual(r.badLinks({ links: { items: [null, FINE] } }), []);
});

// ── outcome ───────────────────────────────────────────────────

test("a clean that removed a threat is stamped CLEAN", () => {
  const out = r.outcome({ changes: [{ type: "macros", label: "3 macros removed" }] });
  assert.equal(out.stamp, "CLEAN");
  assert.equal(out.tone, "ok");
  assert.equal(out.title, "Scrubbed. All yours.");
  assert.equal(out.boo, "happy");
});

test("a link to a flagged site outranks everything: BAD LINK, never CLEAN", () => {
  const out = r.outcome({
    cleaningStrength: "content_preserved",
    changes: [{ type: "macros", label: "3 macros removed" }],
    links: { items: [BAD] },
  });
  assert.equal(out.stamp, "BAD LINK");
  assert.equal(out.tone, "red");
  assert.equal(out.boo, "alarm");
});

test("a format that is only scanned is stamped SCANNED", () => {
  const out = r.outcome({ cleaningStrength: "content_preserved", changes: [] });
  assert.equal(out.stamp, "SCANNED");
  assert.equal(out.tone, "amber");
});

test("nothing removed and nothing converted is ALREADY CLEAN", () => {
  const out = r.outcome({
    cleaningStrength: "re_encoded",
    changes: [{ type: "cleaning_strength", label: "Rebuilt" }, { type: "size", label: "File size changed from 1 MB to 1 MB" }],
  });
  assert.equal(out.stamp, "ALREADY CLEAN");
  assert.equal(out.tone, "ok");
});

test("a report with no changes at all is ALREADY CLEAN, not CLEAN", () => {
  assert.equal(r.outcome({}).stamp, "ALREADY CLEAN");
  assert.equal(r.outcome(undefined).stamp, "ALREADY CLEAN");
});

test("hidden fields count as something removed — by detail rows or by the label's number", () => {
  assert.equal(r.outcome({ changes: [{ type: "exif", label: "Hidden data", details: [{ key: "GPS", value: "x" }] }] }).stamp, "CLEAN");
  assert.equal(r.outcome({ changes: [{ type: "metadata", label: "Stripped 4 metadata fields" }] }).stamp, "CLEAN");
  assert.equal(r.outcome({ changes: [{ type: "metadata", label: "No metadata found" }] }).stamp, "ALREADY CLEAN");
});

test("a format conversion alone keeps CLEAN", () => {
  assert.equal(r.outcome({ changes: [{ type: "conversion", label: "Converted to PDF" }] }).stamp, "CLEAN");
  assert.equal(r.outcome({ changes: [{ type: "format_converted", label: "Saved as .docx" }] }).stamp, "CLEAN");
});

test("an email warning counts as a threat only when the server marked it dangerous", () => {
  assert.equal(r.outcome({ changes: [{ type: "deceptive_links", label: "x", danger: true }] }).stamp, "CLEAN");
  assert.equal(r.outcome({ changes: [{ type: "email_warnings", label: "x" }] }).stamp, "ALREADY CLEAN");
});

test("pre-scan findings (what the file carried) count as a threat removed", () => {
  for (const type of ["macro_analysis", "pdf_analysis", "rtf_analysis", "html_analysis", "archive_analysis", "yara_analysis"]) {
    assert.equal(r.outcome({ changes: [{ type, label: "x" }] }).stamp, "CLEAN", type);
  }
});

// ── failureCopy ───────────────────────────────────────────────

test("a failure the server calls final says a retry cannot help", () => {
  const copy = r.failureCopy("Sanitization blocked: the cleaned file still matched a virus signature.", false);
  assert.equal(copy.title, "We couldn't clean this file.");
  assert.match(copy.body, /^Sanitization blocked: .* Retrying gives the same result — the file itself is the reason\./);
  assert.equal(copy.retry, false);
});

test("any other failure keeps the door open for a retry", () => {
  const copy = r.failureCopy("Processing failed. Please try again.", true);
  assert.equal(copy.title, "Cleaning failed.");
  assert.equal(copy.retry, true);
  // An older server sends no flag at all: that must read as retryable too.
  assert.equal(r.failureCopy("Processing failed.", undefined).retry, true);
});

test("a final failure with no message falls back to the retryable copy", () => {
  // "the file itself is the reason" needs a reason to point at.
  const copy = r.failureCopy("", false);
  assert.equal(copy.title, "Cleaning failed.");
  assert.match(copy.body, /^The server couldn't process this one\./);
});

test("every failure says the upload was erased", () => {
  assert.match(r.failureCopy("x.", false).body, /Your upload was erased either way\.$/);
  assert.match(r.failureCopy(null, true).body, /Your upload was erased either way\.$/);
});
