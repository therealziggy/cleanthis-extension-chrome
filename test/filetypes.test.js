// Unit tests for src/lib/filetypes.js — no network: global.fetch is stubbed.
//
// The semantics under test are the settings contract:
//   - interceptExts MISSING from storage  → follow the recommended set (live);
//   - interceptExts present (even [])     → the user's explicit, frozen choice;
// and the cache ladder: fresh cache → no fetch; fetch failure → cached, else baked.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/api.js");
require("../src/lib/intercept.js");
require("../src/lib/filetypes.js");

const api = self.CleanThisApi;
const intercept = self.CleanThisIntercept;
const FileTypes = self.CleanThisFileTypes;

function fakeExt(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
    _store: store,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fetchNever() {
  global.fetch = async (url) => {
    throw new Error(`unexpected fetch call: ${url}`);
  };
}

const SERVER_PAYLOAD = {
  version: 2,
  groups: [
    { id: "documents", label: "Documents", recommended: true, exts: ["pdf", "docx"] },
    { id: "cad", label: "CAD drawings", recommended: false, exts: ["dwg"] },
  ],
};

test.beforeEach(() => {
  api.baseUrl = "https://cleanthis.io";
});

// ── effectiveExts semantics ───────────────────────────────────

test("effectiveExts: missing key follows the payload's recommendations", () => {
  assert.deepStrictEqual(FileTypes.effectiveExts(undefined, SERVER_PAYLOAD), ["pdf", "docx"]);
});

test("effectiveExts: explicit empty array matches nothing", () => {
  assert.deepStrictEqual(FileTypes.effectiveExts([], SERVER_PAYLOAD), []);
});

test("effectiveExts: explicit list wins over the payload", () => {
  assert.deepStrictEqual(FileTypes.effectiveExts(["dwg"], SERVER_PAYLOAD), ["dwg"]);
});

test("effectiveExts: no payload falls back to the baked snapshot", () => {
  assert.deepStrictEqual(
    FileTypes.effectiveExts(undefined, null).slice().sort(),
    FileTypes.recommendedUnion(FileTypes.BAKED).slice().sort(),
  );
});

// ── the baked snapshot can't drift from the interceptor's defaults ──

test("baked recommended union === intercept DEFAULT_EXTS", () => {
  assert.deepStrictEqual(
    FileTypes.recommendedUnion(FileTypes.BAKED).slice().sort(),
    intercept.DEFAULT_EXTS.slice().sort(),
  );
});

// ── getConfig cache ladder ────────────────────────────────────

test("getConfig: fresh cache is served without touching the network", async () => {
  fetchNever();
  const ext = fakeExt({
    fileTypeConfig: { fetchedAt: Date.now() - 1000, payload: SERVER_PAYLOAD },
  });
  const { payload, fromCache } = await FileTypes.getConfig(ext);
  assert.strictEqual(fromCache, true);
  assert.strictEqual(payload.version, 2);
});

test("getConfig: stale cache refetches and stores the new payload", async () => {
  const newer = { ...SERVER_PAYLOAD, version: 3 };
  global.fetch = async () => jsonResponse(newer);
  const ext = fakeExt({
    fileTypeConfig: { fetchedAt: Date.now() - 2 * 3600 * 1000, payload: SERVER_PAYLOAD },
  });
  const { payload, fromCache } = await FileTypes.getConfig(ext);
  assert.strictEqual(fromCache, false);
  assert.strictEqual(payload.version, 3);
  assert.strictEqual(ext._store.get("fileTypeConfig").payload.version, 3);
});

test("getConfig: stale cache + failing fetch falls back to the cache", async () => {
  global.fetch = async () => {
    throw new Error("offline");
  };
  const ext = fakeExt({
    fileTypeConfig: { fetchedAt: Date.now() - 2 * 3600 * 1000, payload: SERVER_PAYLOAD },
  });
  const { payload, fromCache } = await FileTypes.getConfig(ext);
  assert.strictEqual(fromCache, true);
  assert.strictEqual(payload.version, 2);
});

test("getConfig: no cache + failing fetch falls back to BAKED", async () => {
  global.fetch = async () => {
    throw new Error("offline");
  };
  const { payload, fromCache } = await FileTypes.getConfig(fakeExt());
  assert.strictEqual(fromCache, true);
  assert.strictEqual(payload, FileTypes.BAKED);
});

test("getConfig: a malformed 200 body is treated as a failure", async () => {
  global.fetch = async () => jsonResponse({ nonsense: true });
  const { payload } = await FileTypes.getConfig(fakeExt());
  assert.strictEqual(payload, FileTypes.BAKED);
});
