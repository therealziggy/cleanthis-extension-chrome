// Unit tests for src/lib/verdict.js — the popup's verdict presentation logic
// (wheel state per score axis + the overall statement line). Strings are the
// website's own (public/webpage-scanner.js) so both surfaces say the same
// sentence about the same scan.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/verdict.js");
const v = self.CleanThisVerdict;

// ── wheelState ────────────────────────────────────────────────

test("a full-coverage score renders its value, band and driver", () => {
  assert.deepEqual(
    v.wheelState({ value: 49, band: "red", coverage: "full", driver: "Domain on a spam/abuse blocklist" }),
    { value: "49", band: "red", driver: "Domain on a spam/abuse blocklist", suffix: "", none: false }
  );
});

test("partial coverage gets the Quick-scan suffix; degraded gets the check-didn't-respond one", () => {
  assert.equal(
    v.wheelState({ value: 96, band: "green", coverage: "partial", driver: "Third-party connections" }).suffix,
    " · limited (Quick scan)"
  );
  assert.equal(
    v.wheelState({ value: 96, band: "green", coverage: "partial", degraded: true, driver: "x" }).suffix,
    " · limited — a check didn’t respond"
  );
});

test("a missing axis renders the em-dash wheel", () => {
  const state = v.wheelState(undefined);
  assert.equal(state.none, true);
  assert.equal(state.value, "—");
  assert.equal(state.band, "none");
});

test("coverage none prompts a deeper scan; blocked/unloaded keep the backend driver", () => {
  assert.equal(v.wheelState({ value: null, band: "none", coverage: "none" }).driver, "Run a deeper scan to assess this");
  const blocked = v.wheelState({ value: 10, band: "red", coverage: "blocked", driver: "Not measured" });
  assert.equal(blocked.none, true);
  assert.equal(blocked.driver, "Not measured");
  assert.equal(v.wheelState({ value: 10, band: "red", coverage: "unloaded" }).driver, "Page couldn’t be loaded");
});

// ── statementFor ──────────────────────────────────────────────

test("clean with no findings → the site's not-flagged line", () => {
  assert.deepEqual(v.statementFor("clean", []), {
    text: "Not flagged by any of the sources we checked.",
    strong: false,
  });
});

test("clean but spam-observed → the distribution warning (unknown target)", () => {
  const s = v.statementFor("clean", [
    { source: "cleanthis_spam_observed", result: "notice", details: { wellKnown: false } },
  ]);
  assert.match(s.text, /distributed through an automated spam campaign/);
  assert.equal(s.strong, false);
});

test("a listed lead without a note → '<label> reports this address as dangerous.'", () => {
  assert.deepEqual(
    v.statementFor("suspicious", [{ source: "spamhaus_dbl", sourceLabel: "Spamhaus DBL", result: "listed", severity: "medium" }]),
    { text: "Spamhaus DBL reports this address as dangerous.", strong: true }
  );
});

test("a listed lead with a note → its first sentence", () => {
  assert.equal(
    v.statementFor("suspicious", [
      { source: "x", sourceLabel: "X", result: "listed", details: { note: "First sentence here. Second one." } },
    ]).text,
    "First sentence here."
  );
});

test("lookalike lead → the phishing-mimic line", () => {
  assert.match(v.statementFor("suspicious", [{ source: "lookalike", result: "listed" }]).text, /mimics a well-known brand/);
});

test("non-clean with no listed lead → the verdict summary", () => {
  assert.equal(
    v.statementFor("suspicious", [{ source: "y", result: "notice" }]).text,
    "At least one source flagged this address. Treat with caution."
  );
  assert.equal(v.statementFor("malicious", []).text, "One or more sources report this address as actively dangerous.");
});

test("unreachable → the couldn't-open line", () => {
  assert.match(v.statementFor("unreachable", []).text, /couldn’t open this page/);
});

test("a high-severity listed lead outranks a medium one regardless of order", () => {
  assert.equal(
    v.statementFor("malicious", [
      { source: "a", sourceLabel: "A", result: "listed", severity: "medium" },
      { source: "b", sourceLabel: "B", result: "listed", severity: "high" },
    ]).text,
    "B reports this address as dangerous."
  );
});

// ── firstSentence ─────────────────────────────────────────────

test("firstSentence cuts at the first terminator and caps long run-ons", () => {
  assert.equal(v.firstSentence("One two. Three.", 160), "One two.");
  assert.equal(v.firstSentence("No terminator at all", 160), "No terminator at all");
  const long = "x".repeat(200) + ".";
  assert.equal(v.firstSentence(long, 160).length, 160);
});
