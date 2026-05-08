// One-shot cleanup: deletes Convex spots rows that no longer exist in
// content.yaml after the 2026-05-08 restructure (9 renames + 12 merges
// + 2 deletes). Idempotent — re-running is a no-op once the rows are
// gone.
//
//   node scripts/delete-orphan-spots.mjs --env local

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const argv = process.argv.slice(2);
  let envName = "local";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) { envName = argv[i + 1]; i++; }
  }
  if (process.env.CONVEX_URL && process.env.ADMIN_TOKEN) {
    return { CONVEX_URL: process.env.CONVEX_URL, ADMIN_TOKEN: process.env.ADMIN_TOKEN };
  }
  const path = join(ROOT, `.env.${envName}`);
  if (!existsSync(path)) throw new Error(`.env.${envName} not found at ${path}`);
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL)  throw new Error(`CONVEX_URL missing from .env.${envName}`);
  if (!env.ADMIN_TOKEN) throw new Error(`ADMIN_TOKEN missing from .env.${envName}`);
  return env;
}

// 23 spotKeys that no longer have a counterpart in content.yaml.
const ORPHANS = [
  // Renames (9): old key → new key in restructure
  "central#lake_thun_road",          // → viewpoint_beatenberg
  "central#schilthorn",              // → piz_gloria
  "valais#the_ghost_town",           // → zermatt_huts
  "valais#the_flooded_forest",       // → lac_de_derborence
  "fribourg#latine_canyon",          // → la_tine_canyon
  "western#the_jungle_waterfall",    // → gorges_du_chauderon
  "eastern#the_swiss_dolomites",     // → urnerboden
  "eastern#swiss_grand_canyon",      // → ruinaulta
  "western#morcles_road",            // → route_de_morcles
  "eastern#stoss_kirche",            // → stoos_kapelle
  "central#rosenlaui_secret_waterfall", // → rosenlauifall

  // Merges (10): folded into a parent spot
  "valais#moiry_from_above",         // → moiry_glacier
  "valais#the_ice_cave_by_night",    // → the_ice_cave
  "fribourg#winter_schwarzsee",      // → schwarzsee
  "western#creux_du_van_ibex",       // → creux_du_van
  "ticino#valle_verzasca_kayak",     // → valle_verzasca
  "beyond#mer_de_glace_winter",      // → mer_de_glace
  "beyond#les_drus_winter",          // → les_drus
  "beyond#french_sharp_peaks",       // → les_drus
  "beyond#mighty_range",             // → les_cheserys
  "beyond#aiguille_rouge_reserve",   // → les_cheserys

  // Hard deletes (2)
  "valais#stafelwald_wildlife",
  "western#vevey_docks",
];

async function main() {
  const env = loadEnv();
  console.log(`CONVEX_URL=${env.CONVEX_URL}`);
  console.log(`Deleting ${ORPHANS.length} orphan spot rows...\n`);

  const client = new ConvexHttpClient(env.CONVEX_URL);
  let deleted = 0, noop = 0;

  for (const spotKey of ORPHANS) {
    const result = await client.mutation(api.spots.deleteBySpotKey, {
      spotKey,
      adminToken: env.ADMIN_TOKEN,
    });
    if (result.action === "deleted") {
      deleted++;
      console.log(`  deleted: ${spotKey}`);
    } else {
      noop++;
      console.log(`  noop (already gone): ${spotKey}`);
    }
  }

  console.log(`\n${deleted} deleted, ${noop} no-op.`);
}

main().catch(err => { console.error(err); process.exit(1); });
