#!/usr/bin/env node
//
// Builds the derivative ladder for every photo we have on disk and writes a
// manifest the Convex seed script then consumes.
//
// Inputs:
//   - /Users/lost/Documents/Claude/Projects/Hiking Influencer/rebuild/content.yaml
//   - /Users/lost/Documents/Claude/Projects/Hiking Influencer/rebuild/new_photos.yaml
//   - rebuild/images-full/<spot.image>      (primaries + spread images)
//   - input/NEW_Photos/<file>               (carousel extras, index >= 1)
//
// Outputs:
//   - full/img/derivatives/<photoId>/{w160,w400,w1000,w1800,w2800}.webp
//   - scripts/photo-manifest.json
//
// PhotoId convention:
//   <chapter>_<spot_id>_p<N>   N=0 primary, N=1..K extras / spread tail
//
// Idempotent: if all 5 derivative files exist for a photoId, skip.
// Run: PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-image-derivatives.mjs

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, "..");
const SRC_ROOT   = "/Users/lost/Documents/Claude/Projects/Hiking Influencer";
const CONTENT    = path.join(SRC_ROOT, "rebuild/content.yaml");
const NEW_PHOTOS = path.join(SRC_ROOT, "rebuild/new_photos.yaml");
const IMAGES_FULL= path.join(SRC_ROOT, "rebuild/images-full");
const NEW_PHOTOS_DIR = path.join(SRC_ROOT, "input/NEW_Photos");
const OLI_UNSPLASH_DIR = path.join(SRC_ROOT, "input/oli und unsplashed");
const OUT_DIR    = path.join(REPO_ROOT, "full/img/derivatives");
const MANIFEST   = path.join(REPO_ROOT, "scripts/photo-manifest.json");

const WIDTHS = [160, 400, 1000, 1800, 2800];
const QUALITY = 80;
const PARALLEL = 6;  // sharp respects libvips parallelism; this is per-photo concurrency

// macOS NFD vs NFC: rebuild/images-full/ stores filenames in NFD on APFS, but the
// yaml strings are NFC. Normalize both sides + try both forms.
function nfcVariants(p) {
  const out = new Set([p, p.normalize("NFC"), p.normalize("NFD")]);
  return [...out];
}

async function fileExists(p) {
  for (const v of nfcVariants(p)) {
    try { await fs.access(v); return v; } catch { /* try next */ }
  }
  return null;
}

// Try a few graceful fallbacks when the literal path is missing.
async function resolveSourcePath(rawPath, base) {
  const direct = path.join(base, rawPath);
  let found = await fileExists(direct);
  if (found) return found;
  // Filename fallback chain. content.yaml sometimes references a "_v2"
  // versioned name that doesn't exist on disk — usually because Leon
  // renamed the actual file to "<base>2.jpg" (no underscore) instead. Try:
  //   1. "rosenlaui_v2.jpg" → "rosenlaui2.jpg"   (strip the "_v" infix)
  //   2. "rosenlaui_v2.jpg" → "rosenlaui.jpg"    (strip the whole "_v\d+" suffix)
  const dir = path.dirname(direct);
  const ext = path.extname(direct);
  const stem = path.basename(direct, ext);
  const candidates = [];
  const stripUnderV = stem.replace(/_v(\d+)$/i, "$1");
  if (stripUnderV !== stem) candidates.push(stripUnderV);
  const stripUnderVAll = stem.replace(/_v\d+$/i, "");
  if (stripUnderVAll !== stem) candidates.push(stripUnderVAll);
  for (const cand of candidates) {
    found = await fileExists(path.join(dir, cand + ext));
    if (found) return found;
  }
  return null;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function buildDerivatives(photo, opts = {}) {
  const { force = false } = opts;
  const photoDir = path.join(OUT_DIR, photo.photoId);
  await ensureDir(photoDir);
  const all = WIDTHS.map(w => ({ w, dst: path.join(photoDir, `w${w}.webp`) }));
  if (!force) {
    const allPresent = all.every(({ dst }) => fsSync.existsSync(dst));
    if (allPresent) {
      // Read dims from any existing derivative to fill the manifest cheaply.
      const anyDst = all[all.length - 1].dst;
      // We still need the original dims, not the derivative's. Stat the source.
      try {
        const meta = await sharp(photo.sourceAbs).metadata();
        return { ok: true, skipped: true, width: meta.width, height: meta.height };
      } catch {
        return { ok: true, skipped: true };
      }
    }
  }
  const meta = await sharp(photo.sourceAbs).metadata();
  for (const { w, dst } of all) {
    if (!force && fsSync.existsSync(dst)) continue;
    await sharp(photo.sourceAbs)
      .rotate()                                     // honor EXIF orientation
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 4 })
      .toFile(dst);
  }
  return { ok: true, skipped: false, width: meta.width, height: meta.height };
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, next));
  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  const onlyPhotoId = (process.argv.find(a => a.startsWith("--only=")) || "").split("=")[1] || null;

  const content = yaml.load(await fs.readFile(CONTENT, "utf8"));
  const newPhotos = yaml.load(await fs.readFile(NEW_PHOTOS, "utf8"));
  const npSpots = newPhotos?.spots ?? {};

  // Build the photo job list. One entry per photo to derive.
  // Order is meaningful: the seed script reads photoIds back in the same order
  // it emitted them so primary stays at index 0.
  const jobs = [];
  const warnings = [];

  for (const spot of content.spots) {
    const kind = spot.kind ?? "spot";
    const chapter = spot.chapter;
    const spotId  = spot.id;
    if (kind === "extras") continue;  // no images on the wrapper itself

    if (kind === "spot") {
      // Primary
      if (spot.image) {
        const src = await resolveSourcePath(spot.image, IMAGES_FULL);
        if (!src) {
          warnings.push(`MISSING primary  ${chapter}/${spotId}  ${spot.image}`);
        } else {
          jobs.push({
            photoId: `${slugify(chapter)}_${slugify(spotId)}_p0`,
            sourceAbs: src,
            sourceLabel: `images-full/${spot.image}`,
            chapter, spotId, order: 0,
            credit: spot.image_credit ?? null,
            sourceType: null,
            sourceUrl: null,
          });
        }
      }
      // Extras from new_photos.yaml (index >= 1)
      const extras = npSpots[spotId] ?? [];
      for (let i = 1; i < extras.length; i++) {
        const e = extras[i];
        const src = await resolveSourcePath(e.file, NEW_PHOTOS_DIR);
        if (!src) {
          warnings.push(`MISSING extra    ${chapter}/${spotId} idx=${i}  ${e.file}`);
          continue;
        }
        jobs.push({
          photoId: `${slugify(chapter)}_${slugify(spotId)}_p${i}`,
          sourceAbs: src,
          sourceLabel: `NEW_Photos/${e.file}`,
          chapter, spotId, order: i,
          credit: e.instagram_handle ?? e.author ?? null,
          sourceType: e.source_type ?? null,
          sourceUrl: e.source_url ?? null,
        });
      }
    }

    if (kind === "spread") {
      // Spread images merge into the parent spot. Parent id is the spread id
      // minus the trailing "_spread" or "_..._spread" suffix.
      const parentId = spotId
        .replace(/_ridge_line_spread$/i, "")
        .replace(/_spread$/i, "");
      // Determine where extras already left off, so spread images go after.
      const extrasCount = (npSpots[parentId] ?? []).length;  // includes idx 0
      const startIdx = Math.max(1, extrasCount);  // 1 if no extras, else N
      const images = spot.images ?? [];
      for (let j = 0; j < images.length; j++) {
        const im = images[j];
        const src = await resolveSourcePath(im.src, IMAGES_FULL);
        const order = startIdx + j;
        if (!src) {
          warnings.push(`MISSING spread   ${chapter}/${parentId} idx=${order}  ${im.src}`);
          continue;
        }
        jobs.push({
          photoId: `${slugify(chapter)}_${slugify(parentId)}_p${order}`,
          sourceAbs: src,
          sourceLabel: `images-full/${im.src}`,
          chapter, spotId: parentId, order,
          credit: im.credit ?? null,
          sourceType: null,
          sourceUrl: null,
          fromSpread: spotId,
        });
      }
    }
  }

  // ── webapp-side extras: photos that exist on disk in images-full/ but
  // aren't referenced by content.yaml's `image:` or new_photos.yaml. These
  // are typically older/alternate shots Leon kept around as a second hero.
  // Each entry appends to an EXISTING spot's photos[] at the next free
  // index. Don't edit the yaml files for these — the PDF builder reads
  // them too, and these are webapp-only additions.
  // Reusable credit shorthands for recurring contributors.
  const ZDK = { credit: "zimydakid", sourceType: "instagram", sourceUrl: "https://instagram.com/zimydakid" };
  const OLI = { credit: "oliwear.j", sourceType: "instagram", sourceUrl: "https://instagram.com/oliwear.j", sourceRoot: OLI_UNSPLASH_DIR };
  const CHRIS_HENRY = { credit: "Chris Henry", sourceType: "unsplash", sourceUrl: "https://unsplash.com/photos/person-in-yellow-jacket-and-black-pants-standing-on-rock-near-river-during-daytime-3cGpYqg3Nck", sourceRoot: OLI_UNSPLASH_DIR };
  const NO_HE = { credit: "no he", sourceType: "unsplash", sourceUrl: "https://unsplash.com/photos/a-blue-lake-surrounded-by-mountains-and-trees-71uo1MQhkws", sourceRoot: OLI_UNSPLASH_DIR };
  const WEBAPP_EXTRA_PHOTOS = [
    {
      chapter: "central", spotId: "rosenlaui",
      // Katerina Trapp's IG photo, originally the chapter HTML primary
      // before content.yaml was switched to the Unsplash version.
      file: "spots/central/rosenlaui.jpg",
      credit: "katerina.trapp", sourceType: "instagram", sourceUrl: "https://instagram.com/katerina.trapp",
    },
    // Loose alternate photos found on disk under images-full/spots/ that
    // weren't referenced by content.yaml or new_photos.yaml. Per Leon, all
    // are zimydakid contributions except lavaux_vineyards which is an
    // Unsplash photo whose photographer name is still unknown (credit
    // intentionally left null so no misleading chip renders — fill in
    // when the name surfaces).
    { chapter: "eastern", spotId: "berschnerfall",          file: "spots/eastern/berschnerfall.jpg",            ...ZDK },
    { chapter: "valais",  spotId: "cabane_becs_de_bosson",  file: "spots/valais/cabane_bec_des_bossons.jpg",    ...ZDK },
    { chapter: "valais",  spotId: "the_ice_cave",           file: "spots/valais/ice_cave.jpg",                  ...ZDK },
    { chapter: "valais",  spotId: "la_fouly",               file: "spots/valais/la_fouly_summer.jpg",           ...ZDK },
    // /input/oli und unsplashed/ batch — additions to existing spots.
    { chapter: "valais",  spotId: "aletsch_glacier",  file: "aletsch_glacier.jpeg",  ...OLI },
    { chapter: "eastern", spotId: "falensee",         file: "fälensee_chris-henry-3cGpYqg3Nck-unsplash.jpg", ...CHRIS_HENRY },
    // /input/oli und unsplashed/ batch — primaries for brand-new spots
    // (the spots are created by scripts/seed-orphan-spots.mjs). photoId
    // matches what the orphan seeder expects: <chapter>_<spotId>_p0.
    { chapter: "central", spotId: "brisen",           file: "brisen_oli.jpeg",       ...OLI },
    { chapter: "central", spotId: "engstlensee",      file: "engstlensee.jpeg",      ...OLI },
    { chapter: "eastern", spotId: "maloja_pass",      file: "maloja_pass.jpeg",      ...OLI },
    { chapter: "ticino",  spotId: "ponte_tibetano",   file: "ponte_tibetano.jpeg",   ...OLI },
  ];

  // Track the highest order-index already assigned per spot so webapp
  // extras land at order = N+1 even when new_photos.yaml or spreads also
  // contribute.
  const maxOrderBySpot = new Map();
  for (const j of jobs) {
    const k = `${j.chapter}#${j.spotId}`;
    maxOrderBySpot.set(k, Math.max(maxOrderBySpot.get(k) ?? -1, j.order));
  }
  for (const e of WEBAPP_EXTRA_PHOTOS) {
    const key = `${e.chapter}#${e.spotId}`;
    const root = e.sourceRoot || IMAGES_FULL;
    const src = await resolveSourcePath(e.file, root);
    if (!src) {
      warnings.push(`MISSING webapp-extra ${key}  ${e.file}  (root=${path.basename(root)})`);
      continue;
    }
    const nextOrder = (maxOrderBySpot.get(key) ?? -1) + 1;
    maxOrderBySpot.set(key, nextOrder);
    jobs.push({
      photoId: `${slugify(e.chapter)}_${slugify(e.spotId)}_p${nextOrder}`,
      sourceAbs: src,
      sourceLabel: `images-full/${e.file}`,
      chapter: e.chapter,
      spotId:  e.spotId,
      order:   nextOrder,
      credit:  e.credit,
      sourceType: e.sourceType ?? null,
      sourceUrl:  e.sourceUrl ?? null,
    });
  }

  // ── unmapped: orphan photos in new_photos.yaml whose spot doesn't exist
  // in content.yaml yet. Each bucket key (e.g. "derborence") becomes a new
  // synthetic spot under the chapter folder the photo is filed in.
  // Hard-coded bucket -> { chapter, spotId } mapping keeps the slug stable
  // even if the bucket name later normalises differently.
  // SpotIds match the extras_entry slugs that content.yaml's extras
  // wrappers already produce, so a re-seed UPSERTS the placeholder into a
  // real spot rather than creating a duplicate.
  const ORPHAN_BUCKETS = {
    derborence: { chapter: "valais",  spotId: "lac_de_derborence" },
    zinal:      { chapter: "valais",  spotId: "zinal_glacier" },
    chauderon:  { chapter: "western", spotId: "gorges_du_chauderon" },
  };
  const unmapped = newPhotos?.unmapped ?? {};
  for (const [bucket, entries] of Object.entries(unmapped)) {
    if (!Array.isArray(entries)) continue;  // skip _doc / files keys
    const target = ORPHAN_BUCKETS[bucket];
    if (!target) continue;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e?.file) continue;
      const src = await resolveSourcePath(e.file, NEW_PHOTOS_DIR);
      if (!src) {
        warnings.push(`MISSING orphan   ${target.chapter}/${target.spotId} idx=${i}  ${e.file}`);
        continue;
      }
      jobs.push({
        photoId: `${slugify(target.chapter)}_${slugify(target.spotId)}_p${i}`,
        sourceAbs: src,
        sourceLabel: `NEW_Photos/${e.file}`,
        chapter: target.chapter,
        spotId:  target.spotId,
        order:   i,
        credit:  e.instagram_handle ?? e.author ?? null,
        sourceType: e.source_type ?? null,
        sourceUrl:  e.source_url ?? null,
      });
    }
  }

  // Filter to a single photoId for smoke tests.
  const filtered = onlyPhotoId ? jobs.filter(j => j.photoId === onlyPhotoId) : jobs;
  console.log(`[derivatives] ${filtered.length} photos to consider (force=${force}, only=${onlyPhotoId ?? "-"})`);

  await ensureDir(OUT_DIR);

  let built = 0, skipped = 0, errored = 0;
  const startedAt = Date.now();
  const manifest = [];

  await pool(filtered, PARALLEL, async (job, i) => {
    try {
      const r = await buildDerivatives(job, { force });
      if (r.skipped) skipped++; else built++;
      manifest.push({
        photoId: job.photoId,
        chapter: job.chapter,
        spotId: job.spotId,
        order: job.order,
        sourceLabel: job.sourceLabel,
        credit: job.credit,
        sourceType: job.sourceType,
        sourceUrl: job.sourceUrl,
        width: r.width ?? null,
        height: r.height ?? null,
        fromSpread: job.fromSpread ?? null,
      });
      if ((i + 1) % 25 === 0 || i === filtered.length - 1) {
        const dt = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`  ${i + 1}/${filtered.length}  built=${built} skipped=${skipped} errored=${errored}  (${dt}s)`);
      }
    } catch (err) {
      errored++;
      console.error(`  ERROR  ${job.photoId}  ${job.sourceLabel}  ${err.message}`);
    }
  });

  // Sort manifest deterministically for git-friendly output.
  manifest.sort((a, b) => a.photoId.localeCompare(b.photoId));
  await fs.writeFile(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    widths: WIDTHS,
    quality: QUALITY,
    photos: manifest,
  }, null, 2) + "\n");

  console.log(`\n[derivatives] DONE  built=${built}  skipped=${skipped}  errored=${errored}  total=${filtered.length}`);
  console.log(`[derivatives] manifest -> ${path.relative(REPO_ROOT, MANIFEST)}`);
  if (warnings.length) {
    console.log(`\n[derivatives] ${warnings.length} warning(s) — primaries / extras with no source file on disk:`);
    for (const w of warnings) console.log("  " + w);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
