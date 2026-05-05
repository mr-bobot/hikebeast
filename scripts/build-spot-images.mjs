// Auto-generates `/full/img/spot-images.js`, the sidecar that maps each
// spot key (`<chapter_id>#<anchor>`) to its full photo gallery.
//
// Sources of "extra" photos for a spot:
//   1. Filename siblings of the primary image. Given primary `fulberg_main.jpg`,
//      we look for `fulberg.jpg`, `fulberg2.jpg`, `fulberg_2.jpg`, ...
//      Both `_main` and the bare basename branches are checked so spots
//      using either naming convention pick up their siblings.
//   2. <section class="slide slide-spread" id="<anchor>_spread"> cards in
//      the chapter HTML. Their <img> tags + adjacent .credit-pill give us
//      the photo + photographer credit.
//
// Spots with one photo are NOT included. Re-run after adding new images:
//
//   node scripts/build-spot-images.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FULL = join(ROOT, 'full');
const IMG_DIR = join(FULL, 'img');
const OUT = join(IMG_DIR, 'spot-images.js');

// Parse spots-data.js without evaluating the whole module.
const spotsTxt = readFileSync(join(FULL, 'map', 'spots-data.js'), 'utf8');
const spotsArr = JSON.parse(spotsTxt.match(/window\.SPOTS\s*=\s*(\[[\s\S]*?\]);/)[1]);

// Index of every photo file in /full/img/ (excludes thumbs/, m/).
const imgFiles = new Set(readdirSync(IMG_DIR).filter(f => /\.jpe?g$/i.test(f)));

// Look for sibling photos. Strip `_main` so `fulberg_main.jpg` finds `fulberg2.jpg`.
function findSiblings(primary) {
  if (!primary || !imgFiles.has(primary)) return [];
  const baseRaw = primary.replace(/\.jpe?g$/i, '');
  const baseStripped = baseRaw.replace(/_main$/, '');
  const out = [];
  const seen = new Set([primary]);
  for (const base of new Set([baseRaw, baseStripped])) {
    const candidates = [
      `${base}.jpg`,
      `${base}_main.jpg`,
      `${base}_2.jpg`, `${base}2.jpg`,
      `${base}_3.jpg`, `${base}3.jpg`,
      `${base}_4.jpg`, `${base}4.jpg`,
      `${base}_extra.jpg`,
      `${base}_b.jpg`,
    ];
    for (const c of candidates) {
      if (imgFiles.has(c) && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

// Extract <slide-spread id="<anchor>_spread"> contents from a chapter page.
function findSpreadsForChapter(chapterId) {
  const path = join(FULL, chapterId, 'index.html');
  if (!existsSync(path)) return {};
  const html = readFileSync(path, 'utf8');
  const out = {};
  const re = /<section[^>]*class="slide slide-spread"[^>]*id="(\w+)_spread"[^>]*>([\s\S]*?)<\/section>/g;
  let m;
  while ((m = re.exec(html))) {
    const anchor = m[1];
    const body = m[2];
    const photos = [];
    // Parse pairs of <img src=...> + nearest .credit-pill in document order.
    const re2 = /<img[^>]+src="\.\.\/img\/([^"]+)"[^>]*>(?:[\s\S]*?<span class="credit-pill">Photo\s*·?\s*([^<]+)<\/span>)?/g;
    let im;
    while ((im = re2.exec(body))) {
      photos.push({ src: im[1], credit: (im[2] || '').trim() || null });
    }
    out[anchor] = photos;
  }
  return out;
}

// Pull the credit pill from a single spot card (so siblings inherit it).
function findPrimaryCredit(chapterId, anchor) {
  const path = join(FULL, chapterId, 'index.html');
  if (!existsSync(path)) return null;
  const html = readFileSync(path, 'utf8');
  const re = new RegExp(
    `<section[^>]*class="slide slide-spot"[^>]*id="${anchor}"[^>]*>([\\s\\S]*?)<\\/section>`,
  );
  const m = html.match(re);
  if (!m) return null;
  const cm = m[1].match(/<span class="credit-pill">Photo\s*·?\s*([^<]+)<\/span>/);
  return cm ? cm[1].trim() : null;
}

// Find the primary image as it actually appears in the chapter card. The
// spots-data.js value can drift from the HTML (e.g. fulberg in spots-data
// is `fulberg.jpg` while the spot card uses `fulberg_main.jpg`).
function findPrimaryImage(chapterId, anchor, fallback) {
  const path = join(FULL, chapterId, 'index.html');
  if (!existsSync(path)) return fallback;
  const html = readFileSync(path, 'utf8');
  const re = new RegExp(
    `<section[^>]*class="slide slide-spot"[^>]*id="${anchor}"[^>]*>[\\s\\S]*?<img[^>]+src="\\.\\./img/([^"]+)"`,
  );
  const m = html.match(re);
  return m ? m[1] : fallback;
}

const chapters = [...new Set(spotsArr.map(s => s.chapter_id))];
const spreadsByChapter = Object.fromEntries(chapters.map(c => [c, findSpreadsForChapter(c)]));

const out = {};
let multiCount = 0;

for (const spot of spotsArr) {
  const anchor = (spot.href || '').split('#')[1];
  if (!anchor) continue;

  // Primary photo: trust the chapter HTML over spots-data.js.
  const primary = findPrimaryImage(spot.chapter_id, anchor, spot.image);
  if (!primary || primary === 'zdk_placeholder.jpg') continue;

  const credit = findPrimaryCredit(spot.chapter_id, anchor);
  const photos = [{ src: primary, credit }];
  const seen = new Set([primary]);

  // Filename siblings.
  for (const sib of findSiblings(primary)) {
    if (seen.has(sib)) continue;
    seen.add(sib);
    photos.push({ src: sib, credit });
  }
  // Spread photos.
  const spread = (spreadsByChapter[spot.chapter_id] || {})[anchor] || [];
  for (const p of spread) {
    if (seen.has(p.src)) continue;
    seen.add(p.src);
    photos.push({ src: p.src, credit: p.credit || credit });
  }

  if (photos.length > 1) {
    out[`${spot.chapter_id}#${anchor}`] = photos;
    multiCount++;
  }
}

const body = `// Auto-generated by scripts/build-spot-images.mjs.
// Maps a spot key (\`<chapter_id>#<anchor>\`) to its full photo gallery.
// Index 0 is the primary photo (matches the chapter card's <img>); extras
// come from filename siblings and slide-spread gallery cards. Spots with
// only one photo are NOT listed -- the carousel UI checks for the key
// before activating, so single-photo spots fall back to the static <img>.
window.HB_SPOT_IMAGES = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(OUT, body);
console.log(`Wrote ${OUT}`);
console.log(`  ${multiCount} spots have multi-image galleries:`);
for (const [k, photos] of Object.entries(out)) {
  console.log(`    ${k} (${photos.length} photos)`);
}
