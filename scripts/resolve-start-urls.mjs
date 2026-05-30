#!/usr/bin/env node
//
// Resolves every `maps.app.goo.gl` short URL in hikes.yaml to its
// final Google Maps URL, extracts the lat/lon from the `!3d{LAT}!4d{LON}`
// place pattern, and writes the result to scripts/start-url-coords.json.
//
// Run manually whenever you add a new short URL to hikes.yaml. The
// build-time guard (audit-hike-start-coords.mjs) reads from this cache
// and fails the build if a URL is missing from it.
//
// Slow: 1 curl per unique URL. Network required.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const CACHE = path.join(__dirname, "start-url-coords.json");

const hikesDoc = yaml.load(fs.readFileSync(path.join(ROOT, "hikes.yaml"), "utf8"));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

const shortUrls = new Set();
for (const h of hikesDoc.hikes || []) {
  const u = h.start_maps_url;
  if (u && u.includes("maps.app.goo.gl")) shortUrls.add(u);
}

let added = 0;
for (const u of shortUrls) {
  if (cache[u]) continue;
  console.log(`Resolving ${u} ...`);
  try {
    const final = execSync(`curl -sI -o /dev/null -w '%{url_effective}' -L "${u}"`, { encoding: "utf8" }).trim();
    // Try the !3d/!4d "place" pattern first (most common), then fall back
    // to the /search/LAT,+LON form Google uses for raw coordinate queries.
    let m = final.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
    if (!m) m = final.match(/\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/);
    if (!m) {
      console.warn(`  ⚠ no !3d!4d pattern in resolved URL: ${final.slice(0, 120)}...`);
      continue;
    }
    cache[u] = { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
    added++;
  } catch (e) {
    console.warn(`  ⚠ resolve failed: ${e.message}`);
  }
}

// Drop any cache entries whose URL no longer appears in hikes.yaml
const removedCount = Object.keys(cache).filter(k => !shortUrls.has(k)).length;
for (const k of Object.keys(cache)) {
  if (!shortUrls.has(k)) delete cache[k];
}

const sorted = Object.fromEntries(Object.entries(cache).sort());
fs.writeFileSync(CACHE, JSON.stringify(sorted, null, 2) + "\n");

console.log(`\n[resolve-start-urls] cache now has ${Object.keys(sorted).length} entries (added ${added}, removed ${removedCount})`);
