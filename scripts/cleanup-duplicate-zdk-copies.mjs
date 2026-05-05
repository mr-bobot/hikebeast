#!/usr/bin/env node
//
// One-shot cleanup. The import-zdk-photos script was accidentally run
// twice in a single session, so each ZDK source ended up copied to two
// different slot numbers. content.yaml only references the slots from
// the second run; the first-run slots are byte-identical orphans on
// disk. This script deletes those orphans.
//
// For each spot folder:
//   - Parse the spot's `photos:` block in content.yaml to get the list
//     of slot filenames currently in use.
//   - List the folder contents.
//   - Anything untracked-by-git that is not in that list and not
//     `main.*` is a leftover from the first run → delete.
//
// Idempotent. Safe to run repeatedly.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const CONTENT = path.join(REPO, "content.yaml");
const ASSETS_SPOTS = path.join(REPO, "assets/spots");

const DRY_RUN = process.argv.includes("--dry-run");

function listGitUntracked(folderRel) {
  try {
    const out = execSync(
      `git ls-files --others --exclude-standard "${folderRel}"`,
      { cwd: REPO, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch { return []; }
}

// Parse a single spot block from content.yaml and return the set of
// `file: <name>` values inside its photos: array.
function spotPhotoFiles(yamlText, spotId) {
  const lines = yamlText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `- id: ${spotId}`) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id:\s*\S/.test(lines[i])) { end = i; break; }
    if (/^[a-z_]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  // Find `  photos:` and gather subsequent `  - file: <name>` items.
  let photosLine = -1;
  for (let i = start + 1; i < end; i++) {
    if (/^  photos:\s*$/.test(lines[i])) { photosLine = i; break; }
  }
  if (photosLine < 0) return new Set();
  const out = new Set();
  for (let i = photosLine + 1; i < end; i++) {
    const m = lines[i].match(/^  - file:\s*(\S+)\s*$/);
    if (m) out.add(m[1]);
    else if (/^  [a-z_]+:/.test(lines[i])) break;  // next sibling key
  }
  return out;
}

async function main() {
  const yamlText = await fs.readFile(CONTENT, "utf8");
  const spotIds = (await fs.readdir(ASSETS_SPOTS)).sort();

  let toDelete = [];
  let unknownSpots = 0;

  for (const spotId of spotIds) {
    const folderAbs = path.join(ASSETS_SPOTS, spotId);
    if (!fsSync.statSync(folderAbs).isDirectory()) continue;

    const referenced = spotPhotoFiles(yamlText, spotId);
    if (referenced === null) { unknownSpots++; continue; }

    const folderRel = path.relative(REPO, folderAbs);
    const untracked = listGitUntracked(folderRel + "/");
    for (const rel of untracked) {
      const fname = path.basename(rel);
      // Keep main.* and anything referenced in yaml.
      if (/^main\./.test(fname)) continue;
      if (referenced.has(fname)) continue;
      toDelete.push(path.join(REPO, rel));
    }
  }

  console.log(`[cleanup] ${toDelete.length} file(s) to delete`);
  if (unknownSpots) console.log(`[cleanup] note: ${unknownSpots} spot folder(s) have no content.yaml entry (left alone)`);

  if (DRY_RUN) {
    for (const p of toDelete.slice(0, 10)) console.log(`  would delete  ${path.relative(REPO, p)}`);
    if (toDelete.length > 10) console.log(`  ... and ${toDelete.length - 10} more`);
    return;
  }

  for (const p of toDelete) {
    await fs.unlink(p);
  }
  console.log(`[cleanup] deleted ${toDelete.length} file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
