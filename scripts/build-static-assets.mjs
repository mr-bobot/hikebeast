#!/usr/bin/env node
//
// Copies non-derivative static assets from assets/ into full/img/ where the
// chapter HTML and other static pages can load them. Run as part of the
// build pipeline; idempotent.
//
// SVG files are run through a tiny minifier on the way out — the region
// silhouettes ship as ~88 KB of high-precision path data per file, which
// rounds harmlessly to ~30-40 KB at the precision the hero ever renders.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-static-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ASSETS = path.join(REPO, "assets");
const OUT = path.join(REPO, "full/img");

// Lossy-but-safe SVG minifier:
//   - rounds any decimal number >= 10 to the nearest integer (catches
//     coordinate data in path d/cx/cy without touching small values like
//     stroke-width="1.2" or r="2.5")
//   - inside each path d="..." attribute, collapses whitespace + comma
//     separators and strips the optional space between a command letter
//     and the next number (M 1 2 → M1 2)
//
// The region SVGs are rendered at ≤700 px wide for a 1000-unit viewBox,
// so coordinate precision below 1 viewBox unit is invisible. Other
// attributes (rgb(...), stroke-width="1.2", viewBox) are left alone so
// values like rgb(175,165,122) keep their commas.
function compactPathData(d) {
  return d
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/([MLHVCSQTAZmlhvcsqtaz]) (?=-?\d)/g, "$1")
    .replace(/ -/g, "-")
    .trim();
}

function minifySvg(svg) {
  return svg
    // round large decimals to integer (>= two digits left of the dot)
    .replace(/-?\d{2,}\.\d+/g, (m) => String(Math.round(parseFloat(m))))
    // compact path-data inside d="..."
    .replace(/(\sd=")([^"]+)"/g, (_, head, data) => `${head}${compactPathData(data)}"`);
}

function copyFileMaybeMinify(src, dst) {
  if (src.endsWith(".svg")) {
    const raw = fs.readFileSync(src, "utf8");
    const min = minifySvg(raw);
    fs.writeFileSync(dst, min);
  } else {
    fs.copyFileSync(src, dst);
  }
}

function copyTree(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { count += copyTree(src, dst); }
    else if (entry.isFile()) { copyFileMaybeMinify(src, dst); count++; }
  }
  return count;
}

let total = 0;

// ui/ → full/img/ (region SVGs, avatar, favicon — flat, no subfolder)
total += copyTree(path.join(ASSETS, "ui"), OUT);

// front_matter/ → full/img/front_matter/
total += copyTree(path.join(ASSETS, "front_matter"), path.join(OUT, "front_matter"));

// region-beyond.svg lives only in full/img/ (no upstream source in assets/),
// so the copyTree above misses it. Minify it in place.
const beyond = path.join(OUT, "region-beyond.svg");
if (fs.existsSync(beyond)) {
  const raw = fs.readFileSync(beyond, "utf8");
  const min = minifySvg(raw);
  if (min !== raw) fs.writeFileSync(beyond, min);
}

console.log(`[static-assets] copied ${total} file(s)`);
