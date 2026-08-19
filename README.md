# CleanThis — browser extension

Browser extension for [cleanthis.io](https://cleanthis.io): clean files of hidden
threats (macros, embedded scripts, exploit vectors, metadata) using Content Disarm &
Reconstruction, and check webpages for scams, phishing and privacy issues — right from
your browser.

**Status: beta — working, but not yet published to the extension stores.**
Install it from [Releases](../../releases) for now (see *Building & trying it*).

One codebase builds for **Chrome, Edge, Brave, Opera** (Chromium build) and **Firefox**.

## How it works

The extension is a thin, fully open-source client for cleanthis.io's public APIs.
Files and URLs are processed by cleanthis.io's servers — nothing is analyzed on your
machine, and the extension contains no accounts, keys, or secrets of any kind.

Features:

- **Clean a file** — its own page (drag & drop or browse), get back a sanitized copy
  (Light / Standard / Aggressive, the same three presets as the website). The
  cleaning level applies to file cleaning only — never to page scans.
- **Scan this page** — one click in the popup: a safety verdict plus security /
  privacy / legitimacy scores for the tab you're on (always a Standard scan).
- **Download protection** (opt-in, **off by default**) — intercepts risky file
  downloads, has cleanthis.io fetch and sanitize the file server-side, and hands you
  the cleaned copy instead. Every failure path offers a one-click "download the
  original anyway" — the extension never makes a file unreachable. Anything still
  waiting on you shows as a count on the toolbar icon and stays listed in the popup,
  so a notification you miss costs you nothing. Which file types are intercepted is
  a set of checkboxes in settings, fed by what cleanthis.io currently supports — new
  types show up there on their own, no update needed.

cleanthis.io allows a set number of scans and files per day per user. The extension
shows what's left, and pauses instead of retrying when the allowance runs out or the
service asks it to slow down.

## Repo layout

| Path | What |
|---|---|
| `src/` | The extension itself — plain JavaScript, shared by every browser |
| `manifest/` | `base.json` + per-browser fragments (`chrome.json`, `firefox.json`) |
| `build.js` | Merges manifests and assembles `dist/chrome` + `dist/firefox` |
| `test/` | Unit tests (`npm test`) plus manual browser harnesses |
| `.github/workflows/` | CI: tests + build + Firefox compatibility lint + artifacts |

## Building & trying it

```
node build.js         # → dist/chrome/  dist/firefox/
node build.js --zip   # also produces store-ready zips in dist/
```

- **Chromium:** `chrome://extensions` → enable Developer mode → *Load unpacked* → `dist/chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `dist/firefox/manifest.json`

### Downloads

Prebuilt zips for every version are on the [Releases page](../../releases) — pick
`cleanthis-chrome-v….zip` for Chrome/Edge/Brave/Opera or `cleanthis-firefox-v….zip`
for Firefox. Until the store listings are live these are for developers and early
testers (loaded unpacked / as a temporary add-on, as above); once published, the
stores handle installs and auto-updates.

No bundler and no transpilation — what's in `src/` is exactly what runs. `npm ci` is
only needed for the dev tooling (tests, `web-ext` lint, browser harnesses).

### Tests

```
npm test
```

Unit tests cover the API client and the interception rules; they stub the network and
need no browser. There are also two manual harnesses that drive the built extension in
a real browser against a locally running cleanthis.io instance — `test/e2e.js` (scan,
clean, intercept, and the "download the original" path) and
`test/harness/smoke-load.js`. Run `node build.js --dev` first; they need a browser that
still accepts `--load-extension` (recent Google Chrome does not — Brave or Chromium
work, or set `BROWSER_BIN`).

## Privacy

All requests go exclusively to `cleanthis.io`. A URL or file is sent only when you
trigger an action yourself — or, for download protection, only after you explicitly
turn it on. The extension collects no browsing history and no analytics.

Full detail: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
