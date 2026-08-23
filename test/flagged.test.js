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
  const indexes = flagged.buildIndexes({
    entries: [
      [hexOf("evil-fixture.example"), "phishing", "2026-07"],
      [hexOf("bad-apex.example"), "spam", "2026-06"],
    ],
  });

  const exact = await flagged.check("https://evil-fixture.example/login", indexes);
  assert.deepStrictEqual(exact, { level: "wall", host: "evil-fixture.example", cat: "phishing", seen: "2026-07" });

  const walked = await flagged.check("https://promo.bad-apex.example/offer", indexes);
  assert.deepStrictEqual(walked, { level: "wall", host: "bad-apex.example", cat: "spam", seen: "2026-06" });

  assert.strictEqual(await flagged.check("https://honest.example/", indexes), null);
  assert.strictEqual(await flagged.check("http://192.168.1.20/evil", indexes), null);
});

// ── hybrid tiers (2026-08-20) ─────────────────────────────────

const urlKeyOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

test("hashUrl parity with the server: host+path+query, scheme and port dropped", async () => {
  const expected = urlKeyOf("bakery.example/files/Setup.exe?v=2");
  assert.strictEqual(await flagged.hashUrl("HTTPS://Bakery.example/files/Setup.exe?v=2"), expected);
  assert.strictEqual(await flagged.hashUrl("http://bakery.example:8080/files/Setup.exe?v=2"), expected);
  assert.strictEqual(await flagged.hashUrl("not a url"), null);
});

test("a soft host gives a soft hit; its exact dangerous link is still a wall", async () => {
  const indexes = flagged.buildIndexes({
    entries: [],
    soft: [[hexOf("bakery.example"), "compromised", "2026-08"]],
    urls: [[urlKeyOf("bakery.example/files/Setup.exe?v=2"), "malware", "2026-08"]],
  });

  const homepage = await flagged.check("https://bakery.example/menu", indexes);
  assert.deepStrictEqual(homepage, { level: "soft", host: "bakery.example", cat: "compromised", seen: "2026-08" });

  const hackLink = await flagged.check("https://bakery.example/files/Setup.exe?v=2", indexes);
  assert.strictEqual(hackLink.level, "wall");
  assert.strictEqual(hackLink.cat, "malware");
});

test("softAlreadyShown fires once per host per session", async () => {
  const ext = fakeExt();
  assert.strictEqual(await flagged.softAlreadyShown(ext, "bakery.example"), false); // first: show it
  assert.strictEqual(await flagged.softAlreadyShown(ext, "bakery.example"), true); // second: stay quiet
  assert.strictEqual(await flagged.softAlreadyShown(ext, "other.example"), false); // other hosts unaffected
});

test("refreshList stores the v2 soft/urls fields and defaults them when absent", async () => {
  const ext = fakeExt();
  global.fetch = async () =>
    response({
      body: { version: 9, entries: [[hexOf("evil-fixture.example"), "phishing", null]], soft: [["a".repeat(16), "compromised", null]], urls: [["b".repeat(16), "malware", null]] },
      etag: '"fh-9-1"',
    });
  await flagged.refreshList(ext);
  let { flaggedList } = await ext.storage.local.get("flaggedList");
  assert.strictEqual(flaggedList.soft.length, 1);
  assert.strictEqual(flaggedList.urls.length, 1);

  global.fetch = async () => response({ body: { version: 10, entries: [] }, etag: '"fh-10-0"' });
  await flagged.refreshList(ext);
  ({ flaggedList } = await ext.storage.local.get("flaggedList"));
  assert.deepStrictEqual(flaggedList.soft, []);
  assert.deepStrictEqual(flaggedList.urls, []);
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
  // The 429 cooldown is module-global in api.js; a test that starts one must
  // never leak it into its neighbours.
  api._resetForTests();
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

test("refreshList: a failed attempt is not retried within the gap", async () => {
  const ext = fakeExt();
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    throw new Error("offline");
  };

  await flagged.refreshList(ext);
  assert.equal(fetches, 1);

  // The per-navigation staleness top-up must not retry an outage on every
  // page load.
  await flagged.refreshList(ext);
  assert.equal(fetches, 1, "no retry within the attempt gap");

  // POSITIVE CONTROL 1: the user-gesture path (toggle-on) retries at once.
  await flagged.refreshList(ext, { force: true });
  assert.equal(fetches, 2, "a forced refresh retries immediately");

  // POSITIVE CONTROL 2: once the gap has elapsed, unforced refreshes retry —
  // the gate discriminates, it doesn't switch refreshing off.
  await ext.storage.local.set({ flaggedListAttemptAt: Date.now() - 6 * 60 * 1000 });
  await flagged.refreshList(ext);
  assert.equal(fetches, 3, "the gap elapsing re-opens the gate");
});

test("refreshList: a success does not gate the next refresh", async () => {
  const ext = fakeExt();
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return response({ body: { version: fetches, entries: [] } });
  };

  await flagged.refreshList(ext);
  await flagged.refreshList(ext);
  assert.equal(fetches, 2, "the gate is failure backoff, not a rate limit on success");
});

test("refreshList: a 429 starts the shared cooldown and later refreshes stay local", async () => {
  const ext = fakeExt();
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return response({ status: 429 });
  };

  await flagged.refreshList(ext);
  assert.equal(fetches, 1);
  assert.ok(api._cooldownRemaining() > 0, "a 429 on the list endpoint must start the shared cooldown");

  // Even a forced refresh respects the cooldown — politeness outranks the
  // toggle (ten 429s in five minutes gets an IP firewall-banned).
  await ext.storage.local.set({ flaggedListAttemptAt: 1 });
  await flagged.refreshList(ext, { force: true });
  assert.equal(fetches, 1, "no call during the shared cooldown");
});

test("listStale flags lists older than a day", () => {
  assert.strictEqual(flagged.listStale({ fetchedAt: Date.now() - 1000 }), false);
  assert.strictEqual(flagged.listStale({ fetchedAt: Date.now() - 25 * 3600 * 1000 }), true);
  assert.strictEqual(flagged.listStale(undefined), true);
});
