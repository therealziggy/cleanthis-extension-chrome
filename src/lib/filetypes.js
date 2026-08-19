// CleanThis — the file-type catalogue behind the settings checkboxes.
//
// The options page renders "file types to clean automatically" from the
// server's catalogue (GET /api/extension/file-types), so newly supported
// types appear without an extension update. A baked snapshot keeps the page
// working offline and on first run.
//
// Settings contract (shared with options.js and background.js):
//   - `interceptExts` MISSING from storage → follow the recommended set, live;
//   - `interceptExts` present (even [])    → the user's explicit, frozen choice.
//
// Plain script: exposes self.CleanThisFileTypes for the worker (importScripts),
// Firefox's event page, and extension pages alike.

"use strict";

(() => {
  // Snapshot of the catalogue at build time. The recommended union MUST stay
  // identical to lib/intercept.js DEFAULT_EXTS — a unit test pins this.
  const BAKED = {
    version: 1,
    groups: [
      { id: "documents", label: "Documents", recommended: true, exts: ["pdf", "doc", "docx", "rtf", "odt"] },
      { id: "spreadsheets", label: "Spreadsheets", recommended: true, exts: ["xls", "xlsx", "ods"] },
      { id: "presentations", label: "Presentations", recommended: true, exts: ["ppt", "pptx", "odp"] },
      { id: "archives", label: "Archives", recommended: true, exts: ["zip", "7z", "rar"] },
      { id: "ebooks", label: "Ebooks", recommended: true, exts: ["epub"] },
      { id: "images", label: "Images", recommended: false, exts: ["jpg", "jpeg", "png", "gif", "webp", "tiff", "bmp", "svg"] },
      { id: "email", label: "Email files", recommended: false, exts: ["eml", "msg"] },
      { id: "cad", label: "CAD drawings", recommended: false, exts: ["dwg"] },
    ],
  };

  const CACHE_KEY = "fileTypeConfig";
  const MAX_AGE_MS = 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 10 * 1000;

  function looksLikePayload(p) {
    return !!(p && Array.isArray(p.groups) && p.groups.length);
  }

  function recommendedUnion(payload) {
    const p = looksLikePayload(payload) ? payload : BAKED;
    const out = new Set();
    for (const g of p.groups) {
      if (!g.recommended || !Array.isArray(g.exts)) continue;
      for (const e of g.exts) out.add(String(e).toLowerCase());
    }
    return [...out];
  }

  function effectiveExts(stored, payload) {
    return Array.isArray(stored) ? stored : recommendedUnion(payload);
  }

  // Never throws. Returns {payload, fromCache} where fromCache means "not
  // freshly fetched" (cache hit, fetch failure fallback, or baked snapshot).
  async function getConfig(ext) {
    let cached = null;
    try {
      ({ [CACHE_KEY]: cached = null } = await ext.storage.local.get(CACHE_KEY));
    } catch (_) {
      /* storage trouble reads as "no cache" */
    }

    const fresh = cached && looksLikePayload(cached.payload) && Date.now() - cached.fetchedAt < MAX_AGE_MS;
    if (fresh) return { payload: cached.payload, fromCache: true };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(self.CleanThisApi.resolveUrl("/api/extension/file-types"), {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!looksLikePayload(payload)) throw new Error("malformed catalogue");
      try {
        await ext.storage.local.set({ [CACHE_KEY]: { fetchedAt: Date.now(), payload } });
      } catch (_) {
        /* an unstored payload is still a good payload */
      }
      return { payload, fromCache: false };
    } catch (_) {
      if (cached && looksLikePayload(cached.payload)) return { payload: cached.payload, fromCache: true };
      return { payload: BAKED, fromCache: true };
    }
  }

  self.CleanThisFileTypes = { BAKED, CACHE_KEY, recommendedUnion, effectiveExts, getConfig };
})();
