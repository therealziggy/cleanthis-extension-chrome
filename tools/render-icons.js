#!/usr/bin/env node
// Renders src/icons/boo-mark.svg — the 16×16 pixel Boo with the magnifying
// glass, the same mark as cleanthis.io's favicon — into the PNG set the
// manifest asks for, via a headless Chromium screenshot (pixel-exact, no
// ImageMagick SVG-delegate roulette). Pixel art only scales by whole numbers,
// so every size is an integer multiple of the 16px grid: 1× at 16, 2× at 32,
// 3× at 48, and 6× (96px) inside 16px of padding at 128, the store-icon
// layout. The art has a transparent background and reads on light and dark
// toolbars alike, so the -dark variants Firefox's theme_icons asks for are
// the same render.
//
// Run: node tools/render-icons.js
// Also writes dist/icons-proof.png — the mark at every size on light and dark
// toolbar strips, for eyeballing. Set BROWSER_BIN to pin a browser binary.

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const ICONS = path.join(ROOT, "src", "icons");
const mark = fs.readFileSync(path.join(ICONS, "boo-mark.svg"), "utf8");

// [file, canvas size, art size]
const RENDERS = [
  ["icon-128.png", 128, 96],
  ["icon-48.png", 48, 48],
  ["icon-32.png", 32, 32],
  ["icon-16.png", 16, 16],
  ["icon-32-dark.png", 32, 32],
  ["icon-16-dark.png", 16, 16],
];

function art(size) {
  return mark.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `);
}

const CANDIDATES = [
  process.env.BROWSER_BIN,
  "/usr/bin/brave-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter((p) => p && fs.existsSync(p));

(async () => {
  const browser = await chromium.launch({ executablePath: CANDIDATES[0], headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  for (const [name, canvas, size] of RENDERS) {
    const pad = (canvas - size) / 2;
    await page.setContent(
      `<!doctype html><body style="margin:0;background:transparent"><div style="width:${canvas}px;height:${canvas}px;padding:${pad}px;box-sizing:border-box">${art(size)}</div></body>`
    );
    await page.screenshot({
      path: path.join(ICONS, name),
      omitBackground: true,
      clip: { x: 0, y: 0, width: canvas, height: canvas },
    });
    console.log(`wrote src/icons/${name}`);
  }

  // Proof sheet: every size on a light and a dark toolbar strip.
  const strip = (bg) => `
    <div style="display:flex;align-items:center;gap:28px;background:${bg};padding:22px 26px;border-radius:10px">
      <div style="width:128px;height:128px;padding:16px;box-sizing:border-box">${art(96)}</div>
      ${art(48)} ${art(32)} ${art(16)}
      <span style="font:12px system-ui;color:${bg === "#ffffff" ? "#666" : "#aaa"}">128 · 48 · 32 · 16</span>
    </div>`;
  await page.setContent(
    `<!doctype html><body style="margin:0;display:flex;flex-direction:column;gap:14px;padding:16px;background:#e9edf0">
      ${strip("#ffffff")}
      ${strip("#202124")}
    </body>`
  );
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, "dist", "icons-proof.png"), fullPage: true });
  console.log("wrote dist/icons-proof.png");

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
