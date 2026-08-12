# CleanThis — browser extension

Browser extension for [cleanthis.io](https://cleanthis.io): clean files of hidden
threats (macros, embedded scripts, exploit vectors, metadata) using Content Disarm &
Reconstruction, and check webpages for scams, phishing and privacy issues — right from
your browser.

**Status: in development — not yet published to the extension stores.**

One codebase builds for **Chrome, Edge, Brave, Opera** (Chromium build) and **Firefox**.

## How it works

The extension is a thin, fully open-source client for cleanthis.io's public APIs.
Files and URLs are processed by cleanthis.io's servers — nothing is analyzed on your
machine, and the extension contains no accounts, keys, or secrets of any kind.

Planned v1 features:

- **Clean a file** — pick a file, get back a sanitized copy (Light / Standard /
  Aggressive, the same three presets as the website).
- **Scan this page** — a safety verdict plus security / privacy / legitimacy scores
  for the tab you're on.
- **Download protection** (opt-in, **off by default**) — intercepts risky file
  downloads, has cleanthis.io fetch and sanitize the file server-side, and hands you
  the cleaned copy instead. Every failure path offers a one-click "download the
  original anyway" — the extension never makes a file unreachable.

## Repo layout

| Path | What |
|---|---|
| `src/` | The extension itself — plain JavaScript, shared by every browser |
| `manifest/` | `base.json` + per-browser fragments (`chrome.json`, `firefox.json`) |
| `build.js` | Merges manifests and assembles `dist/chrome` + `dist/firefox` |
| `.github/workflows/` | CI: build + Firefox compatibility lint + downloadable artifacts |

## Building & trying it

```
node build.js         # → dist/chrome/  dist/firefox/
node build.js --zip   # also produces store-ready zips in dist/
```

- **Chromium:** `chrome://extensions` → enable Developer mode → *Load unpacked* → `dist/chrome`
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `dist/firefox/manifest.json`

No bundler and no transpilation — what's in `src/` is exactly what runs. `npm ci` is
only needed for the dev tooling (`web-ext` lint).

## Privacy

All requests go exclusively to `cleanthis.io`. A URL or file is sent only when you
trigger an action yourself — or, for download protection, only after you explicitly
turn it on. The extension collects no browsing history and no analytics. A full
privacy policy will accompany the store release.

## License

[MIT](LICENSE)
