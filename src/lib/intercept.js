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

    const bypass = bypassSet || new Set();
    if (bypass.has(url) || (item.finalUrl && bypass.has(item.finalUrl))) {
      return { intercept: false, reason: "bypassed" };
    }

    const exts = settings.interceptExts && settings.interceptExts.length ? settings.interceptExts : DEFAULT_EXTS;
    // The browser's filename is the better signal — it survives redirects and
    // download.php-style URLs that carry no suffix of their own.
    const ext = extOf(item.filename) || extOf(item.finalUrl || url);
    if (!ext || !exts.includes(ext)) return { intercept: false, reason: "ext-not-matched" };

    return { intercept: true, reason: "matched", ext };
  }

  self.CleanThisIntercept = { decide, extOf, DEFAULT_EXTS };
})();
