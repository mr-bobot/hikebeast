#!/usr/bin/env node
//
// Phase-2 content i18n · STEP 1 of the translation pipeline.
//
// Extracts the *translatable* spot / front-matter / chapter fields from
// content.yaml into small per-chunk English source files under
// i18n/content/_source/, so the translation agents each read a ~one-chapter
// chunk instead of the whole 258 KB content.yaml. Numbers, grades, ids,
// coordinates, image paths etc. are intentionally left out — only prose.
//
//   node scripts/extract-i18n-source.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const content = yaml.load(readFileSync(join(ROOT, "content.yaml"), "utf8"));
const OUT = join(ROOT, "i18n", "content", "_source");
mkdirSync(OUT, { recursive: true });

function spotFields(s) {
  const o = { id: s.id, title: s.title };
  if (s.kicker) o.kicker = s.kicker;
  if (s.deck) o.deck = s.deck;
  if (Array.isArray(s.body) && s.body.length) o.body = s.body;
  if (s.subheadline) o.subheadline = s.subheadline;
  const specs = {};
  for (const k of ["region", "access", "effort", "best_light"]) if (s[k]) specs[k] = s[k];
  if (Object.keys(specs).length) o.specs = specs;
  return o;
}

// Spots grouped by chapter (kind=spot only; extras rollups skipped for now).
const byChapter = {};
for (const s of (content.spots || [])) {
  if ((s.kind || "spot") !== "spot") continue;
  const ch = s.chapter || "_unchaptered";
  (byChapter[ch] ||= []).push(spotFields(s));
}
let n = 0;
const chunks = [];
for (const [ch, list] of Object.entries(byChapter)) {
  writeFileSync(join(OUT, `${ch}.json`), JSON.stringify(list, null, 2) + "\n");
  chunks.push(`${ch} (${list.length})`);
  n += list.length;
}

// Front matter (ethos/plan/camping/map_summary cards).
const fm = (content.front_matter || []).map((f) => {
  const o = { id: f.id };
  if (f.kicker) o.kicker = f.kicker;
  if (f.title) o.title = f.title;
  if (f.deck) o.deck = f.deck;
  if (Array.isArray(f.body) && f.body.length) o.body = f.body;
  if (Array.isArray(f.columns)) o.columns = f.columns.map((c) => ({ heading: c.heading, text: c.text }));
  return o;
});
writeFileSync(join(OUT, "_front_matter.json"), JSON.stringify(fm, null, 2) + "\n");

// Chapter cover name + intro.
const chapters = (content.chapters || []).map((c) => ({ id: c.id, name: c.name, intro: c.intro }));
writeFileSync(join(OUT, "_chapters.json"), JSON.stringify(chapters, null, 2) + "\n");

console.log(`[extract-i18n-source] ${n} spots across ${Object.keys(byChapter).length} chapters: ${chunks.join(", ")}`);
console.log(`[extract-i18n-source] + _front_matter (${fm.length}) + _chapters (${chapters.length}) -> ${OUT}`);
