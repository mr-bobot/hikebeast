#!/usr/bin/env node
//
// Builds WebP derivatives of the intro polaroid hero used on /full/ home
// (slide 1) and /themap/success/. The PNG source is 1868x1260 RGBA
// (transparent) and weighs ~1.94 MB; this generates lighter widths in WebP
// so the home page's first-paint asset shrinks by an order of magnitude.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-intro-derivatives.mjs
//
// Run from `npm run build` (build-all.mjs wires it in). Output paths are
// stable so the <img srcset> in full/index.html can reference them.

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "images", "intro-photos-transparent.png");
const OUT_DIR = path.resolve(__dirname, "..", "images");

// Widths cover the hero box across breakpoints + 2x for HiDPI.
// CSS caps the hero at roughly 480px (mobile column) → 700px (desktop column),
// so 480/960/1400 lands the right asset for 1x/2x on each break.
const WIDTHS = [480, 960, 1400];

async function main() {
  for (const w of WIDTHS) {
    const out = path.join(OUT_DIR, `intro-photos-transparent-w${w}.webp`);
    await sharp(SRC)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90, effort: 5 })
      .toFile(out);
    console.log(`[intro] ${path.relative(process.cwd(), out)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
