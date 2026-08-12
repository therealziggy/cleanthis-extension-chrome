// CleanThis — background script.
// Runs as a service worker on Chromium browsers and as an event page on Firefox.
//
// v1 features (popup message handling, opt-in download interception) land here
// in upcoming commits. All server communication goes through lib/api.js.

"use strict";

// Chrome loads lib/api.js into the service worker here; Firefox loads it via
// the manifest's background.scripts list instead (importScripts doesn't exist
// in event pages).
if (typeof importScripts === "function") {
  importScripts("lib/api.js");
}

const runtime = typeof browser !== "undefined" ? browser : chrome;

runtime.runtime.onInstalled.addListener(() => {
  console.log(`CleanThis installed (API base: ${self.CleanThisApi.BASE_URL})`);
});
