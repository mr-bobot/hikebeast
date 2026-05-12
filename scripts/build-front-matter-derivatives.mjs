#!/usr/bin/env node
//
// Builds WebP derivatives for front-matter JPEGs that ship under
// full/img/front_matter/ (intro hero, intro sidebar thumb, big spread
// photos, etc.). The source JPEGs are huge — page_05.jpg alone is 428 KB
// for a 96×64 sidebar thumb on every chapter page — so we emit a small
// WebP ladder and rely on srcset to let the browser pick.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-front-matter-derivatives.mjs
//
// Source JPEGs are left in place (Leon's rule: don't overwrite handed-in
// files); the WebPs sit next to them. The HTML emit-sites in
// build-chapter-html.mjs and full/intro/index.html reference the WebPs
// via srcset+sizes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "full", "img", "front_matter");

// Widths cover: 96px sidebar thumb (HiDPI 2x/3x), intro spreads at half-
// viewport on tablet (~480px) and full-viewport on mobile (~960px), and
// full-bleed hero on desktop (~1400px).
const WIDTHS = [192, 480, 960, 1400];

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[front-matter] ${SRC_DIR} missing — skipping`);
  process.exit(0);
}

const sources = fs.readdirSync(SRC_DIR).filter(f => /\.(jpe?g|png)$/i.test(f));
for (const file of sources) {
  const base = file.replace(/\.[^.]+$/, "");
  const src = path.join(SRC_DIR, file);
  for (const w of WIDTHS) {
    const out = path.join(SRC_DIR, `${base}-w${w}.webp`);
    // Skip if the output already exists AND is newer than the source —
    // makes the build idempotent and fast on re-runs.
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) continue;
    await sharp(src)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 80, effort: 5 })
      .toFile(out);
    console.log(`[front-matter] ${path.relative(process.cwd(), out)}`);
  }
}
