#!/usr/bin/env node
//
// Second-pass ZDK import. Handles the 41 files the first pass left in
// scripts/zdk-import-unmatched.txt that Leon mapped by hand. Three cases:
//
//   1. Variant of an existing spot (e.g. cap-au-moine-ridge → cap_au_moine).
//      Copy to next free slot, append to that spot's `photos:` in yaml.
//   2. Naming difference (e.g. gutannen-valley → guttannen_valley,
//      pissechevre → pisse_chevre, lake-taney → lac_de_taney).
//      Same as case 1, just spelled differently.
//   3. New spot: heftihutte. Three source files (main + blue-hour + indoors).
//      Create assets/spots/heftihutte/ with main.jpg + 02.jpg + 03.jpg, and
//      insert a fresh content.yaml block right after schrattenfluh.
//
// Files Leon DIDN'T map (still left in unmatched.txt after this run):
//   - Wildlife shots without a clear home: ibex-colony, ibex,
//     saas-fee-marmots, forest-wildlife, marmots
//   - tips-and-more-extra-spots (×4): ZDK guide's extras pages, not real spots
//   - unknown-massive-waterfall
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" \
//     node scripts/import-zdk-photos-pass2.mjs [--dry-run]

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ASSETS_SPOTS = path.join(REPO, "assets/spots");
const SOURCE = "/Users/lost/Documents/Claude/Projects/Hiking Influencer/output/ZDK_71/images copy";
const CONTENT = path.join(REPO, "content.yaml");
const BACKUP = path.join(REPO, "content.yaml.before-zdk-pass2");

const DRY_RUN = process.argv.includes("--dry-run");

// ZDK source-key → target spotId.
const MAPPINGS = {
  "engstligen-falls-from-the-air": "engstligen_falls",
  "schrattenfluh-ridge-line": "schrattenfluh",
  "schrattenfluh-peak": "schrattenfluh",
  "distant-layers": "schrattenfluh",
  "lauterbrunnen-valley": "lauterbrunnen",
  "lauterbrunnen-view-point": "lauterbrunnen",
  "cap-au-moine-ridge": "cap_au_moine",
  "cap-au-moine-ridgeline": "cap_au_moine",
  "cap-au-moine-summit": "cap_au_moine",
  "distant-mountains": "cap_au_moine",
  "creux-du-van-drone-shot": "creux_du_van",
  "creux-du-van-cliffs": "creux_du_van",
  "moiry-glacier-by-drone": "moiry_glacier",
  "moiry-glacier-top-down": "moiry_glacier",
  "la-fouly-winter": "la_fouly",
  "la-fouly-peaks": "la_fouly",
  "la-fouly-summer": "la_fouly",
  "gorges-du-durnand-bridge": "gorges_du_durnand",
  "nax-via-ferrata-top": "nax_via_ferrata",
  "dent-de-broc-from-moleson": "dent_de_broc",
  "barglistuber-waterfall": "barglistuber",
  "schafler-by-night": "schafler",
  "saxer-lucke-path": "saxer_lucke",
  "pissechevre": "pisse_chevre",
  "ice-lake": "ice_lake_griesslisee",
  "gutannen-valley": "guttannen_valley",
  "the-jungle": "the_jungle_waterfall",
  "the-hidden-waterfall": "rosenlaui_secret_waterfall",
  "hardergrat-ridge": "hardergrat_trail",
  "rothorn": "brienzer_rothorn",
  "mighty-range": "les_cheserys",
  "schilthorn-piz-gloria": "schilthorn",
  "snowy-iffigfalle": "iffigfalle",
  "cabane-bec-des-bossons": "cabane_becs_de_bosson",
  "ice-shapes": "the_ice_cave",
  "ice-waterfall": "the_ice_cave",
  "details-of-the-ice-cave": "the_ice_cave",
  "lake-taney": "lac_de_taney",
  "st-prex-cliff-diving": "st_prex",
  "two-worlds": "la_tzoumaz",
  // New spot
  "heftihutte": "heftihutte",
  "heftihutte-blue-hour": "heftihutte",
  "heftihutte-indoors": "heftihutte",
};

const FNAME_RX = /^p(\d+)_([a-z]+)_(.+?)(?:_(\d+))?\.(jpg|jpeg|png)$/i;
const HEFTIHUTTE_PRIMARY_KEY = "heftihutte"; // file with this key (no -suffix) is main.jpg

function nextSlot(existingFiles) {
  const used = new Set();
  for (const f of existingFiles) {
    const m = f.match(/^(\d{2})\./);
    if (m) used.add(parseInt(m[1], 10));
  }
  for (let n = 2; n < 100; n++) {
    if (!used.has(n)) return String(n).padStart(2, "0");
  }
  throw new Error("ran out of slots");
}

async function listFiles(dir) {
  try { return (await fs.readdir(dir)).filter(f => !f.startsWith(".")); }
  catch { return []; }
}

// Find a spot's block in yaml lines: returns { start, end } or null.
function findSpotBlock(lines, spotId) {
  const startRx = new RegExp(`^- id:\\s*${spotId}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRx.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id:\s*\S/.test(lines[i])) { end = i; break; }
    if (/^[a-z_]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function patchSpotBlockAppendPhotos(lines, block, newEntries) {
  let photosLine = -1;
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^  photos:\s*$/.test(lines[i])) { photosLine = i; break; }
  }

  const additions = [];
  for (const e of newEntries) {
    additions.push(`  - file: ${e.file}`);
    additions.push(`    credit: zimydakid`);
    additions.push(`    source_type: book`);
  }

  if (photosLine >= 0) {
    let last = photosLine;
    for (let i = photosLine + 1; i < block.end; i++) {
      const l = lines[i];
      if (l === "") { last = i; continue; }
      if (/^  - /.test(l) || /^    /.test(l)) { last = i; continue; }
      break;
    }
    const out = [...lines];
    out.splice(last + 1, 0, ...additions);
    return out;
  }

  // No photos: yet — insert before gps: if present, else at block end.
  let insertAt = block.end;
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^  gps:\s*$/.test(lines[i])) { insertAt = i; break; }
  }
  const out = [...lines];
  out.splice(insertAt, 0, "  photos:", ...additions);
  return out;
}

const HEFTIHUTTE_BLOCK = `- id: heftihutte
  chapter: central
  title: Heftihütte
  kicker: ''
  deck: TODO
  body:
  - TODO
  region: Schrattenfluh, Central Switzerland
  access: ''
  effort: ''
  best_light: Anytime
  image: spots/heftihutte/main.jpg
  image_credit: zimydakid
  photos:
  - file: 02.jpg
    credit: zimydakid
    source_type: book
  - file: 03.jpg
    credit: zimydakid
    source_type: book`;

function insertHeftihutteAfterSchrattenfluhSpread(lines) {
  // schrattenfluh's main spot ends and is followed by `schrattenfluh_ridge_line_spread`.
  // Insert heftihutte AFTER the spread block so the regional ordering reads
  // schrattenfluh → spread → heftihutte → next spot.
  const block = findSpotBlock(lines, "schrattenfluh_ridge_line_spread");
  if (!block) throw new Error("schrattenfluh_ridge_line_spread block not found in content.yaml");
  const out = [...lines];
  out.splice(block.end, 0, HEFTIHUTTE_BLOCK, "");
  return out;
}

async function main() {
  const sourceFiles = (await listFiles(SOURCE)).sort();
  const yamlOriginal = await fs.readFile(CONTENT, "utf8");
  let lines = yamlOriginal.split("\n");

  // Group source files by target spotId via the MAPPINGS table.
  const byTarget = new Map();   // spotId → [{srcName, ext, key}]
  const skipped = [];
  for (const fname of sourceFiles) {
    const m = fname.match(FNAME_RX);
    if (!m) continue;
    const [, , , key, , ext] = m;
    const target = MAPPINGS[key.toLowerCase()];
    if (!target) continue;     // not in our pass2 mapping
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push({ srcName: fname, ext: ext.toLowerCase(), key: key.toLowerCase() });
  }

  // Special case: heftihutte's primary file (key='heftihutte', no suffix)
  // must become main.jpg. The variants take 02.jpg / 03.jpg.
  if (byTarget.has("heftihutte")) {
    const items = byTarget.get("heftihutte");
    items.sort((a, b) => {
      const aIsPrimary = a.key === HEFTIHUTTE_PRIMARY_KEY ? 0 : 1;
      const bIsPrimary = b.key === HEFTIHUTTE_PRIMARY_KEY ? 0 : 1;
      if (aIsPrimary !== bIsPrimary) return aIsPrimary - bIsPrimary;
      return a.srcName.localeCompare(b.srcName);
    });
  }

  // Allocate destination slots per target.
  const additions = [];   // [{spotId, srcName, dstName}]
  let createdHeftihutteFolder = false;
  for (const [spotId, items] of byTarget) {
    const folderAbs = path.join(ASSETS_SPOTS, spotId);
    let existing;
    if (!fsSync.existsSync(folderAbs)) {
      existing = [];
      if (!DRY_RUN) {
        await fs.mkdir(folderAbs, { recursive: true });
        createdHeftihutteFolder = (spotId === "heftihutte");
      }
    } else {
      existing = await listFiles(folderAbs);
    }

    const allocated = [...existing];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let dstName;
      if (spotId === "heftihutte" && it.key === HEFTIHUTTE_PRIMARY_KEY) {
        // The primary becomes main.<ext>.
        dstName = `main.${it.ext}`;
      } else {
        const slot = nextSlot(allocated);
        dstName = `${slot}.${it.ext}`;
      }
      allocated.push(dstName);
      additions.push({ spotId, srcName: it.srcName, dstName });
    }
  }

  // Copy.
  let copied = 0, skippedExist = 0;
  for (const a of additions) {
    const dst = path.join(ASSETS_SPOTS, a.spotId, a.dstName);
    if (fsSync.existsSync(dst)) { skippedExist++; continue; }
    if (!DRY_RUN) await fs.copyFile(path.join(SOURCE, a.srcName), dst);
    copied++;
  }

  // Update content.yaml.
  // 1. Insert the heftihutte block.
  const hadHeftihutte = !!findSpotBlock(lines, "heftihutte");
  if (byTarget.has("heftihutte") && !hadHeftihutte) {
    lines = insertHeftihutteAfterSchrattenfluhSpread(lines);
  }
  // 2. For each non-heftihutte spot, append its new photos to the spot's
  //    photos: array (excluding main.* — main has its own image_credit field
  //    and is not part of photos:).
  const photosBySpot = new Map();
  for (const a of additions) {
    if (a.dstName.startsWith("main.")) continue;
    if (!photosBySpot.has(a.spotId)) photosBySpot.set(a.spotId, []);
    photosBySpot.get(a.spotId).push({ file: a.dstName });
  }
  // Sort each spot's new photos by filename so yaml order matches filesystem.
  for (const [spotId, entries] of photosBySpot) {
    if (spotId === "heftihutte") continue;   // its photos are already in the inserted block
    entries.sort((a, b) => a.file.localeCompare(b.file));
    const block = findSpotBlock(lines, spotId);
    if (!block) {
      console.warn(`  SKIP yaml patch for ${spotId} — block not found`);
      continue;
    }
    lines = patchSpotBlockAppendPhotos(lines, block, entries);
  }

  const newText = lines.join("\n");

  console.log(`[pass2] copied=${copied} skipped(exists)=${skippedExist} spots_touched=${byTarget.size}`);
  for (const [spotId, items] of byTarget) {
    console.log(`  ${spotId}  +${items.length} photo(s)`);
  }

  if (DRY_RUN) {
    console.log(`[pass2] dry-run, yaml delta = ${newText.length - yamlOriginal.length} bytes`);
    return;
  }

  await fs.writeFile(BACKUP, yamlOriginal);
  await fs.writeFile(CONTENT, newText);
  console.log(`[pass2] wrote content.yaml (backup: ${path.basename(BACKUP)})`);
}

main().catch(err => { console.error(err); process.exit(1); });
