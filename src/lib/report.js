// CleanThis — what a finished clean is allowed to claim.
//
// Pure decisions over the server's completed-job report, shared by the
// clean-a-file window and the background script. The rules are the website's
// own result card (public/app.js there), so both surfaces say the same thing
// about the same file:
//
//   • a cleaned file that still carries a link to a site flagged as malicious
//     is never stamped CLEAN, and is never saved without the user saying so —
//     the file is rebuilt, but "clean" would read as "safe to use";
//   • a format that is only scanned (not rebuilt) is stamped SCANNED;
//   • a file nothing was removed from is ALREADY CLEAN;
//   • a failure says whether trying again can help.
//
// Plain script (no module system): defines self.CleanThisReport.

"use strict";

(() => {
  // Change-entry types that mean "something dangerous was taken out" — the
  // same lists the website's result card counts as threats.
  const THREAT_TYPES = [
    "macros", "javascript", "attachments", "scripts", "event_handlers", "external_refs",
    "csv_formulas", "dwg_vba", "dwg_active_content", "bidi_controls", "invisible_chars",
    // What the pre-scan found before the clean took it out.
    "macro_analysis", "pdf_analysis", "rtf_analysis", "html_analysis", "archive_analysis", "yara_analysis",
  ];
  // Email warnings are a threat only when the server marked them dangerous.
  const PHISH_TYPES = ["deceptive_links", "email_warnings"];
  const METADATA_TYPES = ["exif", "metadata", "dwg_metadata"];
  const CONVERSION_TYPES = ["conversion", "format_converted"];

  function changesOf(report) {
    const list = report && Array.isArray(report.changes) ? report.changes : [];
    return list.filter((c) => c && typeof c.type === "string");
  }

  // Links (and QR codes) left in the cleaned file that lead to a site flagged
  // as malicious. Empty when the server ran no link check at all.
  function badLinks(report) {
    const items = report && report.links && Array.isArray(report.links.items) ? report.links.items : [];
    return items.filter((item) => item && item.verdict === "malicious");
  }

  function removedSomething(report) {
    for (const change of changesOf(report)) {
      if (THREAT_TYPES.includes(change.type)) return true;
      if (PHISH_TYPES.includes(change.type) && change.danger === true) return true;
      if (METADATA_TYPES.includes(change.type)) {
        if (Array.isArray(change.details) && change.details.length) return true;
        // Hidden fields with no detail rows still count ("Stripped N … fields").
        const counted = /Stripped (\d+)/.exec(change.label || "");
        if (counted && Number(counted[1]) > 0) return true;
      }
    }
    return false;
  }

  // The stamp, headline and mascot for a completed job. `tone` is ok | amber |
  // red; `boo` names the sprite.
  function outcome(report) {
    if (badLinks(report).length) {
      return { stamp: "BAD LINK", tone: "red", title: "Cleaned — but mind the link.", boo: "alarm" };
    }
    if (report && report.cleaningStrength === "content_preserved") {
      return { stamp: "SCANNED", tone: "amber", title: "Scanned. Not rebuilt.", boo: "look-right" };
    }
    const converted = changesOf(report).some((c) => CONVERSION_TYPES.includes(c.type));
    if (!removedSomething(report) && !converted) {
      return { stamp: "ALREADY CLEAN", tone: "ok", title: "Nothing was hiding in there.", boo: "happy" };
    }
    return { stamp: "CLEAN", tone: "ok", title: "Scrubbed. All yours.", boo: "happy" };
  }

  // What a failed job says. `retryable === false` is the server's word that
  // the file itself is the reason; anything else (including no flag at all,
  // from an older server) leaves a retry on the table.
  function failureCopy(serverMessage, retryable) {
    const erased = "Your upload was erased either way.";
    if (serverMessage && retryable === false) {
      return {
        title: "We couldn't clean this file.",
        body: `${serverMessage} Retrying gives the same result — the file itself is the reason. ${erased}`,
        retry: false,
      };
    }
    return {
      title: "Cleaning failed.",
      body: `${serverMessage || "The server couldn't process this one."} ${erased}`,
      retry: true,
    };
  }

  self.CleanThisReport = { badLinks, outcome, failureCopy };
})();
