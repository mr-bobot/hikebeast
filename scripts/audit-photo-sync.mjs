// audit-photo-sync.mjs — find every Convex `spots` row whose photos
// reference derivative WebPs that aren't shipped to disk yet.
//
// Cause: admin adds photos in another session (Convex admin UI / Submit
// Photo flow) and saves `photoId: "<id>_pN"`, but the JPEG / WebP ladder
// under full/img/derivatives/<photoId>/ doesn't exist yet. The carousel
// renders the slide, the <img> 404s, and the user sees a broken image
// even though the counter says "N / M".
//
// Usage:
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/audit-photo-sync.mjs           # prod
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/audit-photo-sync.mjs --env staging
//
// The script is read-only — it never writes to Convex. It prints:
//   1. A per-spot list of broken photos with their photoId / staticPath
//      so you know exactly which derivatives to build (or which photo
//      rows to delete).
//   2. A summary count + the recommended next step.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DERIVATIVES_DIR = join(ROOT, "full", "img", "derivatives");
const STATIC_M_DIR = join(ROOT, "full", "img", "m");

function loadEnv() {
  const argv = process.argv.slice(2);
  let envName = "local";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) { envName = argv[i + 1]; i++; }
  }
  if (process.env.CONVEX_URL) return { CONVEX_URL: process.env.CONVEX_URL };
  const path = join(ROOT, `.env.${envName}`);
  if (!existsSync(path)) {
    throw new Error(`.env.${envName} not found at ${path} — pass --env <name> or set CONVEX_URL in process.env`);
  }
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL) throw new Error(`CONVEX_URL missing from .env.${envName}`);
  return env;
}

// A photo entry is OK if at least one of the URLs the frontend would
// resolve points at a file on disk:
//   - photoId -> full/img/derivatives/<photoId>/w1800.webp (preferred)
//   - staticPath (derivative-style) -> full/img/derivatives/<id>/<file>
//   - staticPath (legacy) -> full/img/<file> or full/img/m/<file>
function photoExistsOnDisk(p) {
  if (p.photoId) {
    return existsSync(join(DERIVATIVES_DIR, p.photoId, "w1800.webp"));
  }
  if (p.staticPath) {
    const m = p.staticPath.match(/^derivatives\/([^/]+)\//);
    if (m) return existsSync(join(DERIVATIVES_DIR, m[1], "w1800.webp"));
    // Legacy flat file under full/img/ or full/img/m/.
    if (existsSync(join(ROOT, "full", "img", p.staticPath))) return true;
    if (existsSync(join(STATIC_M_DIR, p.staticPath))) return true;
  }
  if (p.storageId) return true; // Convex blob storage — out of scope here
  return false;
}

const { CONVEX_URL } = loadEnv();
const client = new ConvexHttpClient(CONVEX_URL);

console.log(`Auditing ${CONVEX_URL} against ${DERIVATIVES_DIR}\n`);
const spots = await client.query("spots:list", {});

let brokenSpots = 0;
let brokenPhotos = 0;
const fixHints = [];

for (const spot of spots.sort((a, b) => a.spotKey.localeCompare(b.spotKey))) {
  const photos = spot.photos || [];
  const missing = [];
  photos.forEach((p, idx) => {
    if (!photoExistsOnDisk(p)) {
      missing.push({ idx, photoId: p.photoId, staticPath: p.staticPath, credit: p.credit });
    }
  });
  if (!missing.length) continue;
  brokenSpots++;
  brokenPhotos += missing.length;
  console.log(`✗  ${spot.spotKey}  (${missing.length}/${photos.length} broken)`);
  for (const m of missing) {
    const path = m.photoId
      ? `derivatives/${m.photoId}/w1800.webp`
      : (m.staticPath || "(no path)");
    console.log(`     [${m.idx}] ${path}${m.credit ? `  · ${m.credit}` : ""}`);
  }
  fixHints.push(spot.spotKey);
}

console.log(`\n— Summary —`);
console.log(`Spots with at least one broken photo: ${brokenSpots}`);
console.log(`Total broken photo rows:              ${brokenPhotos}`);

if (brokenSpots > 0) {
  console.log(`\nNext steps:`);
  console.log(`  A. If the JPEGs ARE on your local disk under assets/spots/<spotId>/`);
  console.log(`     and you just forgot to build derivatives, run:`);
  console.log(`       PATH="/opt/homebrew/opt/node@20/bin:$PATH" npm run build`);
  console.log(`     Then commit + push.`);
  console.log(`  B. If the photos shouldn't exist (added by mistake), delete the photo rows:`);
  console.log(`       Edit them in the Convex admin UI, or write a one-off mutation.`);
  console.log(`  C. If the photos live ONLY in Convex blob storage (storageId), they`);
  console.log(`     aren't reachable from this audit's disk check — they'll resolve at`);
  console.log(`     runtime via Convex Storage URLs. Out of scope here.`);
}
