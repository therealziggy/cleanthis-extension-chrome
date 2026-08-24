# Privacy policy — CleanThis browser extension

_Last updated: 24 August 2026_

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
| **Scan with CleanThis** (right-click menu) | The link or selected text you right-clicked | Only when you click the menu item |
| **Download protection** | The web address of a matching download | Only while you have it switched on |
| **Report a mistake** (flagged-site warning page) | The blocked address and your optional note | Only when you press Send |
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

A warning never blocks a site outright: "Proceed anyway" always loads it. And every
warning page carries a **"Report a mistake"** lane — sending one is the only time a
flagged address leaves your device, because you asked it to; the report goes to
human review.

**What the check covers, honestly:** full-page addresses as you navigate (and, on
flagged sites, the specific links known to be dangerous). It does not look inside
pages — content a page embeds from elsewhere (frames) is not checked — and file
downloads are not checked against this list; download protection above is its own,
separate feature. When a warning fires, it replaces the page in your tab; on a site
you had already started loading, the site may have seen the initial request before
the warning took its place.

## What is never sent

- Your browsing history. The extension does not watch pages you visit, and has no
  permission to read page content.
- Anything from pages you do not explicitly scan.
- Analytics, telemetry, advertising or fingerprinting data. There is none.

## What is stored, and where

Everything below is kept by your browser on this device. Nothing is synced anywhere
by the extension, and none of it is sent to cleanthis.io.

- Your settings: the download-protection, flagged-site and document-ask toggles, the
  cleaning level, the file-type list, and your theme choice (System / Light / Dark).
- The most recent daily-allowance figures.
- If the service has asked us to slow down: the time that pause ends, so the
  extension can stay polite without asking twice.
- Configuration downloaded from cleanthis.io: the file-type catalogue, and — only
  while flagged-site warnings are on — the flagged-site list itself (irreversible
  fingerprints, never addresses) plus when it was last fetched.
- While download protection is on: the web address of a download currently being
  cleaned (so an interrupted clean can offer you the original), and addresses you
  chose to download untouched. Both are short-lived — each entry is discarded once
  the download it refers to is dealt with, and they are cleared when you close the
  browser. No history of past downloads is kept.
- While a clean you started is still running or waiting to be saved: the job's id
  and the file's name, so a closed window can still hand you the result. Cleared as
  soon as the job is dealt with, and when you close the browser.
- While flagged-site warnings are on: the hostname you just chose "Proceed anyway"
  for (kept for half a minute), and — for compromised-but-legitimate sites — the
  hostnames already shown the one-time heads-up, so it isn't repeated. Both live
  only until you close the browser.

## What cleanthis.io does with what it receives

Handling of files and scanned addresses on the service side is covered by the
[cleanthis.io privacy policy](https://cleanthis.io/privacy.html). In short: uploaded
files are processed and then deleted shortly afterwards, and they are not shared.

## Permissions and why

- **downloads** — to intercept a matching download and to save the cleaned file.
- **storage** — to keep your settings on your device.
- **notifications** — to tell you a file is ready, or that something went wrong.
- **activeTab** — to read the address of the current tab when you click *Scan this page*.
- **contextMenus** — to offer *Scan with CleanThis* when you right-click a link or
  selected text. The menu item reads nothing and sends nothing until you click it.
- **access to `cleanthis.io`** — to make the API requests the extension exists for.

The extension asks for no access to other websites.

## Source

The extension is open source: <https://github.com/therealziggy/cleanthis-extension-chrome>

## Contact

Questions: open an issue on the repository above.
