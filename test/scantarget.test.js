// Unit tests for src/lib/scantarget.js — what a right-click hands us vs what
// the scanner can actually take. linkUrl arrives as a clean absolute URL;
// selectionText arrives as whatever the user swept up: wrapping quotes and
// punctuation, a bare domain with no scheme, an email, prose. resolve() says
// yes only to something that is unambiguously a public http(s) address.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

global.self = globalThis;
require("../src/lib/scantarget.js");
const { resolve } = self.CleanThisScanTarget;

function ok(input, url) {
  const r = resolve(input);
  assert.deepStrictEqual(r, { ok: true, url }, `resolve(${JSON.stringify(input)})`);
}
function no(input) {
  assert.deepStrictEqual(resolve(input), { ok: false }, `resolve(${JSON.stringify(input)})`);
}

test("explicit http(s) URLs pass through parsed", () => {
  ok("https://example.com/path?q=1", "https://example.com/path?q=1");
  ok("HTTP://Example.COM", "http://example.com/");
  ok("https://sub.example.co.uk:8443/a#b", "https://sub.example.co.uk:8443/a#b");
});

test("explicit scheme keeps IP and userinfo URLs (phishing-shaped is scannable)", () => {
  ok("https://1.2.3.4/login", "https://1.2.3.4/login");
  ok("https://paypal.com@evil.example/x", "https://paypal.com@evil.example/x");
});

test("bare domains get https:// like the site's own input", () => {
  ok("example.com", "https://example.com/");
  ok("www.example.com", "https://www.example.com/");
  ok("EXAMPLE.COM", "https://example.com/");
  ok("example.com:8080/x?y=1", "https://example.com:8080/x?y=1");
  ok("sub.example.co.uk/deep/path", "https://sub.example.co.uk/deep/path");
});

test("selection lint: whitespace and wrapping punctuation are stripped", () => {
  ok("  example.com \n", "https://example.com/");
  ok('"https://example.com"', "https://example.com/");
  ok("(example.com)", "https://example.com/");
  ok("example.com.", "https://example.com/");
  ok("example.com.)", "https://example.com/");
  ok("<https://example.com>", "https://example.com/");
});

test("trailing paren survives only when the URL itself opened one", () => {
  ok("https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)");
  ok("example.com/x)", "https://example.com/x");
});

test("multi-word selections are not URLs", () => {
  no("visit example.com today");
  no("not a url");
  no("go to example.com.");
});

test("non-web schemes are refused", () => {
  no("mailto:user@example.com");
  no("javascript:alert(1)");
  no("data:text/html,hi");
  no("file:///etc/passwd");
  no("ftp://example.com/f");
  no("chrome://settings");
});

test("bare candidates must look like a public dotted host", () => {
  no("1.2.3.4"); // bare IP: Chrome's own Go-to ambiguity, and the final label must be alphabetic
  no("localhost:3000");
  no("user@example.com"); // an email is not a site
  no("example"); // no dot
});

test("garbage in, {ok:false} out", () => {
  no("");
  no("   ");
  no(null);
  no(undefined);
  no(12);
  no("https://");
  no("https://nodots");
  no(`example.com/${"a".repeat(2100)}`); // over the 2000-char sanity cap
});
