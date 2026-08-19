// CleanThis — should this download be intercepted?
//
// Pure decision logic, deliberately free of browser APIs so it can be tested
// directly and reasoned about on its own. The background script owns the side
// effects (cancelling, cleaning, notifying); this file only answers yes/no and
// says why.
//
// Two rules matter more than the rest:
//   • never loop — a cleaned file arrives as a download from our own server,
//     and re-intercepting it would spin forever;
//   • never fight the user — anything they chose to download untouched is on
//     the bypass list and must pass through.
//
// Plain script (no module system): defines self.CleanThisIntercept.

"use strict";

(() => {
  // Document and archive types the sanitizer handles, i.e. the ones where
  // interception buys something. Users can edit this list in the options page.
  const DEFAULT_EXTS = [
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "rtf",
    "odt",
    "ods",
    "odp",
    "zip",
    "7z",
    "rar",
    "epub",
  ];

  function extOf(nameOrPath) {
    if (!nameOrPath || typeof nameOrPath !== "string") return null;
    // Drop any query string or fragment before looking for a suffix.
    const clean = nameOrPath.split(/[?#]/)[0];
    const base = clean.slice(clean.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return null;
    return base.slice(dot + 1).toLowerCase();
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  // Addresses that only exist on this machine or this network: a router page,
  // a NAS, a local dev server. The service fetches downloads from its own
  // location, so it could never reach these — stepping in would interrupt the
  // download for nothing and send an internal address off the machine.
  function isLocalAddress(host) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "[::1]") return true;
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 127 || a === 10 || a === 0) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true;
    }
    // Bare hostnames with no dot are intranet names (\\server\share, http://nas).
    if (!host.includes(".") && !host.includes(":")) return true;
    return false;
  }

  // A link carrying a password, or a one-time signed link, is the user's own
  // secret. Handing it to a service that would re-fetch it is not our call.
  function carriesCredentials(url) {
    try {
      const parsed = new URL(url);
      return !!(parsed.username || parsed.password);
    } catch (_) {
      return false;
    }
  }

  // Ours = the exact host or any subdomain of it. Ports are ignored: a cleaned
  // file can be served from a different port during local development, and
  // treating that as someone else's download would cause an interception loop.
  function isOwnHost(host, baseHost) {
    if (!host || !baseHost) return false;
    return host === baseHost || host.endsWith(`.${baseHost}`);
  }

  function decide(item, settings, bypassSet, baseUrl) {
    if (!settings || !settings.interceptEnabled) return { intercept: false, reason: "disabled" };

    const url = item && item.url;
    if (!url || !/^https?:\/\//i.test(url)) return { intercept: false, reason: "non-http" };

    const host = hostOf(url);
    if (!host) return { intercept: false, reason: "bad-url" };

    if (isOwnHost(host, hostOf(baseUrl))) return { intercept: false, reason: "own-host" };

    if (isLocalAddress(host)) return { intercept: false, reason: "local-address" };

    if (carriesCredentials(url)) return { intercept: false, reason: "credentials" };

    const bypass = bypassSet || new Set();
    if (bypass.has(url) || (item.finalUrl && bypass.has(item.finalUrl))) {
      return { intercept: false, reason: "bypassed" };
    }

    // An ARRAY is always the caller's explicit choice — empty means "match
    // nothing" (the checkbox UI can express that). Only a missing/invalid
    // value falls back to the defaults.
    const exts = Array.isArray(settings.interceptExts) ? settings.interceptExts : DEFAULT_EXTS;
    // The browser's filename is the better signal — it survives redirects and
    // download.php-style URLs that carry no suffix of their own.
    const ext = extOf(item.filename) || extOf(item.finalUrl || url);
    if (!ext || !exts.includes(ext)) return { intercept: false, reason: "ext-not-matched" };

    return { intercept: true, reason: "matched", ext };
  }

  self.CleanThisIntercept = { decide, extOf, DEFAULT_EXTS };
})();
