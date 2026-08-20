// Unit tests for src/lib/docs.js — which URLs get document-cleaning offers.
//
// Two different sets on purpose: the popup's "Clean this file" button uses the
// FULL server catalogue (anything the pipeline accepts), while the opt-in
// blanket ask uses only the document/archive set (DEFAULT_EXTS) — nobody wants
// an interstitial on every jpg.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/intercept.js");
require("../src/lib/docs.js");
const docs = self.CleanThisDocs;

const CATALOGUE = { groups: [{ exts: ["pdf", "docx"] }, { exts: ["jpg"] }] };
const OWN = "https://cleanthis.io";

test("a public pdf URL is cleanable, query stripped", () => {
  assert.equal(docs.cleanableExtFor("https://example.com/report.pdf?dl=1", CATALOGUE, OWN), "pdf");
});

test("catalogue decides the set — jpg is offered when the server accepts it", () => {
  assert.equal(docs.cleanableExtFor("https://example.com/photo.jpg", CATALOGUE, OWN), "jpg");
  assert.equal(docs.cleanableExtFor("https://example.com/tool.exe", CATALOGUE, OWN), null);
});

test("local and private addresses never get the offer", () => {
  assert.equal(docs.cleanableExtFor("http://192.168.1.1/x.pdf", CATALOGUE, OWN), null);
  assert.equal(docs.cleanableExtFor("http://localhost:3000/x.pdf", CATALOGUE, OWN), null);
});

test("our own downloads never get the offer (no cleaning the cleaned)", () => {
  assert.equal(docs.cleanableExtFor("https://cleanthis.io/api/download/x.pdf", CATALOGUE, OWN), null);
});

test("non-http and extension-less URLs → null", () => {
  assert.equal(docs.cleanableExtFor("ftp://example.com/x.pdf", CATALOGUE, OWN), null);
  assert.equal(docs.cleanableExtFor("https://example.com/about", CATALOGUE, OWN), null);
  assert.equal(docs.cleanableExtFor(null, CATALOGUE, OWN), null);
});

test("blanket set: documents yes, images no, local no", () => {
  assert.equal(docs.isBlanketDocUrl("https://example.com/paper.pdf"), true);
  assert.equal(docs.isBlanketDocUrl("https://example.com/report.docx?v=2"), true);
  assert.equal(docs.isBlanketDocUrl("https://example.com/photo.jpg"), false);
  assert.equal(docs.isBlanketDocUrl("http://10.0.0.5/paper.pdf"), false);
  assert.equal(docs.isBlanketDocUrl("https://example.com/"), false);
});
