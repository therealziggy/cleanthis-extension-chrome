// CleanThis — the single point of contact with cleanthis.io.
//
// Everything that talks to the server lives here: the anonymous form-token
// flow, one wrapper per endpoint, job polling, and the polite-client rules.
//
// Being polite matters more than it looks. The server bans an IP at the
// firewall after repeated rate-limit responses, so a 429 must stop us from
// calling again for a while rather than trigger a retry: one 429 sets a
// cooldown, and every call during it fails locally without touching the
// network.
//
// Plain script (no module system): defines self.CleanThisApi for the
// background worker, popup, and options page alike.

"use strict";

(() => {
  const DEFAULT_COOLDOWN_MS = 60000;
  const POLL_INTERVAL_MS = 1500;
  const JOB_TIMEOUT_MS = 300000;

  // Which quota bucket an endpoint draws from — the server counts webpage
  // scans and file uploads separately, and users care about both.
  const BUCKETS = { scan: "scan", upload: "upload" };

  class ApiError extends Error {
    constructor(message, { status = 0, code = "http", retryAfterMs = 0 } = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  let cooldownUntil = 0;
  const lastQuota = { scan: null, upload: null };

  function cooldownRemaining() {
    return Math.max(0, cooldownUntil - Date.now());
  }

  function startCooldown(ms) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  }

  function noteQuota(bucket, headers) {
    if (!bucket) return;
    const limit = Number(headers.get("X-Daily-Limit"));
    const remaining = Number(headers.get("X-Daily-Remaining"));
    if (!Number.isFinite(limit) || !headers.get("X-Daily-Limit")) return;
    const resetEpoch = Number(headers.get("X-Daily-Reset")) || null;
    lastQuota[bucket] = { limit, remaining, resetEpoch };
    // Mirror into storage so the options page can show it without a request.
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [`quota_${bucket}`]: lastQuota[bucket] });
      }
    } catch (_) {
      /* storage is a nicety here, never a hard dependency */
    }
  }

  async function request(path, { method = "GET", headers = {}, body, bucket } = {}) {
    const waitMs = cooldownRemaining();
    if (waitMs > 0) {
      throw new ApiError("Paused after hitting a rate limit. Please try again shortly.", {
        code: "cooldown",
        retryAfterMs: waitMs,
      });
    }

    let response;
    try {
      response = await fetch(`${api.baseUrl}${path}`, { method, headers, body });
    } catch (err) {
      throw new ApiError("Couldn't reach cleanthis.io. Check your connection and try again.", {
        code: "network",
      });
    }

    noteQuota(bucket, response.headers);

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }

    if (response.status === 429) {
      const isQuota = payload && payload.code === "daily_quota_exceeded";
      const retryAfterHeader = Number(response.headers.get("Retry-After"));
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : DEFAULT_COOLDOWN_MS;
      startCooldown(retryAfterMs);
      if (isQuota) {
        throw new ApiError(
          `Daily allowance used up${payload.limit ? ` (${payload.limit} per day)` : ""}. It resets tomorrow.`,
          { status: 429, code: "quota", retryAfterMs }
        );
      }
      throw new ApiError("Too many requests — pausing for a moment.", {
        status: 429,
        code: "rate_limited",
        retryAfterMs,
      });
    }

    if (!response.ok) {
      const message = (payload && (payload.error || payload.message)) || `Request failed (${response.status}).`;
      throw new ApiError(message, { status: response.status, code: "http" });
    }

    return payload;
  }

  async function getFormToken(purpose) {
    const data = await request(`/api/form-token?purpose=${encodeURIComponent(purpose)}`);
    if (!data || !data.token) throw new ApiError("Couldn't start a secure request. Please try again.");
    return data.token;
  }

  // Every anonymous POST needs a fresh single-use token plus an empty
  // honeypot header (a non-empty one is treated as bot traffic).
  function formHeaders(token, extra = {}) {
    return { "X-Form-Token": token, "X-Form-Hp": "", ...extra };
  }

  async function scanUrl(url, tier = "standard") {
    const token = await getFormToken("scan-webpage");
    return request("/api/scan-url", {
      method: "POST",
      headers: formHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ url, tier }),
      bucket: BUCKETS.scan,
    });
  }

  async function sanitizeFile(file, level = "standard") {
    const token = await getFormToken("upload");
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("level", level);
    // No Content-Type header: the browser adds it with the multipart boundary.
    return request("/api/sanitize", {
      method: "POST",
      headers: formHeaders(token),
      body: form,
      bucket: BUCKETS.upload,
    });
  }

  async function sanitizeUrl(url, level = "standard", { acknowledgeSourceWarning = false } = {}) {
    const token = await getFormToken("upload");
    const body = { url, level };
    if (acknowledgeSourceWarning) body.acknowledgeSourceWarning = true;
    return request("/api/sanitize-url", {
      method: "POST",
      headers: formHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      bucket: BUCKETS.upload,
    });
  }

  // The server hands back download links as absolute URLs, but a relative path
  // is just as valid a shape for it to use — resolve either against the base
  // rather than assuming one and building a broken URL from the other.
  function resolveUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    try {
      return new URL(pathOrUrl, api.baseUrl).href;
    } catch (_) {
      return null;
    }
  }

  // The download token gates the completed job's details; it also makes the
  // server re-mint a fresh signed download URL on each poll, so a link fetched
  // now is always live.
  function getJob(jobId, downloadToken) {
    return request(`/api/job/${encodeURIComponent(jobId)}?token=${encodeURIComponent(downloadToken)}`);
  }

  const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

  async function waitForJob(jobId, downloadToken, options = {}) {
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
    const onTick = options.onTick;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await getJob(jobId, downloadToken);
      if (onTick) {
        try {
          onTick(job);
        } catch (_) {
          /* a progress callback must never break the wait */
        }
      }
      if (TERMINAL_STATES.has(job.state)) return job;
      // Check before sleeping as well as after, so an expired wait never
      // issues one more request on its way out.
      if (Date.now() + intervalMs >= deadline) {
        throw new ApiError("This is taking longer than expected. Please try again.", { code: "timeout" });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const api = {
    baseUrl: "https://cleanthis.io",
    ApiError,
    getFormToken,
    scanUrl,
    sanitizeFile,
    sanitizeUrl,
    getJob,
    waitForJob,
    resolveUrl,
    getLastQuota: (bucket) => lastQuota[bucket] || null,
    _cooldownRemaining: cooldownRemaining,
    _resetForTests() {
      cooldownUntil = 0;
      lastQuota.scan = null;
      lastQuota.upload = null;
    },
  };

  self.CleanThisApi = api;
})();
