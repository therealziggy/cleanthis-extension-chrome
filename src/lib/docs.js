// CleanThis — which URLs get a document-cleaning offer.
//
// Two deliberately different sets:
//   • cleanableExtFor — the popup's "Clean this file" button: anything the
//     server's catalogue accepts, on a public http(s) host that isn't ours.
//   • isBlanketDocUrl — the opt-in "ask before opening document links"
//     interstitial: only the document/archive set (DEFAULT_EXTS). An
//     interstitial on every jpg would teach people to click through walls.
//
// Pure decisions, no browser APIs. Depends on CleanThisIntercept for extOf +
// the local-address rule (the server could never fetch a private address, so
// offering to clean one would be a lie).

"use strict";

(() => {
  const intercept = self.CleanThisIntercept;

  function parsedPublicHttp(url) {
    if (!url || typeof url !== "string") return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (intercept.isLocalAddress(parsed.hostname.toLowerCase())) return null;
    return parsed;
  }

  function cleanableExtFor(url, cataloguePayload, ownBaseUrl) {
    const parsed = parsedPublicHttp(url);
    if (!parsed) return null;
    try {
      if (ownBaseUrl && parsed.hostname === new URL(ownBaseUrl).hostname) return null;
    } catch (_) {
      /* an unparseable base never matches */
    }
    const ext = intercept.extOf(parsed.pathname);
    if (!ext) return null;
    const groups = (cataloguePayload && cataloguePayload.groups) || [];
    for (const group of groups) {
      if (Array.isArray(group.exts) && group.exts.includes(ext)) return ext;
    }
    return null;
  }

  function isBlanketDocUrl(url) {
    const parsed = parsedPublicHttp(url);
    if (!parsed) return false;
    const ext = intercept.extOf(parsed.pathname);
    return !!ext && intercept.DEFAULT_EXTS.includes(ext);
  }

  self.CleanThisDocs = { cleanableExtFor, isBlanketDocUrl };
})();
