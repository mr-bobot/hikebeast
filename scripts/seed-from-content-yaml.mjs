#!/usr/bin/env node
//
// Idempotent seed: every kind=spot row in content.yaml becomes a Convex
// spots row, with photos[] driven by scripts/photo-manifest.json. Kind=spread
// rows merge their images into the parent spot. Kind=extras wrappers explode
// into one extras_entry row per inner entry, with no photos (TODO marker for
// the UI). Existing chapter HTML editorial wins for deck/body/specs when
// present; content.yaml is the fallback for the 17 spots not yet in the
// HTML.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/seed-from-content-yaml.mjs
//
// Re-runnable. Existing rows are patched in place; never deletes.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const CONTENT      = join(REPO, "content.yaml");
const CREDITS_YAML = join(REPO, "credits.yaml");
const WILDCAMPING  = join(REPO, "wild_camping.yaml");
const MANIFEST     = join(REPO, "scripts/photo-manifest.json");

const CHAPTERS = ["intro", "central", "valais", "fribourg", "western", "eastern", "ticino", "beyond"];

// ── env ----------------------------------------------------------------
function loadEnv() {
  const path = join(REPO, ".env.local");
  if (!existsSync(path)) throw new Error(".env.local not found -- run convex dev first");
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL || !env.ADMIN_TOKEN) throw new Error("CONVEX_URL / ADMIN_TOKEN missing");
  return env;
}

// ── helpers ------------------------------------------------------------
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = v;  // empty arrays are meaningful (e.g. photos: [] for TODO markers)
  }
  return out;
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// RGB float [0-1] triplet -> "r,g,b" int string used by the frontend tinting.
function colorString(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3) return "175,165,122";
  return rgb.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(",");
}

// ── credits resolver ---------------------------------------------------
//
// Brain rule: credit chips render `Photo · <name>` only. NO platform name
// ("Unsplash") in the credit string. Platform stays as metadata via
// sourceUrl on the photo record.
function buildCreditResolver(creditsYaml) {
  const ph  = creditsYaml?.photographers ?? {};
  const ext = creditsYaml?.external ?? {};
  return (key) => {
    if (!key) return null;
    if (key === "placeholder" || key === "xxx") return null;
    if (ph[key]) {
      // IG contributor (or author = leon.helg). Render as @handle.
      return `@${key}`;
    }
    if (ext[key]) {
      // Unsplash etc. Just the human name; never the platform.
      return ext[key].name ?? key;
    }
    // Unknown key — leave null rather than emit a broken chip.
    return null;
  };
}

// ── chapter HTML editorial extraction ---------------------------------
function chapterHtml(chapterId) {
  const path = join(REPO, "full", chapterId, "index.html");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function buildEditorialIndex() {
  const idx = {};
  const sectionRe = /<section[^>]*class="slide slide-spot"[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/section>/g;
  for (const ch of CHAPTERS) {
    const html = chapterHtml(ch);
    if (!html) continue;
    let m;
    while ((m = sectionRe.exec(html))) {
      const anchor = m[1];
      const inner  = m[2];
      const spotKey = `${ch}#${anchor}`;
      const deckM = inner.match(/<p class="sp-deck">([\s\S]*?)<\/p>/);
      const deck = deckM ? decodeEntities(deckM[1]).trim().replace(/\s+/g, " ") : undefined;
      let body, specs;
      const bodyM = inner.match(/<div class="body">([\s\S]*?)<\/div>\s*<div class="specs">/);
      if (bodyM) {
        const paras = [];
        const pRe = /<p>([\s\S]*?)<\/p>/g;
        let pm;
        while ((pm = pRe.exec(bodyM[1]))) {
          const txt = decodeEntities(pm[1]).trim().replace(/\s+/g, " ");
          if (txt) paras.push(txt);
        }
        if (paras.length) body = paras;
      }
      const specsM = inner.match(/<div class="specs">([\s\S]*?)<\/div>\s*<div class="sp-foot">/);
      if (specsM) {
        const out = [];
        const specRe = /<span class="lbl">([\s\S]*?)<\/span>\s*<span class="val">([\s\S]*?)<\/span>/g;
        let sm;
        while ((sm = specRe.exec(specsM[1]))) {
          out.push({
            label: decodeEntities(sm[1]).trim(),
            value: decodeEntities(sm[2]).trim().replace(/\s+/g, " "),
          });
        }
        if (out.length) specs = out;
      }
      idx[spotKey] = clean({ deck, body, specs });
    }
  }
  return idx;
}

// Build specs from content.yaml (region/access/effort/best_light) when chapter
// HTML doesn't have one (the 17 new spots).
function specsFromYaml(s) {
  const out = [];
  if (s.region)     out.push({ label: "Region",     value: s.region });
  if (s.access)     out.push({ label: "Access",     value: s.access });
  if (s.effort)     out.push({ label: "Effort",     value: s.effort });
  if (s.best_light) out.push({ label: "Best light", value: s.best_light });
  return out.length ? out : undefined;
}

// ── kicker -> properties map ------------------------------------------
//
// Short kickers in content.yaml are category tags ("WATERFALLS"). Long
// descriptive ones are scene-setters and have no derived property. The
// browse-page filter chips pull from `properties[]`. Hand-curated map keeps
// one canonical singular per category.
const KICKER_TO_PROPERTIES = {
  WATERFALLS:        ["Waterfall"],
  LAKES:             ["Lake"],
  "ALPINE LAKES":    ["Alpine lake"],
  "GLACIER LAKES":   ["Glacier lake"],
  SUMMITS:           ["Summit"],
  PEAKS:             ["Summit"],
  RIDGES:            ["Ridge"],
  VILLAGES:          ["Village"],
  VALLEYS:           ["Valley"],
  VIEWPOINTS:        ["Viewpoint"],
  GLACIERS:          ["Glacier"],
  BRIDGES:           ["Bridge"],
  "SUSPENSION BRIDGES": ["Suspension bridge"],
  RIVERS:            ["River"],
  "CABLE CARS":      ["Cable car"],
  "CAMPER SPOTS":    ["Camping"],
  GORGES:            ["Gorge"],
  ROADS:             ["Road"],
  WILDLIFE:          ["Wildlife"],
  LANDSCAPES:        ["Landscape"],
  REFLECTIONS:       ["Reflection"],
  CHAPELS:           ["Chapel"],
  // Labels, not categories — leave empty.
  "HIDDEN GEMS":     [],
};

function propertiesFromKicker(kicker) {
  if (!kicker) return [];
  const norm = String(kicker).trim().toUpperCase();
  if (KICKER_TO_PROPERTIES[norm] !== undefined) return KICKER_TO_PROPERTIES[norm];
  return [];  // long descriptive kicker -> no auto-property
}

// ── manifest -> photoEntry[] grouped by spotKey -----------------------
// The new build-image-derivatives writes the credit (already resolved upstream
// from content.yaml's image_credit at idx 0, or spot.photos[i-1].credit at
// idx >= 1) directly into the manifest. We just format it for the chip.
function buildPhotosBySpot(manifest, creditFor) {
  const out = new Map();  // spotKey -> [{ photoEntry, ... }]
  for (const p of manifest.photos) {
    if (!p.spotId || !p.chapter) continue;  // chapter cover derivatives have no chapter assigned
    const spotKey = `${p.chapter}#${p.spotId}`;
    if (!out.has(spotKey)) out.set(spotKey, []);

    // p.credit may be a credit-key registered in credits.yaml, an IG handle,
    // or a free-form name (unsplash photographer). Try the registry first;
    // fall back to source-type-aware formatting.
    let creditStr = null;
    if (p.credit) {
      const resolved = creditFor(p.credit);
      if (resolved) creditStr = resolved;
      else if (p.sourceType === "instagram") creditStr = `@${p.credit}`;
      else creditStr = p.credit;
    }

    out.get(spotKey).push(clean({
      photoId:   p.photoId,
      credit:    creditStr,
      sourceUrl: p.sourceUrl ?? null,
      width:     p.width,
      height:    p.height,
      order:     p.order,
    }));
  }
  for (const arr of out.values()) arr.sort((a, b) => a.order - b.order);
  return out;
}

// ── build the spot row payload (kind=spot or kind=extras_entry) -------
function buildSpotRow({ s, chapter, photos, editorial, wildVerdict, kind = "spot", origin = undefined }) {
  const chapterId = s.chapter;
  const spotKey = `${chapterId}#${s.id}`;
  return clean({
    spotKey,
    title:     s.title,
    kicker:    s.kicker,
    chapter:   chapter.number ?? "00",
    chapterId,
    lat:       s.gps?.lat,
    lon:       s.gps?.lng,  // yaml is "lng", schema is "lon"
    color:     colorString(chapter.color),
    mapsUrl:   s.maps_url,
    // href is rooted at /full/map/ (legacy sidecar convention) so that
    // pages one directory deep (saved/, swipe/, browse/, map/) can use it
    // verbatim. Pages at /full/ root strip the "../" prefix.
    href:      `../${chapterId}/index.html#${s.id}`,
    photos,
    // content.yaml is the canonical source — chapter HTML is the legacy
    // pre-Convex copy and contains "ZDK"-prefixed phrasings that violate
    // the brand voice rule. Prefer yaml; fall back to HTML only when yaml
    // is missing the field. Specs use the yaml synthesis (region/access/
    // effort/best_light) before HTML's specs.
    deck:      s.deck ?? editorial?.deck,
    body:      (s.body && s.body.length) ? s.body : editorial?.body,
    specs:     specsFromYaml(s) ?? editorial?.specs,
    kind,
    origin,
    properties: propertiesFromKicker(s.kicker),
    wildCamping: wildVerdict ? clean({
      verdict: wildVerdict.wild_camping,
      reason:  wildVerdict.reason,
    }) : undefined,
  });
}

// ── main --------------------------------------------------------------
async function main() {
  const env = loadEnv();
  const content   = yaml.load(readFileSync(CONTENT, "utf8"));
  const credits   = yaml.load(readFileSync(CREDITS_YAML, "utf8"));
  const wildY     = yaml.load(readFileSync(WILDCAMPING, "utf8"));
  const manifest  = JSON.parse(readFileSync(MANIFEST, "utf8"));

  const creditFor = buildCreditResolver(credits);
  const editorial = buildEditorialIndex();
  const wildBySpotId = Object.fromEntries((wildY?.spots ?? []).map(w => [w.id, w]));
  const chaptersById = Object.fromEntries(content.chapters.map(c => [c.id, c]));

  const photosBySpot = buildPhotosBySpot(manifest, creditFor);

  console.log(`CONVEX_URL=${env.CONVEX_URL}`);
  console.log(`Spots in content.yaml: ${content.spots.length}`);
  console.log(`Photos in manifest:    ${manifest.photos.length}`);
  console.log(`Wild-camping verdicts: ${Object.keys(wildBySpotId).length}\n`);

  const client = new ConvexHttpClient(env.CONVEX_URL);
  const stats = { created: 0, updated: 0, skipped: 0, extras: 0, withPhotos: 0, withoutPhotos: 0 };

  // Phase A — kind=spot rows (the 129)
  for (const s of content.spots) {
    if ((s.kind ?? "spot") !== "spot") continue;
    const chapter = chaptersById[s.chapter];
    if (!chapter) {
      console.warn(`  skip (unknown chapter): ${s.id} chapter=${s.chapter}`);
      stats.skipped++;
      continue;
    }
    const spotKey = `${s.chapter}#${s.id}`;
    const photos  = photosBySpot.get(spotKey) ?? [];
    if (photos.length) stats.withPhotos++; else stats.withoutPhotos++;

    const row = buildSpotRow({
      s,
      chapter,
      photos,
      editorial: editorial[spotKey],
      wildVerdict: wildBySpotId[s.id],
      kind: "spot",
    });
    const r = await client.mutation(api.spots.upsertSpot, { adminToken: env.ADMIN_TOKEN, spot: row });
    stats[r.action === "created" ? "created" : "updated"]++;
  }

  // Phase B-1 — kind=extras_entry rows (explode the 5 wrappers)
  for (const wrapper of content.spots) {
    if (wrapper.kind !== "extras") continue;
    const chapter = chaptersById[wrapper.chapter];
    const origin  = wrapper.id;  // e.g. "central_extras"
    for (const e of (wrapper.entries ?? [])) {
      const entrySlug = slugify(e.heading);
      const spotKey = `${wrapper.chapter}#${entrySlug}`;
      const row = clean({
        spotKey,
        title:     e.heading,
        kicker:    undefined,
        chapter:   chapter?.number ?? "00",
        chapterId: wrapper.chapter,
        lat:       e.gps?.lat,
        lon:       e.gps?.lng,
        color:     colorString(chapter?.color),
        mapsUrl:   e.maps_url,
        href:      `../${wrapper.chapter}/index.html#${entrySlug}`,
        photos:    [],  // TODO marker — UI shows "no photo yet"
        deck:      e.text,
        kind:      "extras_entry",
        origin,
      });
      const r = await client.mutation(api.spots.upsertSpot, { adminToken: env.ADMIN_TOKEN, spot: row });
      stats[r.action === "created" ? "created" : "updated"]++;
      stats.extras++;
    }
  }

  // Phase B-2 — verify spread merging happened correctly. The build
  // script already assigned the spread's photoIds under the parent's
  // spotId, so phase A above already wrote them. Here we just sanity-check.
  const spreadParents = new Set();
  for (const s of content.spots) {
    if (s.kind !== "spread") continue;
    const parentId = s.id.replace(/_ridge_line_spread$/i, "").replace(/_spread$/i, "");
    spreadParents.add(`${s.chapter}#${parentId}`);
  }
  console.log(`\nSpread parents to verify: ${[...spreadParents].join(", ")}`);

  console.log(`\nDONE.`);
  console.log(`  spots upserts: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`);
  console.log(`  with photos:    ${stats.withPhotos}`);
  console.log(`  without photos: ${stats.withoutPhotos}  (TODO markers — kind=spot but no source image yet)`);
  console.log(`  extras_entry rows exploded: ${stats.extras}`);
  console.log(`\nVerify counts:`);
  console.log(`  PATH="/opt/homebrew/opt/node@20/bin:$PATH" node node_modules/convex/dist/cli.bundle.cjs run spots:list | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r),'rows'); print(sum(1 for x in r if x.get(chr(34)+'kind'+chr(34))==chr(34)+'extras_entry'+chr(34)),'extras_entry')"`);
}

main().catch(err => { console.error(err); process.exit(1); });
