#!/usr/bin/env node
//
// Refreshes full/map/spots-data.js to match content.yaml's chapter order +
// numbers. The legacy build-full.py also generates this file, but isn't
// part of the npm run build pipeline — so when chapters get renumbered in
// content.yaml (e.g. the May 2026 "eastern first" reorder), the sidecar
// keeps stale numbers and every page that renders from sidecar paints
// different chapter labels than the Convex push delivers. That mismatch
// is the root cause of the Home / Explore photo flicker.
//
// This script keeps the script idempotent + scoped: it only updates the
// chapter number string on each spot row + rebuilds the LEGEND. Other
// fields (lat/lon, image, kicker, etc.) are preserved exactly as they
// were so we don't accidentally drift any other data.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-spots-data.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConvexHttpClient } from "convex/browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SIDECAR = join(REPO, "full/map/spots-data.js");
const CONTENT = join(REPO, "content.yaml");

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const chapters = content.chapters || [];

// id → "01".."07" per current content.yaml ordering.
const numberByChapterId = new Map();
for (const ch of chapters) numberByChapterId.set(ch.id, ch.number);

// id → "R,G,B" 0..255 triplet (matches the legacy build-full.py format).
function colorTriple(rgbFloats) {
  if (!Array.isArray(rgbFloats) || rgbFloats.length !== 3) return "0,0,0";
  return rgbFloats.map((v) => Math.round(v * 255)).join(",");
}
const colorByChapterId = new Map();
for (const ch of chapters) colorByChapterId.set(ch.id, colorTriple(ch.color));

const text = readFileSync(SIDECAR, "utf8");

// SPOTS: parse, rewrite chapter (and color) per chapter_id, leave the rest.
const spotsMatch = text.match(/window\.SPOTS\s*=\s*(\[[\s\S]*?\]);/);
if (!spotsMatch) throw new Error("Could not parse window.SPOTS in spots-data.js");
const spots = JSON.parse(spotsMatch[1]);
let renumbered = 0;
for (const s of spots) {
  const id = s.chapter_id;
  const newNumber = numberByChapterId.get(id);
  if (newNumber && s.chapter !== newNumber) { s.chapter = newNumber; renumbered++; }
  const newColor = colorByChapterId.get(id);
  if (newColor && s.color !== newColor) s.color = newColor;
}

// LEGEND: regenerate from content.yaml chapters in their current order.
const legend = chapters.map((ch) => ({
  number: ch.number,
  name:   ch.name,
  color:  colorTriple(ch.color),
}));

let next = text;
next = next.replace(/window\.SPOTS\s*=\s*\[[\s\S]*?\];/, `window.SPOTS = ${JSON.stringify(spots)};`);
if (/window\.LEGEND\s*=\s*\[[\s\S]*?\];/.test(next)) {
  next = next.replace(/window\.LEGEND\s*=\s*\[[\s\S]*?\];/, `window.LEGEND = ${JSON.stringify(legend)};`);
} else {
  // Older sidecars may not have LEGEND inline. Append it before any trailing newline.
  next = next.trimEnd() + "\n" + `window.LEGEND = ${JSON.stringify(legend)};\n`;
}

// Convex hydration: when admin edits a title / kicker in the Convex
// admin UI without round-tripping back to content.yaml, the sidecar
// paint shows yaml's stale text while the Convex push shows the new
// text — first paint flickers as the row card re-renders. Override
// sidecar title + kicker with Convex's when they differ. Same pattern
// as build-spot-images.mjs. Gracefully no-ops if Convex unreachable.
const CONVEX_URL = process.env.CONVEX_URL || "https://whimsical-sparrow-336.convex.cloud";
const skipConvex = process.env.HB_SKIP_CONVEX === "1";
if (!skipConvex) {
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    const rows = await client.query("spots:list", {});
    const cBySpotKey = new Map(rows.map((r) => [r.spotKey, r]));
    let hydrated = 0;
    for (const s of spots) {
      const anchor = (s.href || "").split("#")[1];
      const spotKey = anchor ? `${s.chapter_id}#${anchor}` : null;
      const c = spotKey ? cBySpotKey.get(spotKey) : null;
      if (!c) continue;
      let changed = false;
      if (c.title && c.title !== s.title) { s.title = c.title; changed = true; }
      const cKicker = c.kicker || "";
      if (cKicker !== (s.kicker || "")) { s.kicker = cKicker; changed = true; }
      if (changed) hydrated++;
    }
    console.log(`[build-spots-data] Convex hydration: ${hydrated} rows updated (title/kicker)`);
    next = next.replace(/window\.SPOTS\s*=\s*\[[\s\S]*?\];/, `window.SPOTS = ${JSON.stringify(spots)};`);
  } catch (e) {
    console.warn(`[build-spots-data] Convex query failed; sidecar carries yaml-only data (${e.message})`);
  }
} else {
  console.log(`[build-spots-data] HB_SKIP_CONVEX=1 set, skipping Convex hydration`);
}

writeFileSync(SIDECAR, next);
console.log(`[build-spots-data] renumbered ${renumbered} spot rows; LEGEND rewrote with ${legend.length} chapters`);
