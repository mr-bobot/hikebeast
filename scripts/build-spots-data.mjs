#!/usr/bin/env node
//
// Refreshes full/map/spots-data.js so window.SPOTS + window.LEGEND match
// the current content.yaml + the live Convex DB. The legacy build-full.py
// also generates this file, but isn't part of npm run build — so when:
//   - chapters get renumbered (May 2026 "eastern first" reorder), or
//   - new spots get added (orphans-as-spots merge, Photos batch 2/3), or
//   - admin edits title/kicker in Convex without round-tripping to yaml
// the sidecar drifts. Drift = different sidecar paint vs Convex push =
// hydration flicker on Home + Explore.
//
// This script is the authoritative regenerator going forward:
//   1. Preserve the existing row's `image` filename + lat/lon when the
//      spot was already in spots-data.js (so we don't accidentally
//      reformat 100 existing rows).
//   2. Add a row for every yaml spot / extras_entry not currently in
//      the sidecar — fills in defaults derived from content.yaml.
//   3. Hydrate title + kicker from Convex (admin edits override yaml).
//   4. Append Convex-only spots (rare; ones present in Convex but not
//      in either yaml or the existing sidecar).
//   5. Renumber `chapter` + `color` per current chapters[] ordering.
//   6. Regenerate window.LEGEND from the same chapters[].
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-spots-data.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConvexHttpClient } from "convex/browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SIDECAR = join(REPO, "full/map/spots-data.js");
const CONTENT = join(REPO, "content.yaml");

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const chapters = content.chapters || [];

function colorTriple(rgbFloats) {
  if (!Array.isArray(rgbFloats) || rgbFloats.length !== 3) return "0,0,0";
  return rgbFloats.map((v) => Math.round(v * 255)).join(",");
}
const numberByChapterId = new Map(chapters.map((ch) => [ch.id, ch.number]));
const colorByChapterId  = new Map(chapters.map((ch) => [ch.id, colorTriple(ch.color)]));

// ── 1. Load the existing sidecar so we can preserve already-set fields ──
const text = readFileSync(SIDECAR, "utf8");
const spotsMatch = text.match(/window\.SPOTS\s*=\s*(\[[\s\S]*?\]);/);
if (!spotsMatch) throw new Error("Could not parse window.SPOTS in spots-data.js");
const existing = JSON.parse(spotsMatch[1]);

function spotKeyOfRow(s) {
  const anchor = (s.href || "").split("#")[1];
  return anchor ? `${s.chapter_id}#${anchor}` : null;
}

const existingByKey = new Map();
for (const s of existing) {
  const k = spotKeyOfRow(s);
  if (k) existingByKey.set(k, s);
}

// ── 2. Build the union from content.yaml ────────────────────────────────
//    Regular spots (kind: spot or default) → one row per id.
//    extras blocks → one row per entries[] entry, kind=extras_entry.
const rows = [];
const seen = new Set();

function legacyImageName(yamlImage, id) {
  // Existing sidecars use a flattened filename ("engstligen_falls.jpg",
  // "leon_camping_riffelsee.jpg"). build-full.py derived these via an
  // img_name map we don't have. For NEW rows we synthesise something
  // unique-enough — the field is mostly vestigial: photoId already
  // resolves the rendered URL, and `image` is only consulted as a
  // fallback for photos[0].src in social.js's seedFromSidecars.
  if (!yamlImage) return "";
  return `${id}_${basename(yamlImage)}`.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

for (const s of (content.spots || [])) {
  const chapterId = s.chapter;
  if (!chapterId) continue;
  const chapterNum = numberByChapterId.get(chapterId);
  if (!chapterNum) continue;
  const color = colorByChapterId.get(chapterId) || "0,0,0";

  if (s.kind === "extras") {
    for (const e of (s.entries || [])) {
      const entryId = e.id || (e.heading || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const key = `${chapterId}#${entryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existingRow = existingByKey.get(key);
      const gps = e.gps || {};
      rows.push(existingRow ? { ...existingRow, kicker: "EXTRAS", chapter: chapterNum, color } : {
        title: e.heading || "",
        kicker: "EXTRAS",
        chapter: chapterNum,
        chapter_id: chapterId,
        lat: gps.lat ?? undefined,
        lon: gps.lng ?? undefined,
        image: "",
        href: `../${chapterId}/index.html#${s.id || "extras"}`,
        color,
        maps_url: e.maps_url || "",
        kind: "extras_entry",
      });
    }
    continue;
  }

  const key = `${chapterId}#${s.id}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const existingRow = existingByKey.get(key);
  const gps = s.gps || {};
  if (existingRow) {
    // Preserve existing fields (especially `image`) and only fix the
    // chapter + color so we don't drift filenames already in flight.
    rows.push({ ...existingRow, chapter: chapterNum, color, title: s.title, kicker: s.kicker || "" });
  } else {
    rows.push({
      title: s.title || "",
      kicker: s.kicker || "",
      chapter: chapterNum,
      chapter_id: chapterId,
      lat: gps.lat ?? undefined,
      lon: gps.lng ?? undefined,
      image: legacyImageName(s.image, s.id),
      href: `../${chapterId}/index.html#${s.id}`,
      color,
      maps_url: s.maps_url || "",
    });
  }
}

// Drop undefined fields so JSON output matches the existing schema (no
// "lat":null on rows without GPS).
for (const r of rows) {
  for (const k of Object.keys(r)) {
    if (r[k] === undefined) delete r[k];
  }
}

// ── 3. Convex pass: hydrate title/kicker + append any Convex-only spots ──
const CONVEX_URL = process.env.CONVEX_URL || "https://whimsical-sparrow-336.convex.cloud";
const skipConvex = process.env.HB_SKIP_CONVEX === "1";
let hydrated = 0, appended = 0;
if (!skipConvex) {
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    const convexRows = await client.query("spots:list", {});
    const rowsByKey = new Map(rows.map((r) => [spotKeyOfRow(r), r]));
    for (const c of convexRows) {
      const r = rowsByKey.get(c.spotKey);
      if (r) {
        if (c.title && c.title !== r.title) { r.title = c.title; hydrated++; }
        const cKicker = c.kicker || "";
        if (cKicker !== (r.kicker || "")) { r.kicker = cKicker; hydrated++; }
        // Convex's `kind` overrides yaml: when admin reclassified a spot
        // as `extras_entry` (TODO marker without copy), but yaml still
        // lists it as a regular spot, the Convex paint excludes it from
        // the pool (hasRealImage filters extras_entry) while the
        // sidecar paint includes it — Browse / Home counts drift on
        // first hydrate. Mirror Convex's kind so both paints agree.
        if (c.kind === "extras_entry" && r.kind !== "extras_entry") {
          r.kind = "extras_entry";
          hydrated++;
        } else if (!c.kind && r.kind === "extras_entry") {
          delete r.kind;
          hydrated++;
        }
        // Spots whose yaml carries `zdk_placeholder.jpg` are excluded by
        // hasRealImage() in the sidecar pass; if Convex has real photos
        // for them, the Convex push adds them to the pool and drifts
        // the chapter counts (Browse + Home buildUpNext rebuild on
        // first hydrate → flicker). Swap the placeholder out for a
        // real-looking filename so seedFromSidecars synthesises a
        // valid photoId and hasRealImage passes.
        if (r.image === "zdk_placeholder.jpg" && (c.photos || []).length > 0) {
          const anchor = (r.href || "").split("#")[1] || "";
          if (anchor) { r.image = `${anchor}.jpg`; hydrated++; }
        }
        continue;
      }
      // Convex-only spot. Build a minimal row from the Convex shape so it
      // shows up in counts; image stays empty (photoId will resolve via
      // seedFromSidecars / HB_SPOT_IMAGES).
      const anchor = (c.spotKey || "").split("#")[1];
      const chapterId = c.chapterId || (c.spotKey || "").split("#")[0];
      const chapterNum = c.chapter || numberByChapterId.get(chapterId) || "";
      const color = c.color || colorByChapterId.get(chapterId) || "0,0,0";
      rows.push({
        title: c.title || "",
        kicker: c.kicker || "",
        chapter: chapterNum,
        chapter_id: chapterId,
        ...(c.lat != null ? { lat: c.lat } : {}),
        ...(c.lon != null ? { lon: c.lon } : {}),
        image: "",
        href: `../${chapterId}/index.html#${anchor || ""}`,
        color,
        maps_url: c.mapsUrl || "",
        ...(c.kind && c.kind !== "spot" ? { kind: c.kind } : {}),
      });
      appended++;
    }
    console.log(`[build-spots-data] Convex hydration: ${hydrated} fields updated, ${appended} convex-only spots appended`);
  } catch (e) {
    console.warn(`[build-spots-data] Convex query failed; sidecar carries yaml-only data (${e.message})`);
  }
} else {
  console.log(`[build-spots-data] HB_SKIP_CONVEX=1 set, skipping Convex hydration`);
}

// ── 4. LEGEND from content.yaml chapters ───────────────────────────────
const legend = chapters.map((ch) => ({
  number: ch.number,
  name:   ch.name,
  color:  colorTriple(ch.color),
}));

// ── 5. Write back ──────────────────────────────────────────────────────
let next = text;
next = next.replace(/window\.SPOTS\s*=\s*\[[\s\S]*?\];/, `window.SPOTS = ${JSON.stringify(rows)};`);
if (/window\.LEGEND\s*=\s*\[[\s\S]*?\];/.test(next)) {
  next = next.replace(/window\.LEGEND\s*=\s*\[[\s\S]*?\];/, `window.LEGEND = ${JSON.stringify(legend)};`);
} else {
  next = next.trimEnd() + "\n" + `window.LEGEND = ${JSON.stringify(legend)};\n`;
}

writeFileSync(SIDECAR, next);
console.log(`[build-spots-data] sidecar now lists ${rows.length} rows (was ${existing.length}); LEGEND has ${legend.length} chapters`);
