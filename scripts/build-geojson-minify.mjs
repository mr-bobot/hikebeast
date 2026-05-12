#!/usr/bin/env node
//
// In-place minify of full/map/switzerland.geojson — strips whitespace and
// rounds every coordinate to 4 decimal places. At 4 dp the precision is
// ~11m, which is well below the visible resolution of the canton outlines
// the map ever renders. Drops the file from ~234 KB to ~112 KB.
//
// Idempotent: rounding an already-rounded value is a no-op, JSON.stringify
// produces stable output, and we only write back when bytes actually
// changed (preserves mtime for incremental tooling).
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-geojson-minify.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "full", "map", "switzerland.geojson");

if (!fs.existsSync(SRC)) {
  console.warn(`[geojson] ${SRC} missing — skipping`);
  process.exit(0);
}

function round4(v) {
  if (Array.isArray(v)) return v.map(round4);
  if (typeof v === "number") return Math.round(v * 10000) / 10000;
  if (v && typeof v === "object") {
    const o = {};
    for (const k in v) o[k] = round4(v[k]);
    return o;
  }
  return v;
}

const raw = fs.readFileSync(SRC, "utf8");
const out = JSON.stringify(round4(JSON.parse(raw)));

if (out !== raw) {
  fs.writeFileSync(SRC, out);
  console.log(`[geojson] ${path.relative(process.cwd(), SRC)}: ${raw.length} → ${out.length} bytes`);
} else {
  console.log(`[geojson] already minified`);
}
