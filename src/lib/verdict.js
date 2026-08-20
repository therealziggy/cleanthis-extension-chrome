// CleanThis — verdict presentation logic for the popup's scan result.
//
// Pure functions only: what each score wheel should show, and the one
// overall statement line under the wheels. The strings are the website's own
// (its scanner report page renders the same data), so the popup and the site
// say the same sentence about the same scan.
//
// Plain script (no module system): defines self.CleanThisVerdict for the
// popup page, and loads under node --test the same way lib/flagged.js does.

"use strict";

(() => {
  // First sentence of a note, capped — long run-ons get an ellipsis.
  function firstSentence(s, cap) {
    const str = String(s || "").trim();
    if (!str) return "";
    const m = str.match(/^.*?[.!?](?=\s|$)/);
    const out = m ? m[0] : str;
    return out.length > cap ? out.slice(0, cap - 1).trimEnd() + "…" : out;
  }

  // Per-axis wheel state from the API's score object (or undefined).
  // Mirrors the site's renderScores(): blocked/unloaded/none render an
  // em-dash wheel with an explanatory driver instead of a fake number;
  // partial coverage carries the "limited" suffix.
  function wheelState(score) {
    const s = score || { value: null, band: "none", coverage: "none", driver: null };
    const blocked = s.coverage === "blocked";
    const unloaded = s.coverage === "unloaded";
    const none = blocked || unloaded || s.coverage === "none" || s.value == null;
    const band = none ? "none" : (s.band || "none");
    const driver = blocked
      ? (s.driver || "Not measured")
      : unloaded
        ? (s.driver || "Page couldn’t be loaded")
        : none
          ? "Run a deeper scan to assess this"
          : (s.driver || "");
    let suffix = "";
    if (!none && s.coverage === "partial") {
      suffix = s.degraded ? " · limited — a check didn’t respond" : " · limited (Quick scan)";
    }
    return { value: none ? "—" : String(s.value), band, driver, suffix, none };
  }

  const SEV = { high: 2, medium: 1 };

  // The one overall sentence under the wheels. Worst "listed" finding leads;
  // clean gets the not-flagged line unless the exact link was spam-distributed.
  function statementFor(verdict, findings) {
    const list = Array.isArray(findings) ? findings : [];

    if (verdict === "clean") {
      const so = list.find((f) => f && f.source === "cleanthis_spam_observed" && f.result === "notice");
      if (so) {
        return {
          strong: false,
          text: so.details && so.details.wellKnown
            ? "No threat signals from the blocklists — but this exact link was distributed through an automated spam campaign, most likely as an ad/referral link. The site itself is not flagged."
            : "This exact link was distributed through an automated spam campaign. The destination is undetermined — links spread this way are typically junk promos or lead-ins to a scam, so treat it with caution.",
        };
      }
      return { strong: false, text: "Not flagged by any of the sources we checked." };
    }

    if (verdict === "unreachable") {
      return {
        strong: false,
        text: "We couldn’t open this page, so we couldn’t analyse what it actually does. The reputation checks still ran.",
      };
    }

    const lead = list
      .filter((f) => f && f.result === "listed")
      .sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0))[0];

    if (!lead) {
      return {
        strong: false,
        text: verdict === "malicious"
          ? "One or more sources report this address as actively dangerous."
          : "At least one source flagged this address. Treat with caution.",
      };
    }

    if (lead.source === "lookalike") {
      return { strong: true, text: "This address closely mimics a well-known brand and may be a phishing attempt." };
    }
    if (lead.details && lead.details.note) {
      return { strong: true, text: firstSentence(lead.details.note, 160) };
    }
    return { strong: true, text: `${lead.sourceLabel || lead.source} reports this address as dangerous.` };
  }

  self.CleanThisVerdict = { firstSentence, wheelState, statementFor };
})();
