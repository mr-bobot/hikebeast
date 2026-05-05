#!/usr/bin/env node
//
// Imports the ZDK_71 image dump into assets/spots/<spotId>/ as additional
// photos. Source filenames follow this scheme:
//
//   p<NN>_<chapter>_<spot-key>(_<id>)?.<ext>
//
// Examples:
//   p013_central_engstligen-falls_02.jpg          → spotKey=engstligen-falls
//   p035_central_schrattenfluh.jpg                → spotKey=schrattenfluh
//   p045_central_schilthorn-piz-gloria_02.jpg     → spotKey=schilthorn-piz-gloria
//
// The leading p<NN> (page number) and chapter token are legacy from the
// PDF builder and ignored. The trailing _<id> is a per-spot index from the
// ZDK guide and has no relationship to our `02.jpg`/`03.jpg` numbering.
//
// Mapping rule (kept conservative):
//   1. Replace `-` with `_` in spotKey, look up assets/spots/<spotId>/.
//   2. If no match, the file is recorded as UNMATCHED — never guessed.
//
// On match: copy the file to assets/spots/<spotId>/<NN>.<ext>, where <NN>
// is the next zero-padded integer not already used by that folder. Never
// overwrites; never renames an existing file.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" \
//     node scripts/import-zdk-photos.mjs \
//     [--source <path>] [--credit <key>] [--dry-run]
//
// Outputs (besides the copies):
//   - scripts/zdk-import-report.yaml  — what was matched + what to paste
//                                       into content.yaml's photos: arrays
//   - scripts/zdk-import-unmatched.txt — files I could not match

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ASSETS_SPOTS = path.join(REPO, "assets/spots");

const args = process.argv.slice(2);
const argFlag = (name, dflt) => {
  const i = args.findIndex(a => a === name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
};
const SOURCE = argFlag("--source", "/Users/lost/Documents/Claude/Projects/Hiking Influencer/output/ZDK_71/images copy");
const CREDIT = argFlag("--credit", "zimydakid");
const DRY_RUN = !!argFlag("--dry-run", false);

const FNAME_RX = /^p(\d+)_([a-z]+)_(.+?)(?:_(\d+))?\.(jpg|jpeg|png)$/i;

function nextSlot(existingFiles) {
  // Existing folder filenames are `main.<ext>` and `<NN>.<ext>` where NN >= 02.
  // Pick the smallest 2-digit integer not already used.
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

async function main() {
  const sourceFiles = (await listFiles(SOURCE)).sort();
  console.log(`[zdk-import] source: ${SOURCE}`);
  console.log(`[zdk-import] ${sourceFiles.length} files in source`);
  console.log(`[zdk-import] credit: ${CREDIT}`);
  console.log(`[zdk-import] dry-run: ${DRY_RUN}`);
  console.log("");

  // Group source files by candidate spotId (so we allocate slot numbers
  // consistently per spot when there are multiple new photos).
  const matched = new Map();   // spotId → [{srcPath, srcName, newName}]
  const unmatched = [];        // [{srcName, spotKey, reason}]
  const missingFolders = [];   // [{srcName, spotKey, candidate}]

  for (const fname of sourceFiles) {
    const m = fname.match(FNAME_RX);
    if (!m) { unmatched.push({ srcName: fname, spotKey: null, reason: "filename does not match p<NN>_<chap>_<key>(_<id>)?.<ext>" }); continue; }
    const [, , , spotKey, , ext] = m;
    const spotIdGuess = spotKey.toLowerCase().replace(/-/g, "_");
    const folderAbs = path.join(ASSETS_SPOTS, spotIdGuess);
    if (!fsSync.existsSync(folderAbs)) {
      missingFolders.push({ srcName: fname, spotKey, candidate: spotIdGuess });
      continue;
    }
    if (!matched.has(spotIdGuess)) matched.set(spotIdGuess, []);
    matched.get(spotIdGuess).push({ srcName: fname, ext: ext.toLowerCase() });
  }

  // For each matched spot, allocate slot numbers based on the current
  // folder contents + any allocations we make in this run.
  const additions = [];   // [{spotId, slot, srcName, ext}]
  for (const [spotId, items] of matched) {
    const folderAbs = path.join(ASSETS_SPOTS, spotId);
    const existing = await listFiles(folderAbs);
    const allocated = [...existing];
    for (const it of items) {
      const slot = nextSlot(allocated);
      const newName = `${slot}.${it.ext}`;
      allocated.push(newName);
      additions.push({ spotId, slot, newName, srcName: it.srcName, ext: it.ext });
    }
  }

  // Copy the files (or skip on --dry-run).
  let copied = 0, skipped = 0;
  for (const a of additions) {
    const dst = path.join(ASSETS_SPOTS, a.spotId, a.newName);
    if (fsSync.existsSync(dst)) { skipped++; continue; }
    if (DRY_RUN) { copied++; continue; }
    await fs.copyFile(path.join(SOURCE, a.srcName), dst);
    copied++;
  }

  // Build a yaml-shaped report grouped by spotId for easy paste.
  const reportLines = ["# ZDK photo import — paste each spot's `photos:` block",
                       "# into content.yaml under the matching `- id: <spotId>` entry.",
                       "# If `photos:` already exists, MERGE these entries onto its end.",
                       "# Generated by scripts/import-zdk-photos.mjs.",
                       ""];
  const bySpot = new Map();
  for (const a of additions) {
    if (!bySpot.has(a.spotId)) bySpot.set(a.spotId, []);
    bySpot.get(a.spotId).push(a);
  }
  for (const [spotId, entries] of [...bySpot.entries()].sort()) {
    reportLines.push(`# spot: ${spotId}`);
    reportLines.push(`# (add to content.yaml's "- id: ${spotId}" entry)`);
    reportLines.push(`photos:`);
    for (const e of entries) {
      reportLines.push(`  - file: ${e.newName}`);
      reportLines.push(`    credit: ${CREDIT}`);
      reportLines.push(`    source_type: book`);
      reportLines.push(`    # ZDK source: ${e.srcName}`);
    }
    reportLines.push("");
  }

  if (!DRY_RUN) {
    await fs.writeFile(path.join(REPO, "scripts/zdk-import-report.yaml"), reportLines.join("\n"));
  }

  // Unmatched + missing-folder report.
  const umLines = ["# Files NOT imported. Resolve each by either (a) renaming",
                   "# the source filename, (b) creating an assets/spots/<id>/ folder",
                   "# with the right name, or (c) leaving as-is and ignoring this row.",
                   ""];
  if (missingFolders.length) {
    umLines.push("## No matching assets/spots/<spotId>/ folder");
    for (const r of missingFolders) {
      umLines.push(`  ${r.srcName}    (key=${r.spotKey}, would-have-mapped-to=${r.candidate})`);
    }
    umLines.push("");
  }
  if (unmatched.length) {
    umLines.push("## Filename did not parse");
    for (const r of unmatched) umLines.push(`  ${r.srcName}    (${r.reason})`);
  }
  if (!DRY_RUN) {
    await fs.writeFile(path.join(REPO, "scripts/zdk-import-unmatched.txt"), umLines.join("\n"));
  }

  console.log(`[zdk-import] DONE`);
  console.log(`  copied:           ${copied}`);
  console.log(`  skipped (exists): ${skipped}`);
  console.log(`  spots affected:   ${bySpot.size}`);
  console.log(`  no folder match:  ${missingFolders.length}`);
  console.log(`  did not parse:    ${unmatched.length}`);
  if (!DRY_RUN) {
    console.log(`\n  report:    scripts/zdk-import-report.yaml`);
    console.log(`  unmatched: scripts/zdk-import-unmatched.txt`);
  }
  if (missingFolders.length) {
    console.log("\n[zdk-import] First 20 unmatched (no folder):");
    for (const r of missingFolders.slice(0, 20)) {
      console.log(`  ${r.srcName}  (would-have-mapped-to ${r.candidate})`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
