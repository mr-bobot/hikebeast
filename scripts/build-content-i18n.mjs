#!/usr/bin/env node
//
// Phase-2 content i18n · STEP 3. Merges the per-chunk translation overlays
// under i18n/content/<lang>/ into one gated runtime bundle per language:
//   full/i18n/content.<lang>.json = { spots:{id:{...}}, chapters:{id:{...}}, frontMatter:{id:{...}} }
//
// social.js fetches this when the active language is not English and overlays
// the translated prose onto the statically-baked English HTML. The bundle
// lives under /full/i18n/ (NOT /full/lib/), so the auth middleware keeps it
// behind the login cookie exactly like /full/map/spots-data.js.
//
// Runs in build-all after build-i18n. A language with no overlays yet is
// skipped (no bundle emitted) so English/partial states never break.
//
//   node scripts/build-content-i18n.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "i18n", "content");
const OUT = join(ROOT, "full", "i18n");
mkdirSync(OUT, { recursive: true });
const LANGS = ["de", "fr"];

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

for (const lang of LANGS) {
  const dir = join(SRC, lang);
  if (!existsSync(dir)) { console.log(`[build-content-i18n] ${lang}: no overlays yet, skipping`); continue; }
  const bundle = { spots: {}, chapters: {}, frontMatter: {} };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const data = readJson(join(dir, file));
    if (!Array.isArray(data)) continue;
    const name = basename(file, ".json");
    if (name === "_chapters") {
      for (const c of data) if (c && c.id) bundle.chapters[c.id] = c;
    } else if (name === "_front_matter") {
      for (const f of data) if (f && f.id) bundle.frontMatter[f.id] = f;
    } else {
      for (const s of data) if (s && s.id) bundle.spots[s.id] = s;
    }
  }
  writeFileSync(join(OUT, `content.${lang}.json`), JSON.stringify(bundle));
  console.log(`[build-content-i18n] ${lang}: ${Object.keys(bundle.spots).length} spots, ${Object.keys(bundle.chapters).length} chapters, ${Object.keys(bundle.frontMatter).length} front-matter -> full/i18n/content.${lang}.json`);
}
