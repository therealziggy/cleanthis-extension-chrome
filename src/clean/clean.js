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
  const port = ext.runtime.connect({ name: "job-watch" });
  let handedOver = false;

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
          // background worker stays on the job in case the page disappears.
          port.postMessage({ done: true });
          note.textContent = "Saved.";
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
      port.postMessage({ done: true });
      show(els.cleanResult, { html: text("span", null, "That job was cancelled."), error: true });
    } else {
      // The failure is on screen already; no need for the background worker to
      // repeat it as a notification.
      port.postMessage({ done: true });
      show(els.cleanResult, {
        html: text("span", null, finished.error || "Cleaning failed. Please try again."),
        error: true,
      });
    }
  } catch (err) {
    if (handedOver) {
      // The background script is still watching; say so rather than implying
      // the job died.
      show(els.cleanResult, {
        html: text("span", null, `${humanize(err)} You'll get a notification if it finishes.`),
        error: true,
      });
    } else {
      show(els.cleanResult, { html: text("span", null, humanize(err)), error: true });
    }
  } finally {
    busy(false);
    refreshQuota();
    try {
      port.disconnect();
    } catch (_) {
      /* already gone */
    }
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
