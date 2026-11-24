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

  function plain(text) {
    return { strong: false, caution: false, text };
  }

  // The lead reason behind a non-clean verdict: the worst "listed" finding,
  // with the page-content scam findings ahead of the blocklist rows — the
  // website orders them the same way (a clone or fake login is the reason a
  // person can act on; "listed by X" is not).
  function leadFinding(list) {
    return list
      .filter((f) => f && f.result === "listed")
      .map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const scam = (b.f.lens === "scam") - (a.f.lens === "scam");
        if (scam) return scam;
        return (SEV[b.f.severity] || 0) - (SEV[a.f.severity] || 0) || a.i - b.i;
      })
      .map((row) => row.f)[0];
  }

  // The one overall sentence under the score bars. `caution` marks a result
  // whose verdict is "clean" but whose sentence is a warning — the popup must
  // not put a happy face next to it.
  function statementFor(verdict, findings, scores) {
    const list = Array.isArray(findings) ? findings : [];

    if (verdict === "clean") {
      // A malware-delivery link outranks the generic spam-campaign note.
      const payload = list.find((f) => f && f.source === "cleanthis_payload_url" && (f.result === "notice" || f.result === "listed"));
      if (payload) {
        return {
          strong: true,
          caution: true,
          text: payload.details && payload.details.wellKnown
            ? "No threat signals from the blocklists — but this exact link points to an executable download that was distributed through a spam / phishing campaign. Verify you trust the source before running it."
            : "This exact link downloads an executable installer that was distributed through a spam / phishing campaign. Do not download or run it — links like this deliver malware or remote-access tools.",
        };
      }
      const so = list.find((f) => f && f.source === "cleanthis_spam_observed" && f.result === "notice");
      if (so) {
        const wellKnown = !!(so.details && so.details.wellKnown);
        return {
          strong: false,
          caution: !wellKnown,
          text: wellKnown
            ? "No threat signals from the blocklists — but this exact link was distributed through an automated spam campaign, most likely as an ad/referral link. The site itself is not flagged."
            : "This exact link was distributed through an automated spam campaign. The destination is undetermined — links spread this way are typically junk promos or lead-ins to a scam, so treat it with caution.",
        };
      }
      // Nothing is listed, yet the page itself reads like a scam: a measured,
      // red legitimacy score. Security and privacy dips under a clean verdict
      // ("safe but tracker-heavy") are coherent and stay reassuring.
      const legit = scores && scores.legitimacy;
      if (legit && legit.value != null && legit.band === "red") {
        const why = legit.driver ? ` (${String(legit.driver).toLowerCase()})` : "";
        return {
          strong: true,
          caution: true,
          text: `No blocklist or security vendor has flagged this address yet — but the page itself shows signs of a scam${why}. Treat it with caution.`,
        };
      }
      return plain("Not flagged by any of the sources we checked.");
    }

    if (verdict === "unreachable") {
      return plain("We couldn’t open this page, so we couldn’t analyse what it actually does. The reputation checks still ran.");
    }

    if (verdict === "unknown") {
      return plain("We couldn't reach any of the sources for this scan. Try again in a moment.");
    }

    const lead = leadFinding(list);

    if (!lead) {
      return plain(
        verdict === "malicious"
          ? "One or more sources report this address as actively dangerous."
          : "At least one source flagged this address. Treat with caution."
      );
    }

    const brand = lead.details && lead.details.brand;
    let text;
    if (lead.source === "cryptominer") {
      text = "An in-browser cryptocurrency miner is running on this page — it can hijack your device to mine for someone else.";
    } else if (lead.source === "lookalike") {
      text = "This address closely mimics a well-known brand and may be a phishing attempt.";
    } else if (lead.source === "brandClone" && lead.details && lead.details.kind === "suspected_phishing") {
      text = `This page copies ${brand || "a well-known brand"}’s look but isn’t on an official ${brand || "brand"} site — very likely a phishing page. Don’t sign in here.`;
    } else if (lead.source === "brandClone") {
      text = `This page impersonates ${brand || "a well-known brand"} to harvest logins or payment details — a likely phishing clone.`;
    } else if (lead.source === "fakeLogin") {
      text = `This looks like a fake ${brand ? `${brand} ` : ""}sign-in page built to steal credentials — it has a login form that sends what you type to another site or a known data-theft channel, which legitimate sign-in pages don't do.`;
    } else if (lead.details && lead.details.note) {
      text = firstSentence(lead.details.note, 160);
    } else {
      text = `${lead.sourceLabel || lead.source} reports this address as dangerous.`;
    }
    return { strong: true, caution: false, text };
  }

  // "just now" is only true of a scan that just ran. The server answers a
  // repeat scan from a cache for up to a day, and says so — an old result
  // must not be dressed as a fresh one.
  function whenLabel(result, now) {
    if (!result || result.cached !== true) return "just now";
    const age = now - Number(result.computedAt);
    if (!Number.isFinite(age) || age < 0) return "checked earlier";
    const minutes = Math.floor(age / 60000);
    if (minutes < 1) return "checked a moment ago";
    if (minutes < 60) return `checked ${minutes} min ago`;
    return `checked ${Math.floor(minutes / 60)} h ago`;
  }

  self.CleanThisVerdict = { firstSentence, wheelState, statementFor, whenLabel };
})();
