// CleanThis — resolving a right-click into something the scanner can take.
//
// linkUrl arrives as a clean absolute URL; selectionText arrives as whatever
// the user swept up — wrapping quotes, trailing punctuation, a bare domain
// with no scheme, or plain prose. resolve() answers one question: is this
// unambiguously a public http(s) address? Bare text gets https:// prepended
// (the same normalisation the site's input applies); anything ambiguous —
// multi-word text, other schemes, bare IPs, emails — is refused, and the
// caller tells the user instead of guessing.
//
// Pure decisions, no browser APIs. Depends on CleanThisIntercept for the
// local-address rule — the scanner fetches the page from its own location, so
// a private address is a guaranteed dead end: the handoff tab would open only
// to fail. Both background load paths already load intercept.js first
// (background.js importScripts, manifest/firefox.json background.scripts).

"use strict";

(() => {
  const intercept = self.CleanThisIntercept;
  const MAX_LEN = 2000;

  // Selections drag wrapping punctuation along ("see example.com," or
  // "(https://x.com)"). A trailing ")" is stripped only when the string never
  // opened a paren — the standard linkifier heuristic, so Wikipedia-style
  // "Foo_(bar)" paths survive. Loop: stripping one layer can expose another
  // ("example.com.)" → ")" → ".").
  function stripWrapping(text) {
    let out = text.replace(/^["'<([{]+/, "");
    for (;;) {
      const before = out;
      out = out.replace(/["'>.,;:!?\]}]+$/, "");
      if (out.endsWith(")") && !out.includes("(")) out = out.replace(/\)+$/, "");
      if (out === before) return out;
    }
  }

  function parsed(candidate, bare) {
    let url;
    try {
      url = new URL(candidate);
    } catch (_) {
      return { ok: false };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
    // Governs BOTH branches: a router page, a NAS, a local dev server is
    // something cleanthis.io can never reach, so prefilling it would burn a
    // tab on a certain failure. The caller shows its "couldn't find a web
    // address" notification instead. Public IP literals stay in — a
    // dangerous-looking host is exactly what the scanner is for.
    if (intercept.isLocalAddress(url.hostname.toLowerCase())) return { ok: false };
    if (!url.hostname.includes(".")) return { ok: false };
    if (bare) {
      // Bare text earns the https:// guess only when it reads like a public
      // host: alphabetic final label (rejects bare IPs) and no userinfo (an
      // email is not a site). Explicit URLs keep both — a phishing link
      // shaped like https://brand@evil.example is exactly what to scan.
      if (!/\.[a-z]{2,}$/i.test(url.hostname)) return { ok: false };
      if (url.username || url.password) return { ok: false };
    }
    return { ok: true, url: url.href };
  }

  function resolve(raw) {
    if (typeof raw !== "string") return { ok: false };
    const text = stripWrapping(raw.trim());
    if (!text || text.length > MAX_LEN || /\s/.test(text)) return { ok: false };
    if (/^https?:\/\//i.test(text)) return parsed(text, false);
    // Any other scheme-shaped prefix is a refusal (mailto:, javascript:,
    // data: …). The character class has no dot, so example.com:8080 never
    // matches — that colon is a port, handled by the bare branch below.
    if (/^[a-z][a-z0-9+-]*:/i.test(text)) return { ok: false };
    return parsed(`https://${text}`, true);
  }

  self.CleanThisScanTarget = { resolve };
})();
