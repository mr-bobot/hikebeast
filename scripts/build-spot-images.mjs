#!/usr/bin/env node
//
// Auto-generates `/full/img/spot-images.js`, the sidecar that maps each
// spot key (`<chapter_id>#<anchor>`) to its full photo gallery. Used by
// social.js to drive the carousel on each chapter card.
//
// Two-pass build:
//   1. Read content.yaml to build a baseline (spot.image + spot.photos[]
//      + spread blocks). This works offline.
//   2. If CONVEX_URL is reachable, fetch the live `spots:list` query and
//      OVERRIDE the baseline for any spot whose Convex row has photos.
//      This keeps the sidecar in sync with photos admin added in Convex
//      (admin UI / Submit-Photo flow) that never made it back to the
//      yaml — fixes the Explore-page double-render flash where the
//      sidecar tile count was lower than the Convex tile count, forcing
//      a rebuild on first Convex push.
//
// Builds gracefully fall back to the yaml baseline if the Convex query
// fails (offline / network glitch). Set HB_SKIP_CONVEX=1 to force-skip
// the Convex pass.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-spot-images.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConvexHttpClient } from "convex/browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONTENT = join(ROOT, "content.yaml");
const CREDITS = join(ROOT, "credits.yaml");
const OUT = join(ROOT, "full/img/spot-images.js");

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const creditsYaml = yaml.load(readFileSync(CREDITS, "utf8"));

function renderCredit(key) {
  if (!key) return null;
  if (key === "placeholder" || key === "xxx") return null;
  const ph = creditsYaml?.photographers ?? {};
  const ext = creditsYaml?.external ?? {};
  if (ph[key]) return `@${key}`;
  if (ext[key]) return ext[key].name ?? key;
  return key;
}

function derivativeSrc(spotId, idx) {
  return `derivatives/${spotId}_p${idx}/w1800.webp`;
}

const out = {};
let multiCount = 0;

// Build a {spotId → spread block} index so we can append spread photos
// to the parent spot's gallery.
const spreadsByParent = {};
for (const s of content.spots ?? []) {
  if (s.kind !== "spread" || !Array.isArray(s.images)) continue;
  // Parent is encoded in the spread's id (e.g. "fulberg_spread" → "fulberg",
  // "schrattenfluh_ridge_line_spread" → "schrattenfluh"). Parse the same
  // way the migration did.
  const parent = s.id
    .replace(/_ridge_line_spread$/i, "")
    .replace(/_spread$/i, "");
  spreadsByParent[parent] = s;
}

for (const spot of content.spots ?? []) {
  if ((spot.kind ?? "spot") !== "spot") continue;

  // Primary + extras = consecutive photoIds <id>_p0, _p1, _p2, ...
  const photos = [];
  if (spot.image) {
    photos.push({
      src: derivativeSrc(spot.id, 0),
      credit: renderCredit(spot.image_credit),
    });
  }
  const extras = spot.photos ?? [];
  for (let i = 0; i < extras.length; i++) {
    const e = extras[i];
    photos.push({
      src: derivativeSrc(spot.id, photos.length),
      credit: renderCredit(e.credit) ?? (e.credit ?? null),
    });
  }

  // Spread photos live at the same index range too — they were folded into
  // the spot's photo list during migration. The spread block's images[].src
  // already points at the file name; resolve to derivative idx via the
  // spot's photo file list.
  const spread = spreadsByParent[spot.id];
  if (spread) {
    const fileList = [];
    if (spot.image) fileList.push(basename(spot.image));
    for (const p of extras) if (p.file) fileList.push(p.file);
    for (const im of spread.images ?? []) {
      const m = im.src?.match(/^spots\/[^/]+\/(.+)$/);
      const fileName = m ? m[1] : null;
      const idx = fileName ? fileList.indexOf(fileName) : -1;
      if (idx < 0) continue;
      // Already in photos[]? If so, just refresh credit (spread credits are
      // sometimes more specific than the photos[] credit).
      const existing = photos[idx];
      if (existing) {
        const cred = renderCredit(im.credit) ?? im.credit ?? null;
        if (cred && !existing.credit) existing.credit = cred;
      }
    }
  }

  if (photos.length > 1) {
    out[`${spot.chapter}#${spot.id}`] = photos;
    multiCount++;
  }
}

// Pass 2: Convex hydration. Pull the live `spots:list` query and
// override the yaml-derived gallery for any spot Convex returns with
// >=2 photos. Anchors back to derivativeSrc(spot.id, idx) so the URL
// pattern stays consistent — Convex sometimes carries `photoId` but
// the photoId format is identical to <spot_id>_p<idx>.
const CONVEX_URL = process.env.CONVEX_URL || "https://whimsical-sparrow-336.convex.cloud";
const skipConvex = process.env.HB_SKIP_CONVEX === "1";
let overrideCount = 0;
let addedCount = 0;
if (!skipConvex) {
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    const rows = await client.query("spots:list", {});
    for (const row of rows) {
      const spotKey = row.spotKey; // "<chapter>#<anchor>"
      if (!spotKey) continue;
      const anchor = spotKey.split("#")[1];
      if (!anchor) continue;
      const photos = (row.photos || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (photos.length < 2) continue;
      const list = photos.map((p, idx) => ({
        src: derivativeSrc(anchor, idx),
        credit: p.credit || null,
      }));
      if (Object.prototype.hasOwnProperty.call(out, spotKey)) {
        // Only override if the photo count actually differs from yaml —
        // saves churn on the committed sidecar when Convex and yaml are
        // in sync (the common case).
        if (out[spotKey].length !== list.length) {
          out[spotKey] = list;
          overrideCount++;
        }
      } else {
        out[spotKey] = list;
        addedCount++;
      }
    }
    console.log(`[build-spot-images] Convex hydration: ${addedCount} new, ${overrideCount} replaced`);
  } catch (e) {
    console.warn(`[build-spot-images] Convex query failed; falling back to yaml-only sidecar (${e.message})`);
  }
} else {
  console.log(`[build-spot-images] HB_SKIP_CONVEX=1 set, skipping Convex hydration`);
}

const totalMulti = Object.keys(out).length;

const body = `// Auto-generated by scripts/build-spot-images.mjs.
// Maps a spot key (\`<chapter_id>#<anchor>\`) to its full photo gallery.
// Index 0 is the primary photo (matches the chapter card's <img>); extras
// follow. Spots with only one photo are NOT listed — the carousel UI
// checks for the key before activating, so single-photo spots fall back
// to the static <img>.
window.HB_SPOT_IMAGES = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(OUT, body);
console.log(`Wrote ${OUT}`);
console.log(`  ${totalMulti} spots have multi-image galleries`);
