// One-shot (idempotent) migration: every catalogued spot in
// full/map/spots-data.js gets a Convex `spots` row, with its primary photo
// + any extras from full/img/spot-images.js folded into a single photos[]
// array.
//
//   node scripts/migrate-spots-to-convex.mjs
//
// Re-runnable: upsertSpot replaces existing rows in place. After this
// runs successfully once, the deprecated `galleries` table data can be
// cleared via `npx convex run spots:dropDeprecatedGalleries '{...}'`.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- Load env from .env.local (default) or .env.<name> when --env <name>
//     is passed. Lets the same script seed prod or any sandbox deployment
//     without temporarily juggling .env.local files. process.env always wins
//     if both CONVEX_URL and ADMIN_TOKEN are already set on the caller.
function loadEnv() {
  const argv = process.argv.slice(2);
  let envName = "local";  // default → .env.local
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) { envName = argv[i + 1]; i++; }
  }
  // process.env override path: caller already exported the values.
  if (process.env.CONVEX_URL && process.env.ADMIN_TOKEN) {
    return {
      CONVEX_URL:  process.env.CONVEX_URL,
      ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    };
  }
  const path = join(ROOT, `.env.${envName}`);
  if (!existsSync(path)) {
    throw new Error(`.env.${envName} not found at ${path} — pass --env <name> or set CONVEX_URL + ADMIN_TOKEN in process.env`);
  }
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL)  throw new Error(`CONVEX_URL missing from .env.${envName}`);
  if (!env.ADMIN_TOKEN) throw new Error(`ADMIN_TOKEN missing from .env.${envName}`);
  return env;
}

// --- Parse spots-data.js (catalog) --------------------------------------
function loadCatalog() {
  const src = readFileSync(join(ROOT, "full", "map", "spots-data.js"), "utf8");
  const m = src.match(/window\.SPOTS\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("Could not parse window.SPOTS from spots-data.js");
  return JSON.parse(m[1]);
}

// --- Parse spot-images.js (multi-photo extras) --------------------------
function loadGalleries() {
  const path = join(ROOT, "full", "img", "spot-images.js");
  if (!existsSync(path)) return {};
  const src = readFileSync(path, "utf8");
  const m = src.match(/window\.HB_SPOT_IMAGES\s*=\s*(\{[\s\S]*\});\s*$/m);
  if (!m) return {};
  return JSON.parse(m[1]);
}

// Decode the small set of HTML entities Leon uses in spot copy. Saves
// pulling in a full HTML parser for an otherwise simple extraction.
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

const CHAPTERS = ["intro", "central", "valais", "fribourg", "western", "eastern", "ticino", "beyond"];

function chapterHtml(chapterId) {
  const path = join(ROOT, "full", chapterId, "index.html");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// Pull the credit pill from each chapter card so the primary photo's
// credit gets carried into Convex without per-spot manual entry.
function buildCreditIndex() {
  const credits = {};
  for (const ch of CHAPTERS) {
    const html = chapterHtml(ch);
    if (!html) continue;
    const re = /<section[^>]*class="slide slide-spot"[^>]*id="(\w+)"[^>]*>[\s\S]*?<span class="credit-pill">Photo\s*·?\s*([^<]+)<\/span>/g;
    let m;
    while ((m = re.exec(html))) {
      credits[`${ch}#${m[1]}`] = m[2].trim();
    }
  }
  return credits;
}

// Extract editorial content (deck, body paragraphs, specs) from each spot
// section in the chapter HTML. Output keyed by spotKey.
function buildEditorialIndex() {
  const idx = {};
  // Outer regex isolates one <section class="slide slide-spot" id="…">…</section> at a time.
  const sectionRe = /<section[^>]*class="slide slide-spot"[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/section>/g;
  for (const ch of CHAPTERS) {
    const html = chapterHtml(ch);
    if (!html) continue;
    let m;
    while ((m = sectionRe.exec(html))) {
      const anchor = m[1];
      const inner  = m[2];
      const spotKey = `${ch}#${anchor}`;

      // Deck: the lead sentence directly under the title.
      const deckM = inner.match(/<p class="sp-deck">([\s\S]*?)<\/p>/);
      const deck = deckM ? decodeEntities(deckM[1]).trim().replace(/\s+/g, " ") : undefined;

      // Body paragraphs: everything inside <div class="body">…</div>
      let body = undefined;
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

      // Specs: each <div class="spec"><span class="lbl">…</span><span class="val">…</span></div>
      let specs = undefined;
      const specsM = inner.match(/<div class="specs">([\s\S]*?)<\/div>\s*<div class="sp-foot">/);
      if (specsM) {
        const specRe = /<span class="lbl">([\s\S]*?)<\/span>\s*<span class="val">([\s\S]*?)<\/span>/g;
        const out = [];
        let sm;
        while ((sm = specRe.exec(specsM[1]))) {
          out.push({
            label: decodeEntities(sm[1]).trim(),
            value: decodeEntities(sm[2]).trim().replace(/\s+/g, " "),
          });
        }
        if (out.length) specs = out;
      }

      idx[spotKey] = { deck, body, specs };
    }
  }
  return idx;
}

// --- Build the photos[] array for one spot ------------------------------
// Order: primary first (from spots-data.js), then any extras from the
// gallery sidecar that aren't already the primary. Placeholder spots get
// a single placeholder entry so the row still has photos[] >= 1; the
// frontend filters via HB.hasRealImage.
// Convex's `v.optional(v.string())` accepts string-or-undefined, never
// null. Helper drops keys that are nullish so we don't accidentally trip
// the validator with a literal null credit.
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function buildPhotos(spot, gallery, primaryCredit, now) {
  const out = [];
  const seen = new Set();
  if (spot.image) {
    out.push(clean({
      staticPath: spot.image,
      credit:     primaryCredit,
      order:      0,
      addedAt:    now,
    }));
    seen.add(spot.image);
  }
  for (const extra of (gallery || [])) {
    if (!extra.src || seen.has(extra.src)) continue;
    seen.add(extra.src);
    out.push(clean({
      staticPath: extra.src,
      credit:     extra.credit ?? primaryCredit,
      order:      out.length,
      addedAt:    now,
    }));
  }
  return out;
}

// --- Run ----------------------------------------------------------------
async function main() {
  const env = loadEnv();
  const spots = loadCatalog();
  const galleries = loadGalleries();
  const credits = buildCreditIndex();
  const editorial = buildEditorialIndex();

  console.log(`CONVEX_URL=${env.CONVEX_URL}`);
  console.log(`Migrating ${spots.length} spots (${Object.keys(galleries).length} multi-photo, ${Object.keys(editorial).length} with editorial)\n`);

  const client = new ConvexHttpClient(env.CONVEX_URL);
  const now = Date.now();
  let created = 0, updated = 0, totalPhotos = 0;

  for (const s of spots) {
    const anchor = (s.href || "").split("#")[1];
    if (!anchor) {
      console.warn(`  skip (no anchor): ${s.title}`);
      continue;
    }
    const spotKey = `${s.chapter_id}#${anchor}`;
    const photos = buildPhotos(s, galleries[spotKey], credits[spotKey], now);
    if (!photos.length) {
      console.warn(`  skip (no photos): ${spotKey} ${s.title}`);
      continue;
    }
    const ed = editorial[spotKey] || {};
    const result = await client.mutation(api.spots.upsertSpot, {
      adminToken: env.ADMIN_TOKEN,
      spot: clean({
        spotKey,
        title:     s.title,
        kicker:    s.kicker,
        chapter:   s.chapter,
        chapterId: s.chapter_id,
        lat:       s.lat,
        lon:       s.lon,
        color:     s.color,
        mapsUrl:   s.maps_url,
        href:      s.href,
        photos,
        deck:      ed.deck,
        body:      ed.body,
        specs:     ed.specs,
      }),
    });
    if (result.action === "created") created++; else updated++;
    totalPhotos += photos.length;
  }

  console.log(`${created} created, ${updated} updated. ${totalPhotos} photos total.`);
  console.log(`Verify: npx convex run spots:list | grep -c spotKey`);
}

main().catch(err => { console.error(err); process.exit(1); });
