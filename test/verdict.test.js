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
    caution: false,
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
    { text: "Spamhaus DBL reports this address as dangerous.", strong: true, caution: false }
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

// ── v0.7.1: the sentences the website gained since ────────────

const RED_LEGIT = { legitimacy: { value: 12, band: "red", coverage: "full", driver: "Promoted through spam campaigns" } };

test("unknown → the sources-unreachable line, not the page-unreachable one", () => {
  const s = v.statementFor("unknown", []);
  assert.equal(s.text, "We couldn't reach any of the sources for this scan. Try again in a moment.");
  assert.equal(s.caution, false);
});

test("clean + a spam-distributed installer link → the do-not-run warning, flagged as a caution", () => {
  const s = v.statementFor("clean", [{ source: "cleanthis_payload_url", result: "notice", details: {} }]);
  assert.equal(
    s.text,
    "This exact link downloads an executable installer that was distributed through a spam / phishing campaign. Do not download or run it — links like this deliver malware or remote-access tools."
  );
  assert.equal(s.strong, true);
  assert.equal(s.caution, true);
});

test("clean + an installer link on a well-known site → the verify-the-source line", () => {
  const s = v.statementFor("clean", [{ source: "cleanthis_payload_url", result: "notice", details: { wellKnown: true } }]);
  assert.equal(
    s.text,
    "No threat signals from the blocklists — but this exact link points to an executable download that was distributed through a spam / phishing campaign. Verify you trust the source before running it."
  );
  assert.equal(s.caution, true);
});

test("the installer-link warning leads over the spam-observed note", () => {
  const s = v.statementFor("clean", [
    { source: "cleanthis_spam_observed", result: "notice", details: {} },
    { source: "cleanthis_payload_url", result: "notice", details: {} },
  ]);
  assert.match(s.text, /executable installer/);
});

test("clean + spam-observed on an unknown site is a caution; on a well-known site it is not", () => {
  assert.equal(v.statementFor("clean", [{ source: "cleanthis_spam_observed", result: "notice", details: {} }]).caution, true);
  assert.equal(
    v.statementFor("clean", [{ source: "cleanthis_spam_observed", result: "notice", details: { wellKnown: true } }]).caution,
    false
  );
});

test("clean with a red legitimacy score → the scam-signs line, driver in lower case", () => {
  const s = v.statementFor("clean", [], RED_LEGIT);
  assert.equal(
    s.text,
    "No blocklist or security vendor has flagged this address yet — but the page itself shows signs of a scam (promoted through spam campaigns). Treat it with caution."
  );
  assert.equal(s.caution, true);
});

test("scam signs without a driver still read as one sentence", () => {
  const s = v.statementFor("clean", [], { legitimacy: { value: 5, band: "red" } });
  assert.equal(
    s.text,
    "No blocklist or security vendor has flagged this address yet — but the page itself shows signs of a scam. Treat it with caution."
  );
});

test("a red legitimacy score with no value is not scam signs (nothing was measured)", () => {
  const s = v.statementFor("clean", [], { legitimacy: { value: null, band: "red" } });
  assert.equal(s.text, "Not flagged by any of the sources we checked.");
  assert.equal(s.caution, false);
});

test("a plain clean result carries no caution", () => {
  assert.equal(v.statementFor("clean", []).caution, false);
});

test("a cryptominer lead names the miner", () => {
  assert.equal(
    v.statementFor("malicious", [{ source: "cryptominer", result: "listed", severity: "high" }]).text,
    "An in-browser cryptocurrency miner is running on this page — it can hijack your device to mine for someone else."
  );
});

test("a brand-clone lead names the brand, in both of the site's wordings", () => {
  assert.equal(
    v.statementFor("malicious", [
      { source: "brandClone", result: "listed", severity: "high", details: { brand: "PayPal", kind: "suspected_phishing" } },
    ]).text,
    "This page copies PayPal’s look but isn’t on an official PayPal site — very likely a phishing page. Don’t sign in here."
  );
  assert.equal(
    v.statementFor("malicious", [{ source: "brandClone", result: "listed", severity: "high", details: { brand: "PayPal" } }]).text,
    "This page impersonates PayPal to harvest logins or payment details — a likely phishing clone."
  );
  assert.equal(
    v.statementFor("malicious", [{ source: "brandClone", result: "listed", severity: "high" }]).text,
    "This page impersonates a well-known brand to harvest logins or payment details — a likely phishing clone."
  );
});

test("a fake-login lead names the brand when there is one", () => {
  assert.match(
    v.statementFor("malicious", [{ source: "fakeLogin", result: "listed", severity: "high", details: { brand: "Microsoft" } }]).text,
    /^This looks like a fake Microsoft sign-in page built to steal credentials/
  );
  assert.match(
    v.statementFor("malicious", [{ source: "fakeLogin", result: "listed", severity: "high" }]).text,
    /^This looks like a fake sign-in page built to steal credentials/
  );
});

test("a scam-lens finding leads over a higher-severity blocklist row, as on the website", () => {
  const s = v.statementFor("malicious", [
    { source: "x", sourceLabel: "X", result: "listed", severity: "high" },
    { source: "brandClone", lens: "scam", result: "listed", severity: "medium", details: { brand: "PayPal" } },
  ]);
  assert.match(s.text, /^This page impersonates PayPal/);
});

// ── whenLabel ─────────────────────────────────────────────────

test("a fresh result reads 'just now'", () => {
  assert.equal(v.whenLabel({ cached: false, computedAt: 1000 }, 5000), "just now");
  assert.equal(v.whenLabel({}, 5000), "just now");
});

test("a cached result says how old it is", () => {
  const now = 100 * 3600 * 1000;
  assert.equal(v.whenLabel({ cached: true, computedAt: now - 30 * 1000 }, now), "checked a moment ago");
  assert.equal(v.whenLabel({ cached: true, computedAt: now - 12 * 60 * 1000 }, now), "checked 12 min ago");
  assert.equal(v.whenLabel({ cached: true, computedAt: now - 3 * 3600 * 1000 }, now), "checked 3 h ago");
  assert.equal(v.whenLabel({ cached: true, computedAt: now - 23.6 * 3600 * 1000 }, now), "checked 23 h ago");
});

test("a cached result with no usable time still does not claim 'just now'", () => {
  assert.equal(v.whenLabel({ cached: true }, 5000), "checked earlier");
  assert.equal(v.whenLabel({ cached: true, computedAt: 9000 }, 5000), "checked earlier");
});
