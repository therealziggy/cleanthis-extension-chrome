// CleanThis — the "Clean a file" page.
//
// This lives in a real tab on purpose: a popup dies the moment the native
// file dialog (or anything else) takes focus, killing the upload before it
// starts. A tab survives focus changes, so picking a file here always works.
//
// The clean flow itself is the popup's v1 flow, moved verbatim: a cleaning
// job can still outlast this page (the tab can be closed mid-clean), so the
// page opens a port to the background script and hands the job over if it is
// still running when the page goes away.

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const api = self.CleanThisApi;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const els = {
  level: document.getElementById("level"),
  drop: document.getElementById("drop"),
  fileInput: document.getElementById("file-input"),
  cleanResult: document.getElementById("clean-result"),
  quota: document.getElementById("quota"),
  settings: document.getElementById("settings-link"),
};

// ── small helpers ─────────────────────────────────────────────

function show(el, { html, error = false } = {}) {
  el.hidden = false;
  el.classList.toggle("error", error);
  el.textContent = "";
  if (html) el.append(html);
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function busy(isBusy) {
  els.drop.classList.toggle("busy", isBusy);
  els.fileInput.disabled = isBusy;
}

// Turns an ApiError into something a person can act on.
function humanize(err) {
  if (!err) return "Something went wrong. Please try again.";
  if (err.code === "cooldown") return "Paused briefly after hitting a rate limit. Try again in a moment.";
  if (err.code === "quota") return err.message;
  if (err.code === "rate_limited") return "Too many requests just now — please wait a minute.";
  if (err.code === "network") return "Couldn't reach cleanthis.io. Check your connection.";
  if (err.code === "timeout") return "That took longer than expected. Please try again.";
  return err.message || "Something went wrong. Please try again.";
}

async function refreshQuota() {
  try {
    const stored = await ext.storage.local.get(["quota_scan", "quota_upload"]);
    const parts = [];
    if (stored.quota_scan) parts.push(`${stored.quota_scan.remaining} scans left today`);
    if (stored.quota_upload) parts.push(`${stored.quota_upload.remaining} files left today`);
    els.quota.textContent = parts.join(" · ");
  } catch (_) {
    /* the quota line is informational only */
  }
}

// ── level preference (shared storage key with interception) ───

ext.storage.local.get(["level"]).then(({ level }) => {
  if (level) els.level.value = level;
});

els.level.addEventListener("change", () => {
  ext.storage.local.set({ level: els.level.value });
});

els.settings.addEventListener("click", (event) => {
  event.preventDefault();
  ext.runtime.openOptionsPage();
});

// ── the sanitization report ───────────────────────────────────
// The server's completed-job response has always carried the same report the
// website shows (what was stripped, what the pre-scan found, how strong the
// clean was); until v0.5.3 the extension ignored it. Rendered compactly:
// the cleaning-strength line first, then up to MAX_REPORT_ITEMS changes.

const MAX_REPORT_ITEMS = 8;

function renderReport(report) {
  if (!report || !Array.isArray(report.changes) || !report.changes.length) return null;

  const box = text("div", "report");
  box.append(text("h2", "report-title", "What was done"));

  // The strength descriptor leads — it says how deep the clean could go.
  const strength = report.changes.find((c) => c && c.type === "cleaning_strength");
  if (strength && strength.label) box.append(text("p", "report-strength", strength.label));

  const rest = report.changes.filter((c) => c && c !== strength && c.label);
  const list = text("ul", "report-list");
  for (const change of rest.slice(0, MAX_REPORT_ITEMS)) {
    const row = text("li", change.danger ? "danger" : null, change.label);
    list.append(row);
  }
  if (list.childElementCount) box.append(list);
  if (rest.length > MAX_REPORT_ITEMS) {
    box.append(text("p", "report-more", `…and ${rest.length - MAX_REPORT_ITEMS} more`));
  }
  if (report.summary) box.append(text("p", "report-summary", report.summary));

  return box.childElementCount > 1 ? box : null;
}

// ── clean flow (moved verbatim from the v1 popup) ─────────────

async function startClean(file) {
  if (!file) return;

  if (file.size > MAX_UPLOAD_BYTES) {
    show(els.cleanResult, { html: text("span", null, "That file is over the 50 MB limit."), error: true });
    return;
  }

  busy(true);
  show(els.cleanResult, { html: text("span", "progress", `Uploading ${file.name}…`) });

  // Hand the job to the background script if this page closes mid-flight.
  // The port deliberately stays OPEN while an unsaved result is on screen:
  // disconnecting is what tells the background to take the job over, so doing
  // it early would double-offer a file the page is already showing. (v1's
  // popup had exactly that bug — plus a dead-port error on a late Save click.)
  const port = ext.runtime.connect({ name: "job-watch" });
  let handedOver = false;

  // Mark the job dealt-with and close the port. A dead port means the worker
  // restarted and its recovery path owns the job now — never an error here.
  function settle() {
    try {
      port.postMessage({ done: true });
    } catch (_) {
      /* recovery owns it */
    }
    try {
      port.disconnect();
    } catch (_) {
      /* already gone */
    }
  }

  try {
    const job = await api.sanitizeFile(file, els.level.value);
    port.postMessage({ jobId: job.jobId, downloadToken: job.downloadToken, name: file.name });
    handedOver = true;

    show(els.cleanResult, { html: text("span", "progress", "Cleaning…") });
    const finished = await api.waitForJob(job.jobId, job.downloadToken, {
      onTick: (snapshot) => {
        if (snapshot.state === "queued") show(els.cleanResult, { html: text("span", "progress", "Waiting for a slot…") });
      },
    });

    if (finished.state === "completed") {
      const wrap = document.createDocumentFragment();
      wrap.append(text("p", null, `${finished.downloadName || file.name} is ready.`));
      const report = renderReport(finished.report);
      if (report) wrap.append(report);
      const save = document.createElement("button");
      save.textContent = "Save cleaned file";
      const note = text("p", "driver");
      save.addEventListener("click", async () => {
        // Download links are signed and short-lived, so ask for a fresh one
        // at click time rather than reusing the one from completion.
        save.disabled = true;
        note.textContent = "";
        try {
          const fresh = await api.getJob(job.jobId, job.downloadToken);
          const url = fresh && fresh.state === "completed" ? api.resolveUrl(fresh.downloadUrl) : null;
          if (!url) throw new api.ApiError("Cleaned files are only kept for a few minutes. Clean it again for a fresh copy.");
          await ext.downloads.download({ url, filename: fresh.downloadName || undefined });
          // Only now is the file genuinely the user's; until this point the
          // port stays open so a closed page hands the job to the background.
          note.textContent = "Saved.";
          settle();
        } catch (err) {
          // Leave the button usable — the job is valid for a few more minutes
          // and a second click often just works.
          note.textContent = humanize(err);
        }
        save.disabled = false;
      });
      wrap.append(save);
      wrap.append(note);
      show(els.cleanResult, { html: wrap });
    } else if (finished.state === "cancelled") {
      settle();
      show(els.cleanResult, { html: text("span", null, "That job was cancelled."), error: true });
    } else {
      // The failure is on screen already; no need for the background worker to
      // repeat it as a notification.
      settle();
      show(els.cleanResult, {
        html: text("span", null, finished.error || "Cleaning failed. Please try again."),
        error: true,
      });
    }
  } catch (err) {
    if (handedOver) {
      // Disconnecting WITHOUT done hands the job to the background watcher;
      // say so rather than implying the job died.
      show(els.cleanResult, {
        html: text("span", null, `${humanize(err)} You'll get a notification if it finishes.`),
        error: true,
      });
      try {
        port.disconnect();
      } catch (_) {
        /* already gone */
      }
    } else {
      show(els.cleanResult, { html: text("span", null, humanize(err)), error: true });
      try {
        port.disconnect();
      } catch (_) {
        /* nothing registered — closing is just tidy */
      }
    }
  } finally {
    busy(false);
    refreshQuota();
  }
}

// ── picker + drag-and-drop share startClean ───────────────────

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  startClean(file);
});

els.drop.addEventListener("click", () => els.fileInput.click());

els.drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.fileInput.click();
  }
});

els.drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.drop.classList.add("over");
});

els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));

els.drop.addEventListener("drop", (event) => {
  event.preventDefault();
  els.drop.classList.remove("over");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) startClean(file);
});

refreshQuota();
