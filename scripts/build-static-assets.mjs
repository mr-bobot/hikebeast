#!/usr/bin/env node
//
// Copies non-derivative static assets from assets/ into full/img/ where the
// chapter HTML and other static pages can load them. Run as part of the
// build pipeline; idempotent.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-static-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ASSETS = path.join(REPO, "assets");
const OUT = path.join(REPO, "full/img");

function copyTree(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { count += copyTree(src, dst); }
    else if (entry.isFile()) { fs.copyFileSync(src, dst); count++; }
  }
  return count;
}

let total = 0;

// ui/ → full/img/ (region SVGs, avatar, favicon — flat, no subfolder)
total += copyTree(path.join(ASSETS, "ui"), OUT);

// front_matter/ → full/img/front_matter/
total += copyTree(path.join(ASSETS, "front_matter"), path.join(OUT, "front_matter"));

console.log(`[static-assets] copied ${total} file(s)`);
