#!/usr/bin/env node
//
// Generates the webp derivative ladder for every photo on disk, plus the
// manifest the seed script and chapter HTML generator both consume.
//
// Inputs:
//   - content.yaml                                 (per-spot editorial + photo metadata)
//   - assets/spots/<spotId>/{main,02,03,...}.<ext> (source images)
//   - assets/chapters/<chapterId>.<ext>            (chapter cover sources)
//
// Outputs:
//   - full/img/derivatives/<photoId>/{w160,w400,w1000,w1800,w2800}.webp
//   - full/img/chapters/<chapterId>/{w160,w400,w1000,w1800,w2800}.webp
//   - scripts/photo-manifest.json
//
// PhotoId convention: <spotId>_p<N>. N=0 is the primary (main.<ext>), N>=1
// matches the file's sorted-position in assets/spots/<spotId>/.
//
// Idempotent: skips a photoId if all 5 derivatives already exist.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-image-derivatives.mjs

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ASSETS = path.join(REPO, "assets");
const SPOTS = path.join(ASSETS, "spots");
const CHAPTERS = path.join(ASSETS, "chapters");
const OUT_DIR = path.join(REPO, "full/img/derivatives");
const OUT_CHAPTERS = path.join(REPO, "full/img/chapters");
const MANIFEST = path.join(REPO, "scripts/photo-manifest.json");

const WIDTHS = [160, 400, 1000, 1800, 2800];
const QUALITY = 80;
const PARALLEL = 6;

const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function buildDerivatives(srcAbs, dstDir, opts = {}) {
  const { force = false } = opts;
  await ensureDir(dstDir);
  const all = WIDTHS.map(w => ({ w, dst: path.join(dstDir, `w${w}.webp`) }));
  if (!force && all.every(({ dst }) => fsSync.existsSync(dst))) {
    try {
      const meta = await sharp(srcAbs).metadata();
      return { ok: true, skipped: true, width: meta.width, height: meta.height };
    } catch { return { ok: true, skipped: true }; }
  }
  const meta = await sharp(srcAbs).metadata();
  for (const { w, dst } of all) {
    if (!force && fsSync.existsSync(dst)) continue;
    await sharp(srcAbs).rotate().resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 4 }).toFile(dst);
  }
  return { ok: true, skipped: false, width: meta.width, height: meta.height };
}

async function pool(items, n, worker) {
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, next));
}

// Sort filenames: main.* first, then numeric prefixes (02, 03, ...).
function sortPhotoFiles(files) {
  return files.sort((a, b) => {
    const aMain = /^main\./.test(a) ? 0 : 1;
    const bMain = /^main\./.test(b) ? 0 : 1;
    if (aMain !== bMain) return aMain - bMain;
    return a.localeCompare(b);
  });
}

async function main() {
  const force = process.argv.includes("--force");
  const onlyPhotoId = (process.argv.find(a => a.startsWith("--only=")) || "").split("=")[1] || null;

  const content = yaml.load(await fs.readFile(path.join(REPO, "content.yaml"), "utf8"));

  // Build spotId → spot lookup for credit/chapter resolution.
  const spotById = new Map();
  for (const spot of content.spots ?? []) {
    if ((spot.kind ?? "spot") === "spot") spotById.set(spot.id, spot);
  }

  // Walk assets/spots/* — every folder is a spot. Each file in it (sorted)
  // becomes a derivative job. Spots not in content.yaml still get
  // derivatives (covers brand-new spots that the orphan seeder will pick
  // up); credit will be null for them.
  const jobs = [];
  const warnings = [];

  for (const spotId of (await fs.readdir(SPOTS)).sort()) {
    const spotDir = path.join(SPOTS, spotId);
    const stat = await fs.stat(spotDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const files = sortPhotoFiles(
      (await fs.readdir(spotDir))
        .filter(f => IMG_EXT.has(path.extname(f).toLowerCase())),
    );

    const spot = spotById.get(spotId) ?? null;
    if (!spot) warnings.push(`NOTE: assets/spots/${spotId}/ has no content.yaml entry`);

    for (let i = 0; i < files.length; i++) {
      const fname = files[i];
      const photoId = `${spotId}_p${i}`;

      // Resolve credit + source for this photo.
      let credit = null, sourceType = null, sourceUrl = null;
      if (i === 0 && spot) {
        credit = spot.image_credit ?? null;
      } else if (spot?.photos?.[i - 1]) {
        const e = spot.photos[i - 1];
        credit = e.credit ?? null;
        sourceType = e.source_type ?? null;
        sourceUrl = e.source_url ?? null;
      }

      jobs.push({
        photoId,
        sourceAbs: path.join(spotDir, fname),
        sourceLabel: `assets/spots/${spotId}/${fname}`,
        chapter: spot?.chapter ?? null,
        spotId,
        order: i,
        credit, sourceType, sourceUrl,
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
      const r = await buildDerivatives(job.sourceAbs, path.join(OUT_DIR, job.photoId), { force });
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

  // Chapter cover derivatives. Same width ladder, output under
  // full/img/chapters/<chapterId>/. Chapter HTML uses the w1800 variant.
  await ensureDir(OUT_CHAPTERS);
  const chapterFiles = (await fs.readdir(CHAPTERS).catch(() => []))
    .filter(f => IMG_EXT.has(path.extname(f).toLowerCase()));
  for (const f of chapterFiles) {
    const chapterId = path.basename(f, path.extname(f));
    const r = await buildDerivatives(path.join(CHAPTERS, f), path.join(OUT_CHAPTERS, chapterId), { force });
    if (r.skipped) skipped++; else built++;
  }

  manifest.sort((a, b) => a.photoId.localeCompare(b.photoId));
  await fs.writeFile(MANIFEST, JSON.stringify({
    generatedAt: new Date().toISOString(),
    widths: WIDTHS,
    quality: QUALITY,
    photos: manifest,
  }, null, 2) + "\n");

  console.log(`\n[derivatives] DONE  built=${built}  skipped=${skipped}  errored=${errored}`);
  console.log(`[derivatives] manifest -> ${path.relative(REPO, MANIFEST)}`);
  if (warnings.length) {
    console.log(`\n[derivatives] ${warnings.length} note(s):`);
    for (const w of warnings) console.log("  " + w);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
