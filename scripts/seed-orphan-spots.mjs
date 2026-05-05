#!/usr/bin/env node
//
// Creates three new Convex spot rows for orphan photos that were sitting in
// new_photos.yaml's `unmapped:` bucket because content.yaml had no entry
// for them. Editorial copy is hand-written here (not lifted from any
// existing source) per house rules.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/seed-orphan-spots.mjs
//
// Idempotent. Re-runs patch in place.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const MANIFEST = join(REPO, "scripts/photo-manifest.json");

function loadEnv() {
  const path = join(REPO, ".env.local");
  if (!existsSync(path)) throw new Error(".env.local not found");
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL || !env.ADMIN_TOKEN) throw new Error("CONVEX_URL / ADMIN_TOKEN missing");
  return env;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ── Spec for the three orphan spots ──────────────────────────────────
//
// All editorial copy below is hand-written for the webapp. Photo credits
// + sourceUrl are pulled from the manifest. GPS notes:
//   - Chauderon  : found in input/locations.yaml
//   - Zinal      : not in locations.yaml; coords below come from
//                  the ZDK_71 photo guide notes (cave at the head of the
//                  Zinal valley; parking is at 46.127840, 7.629728)
//   - Derborence : not in either source. Coords below are a best-guess
//                  for Lac de Derborence and should be confirmed.
const ORPHANS = [
  {
    spotKey:    "valais#zinal_glacier",
    photoIdPrefix: "valais_zinal_glacier",
    photoCount: 2,
    title:      "Zinal Glacier",
    kicker:     "GLACIERS",
    chapter:    "02",
    chapterId:  "valais",
    color:      "235,184,191",
    lat:        46.071559,
    lon:        7.632709,
    mapsUrl:    "https://www.google.com/maps/search/?api=1&query=46.071559,7.632709",
    href:       "../valais/index.html#zinal_glacier",
    deck:       "An ice cave at the head of the Zinal valley. Open in winter, dangerous in spring.",
    body: [
      "Park at the end of Zinal village (46.127840, 7.629728). From there the valley path runs south for around two hours, hugging the river toward the toe of the glacier.",
      "Conditions matter. The cave only stays put when temperatures stay cold. Warm spells thin the roof, and the approach crosses avalanche terrain. Check the bulletin and pick a cold, settled day.",
      "Inside, the light goes blue. Wide lens for the tunnel, crampons for the floor, headlamp and tripod for the dark sections. The shape changes from one winter to the next.",
    ],
    specs: [
      { label: "Region",     value: "Zinal, Valais" },
      { label: "Access",     value: "About 2h hike from Zinal village" },
      { label: "Effort",     value: "Moderate, technical in winter" },
      { label: "Best light", value: "Midday in deep winter" },
    ],
    properties: ["Glacier"],
  },
  {
    // SpotKey matches the extras_entry slug content.yaml already produces
    // for "LAC DE DERBORENCE", so this UPSERT promotes the placeholder
    // into a real spot rather than creating a duplicate row.
    spotKey:    "valais#lac_de_derborence",
    photoIdPrefix: "valais_lac_de_derborence",
    photoCount: 2,
    title:      "Derborence Lake",
    kicker:     "ALPINE LAKES",
    chapter:    "02",
    chapterId:  "valais",
    color:      "235,184,191",
    // GPS intentionally undefined — Lac de Derborence wasn't in
    // locations.yaml or ZDK_71 and the user asked us not to guess. The
    // spot still renders on browse / chapter pages; it's just absent
    // from the map until coords are added.
    lat:        undefined,
    lon:        undefined,
    mapsUrl:    "https://www.google.com/maps/search/?api=1&query=Lac+de+Derborence",
    href:       "../valais/index.html#lac_de_derborence",
    deck:       "An alpine lake born from two landslides in the 1700s. Quiet, dark green, rimmed by cliffs.",
    body: [
      "The road climbs up from the Rhone valley above Conthey and dead-ends at the lake car park. From there a flat path runs around the shore.",
      "On the eastern bank, dead trees still stand in the water. They photograph best from a low angle, on a still morning before the wind picks up.",
      "Afternoons are good for the cliffs above the water. Bring a polariser if the sun is out, the surface goes very reflective.",
    ],
    specs: [
      { label: "Region",     value: "Conthey, Valais" },
      { label: "Access",     value: "Drive to the lake car park, flat paths around the shore" },
      { label: "Effort",     value: "Easy" },
      { label: "Best light", value: "Calm morning" },
    ],
    properties: ["Alpine lake"],
  },
  {
    spotKey:    "western#gorges_du_chauderon",
    photoIdPrefix: "western_gorges_du_chauderon",
    photoCount: 3,
    title:      "Gorges du Chauderon",
    kicker:     "GORGES",
    chapter:    "04",
    chapterId:  "western",
    color:      "204,224,158",
    lat:        46.4368563,
    lon:        6.9250077,
    mapsUrl:    "https://www.google.com/maps/place/Gorges+du+Chauderon/@46.4368563,6.9250077,17z",
    href:       "../western/index.html#gorges_du_chauderon",
    deck:       "Steep limestone canyon above Montreux. Tropical green when it rains.",
    body: [
      "The path drops in from above Montreux. It is slick after rain, so non-slip shoes are mandatory and tripod legs need their feet planted carefully.",
      "There is a waterfall on the lower section, harder to spot from the trail. Easier to scout with a drone before committing to the hike down.",
      "Late spring through summer is best, when the canyon stays moody and the moss is dialled up. After heavy rain the volume picks up and the place takes on a tropical feel.",
    ],
    specs: [
      { label: "Region",     value: "Montreux, Vaud" },
      { label: "Access",     value: "Hike in from above Montreux" },
      { label: "Effort",     value: "Moderate, slippery when wet" },
      { label: "Best light", value: "Overcast or after rain" },
    ],
    properties: ["Gorge", "Waterfall"],
  },
  // === New spots from /input/oli und unsplashed/ ===
  // Photos seed via build-image-derivatives.mjs's WEBAPP_EXTRA_PHOTOS map;
  // editorial / GPS / specs intentionally LEFT BLANK — Leon will fill in.
  // (Brain TODO.md tracks the open work.)
  {
    spotKey:    "central#brisen",
    photoIdPrefix: "central_brisen",
    photoCount: 1,
    title:      "Brisen",
    kicker:     "RIDGES",
    chapter:    "01",
    chapterId:  "central",
    color:      "176,166,122",
    lat:        undefined,
    lon:        undefined,
    href:       "../central/index.html#brisen",
    body:       [],
    specs:      [],
    properties: [],
  },
  {
    spotKey:    "central#engstlensee",
    photoIdPrefix: "central_engstlensee",
    photoCount: 1,
    title:      "Engstlensee",
    kicker:     "ALPINE LAKES",
    chapter:    "01",
    chapterId:  "central",
    color:      "176,166,122",
    lat:        undefined,
    lon:        undefined,
    href:       "../central/index.html#engstlensee",
    body:       [],
    specs:      [],
    properties: [],
  },
  {
    spotKey:    "eastern#maloja_pass",
    photoIdPrefix: "eastern_maloja_pass",
    photoCount: 1,
    title:      "Maloja Pass",
    kicker:     "ROADS",
    chapter:    "05",
    chapterId:  "eastern",
    color:      "125,181,168",
    lat:        undefined,
    lon:        undefined,
    href:       "../eastern/index.html#maloja_pass",
    body:       [],
    specs:      [],
    properties: [],
  },
  {
    spotKey:    "ticino#ponte_tibetano",
    photoIdPrefix: "ticino_ponte_tibetano",
    photoCount: 1,
    title:      "Ponte Tibetano Carasc",
    kicker:     "SUSPENSION BRIDGES",
    chapter:    "06",
    chapterId:  "ticino",
    color:      "148,133,186",
    lat:        undefined,
    lon:        undefined,
    href:       "../ticino/index.html#ponte_tibetano",
    body:       [],
    specs:      [],
    properties: [],
  },
];

async function main() {
  const env = loadEnv();
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const photoByPhotoId = Object.fromEntries(manifest.photos.map(p => [p.photoId, p]));
  const client = new ConvexHttpClient(env.CONVEX_URL);

  console.log(`Seeding ${ORPHANS.length} orphan spots into ${env.CONVEX_URL}\n`);
  const stats = { created: 0, updated: 0 };

  for (const o of ORPHANS) {
    const photos = [];
    for (let i = 0; i < o.photoCount; i++) {
      const pid = `${o.photoIdPrefix}_p${i}`;
      const m = photoByPhotoId[pid];
      if (!m) {
        console.warn(`  WARN ${pid} not in manifest, skipping`);
        continue;
      }
      // Credit formatting per house rules:
      // - instagram contributors -> @<handle>
      // - unsplash               -> <name>  (no platform name)
      let creditStr = null;
      if (m.sourceType === "instagram" && m.credit) creditStr = `@${m.credit}`;
      else if (m.sourceType === "unsplash" && m.credit) creditStr = m.credit;
      photos.push(clean({
        photoId:   pid,
        credit:    creditStr,
        sourceUrl: m.sourceUrl,
        width:     m.width,
        height:    m.height,
        order:     i,
      }));
    }
    if (!photos.length) {
      console.warn(`  WARN ${o.spotKey} has no resolvable photos, skipping`);
      continue;
    }
    const row = clean({
      spotKey:   o.spotKey,
      title:     o.title,
      kicker:    o.kicker,
      chapter:   o.chapter,
      chapterId: o.chapterId,
      lat:       o.lat,
      lon:       o.lon,
      color:     o.color,
      mapsUrl:   o.mapsUrl,
      href:      o.href,
      photos,
      deck:      o.deck,
      body:      o.body,
      specs:     o.specs,
      kind:      "spot",
      properties: o.properties,
    });
    const r = await client.mutation(api.spots.upsertSpot, { adminToken: env.ADMIN_TOKEN, spot: row });
    stats[r.action === "created" ? "created" : "updated"]++;
    console.log(`  ${r.action.toUpperCase().padEnd(7)} ${o.spotKey}  photos=${photos.length}`);
  }

  console.log(`\nDONE. ${stats.created} created, ${stats.updated} updated.`);
}

main().catch(err => { console.error(err); process.exit(1); });
