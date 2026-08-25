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
  // One hour, matching the server's own memo window for the list — refreshing
  // faster only re-downloads the same memoized payload, and ETag/304 makes the
  // hourly check nearly free. End-to-end staleness worst case ≈ two hours.
  const LIST_MAX_AGE_MS = 60 * 60 * 1000;
  const BYPASS_TTL_MS = 30 * 1000;
  const FETCH_TIMEOUT_MS = 15 * 1000;
  // A recent FAILED attempt gates unforced refreshes: staleness is re-checked
  // on every navigation, and an endpoint outage must not turn that into a
  // retry per page load.
  const ATTEMPT_KEY = "flaggedListAttemptAt";
  const ATTEMPT_MIN_GAP_MS = 5 * 60 * 1000;

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

  async function sha16(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // First 16 hex chars of SHA-256, identical to the server's builder.
  function hashHost(host) {
    return sha16(String(host).toLowerCase().replace(/\.$/, ""));
  }

  // Exact-URL key: lowercased host + path + query — scheme, port and fragment
  // dropped, byte-identical to the server's hashUrl (parity pinned by tests).
  function hashUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return Promise.resolve(null);
    }
    const key = parsed.hostname.toLowerCase().replace(/\.$/, "") + parsed.pathname + parsed.search;
    return sha16(key);
  }

  function buildIndex(entries) {
    const index = new Map();
    for (const entry of entries || []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      index.set(entry[0], { cat: entry[1] || "other", seen: entry[2] || null });
    }
    return index;
  }

  // Three tiers from one stored list (older lists simply lack soft/urls).
  function buildIndexes(list) {
    return {
      wall: buildIndex(list && list.entries),
      soft: buildIndex(list && list.soft),
      urls: buildIndex(list && list.urls),
    };
  }

  // Most-specific match wins. The exact-link tier is checked first, so a
  // dangerous link is a WALL even when its host is only soft-tier (the
  // hacked-bakery hybrid). Then the host labels are walked from the fullest
  // name outwards and the FIRST listed candidate answers, whichever tier it
  // sits in — so specificity governs the walk, not severity, and a soft entry
  // on a subdomain answers before a wall entry on its parent domain. If that
  // ever needs to flip, walk every candidate against `wall` before touching
  // `soft`. Returns {level, host, cat, seen} or null.
  async function check(url, indexes) {
    if (!indexes) return null;
    const host = canonicalHost(url);
    if (!host) return null;

    if (indexes.urls && indexes.urls.size) {
      const hit = indexes.urls.get(await hashUrl(url));
      if (hit) return { level: "wall", host, cat: hit.cat, seen: hit.seen };
    }
    for (const candidate of candidateHosts(host)) {
      const hash = await hashHost(candidate);
      const wallHit = indexes.wall && indexes.wall.get(hash);
      if (wallHit) return { level: "wall", host: candidate, cat: wallHit.cat, seen: wallHit.seen };
      const softHit = indexes.soft && indexes.soft.get(hash);
      if (softHit) return { level: "soft", host: candidate, cat: softHit.cat, seen: softHit.seen };
    }
    return null;
  }

  // Soft warnings nudge once per host per browser session — a heads-up, not a
  // nag on every page of the site. Consume-on-first-read.
  async function softAlreadyShown(ext, host) {
    const store = bypassStore(ext);
    let shown = [];
    try {
      ({ softNotifiedHosts: shown = [] } = await store.get("softNotifiedHosts"));
    } catch (_) {
      return false;
    }
    if (shown.includes(host)) return true;
    try {
      await store.set({ softNotifiedHosts: [...shown, host].slice(-200) });
    } catch (_) {
      /* worst case the user gets the heads-up twice */
    }
    return false;
  }

  // ── proceed-anyway bypass: one shot, short-lived ────────────

  async function grantBypass(ext, host) {
    await bypassStore(ext).set({ [BYPASS_KEY]: { host, until: Date.now() + BYPASS_TTL_MS } });
  }

  // Peek: does a matching, unexpired grant exist? Never deletes. The
  // pre-navigation check uses this so the commit-time check (which consumes)
  // stays the single point where a grant is spent — one navigation crosses
  // both checkpoints, and a proceed must survive to the commit.
  async function peekBypass(ext, host) {
    let grant = null;
    try {
      ({ [BYPASS_KEY]: grant = null } = await bypassStore(ext).get(BYPASS_KEY));
    } catch (_) {
      return false;
    }
    return !!grant && grant.host === host && grant.until >= Date.now();
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
  // failure leaves the stored list exactly as it was — but is remembered, so
  // an outage backs off instead of retrying on every navigation. `force` is
  // the user-gesture path (the toggle): it skips the failure gate, never the
  // shared 429 cooldown — politeness outranks the toggle, because repeated
  // 429s get an IP firewall-banned server-side.
  async function refreshList(ext, { force = false } = {}) {
    if (self.CleanThisApi._cooldownRemaining() > 0) return;

    let stored = null;
    let attemptAt = null;
    try {
      ({ [LIST_KEY]: stored = null, [ATTEMPT_KEY]: attemptAt = null } = await ext.storage.local.get([
        LIST_KEY,
        ATTEMPT_KEY,
      ]));
    } catch (_) {
      /* treated as no list */
    }

    if (!force && Number.isFinite(attemptAt) && Date.now() - attemptAt < ATTEMPT_MIN_GAP_MS) return;

    // Only failures are stamped: a success is followed by 24h of freshness
    // anyway, and gating successes would change the refresh semantics.
    const noteFailure = async () => {
      try {
        await ext.storage.local.set({ [ATTEMPT_KEY]: Date.now() });
      } catch (_) {
        /* the gate is best-effort; the worst case is the old retry behaviour */
      }
    };

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

      if (response.status === 429) {
        // Not our polite request() wrapper, so feed the shared cooldown by
        // hand — every endpoint pauses together.
        const retryAfter = Number(response.headers.get("Retry-After"));
        self.CleanThisApi._noteRateLimit(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
        );
        await noteFailure();
        return;
      }
      if (response.status === 304 && stored) {
        await ext.storage.local.set({ [LIST_KEY]: { ...stored, fetchedAt: Date.now() } });
        return;
      }
      if (!response.ok) {
        await noteFailure();
        return;
      }

      const body = await response.json();
      if (!body || !Array.isArray(body.entries)) {
        await noteFailure();
        return;
      }
      await ext.storage.local.set({
        [LIST_KEY]: {
          version: body.version,
          etag: response.headers.get("etag") || null,
          fetchedAt: Date.now(),
          entries: body.entries,
          soft: Array.isArray(body.soft) ? body.soft : [],
          urls: Array.isArray(body.urls) ? body.urls : [],
        },
      });
    } catch (_) {
      // Offline or mid-flight failure: the stored list stays authoritative.
      await noteFailure();
    }
  }

  self.CleanThisFlagged = {
    LIST_KEY,
    canonicalHost,
    candidateHosts,
    hashHost,
    hashUrl,
    buildIndex,
    buildIndexes,
    check,
    grantBypass,
    peekBypass,
    takeBypass,
    softAlreadyShown,
    listStale,
    refreshList,
  };
})();
