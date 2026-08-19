// Unit tests for src/lib/flagged.js — no network: global.fetch is stubbed.
//
// Contracts under test:
//   - canonicalHost only yields public http(s) hostnames (never local/own/IP);
//   - matching walks subdomain labels so an apex entry covers all subdomains;
//   - the client hash equals the server's (pinned by a hard-coded vector);
//   - the proceed-anyway bypass is one-shot and expires;
//   - list refresh keeps entries on 304 and on failure, replaces on 200.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

global.self = globalThis;
require("../src/lib/api.js");
require("../src/lib/intercept.js");
require("../src/lib/flagged.js");

const api = self.CleanThisApi;
const flagged = self.CleanThisFlagged;

function fakeExt(initial = {}) {
  function area(prefix) {
    const store = new Map(Object.entries(initial[prefix] || {}));
    return {
      async get(key) {
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      async remove(key) {
        store.delete(key);
      },
      _store: store,
    };
  }
  return { storage: { local: area("local"), session: area("session") } };
}

const hexOf = (host) => crypto.createHash("sha256").update(host).digest("hex").slice(0, 16);

// ── canonicalHost ─────────────────────────────────────────────

test("canonicalHost accepts public http(s) hosts, lowercased, dot-stripped", () => {
  assert.strictEqual(flagged.canonicalHost("https://EvIl.Example.COM./x?y#z"), "evil.example.com");
  assert.strictEqual(flagged.canonicalHost("http://sub.shady.example/offer"), "sub.shady.example");
});

test("canonicalHost rejects non-http, local, own-host, IP and single-label", () => {
  assert.strictEqual(flagged.canonicalHost("chrome-extension://abc/warning.html"), null);
  assert.strictEqual(flagged.canonicalHost("ftp://evil.example.com/"), null);
  assert.strictEqual(flagged.canonicalHost("https://localhost/"), null);
  assert.strictEqual(flagged.canonicalHost("https://nas.local/"), null);
  assert.strictEqual(flagged.canonicalHost("http://10.0.0.5/"), null);
  assert.strictEqual(flagged.canonicalHost("http://192.168.1.1/admin"), null);
  assert.strictEqual(flagged.canonicalHost("http://8.8.8.8/"), null);
  assert.strictEqual(flagged.canonicalHost("http://[2001:db8::1]/"), null);
  assert.strictEqual(flagged.canonicalHost("https://cleanthis.io/webpage-scanner.html"), null);
  assert.strictEqual(flagged.canonicalHost("https://api.cleanthis.io/"), null);
  assert.strictEqual(flagged.canonicalHost("https://intranet/"), null);
  assert.strictEqual(flagged.canonicalHost("not a url"), null);
});

// ── label walk ────────────────────────────────────────────────

test("candidateHosts walks labels down to two", () => {
  assert.deepStrictEqual(flagged.candidateHosts("a.b.example.com"), [
    "a.b.example.com",
    "b.example.com",
    "example.com",
  ]);
  assert.deepStrictEqual(flagged.candidateHosts("example.com"), ["example.com"]);
});

// ── hash parity with the server ───────────────────────────────

test("hashHost matches the server's truncated sha256", async () => {
  assert.strictEqual(await flagged.hashHost("evil-fixture.example"), hexOf("evil-fixture.example"));
  assert.strictEqual(await flagged.hashHost("EvIl-Fixture.Example."), hexOf("evil-fixture.example"));
});

// ── matching ──────────────────────────────────────────────────

test("check matches the exact host and an apex through the walk; misses return null", async () => {
  const index = flagged.buildIndex([
    [hexOf("evil-fixture.example"), "phishing", "2026-07"],
    [hexOf("bad-apex.example"), "spam", "2026-06"],
  ]);

  const exact = await flagged.check("https://evil-fixture.example/login", index);
  assert.deepStrictEqual(exact, { host: "evil-fixture.example", cat: "phishing", seen: "2026-07" });

  const walked = await flagged.check("https://promo.bad-apex.example/offer", index);
  assert.deepStrictEqual(walked, { host: "bad-apex.example", cat: "spam", seen: "2026-06" });

  assert.strictEqual(await flagged.check("https://honest.example/", index), null);
  assert.strictEqual(await flagged.check("http://192.168.1.20/evil", index), null);
});

// ── bypass: one-shot with expiry ──────────────────────────────

test("peekBypass sees a grant without consuming it", async () => {
  const ext = fakeExt();
  await flagged.grantBypass(ext, "evil-fixture.example");
  assert.strictEqual(await flagged.peekBypass(ext, "evil-fixture.example"), true);
  assert.strictEqual(await flagged.peekBypass(ext, "evil-fixture.example"), true); // still there
  assert.strictEqual(await flagged.peekBypass(ext, "other.example"), false);
  assert.strictEqual(await flagged.takeBypass(ext, "evil-fixture.example"), true); // consume works after peeks
  assert.strictEqual(await flagged.peekBypass(ext, "evil-fixture.example"), false); // gone once taken

  const store = ext.storage.session;
  await store.set({ flaggedBypass: { host: "evil-fixture.example", until: Date.now() - 1 } });
  assert.strictEqual(await flagged.peekBypass(ext, "evil-fixture.example"), false); // expired
});

test("takeBypass consumes exactly once and respects expiry", async () => {
  const ext = fakeExt();
  await flagged.grantBypass(ext, "evil-fixture.example");
  assert.strictEqual(await flagged.takeBypass(ext, "evil-fixture.example"), true);
  assert.strictEqual(await flagged.takeBypass(ext, "evil-fixture.example"), false); // one-shot

  await flagged.grantBypass(ext, "evil-fixture.example");
  assert.strictEqual(await flagged.takeBypass(ext, "other.example"), false); // wrong host doesn't consume
  assert.strictEqual(await flagged.takeBypass(ext, "evil-fixture.example"), true);

  // Expired grants never apply.
  const store = ext.storage.session;
  await store.set({ flaggedBypass: { host: "evil-fixture.example", until: Date.now() - 1 } });
  assert.strictEqual(await flagged.takeBypass(ext, "evil-fixture.example"), false);
});

// ── list refresh ──────────────────────────────────────────────

function response({ status = 200, body = null, etag = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

test.beforeEach(() => {
  api.baseUrl = "https://cleanthis.io";
});

test("refreshList: 200 replaces the stored list and keeps the etag", async () => {
  const ext = fakeExt();
  global.fetch = async () =>
    response({ body: { version: 7, entries: [[hexOf("evil-fixture.example"), "phishing", "2026-07"]] }, etag: '"fh-7-1"' });
  await flagged.refreshList(ext);
  const { flaggedList } = await ext.storage.local.get("flaggedList");
  assert.strictEqual(flaggedList.version, 7);
  assert.strictEqual(flaggedList.etag, '"fh-7-1"');
  assert.strictEqual(flaggedList.entries.length, 1);
});

test("refreshList: 304 keeps entries and bumps fetchedAt", async () => {
  const old = { version: 7, etag: '"fh-7-1"', fetchedAt: 1, entries: [["a".repeat(16), "spam", null]] };
  const ext = fakeExt({ local: { flaggedList: old } });
  let sentINM = null;
  global.fetch = async (url, opts = {}) => {
    sentINM = (opts.headers || {})["If-None-Match"];
    return response({ status: 304 });
  };
  await flagged.refreshList(ext);
  const { flaggedList } = await ext.storage.local.get("flaggedList");
  assert.strictEqual(sentINM, '"fh-7-1"');
  assert.strictEqual(flaggedList.entries.length, 1);
  assert.ok(flaggedList.fetchedAt > 1);
});

test("refreshList: a failing fetch keeps the stored list untouched", async () => {
  const old = { version: 7, etag: '"fh-7-1"', fetchedAt: 1, entries: [["a".repeat(16), "spam", null]] };
  const ext = fakeExt({ local: { flaggedList: old } });
  global.fetch = async () => {
    throw new Error("offline");
  };
  await flagged.refreshList(ext);
  const { flaggedList } = await ext.storage.local.get("flaggedList");
  assert.deepStrictEqual(flaggedList, old);
});

test("listStale flags lists older than a day", () => {
  assert.strictEqual(flagged.listStale({ fetchedAt: Date.now() - 1000 }), false);
  assert.strictEqual(flagged.listStale({ fetchedAt: Date.now() - 25 * 3600 * 1000 }), true);
  assert.strictEqual(flagged.listStale(undefined), true);
});
