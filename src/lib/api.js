// CleanThis — the single point of contact with cleanthis.io.
//
// Everything that talks to the server lives here and nowhere else: the
// anonymous form-token flow, each endpoint wrapper, job polling, and the
// polite-client rules (exponential backoff on 429, respect for the
// X-Daily-Remaining quota headers, never blind-retry).
//
// Plain script (no module system): defines self.CleanThisApi for the
// background script, popup, and options page alike.

"use strict";

(() => {
  const BASE_URL = "https://cleanthis.io";

  // Endpoint wrappers land with the v1 feature commits.
  self.CleanThisApi = { BASE_URL };
})();
