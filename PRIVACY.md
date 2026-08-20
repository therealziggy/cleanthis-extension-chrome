# Privacy policy — CleanThis browser extension

_Last updated: 12 August 2026_

The extension is a client for [cleanthis.io](https://cleanthis.io). It has no servers,
accounts, or storage of its own beyond your settings, and it talks to no one except
cleanthis.io.

## What gets sent, and when

Nothing is sent unless you ask for it, or you turn on download protection yourself.

| Action | What leaves your browser | When |
|---|---|---|
| **Clean a file** | The file you picked | Only when you pick it |
| **Clean this file** (a document you're viewing) | The web address of the document | Only when you click *Clean this file* / *Clean it first* |
| **Scan this page** | The web address of the active tab | Only when you click *Scan this page* |
| **Download protection** | The web address of a matching download | Only while you have it switched on |
| **Ask before opening document links** | Nothing | The check is on your device; the address only leaves if you then choose to clean it |

Download protection is **off until you turn it on**. While it is on, the address of a
download matching your chosen file types is sent to cleanthis.io so the service can
fetch the file, clean it, and give you the cleaned copy. The file contents are not read
by the extension.

The extension also periodically fetches its **file-type catalogue** from cleanthis.io —
the list of types the settings page can offer. That request is a plain configuration
download and carries nothing about you: no addresses, no files, no identifiers.

## Flagged-site warnings (optional, off by default)

When you turn this on, the extension downloads CleanThis's list of known-bad sites as
irreversible fingerprints and checks the sites you visit **on your device**. The
addresses you visit are never sent to cleanthis.io or anyone else, and no page is ever
scanned automatically. The list download itself is the same kind of plain configuration
request as above — it carries nothing about you.

Turning the feature on asks for the browser's "tabs" and "webNavigation" permissions
in one prompt. Together they are what let the extension see the address of a page as
it starts to load — locally. Both matter: many flagged sites redirect somewhere else
in an instant, so the check has to happen before the site answers, or the dangerous
address is never seen at all. Turning the feature off stops all checking; you can also
revoke the permissions from your browser's extension settings at any time.

A warning never blocks a site outright: "Proceed anyway" always loads it.

## What is never sent

- Your browsing history. The extension does not watch pages you visit, and has no
  permission to read page content.
- Anything from pages you do not explicitly scan.
- Analytics, telemetry, advertising or fingerprinting data. There is none.

## What is stored, and where

Everything below is kept in your browser's own extension storage, on your device.
Nothing is synced anywhere by the extension, and none of it is sent to cleanthis.io.

- Your settings: the download-protection toggle, cleaning level, and file-type list.
- The most recent daily-allowance figures.
- While download protection is on: the web address of a download currently being
  cleaned (so an interrupted clean can offer you the original), and addresses you
  chose to download untouched. Both are short-lived — each entry is discarded once
  the download it refers to is dealt with, and they are cleared when you close the
  browser. No history of past downloads is kept.

## What cleanthis.io does with what it receives

Handling of files and scanned addresses on the service side is covered by the
[cleanthis.io privacy policy](https://cleanthis.io/privacy.html). In short: uploaded
files are processed and then deleted shortly afterwards, and they are not shared.

## Permissions and why

- **downloads** — to intercept a matching download and to save the cleaned file.
- **storage** — to keep your settings on your device.
- **notifications** — to tell you a file is ready, or that something went wrong.
- **activeTab** — to read the address of the current tab when you click *Scan this page*.
- **access to `cleanthis.io`** — to make the API requests the extension exists for.

The extension asks for no access to other websites.

## Source

The extension is open source: <https://github.com/therealziggy/cleanthis-extension-chrome>

## Contact

Questions: open an issue on the repository above.
