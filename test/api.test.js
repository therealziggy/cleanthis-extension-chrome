// Unit tests for src/lib/api.js — no network: global.fetch is stubbed.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/api.js");
const api = self.CleanThisApi;

// ── fetch stub ────────────────────────────────────────────────
let calls;
let queue;

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function stubFetch(responses) {
  calls = [];
  queue = [...responses];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
}

// Endless supply of one response — for loops that must end on a deadline
// rather than on running out of canned replies.
function stubFetchAlways(makeResponse) {
  calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return makeResponse();
  };
}

const tokenOk = () => jsonResponse({ token: "tok-123", ttl: 300 });

test.beforeEach(() => {
  api._resetForTests();
  api.baseUrl = "https://cleanthis.io";
});

// ── form token + headers ──────────────────────────────────────

test("scanUrl fetches a form token and sends it with an empty honeypot header", async () => {
  stubFetch([tokenOk(), jsonResponse({ ok: true, verdict: "clean", findings: [], scores: {} })]);

  const result = await api.scanUrl("https://example.com", "standard");

  assert.equal(result.verdict, "clean");
  assert.match(calls[0].url, /\/api\/form-token\?purpose=scan-webpage$/);
  const headers = calls[1].options.headers;
  assert.equal(headers["X-Form-Token"], "tok-123");
  assert.equal(headers["X-Form-Hp"], "");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: "https://example.com", tier: "standard" });
});

// ── 429 cooldown ──────────────────────────────────────────────

test("a 429 starts a cooldown and the next call fails without touching the network", async () => {
  stubFetch([tokenOk(), jsonResponse({ error: "slow down" }, { status: 429, headers: { "retry-after": "30" } })]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "rate_limited");
    return true;
  });

  const callsAfterFirst = calls.length;
  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "cooldown");
    assert.ok(err.retryAfterMs > 0);
    return true;
  });
  assert.equal(calls.length, callsAfterFirst, "no network call may be made during cooldown");
  assert.ok(api._cooldownRemaining() > 25000);
});

test("a 429 carrying the daily-quota code reports quota, not rate limiting", async () => {
  stubFetch([
    tokenOk(),
    jsonResponse({ code: "daily_quota_exceeded", limit: 25, used: 25, resetEpoch: 1 }, { status: 429 }),
  ]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "quota");
    return true;
  });
});

// ── quota headers ─────────────────────────────────────────────

test("quota headers are recorded per bucket", async () => {
  stubFetch([
    tokenOk(),
    jsonResponse(
      { ok: true, verdict: "clean" },
      { headers: { "x-daily-limit": "25", "x-daily-remaining": "22", "x-daily-reset": "1786600000" } }
    ),
  ]);

  await api.scanUrl("https://example.com", "light");

  assert.deepEqual(api.getLastQuota("scan"), { limit: 25, remaining: 22, resetEpoch: 1786600000 });
  assert.equal(api.getLastQuota("upload"), null);
});

// ── error surfacing ───────────────────────────────────────────

test("a non-OK response surfaces the server's error message", async () => {
  stubFetch([tokenOk(), jsonResponse({ error: "URL is too long (max 2048 characters)." }, { status: 400 })]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "http");
    assert.equal(err.status, 400);
    assert.match(err.message, /too long/);
    return true;
  });
});

test("a network failure is reported as a network error", async () => {
  stubFetch([new TypeError("Failed to fetch")]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "network");
    return true;
  });
});

// ── file + url sanitize ───────────────────────────────────────

test("sanitizeFile posts multipart fields file and level", async () => {
  stubFetch([tokenOk(), jsonResponse({ jobId: "j1", cancelToken: "c1", downloadToken: "d1" })]);
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });

  const job = await api.sanitizeFile(file, "aggressive");

  assert.equal(job.jobId, "j1");
  assert.match(calls[0].url, /purpose=upload$/);
  const body = calls[1].options.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("level"), "aggressive");
  assert.equal(body.get("file").name, "notes.txt");
  assert.equal(body.get("file").size, 5);
  assert.equal(calls[1].options.headers["Content-Type"], undefined, "the browser must set the multipart boundary");
});

test("sanitizeUrl includes the acknowledgement only when asked", async () => {
  stubFetch([tokenOk(), jsonResponse({ jobId: "j2", downloadToken: "d2" })]);
  await api.sanitizeUrl("https://example.com/a.pdf", "standard");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: "https://example.com/a.pdf", level: "standard" });

  stubFetch([tokenOk(), jsonResponse({ jobId: "j3", downloadToken: "d3" })]);
  await api.sanitizeUrl("https://example.com/a.pdf", "standard", { acknowledgeSourceWarning: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    url: "https://example.com/a.pdf",
    level: "standard",
    acknowledgeSourceWarning: true,
  });
});

test("sanitizeUrl surfaces a blocked source instead of a job", async () => {
  stubFetch([tokenOk(), jsonResponse({ sourceWarning: "This site is flagged as malicious." })]);

  const result = await api.sanitizeUrl("https://bad.example/a.pdf", "standard");

  assert.equal(result.jobId, undefined);
  assert.match(result.sourceWarning, /flagged/);
});

// ── download links ────────────────────────────────────────────

test("resolveUrl accepts both the absolute links the server sends and relative paths", () => {
  // Regression: prefixing an already-absolute URL produced
  // "https://cleanthis.iohttps://cleanthis.io/..." and every download failed.
  assert.equal(
    api.resolveUrl("https://cleanthis.io/api/download/j1?sig=x"),
    "https://cleanthis.io/api/download/j1?sig=x"
  );
  assert.equal(api.resolveUrl("/api/download/j1?sig=x"), "https://cleanthis.io/api/download/j1?sig=x");

  api.baseUrl = "http://localhost:3000";
  assert.equal(
    api.resolveUrl("http://localhost:3000/api/download/j1"),
    "http://localhost:3000/api/download/j1"
  );
  assert.equal(api.resolveUrl("/api/download/j1"), "http://localhost:3000/api/download/j1");

  assert.equal(api.resolveUrl(null), null);
  assert.equal(api.resolveUrl(""), null);
});

// ── job polling ───────────────────────────────────────────────

test("waitForJob polls until the job reaches a terminal state", async () => {
  stubFetch([
    jsonResponse({ state: "processing" }),
    jsonResponse({ state: "processing" }),
    jsonResponse({ state: "completed", downloadUrl: "/api/download/j1?sig=x", downloadName: "clean.pdf" }),
  ]);
  const ticks = [];

  const job = await api.waitForJob("j1", "d1", { intervalMs: 1, onTick: (s) => ticks.push(s.state) });

  assert.equal(job.state, "completed");
  assert.equal(job.downloadName, "clean.pdf");
  assert.deepEqual(ticks, ["processing", "processing", "completed"]);
  assert.match(calls[0].url, /\/api\/job\/j1\?token=d1$/);
});

test("waitForJob returns a failed job rather than throwing", async () => {
  stubFetch([jsonResponse({ state: "failed", error: "Processing failed. Please try again." })]);

  const job = await api.waitForJob("j9", "d9", { intervalMs: 1 });

  assert.equal(job.state, "failed");
  assert.match(job.error, /Processing failed/);
});

test("waitForJob gives up after its timeout", async () => {
  stubFetchAlways(() => jsonResponse({ state: "processing" }));

  await assert.rejects(() => api.waitForJob("j1", "d1", { intervalMs: 1, timeoutMs: 20 }), (err) => {
    assert.equal(err.code, "timeout");
    return true;
  });
  assert.ok(calls.length > 0, "it should have polled at least once");
});
