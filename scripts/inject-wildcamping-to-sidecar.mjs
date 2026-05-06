#!/usr/bin/env node
//
// After the chapter HTML and spot-images sidecar are built, inject the
// `wildCamping` block from content.yaml directly into full/map/spots-data.js.
// That way the kebab → Wildcamping status modal works on a vanilla
// localhost build with no Convex round-trip — useful while iterating on
// verdict copy and the modal layout.
//
// Production reads the same field from Convex via the spots:list
// subscription; this sidecar is just a faster paint + a no-Convex
// fallback.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const SIDECAR = join(REPO, "full/map/spots-data.js");
const CONTENT = join(REPO, "content.yaml");

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const wcByKey = new Map();
for (const s of content.spots) {
  if (!s.wildCamping) continue;
  // Sidecar uses href like "../central/index.html#engstligen_falls" —
  // we'll match on the chapter_id + id derived from each sidecar entry.
  // Build a lookup keyed by "<chapter>#<id>".
  wcByKey.set(`${s.chapter}#${s.id}`, s.wildCamping);
}

// Read sidecar, parse window.SPOTS array
const text = readFileSync(SIDECAR, "utf8");
const m = text.match(/window\.SPOTS\s*=\s*(\[[\s\S]*?\]);/);
if (!m) throw new Error("Could not parse window.SPOTS in spots-data.js");
const spots = JSON.parse(m[1]);

let injected = 0;
for (const sp of spots) {
  // sp.href is "../<chapter_id>/index.html#<spot_id>"
  const hashIdx = sp.href ? sp.href.indexOf("#") : -1;
  if (hashIdx < 0) continue;
  const spotId = sp.href.slice(hashIdx + 1);
  const key = `${sp.chapter_id}#${spotId}`;
  const wc = wcByKey.get(key);
  if (wc) {
    sp.wildCamping = wc;
    injected++;
  }
}

const newSpotsLine = `window.SPOTS = ${JSON.stringify(spots)};`;
const updated = text.replace(/window\.SPOTS\s*=\s*\[[\s\S]*?\];/, newSpotsLine);
writeFileSync(SIDECAR, updated);
console.log(`[inject-wildcamping] inlined ${injected}/${spots.length} verdicts into spots-data.js`);
