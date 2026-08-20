#!/usr/bin/env node
// Renders src/icons/mark.svg / mark-solid.svg into the PNG set the manifest
// asks for, via a headless Chromium screenshot (pixel-exact, no ImageMagick
// SVG-delegate roulette). Outlined at 128/48/32 with the stroke thickening as
// the render shrinks (1.7 → 1.9 → 2.2); solid at 16 — hairlines don't survive
// a 16px grid. Teal on transparent; -dark variants feed Firefox theme_icons.
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

const LIGHT = "#2a7e80";
const DARK = "#4db8aa";

const outline = fs.readFileSync(path.join(ICONS, "mark.svg"), "utf8");
const solid = fs.readFileSync(path.join(ICONS, "mark-solid.svg"), "utf8");

function outlineAt(strokeWidth, color) {
  return outline
    .replace(/stroke="#2a7e80"/, `stroke="${color}"`)
    .replace(/stroke-width="1\.7"/, `stroke-width="${strokeWidth}"`);
}

function solidAt(color) {
  return solid.replace(/fill="#2a7e80"/, `fill="${color}"`);
}

// One render per file: [name, size, svg]
const RENDERS = [
  ["icon-128.png", 128, outlineAt(1.7, LIGHT)],
  ["icon-48.png", 48, outlineAt(1.9, LIGHT)],
  ["icon-32.png", 32, outlineAt(2.2, LIGHT)],
  ["icon-16.png", 16, solidAt(LIGHT)],
  ["icon-32-dark.png", 32, outlineAt(2.2, DARK)],
  ["icon-16-dark.png", 16, solidAt(DARK)],
];

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

  for (const [name, size, svg] of RENDERS) {
    const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
    await page.setContent(
      `<!doctype html><body style="margin:0;background:transparent">${sized}</body>`
    );
    await page.screenshot({
      path: path.join(ICONS, name),
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    console.log(`wrote src/icons/${name}`);
  }

  // Proof sheet: every size on a light and a dark toolbar strip.
  const strip = (bg, color16, color32) => `
    <div style="display:flex;align-items:center;gap:28px;background:${bg};padding:22px 26px;border-radius:10px">
      ${outlineAt(1.7, LIGHT).replace("<svg ", '<svg width="128" height="128" ')}
      ${outlineAt(1.9, LIGHT).replace("<svg ", '<svg width="48" height="48" ')}
      ${outlineAt(2.2, color32).replace("<svg ", '<svg width="32" height="32" ')}
      ${solidAt(color16).replace("<svg ", '<svg width="16" height="16" ')}
      ${solidAt(color16).replace("<svg ", '<svg width="32" height="32" ')}
      <span style="font:12px system-ui;color:${bg === "#ffffff" ? "#666" : "#aaa"}">128 · 48 · 32 · 16 (+16@2x)</span>
    </div>`;
  await page.setContent(
    `<!doctype html><body style="margin:0;display:flex;flex-direction:column;gap:14px;padding:16px;background:#e9edf0">
      ${strip("#ffffff", LIGHT, LIGHT)}
      ${strip("#202124", DARK, DARK)}
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
