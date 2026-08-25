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

test("_noteRateLimit pauses request() without any network call", async () => {
  stubFetch([]); // any fetch would throw "unexpected fetch call"

  api._noteRateLimit(30000);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"), (err) => {
    assert.equal(err.code, "cooldown");
    assert.ok(err.retryAfterMs > 0);
    return true;
  });
  assert.equal(calls.length, 0, "an externally noted 429 must stop calls before the network");
});

test("_noteRateLimit defaults to a real pause and caps at the maximum", () => {
  api._noteRateLimit();
  assert.ok(api._cooldownRemaining() > 30000, "no argument still pauses for a meaningful time");

  api._resetForTests();
  api._noteRateLimit(999 * 24 * 3600 * 1000);
  assert.ok(api._cooldownRemaining() <= 24 * 3600 * 1000, "the cap must hold");
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

test("a spent daily allowance pauses until it resets, not for a minute", async () => {
  // Regression: a 60-second pause meant walking back into the rate limiter
  // every minute for the rest of the day, which is what gets an IP banned.
  const resetEpoch = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
  stubFetch([
    tokenOk(),
    jsonResponse({ code: "daily_quota_exceeded", limit: 25, used: 25, resetEpoch }, { status: 429 }),
  ]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"));

  const remaining = api._cooldownRemaining();
  assert.ok(remaining > 3 * 60 * 60 * 1000, `expected a pause of hours, got ${remaining}ms`);
});

test("a quota 429 without a reset time still pauses for much longer than a minute", async () => {
  stubFetch([tokenOk(), jsonResponse({ code: "daily_quota_exceeded", limit: 25 }, { status: 429 })]);

  await assert.rejects(() => api.scanUrl("https://example.com", "light"));

  assert.ok(api._cooldownRemaining() > 10 * 60 * 1000);
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

// ── cancellation ──────────────────────────────────────────────

test("scanUrl aborts cleanly with code 'aborted' and starts no cooldown", async () => {
  calls = [];
  const controller = new AbortController();
  global.fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ url, options });
      if (/form-token/.test(String(url))) {
        resolve(jsonResponse({ token: "tok-123", ttl: 300 }));
        return;
      }
      // The scan POST hangs until the caller aborts it.
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      });
    });

  const scan = api.scanUrl("https://example.com", "standard", { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(scan, (err) => {
    assert.equal(err.code, "aborted");
    return true;
  });
  assert.equal(api._cooldownRemaining(), 0, "an abort must not start a cooldown");
});

test("scanUrl sends bypassCache only when asked", async () => {
  stubFetch([tokenOk(), jsonResponse({ ok: true, verdict: "clean", scores: {} })]);
  await api.scanUrl("https://example.com", "standard", { bypassCache: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    url: "https://example.com",
    tier: "standard",
    bypassCache: true,
  });

  stubFetch([tokenOk(), jsonResponse({ ok: true, verdict: "clean", scores: {} })]);
  await api.scanUrl("https://example.com", "standard");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: "https://example.com", tier: "standard" });
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

// ── report a mistake ──────────────────────────────────────────

test("reportScan posts the report with a report-scan form token", async () => {
  stubFetch([jsonResponse({ token: "tok-r", ttl: 300 }), jsonResponse({ ok: true })]);

  const out = await api.reportScan({
    url: "https://walled.example/x?q=1",
    reportType: "too_harsh",
    note: "  this is our own site  ",
  });

  assert.equal(out.ok, true);
  assert.match(calls[0].url, /\/api\/form-token\?purpose=report-scan$/);
  assert.match(calls[1].url, /\/api\/report-scan$/);
  const headers = calls[1].options.headers;
  assert.equal(headers["X-Form-Token"], "tok-r");
  assert.equal(headers["X-Form-Hp"], "");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    url: "https://walled.example/x?q=1",
    tier: "extension",
    verdict: "walled",
    reportType: "too_harsh",
    note: "this is our own site",
  });

  // An empty note is omitted entirely, not sent as "".
  stubFetch([jsonResponse({ token: "tok-r2", ttl: 300 }), jsonResponse({ ok: true })]);
  await api.reportScan({ url: "https://walled.example/", reportType: "too_harsh", note: "   " });
  assert.equal(JSON.parse(calls[1].options.body).note, undefined);
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

test("resolveUrl refuses anything that resolves off our own origin", () => {
  // What comes back from here is handed straight to downloads.download() and
  // tabs.create(). Only the base's own origin is a link we are willing to act
  // on, so a response that points somewhere else is refused rather than
  // fetched — the callers all read null as "no usable link".
  const previous = api.baseUrl;
  api.baseUrl = "https://cleanthis.io";
  try {
    assert.equal(api.resolveUrl("https://evil.example/payload"), null);
    assert.equal(api.resolveUrl("//evil.example/payload"), null, "protocol-relative link escaped the origin");
    assert.equal(api.resolveUrl("http://cleanthis.io/api/download/j1"), null, "scheme downgrade allowed");
    assert.equal(api.resolveUrl("https://cleanthis.io.evil.example/x"), null, "suffix look-alike allowed");
    assert.equal(api.resolveUrl("javascript:alert(1)"), null);
    assert.equal(api.resolveUrl("data:text/html,<script>alert(1)</script>"), null);
    assert.equal(api.resolveUrl("file:///etc/passwd"), null);

    // Positive control: the shapes the server actually uses still resolve, so
    // a null above means "refused", never "resolveUrl stopped working".
    assert.equal(
      api.resolveUrl("https://cleanthis.io/api/download/j1?sig=x"),
      "https://cleanthis.io/api/download/j1?sig=x"
    );
    assert.equal(api.resolveUrl("/api/download/j1"), "https://cleanthis.io/api/download/j1");

    // The dev build's base is plain http on localhost — the rule is
    // same-origin, not https-only, or every harness download would break.
    api.baseUrl = "http://localhost:3000";
    assert.equal(
      api.resolveUrl("http://localhost:3000/api/download/j1"),
      "http://localhost:3000/api/download/j1"
    );
    assert.equal(api.resolveUrl("/api/download/j1"), "http://localhost:3000/api/download/j1");
    assert.equal(api.resolveUrl("http://localhost:3001/api/download/j1"), null, "a different port is a different origin");
  } finally {
    api.baseUrl = previous;
  }
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
