// CleanThis — flagged-site matching, entirely on-device.
//
// The extension downloads cleanthis.io's flagged-site list as irreversible
// truncated fingerprints and checks visited hosts against it locally. The
// address of a page you visit is NEVER sent anywhere — matching a hash of the
// host against an already-downloaded list needs no network at all, which is
// the whole point of shipping the list rather than looking hosts up remotely.
//
// Matching walks subdomain labels (a.b.example.com → b.example.com →
// example.com) so a domain-level entry covers every subdomain.
//
// Plain script: exposes self.CleanThisFlagged for the worker (importScripts),
// Firefox's event page, and extension pages alike.

"use strict";

(() => {
  const LIST_KEY = "flaggedList";
  const BYPASS_KEY = "flaggedBypass";
  const LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const BYPASS_TTL_MS = 30 * 1000;
  const FETCH_TIMEOUT_MS = 15 * 1000;

  const OWN_HOST = "cleanthis.io";

  function bypassStore(ext) {
    return ext.storage.session || ext.storage.local;
  }

  // The host of a page worth checking: public, http(s), a real dotted
  // hostname. Everything else returns null — local/intranet addresses, IP
  // literals, our own site, extension pages, single-label names.
  function canonicalHost(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || !host.includes(".")) return null;
    if (host === OWN_HOST || host.endsWith(`.${OWN_HOST}`)) return null;
    if (host.includes(":") || host.startsWith("[")) return null; // IPv6 literal
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4 literal
    if (self.CleanThisIntercept.isLocalAddress(host)) return null;
    return host;
  }

  // ["a.b.example.com", "b.example.com", "example.com"] — never below 2 labels.
  function candidateHosts(host) {
    const labels = host.split(".");
    const out = [];
    for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
    return out;
  }

  // First 16 hex chars of SHA-256, identical to the server's builder.
  async function hashHost(host) {
    const canonical = String(host).toLowerCase().replace(/\.$/, "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function buildIndex(entries) {
    const index = new Map();
    for (const entry of entries || []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      index.set(entry[0], { cat: entry[1] || "other", seen: entry[2] || null });
    }
    return index;
  }

  // {host, cat, seen} for the first (most specific) matching candidate, else null.
  async function check(url, index) {
    if (!index || index.size === 0) return null;
    const host = canonicalHost(url);
    if (!host) return null;
    for (const candidate of candidateHosts(host)) {
      const hit = index.get(await hashHost(candidate));
      if (hit) return { host: candidate, cat: hit.cat, seen: hit.seen };
    }
    return null;
  }

  // ── proceed-anyway bypass: one shot, short-lived ────────────

  async function grantBypass(ext, host) {
    await bypassStore(ext).set({ [BYPASS_KEY]: { host, until: Date.now() + BYPASS_TTL_MS } });
  }

  // Consume-on-read: a matching, unexpired grant is deleted and honoured once.
  async function takeBypass(ext, host) {
    const store = bypassStore(ext);
    let grant = null;
    try {
      ({ [BYPASS_KEY]: grant = null } = await store.get(BYPASS_KEY));
    } catch (_) {
      return false;
    }
    if (!grant) return false;
    if (grant.until < Date.now()) {
      try {
        await store.remove(BYPASS_KEY);
      } catch (_) {
        /* stale grant expires on its own */
      }
      return false;
    }
    if (grant.host !== host) return false;
    try {
      await store.remove(BYPASS_KEY);
    } catch (_) {
      /* worst case the grant survives its 30s window */
    }
    return true;
  }

  // ── list refresh ────────────────────────────────────────────

  function listStale(stored) {
    return !stored || !Number.isFinite(stored.fetchedAt) || Date.now() - stored.fetchedAt > LIST_MAX_AGE_MS;
  }

  // Never throws. 200 replaces the list, 304 just refreshes its age, and any
  // failure leaves the stored list exactly as it was.
  async function refreshList(ext) {
    let stored = null;
    try {
      ({ [LIST_KEY]: stored = null } = await ext.storage.local.get(LIST_KEY));
    } catch (_) {
      /* treated as no list */
    }

    try {
      const headers = {};
      if (stored && stored.etag) headers["If-None-Match"] = stored.etag;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(self.CleanThisApi.resolveUrl("/api/extension/flagged-hosts"), {
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 304 && stored) {
        await ext.storage.local.set({ [LIST_KEY]: { ...stored, fetchedAt: Date.now() } });
        return;
      }
      if (!response.ok) return;

      const body = await response.json();
      if (!body || !Array.isArray(body.entries)) return;
      await ext.storage.local.set({
        [LIST_KEY]: {
          version: body.version,
          etag: response.headers.get("etag") || null,
          fetchedAt: Date.now(),
          entries: body.entries,
        },
      });
    } catch (_) {
      /* offline or mid-flight failure: the stored list stays authoritative */
    }
  }

  self.CleanThisFlagged = {
    LIST_KEY,
    canonicalHost,
    candidateHosts,
    hashHost,
    buildIndex,
    check,
    grantBypass,
    takeBypass,
    listStale,
    refreshList,
  };
})();
