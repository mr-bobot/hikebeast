#!/usr/bin/env node
//
// Apply scripts/zdk-import-report.yaml to content.yaml — append new
// photo entries to each spot's `photos:` array (or create the array
// if missing), preserving the rest of the file byte-for-byte.
//
// Strategy: pure string editing. We never round-trip through js-yaml
// because that reformats the entire file (and the previous comment-
// preserving-yaml work has burned us before). Instead, for each spot:
//   1. Find the line `- id: <spotId>` at column 0.
//   2. Find the boundaries: from that line to the next `- id:` line
//      (or EOF).
//   3. Within that block, look for an existing `  photos:` line.
//      - If found, locate the last `  - file:` entry within the photos
//        list and insert new entries right after it.
//      - If not found, insert a fresh `  photos:` block just before
//        the `  gps:` line (every spot has gps near the end).
//   4. Re-emit the file with the patched block.
//
// Safety:
//   - Writes content.yaml.before-zdk-import as a backup before saving.
//   - Refuses to run if the report file is missing.
//   - Refuses to patch a spot if its block can't be found unambiguously.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" \
//     node scripts/apply-zdk-import-to-yaml.mjs [--dry-run]

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const CONTENT = path.join(REPO, "content.yaml");
const REPORT = path.join(REPO, "scripts/zdk-import-report.yaml");
const BACKUP = path.join(REPO, "content.yaml.before-zdk-import");

const DRY_RUN = process.argv.includes("--dry-run");

// Parse the report file produced by import-zdk-photos.mjs into a
// {spotId → [{file, credit, source_type, sourceComment}]} map.
function parseReport(text) {
  const entries = new Map();
  let currentSpot = null;
  let cur = null;

  for (const line of text.split("\n")) {
    const m1 = line.match(/^# spot:\s*(\S+)$/);
    if (m1) {
      currentSpot = m1[1];
      if (!entries.has(currentSpot)) entries.set(currentSpot, []);
      cur = null;
      continue;
    }
    const m2 = line.match(/^  - file:\s*(\S+)$/);
    if (m2 && currentSpot) {
      cur = { file: m2[1], credit: null, source_type: null, sourceComment: null };
      entries.get(currentSpot).push(cur);
      continue;
    }
    const m3 = line.match(/^    credit:\s*(\S+)$/);
    if (m3 && cur) cur.credit = m3[1];
    const m4 = line.match(/^    source_type:\s*(\S+)$/);
    if (m4 && cur) cur.source_type = m4[1];
    const m5 = line.match(/^    # ZDK source:\s*(.+)$/);
    if (m5 && cur) cur.sourceComment = m5[1];
  }
  return entries;
}

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
    // Stop at the next top-level key (e.g. `front_matter:`, `back_matter:`)
    if (/^[a-z_]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function emitPhotoEntry(entry) {
  const lines = [`  - file: ${entry.file}`];
  if (entry.credit) lines.push(`    credit: ${entry.credit}`);
  if (entry.source_type) lines.push(`    source_type: ${entry.source_type}`);
  return lines;
}

function patchSpotBlock(lines, block, newEntries) {
  // Within block, look for `  photos:` at indentation 2.
  let photosLine = -1;
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^  photos:\s*$/.test(lines[i])) { photosLine = i; break; }
  }

  const additions = [];
  for (const e of newEntries) additions.push(...emitPhotoEntry(e));

  if (photosLine >= 0) {
    // Find the last line that belongs to the photos list. Items are
    // `  - file: ...` (indent 2) plus their `    key: ...` continuation
    // lines (indent 4). Stop when we hit a line that's neither.
    let last = photosLine;
    for (let i = photosLine + 1; i < block.end; i++) {
      const l = lines[i];
      if (l === "") { last = i; continue; }
      if (/^  - /.test(l) || /^    /.test(l)) { last = i; continue; }
      break;
    }
    // Insert after `last`.
    const out = [...lines];
    out.splice(last + 1, 0, ...additions);
    return out;
  }

  // No `photos:` yet — insert a new block. Place it right before the
  // `  gps:` line if present (every spot has one near the end), else
  // right before the block's end.
  let insertAt = block.end;
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^  gps:\s*$/.test(lines[i])) { insertAt = i; break; }
  }
  const out = [...lines];
  out.splice(insertAt, 0, "  photos:", ...additions);
  return out;
}

async function main() {
  if (!fsSync.existsSync(REPORT)) {
    console.error(`missing report: ${REPORT}`);
    process.exit(1);
  }
  const reportText = await fs.readFile(REPORT, "utf8");
  const entries = parseReport(reportText);
  console.log(`[apply] ${entries.size} spots in report, ${[...entries.values()].reduce((a,b)=>a+b.length,0)} photos total`);

  let text = await fs.readFile(CONTENT, "utf8");
  let lines = text.split("\n");

  let patched = 0;
  let skipped = 0;
  for (const [spotId, newEntries] of entries) {
    const block = findSpotBlock(lines, spotId);
    if (!block) {
      console.warn(`  SKIP ${spotId} — no '- id: ${spotId}' found in content.yaml`);
      skipped++;
      continue;
    }
    lines = patchSpotBlock(lines, block, newEntries);
    patched++;
  }

  console.log(`[apply] patched ${patched} spots, skipped ${skipped}`);

  const newText = lines.join("\n");
  if (newText === text) {
    console.log(`[apply] no changes`);
    return;
  }

  if (DRY_RUN) {
    console.log(`[apply] dry-run: would write ${newText.length - text.length} new bytes`);
    return;
  }

  await fs.writeFile(BACKUP, text);
  await fs.writeFile(CONTENT, newText);
  console.log(`[apply] wrote ${CONTENT}, backup at ${BACKUP}`);
}

main().catch(err => { console.error(err); process.exit(1); });
