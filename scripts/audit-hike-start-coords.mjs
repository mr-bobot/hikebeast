#!/usr/bin/env node
//
// Build-time guard: every hike's `start_maps_url` must point within
// a sane distance of its visited spot's GPS. Catches the kind of error
// that put a Zermatt cable car hike on the Fribourg Schwarzsee spot
// card on 2026-05-18.
//
// How it works:
//   1. Parse coords from each hike's start_maps_url:
//      - `https://www.google.com/maps/place/?q=LAT,LON&z=N` → inline
//      - `https://maps.app.goo.gl/<short>` → looked up in
//        scripts/start-url-coords.json (resolved once by
//        scripts/resolve-start-urls.mjs)
//   2. For each visited spot, compute Haversine distance.
//   3. Fail the build on any distance > MAX_DISTANCE_KM.
//
// If you add a new short URL to hikes.yaml and the cache doesn't have
// it yet, run `node scripts/resolve-start-urls.mjs` to populate it,
// then commit the updated cache.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

// Threshold tuned to the Swiss Alps. The widest legit traverse in the
// dataset (Brienzergrat full traverse) sits well under 40km end-to-end,
// so we'd catch a Schwarzsee-class error (80km Zermatt→Fribourg) easily
// while leaving real long-day traverses alone. Adjust if needed, but
// never raise it without verifying the new outliers are legit.
const MAX_DISTANCE_KM = 40;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = d => d * Math.PI / 180;
  const dphi = toRad(lat2 - lat1);
  const dlam = toRad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dlam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseQuery(url) {
  const m = url.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null;
}

const hikesDoc = yaml.load(fs.readFileSync(path.join(ROOT, "hikes.yaml"), "utf8"));
const contentDoc = yaml.load(fs.readFileSync(path.join(ROOT, "content.yaml"), "utf8"));
const shortCache = JSON.parse(fs.readFileSync(path.join(__dirname, "start-url-coords.json"), "utf8"));

const spotGps = {};
for (const s of contentDoc.spots || []) {
  if (s.gps?.lat != null && s.gps?.lng != null) {
    spotGps[s.id] = { lat: s.gps.lat, lon: s.gps.lng };
  }
}

const missingCache = [];
const violations = [];
const warnings = [];

for (const h of hikesDoc.hikes || []) {
  const url = h.start_maps_url;
  if (!url) continue;

  let coords = null;
  if (url.includes("maps.app.goo.gl")) {
    if (shortCache[url]) coords = shortCache[url];
    else missingCache.push({ hike: h.id, url });
  } else if (url.includes("q=")) {
    coords = parseQuery(url);
  }
  if (!coords) continue;

  for (const spotId of (h.visits || [])) {
    const sp = spotGps[spotId];
    if (!sp) continue;
    const d = haversineKm(coords.lat, coords.lon, sp.lat, sp.lon);
    if (d > MAX_DISTANCE_KM) {
      violations.push({ d, hike: h.id, spot: spotId, start: h.start, hikeCoords: coords, spotCoords: sp });
    } else if (d > 15) {
      warnings.push({ d, hike: h.id, spot: spotId });
    }
  }
}

let exitCode = 0;

if (missingCache.length) {
  console.error(`\n[audit-hike-start-coords] ${missingCache.length} short URL(s) not in cache:`);
  for (const m of missingCache) console.error(`  ${m.hike}: ${m.url}`);
  console.error(`\nRun: node scripts/resolve-start-urls.mjs`);
  console.error(`Then commit the updated scripts/start-url-coords.json.`);
  exitCode = 1;
}

if (violations.length) {
  console.error(`\n[audit-hike-start-coords] ${violations.length} hike(s) start more than ${MAX_DISTANCE_KM} km from their spot:`);
  for (const v of violations) {
    console.error(`  ${v.d.toFixed(1)} km  hike=${v.hike}  spot=${v.spot}`);
    console.error(`           start=${JSON.stringify(v.start)}`);
    console.error(`           hike_coords=${JSON.stringify(v.hikeCoords)}  spot_coords=${JSON.stringify(v.spotCoords)}`);
  }
  console.error(`\nThis means a hike is attached to the wrong spot, or the start_maps_url is pasted on the wrong hike.`);
  console.error(`Fix hikes.yaml (correct the link, or move the hike to the right spot) and rerun.`);
  exitCode = 1;
}

if (exitCode === 0) {
  const total = (hikesDoc.hikes || []).filter(h => h.start_maps_url).length;
  console.log(`[audit-hike-start-coords] PASS · ${total} hike start URLs all within ${MAX_DISTANCE_KM} km of their spot` +
    (warnings.length ? ` (${warnings.length} between 15-${MAX_DISTANCE_KM} km — long traverses, OK)` : ""));
}

process.exit(exitCode);
