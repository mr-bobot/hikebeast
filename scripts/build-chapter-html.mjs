#!/usr/bin/env node
//
// Generates each region's chapter HTML (full/<chapter>/index.html) from
// content.yaml + credits.yaml. content.yaml is the single source of truth
// for spot data; running this script after editing content.yaml keeps the
// static HTML in sync with what the Convex seed will publish, so first
// paint matches the live state and there is no credit/image flash.
//
// Inputs:
//   - /Users/lost/Documents/Claude/Projects/Hiking Influencer/rebuild/content.yaml
//   - /Users/lost/Documents/Claude/Projects/Hiking Influencer/rebuild/credits.yaml
//
// Outputs:
//   - full/central/index.html
//   - full/valais/index.html
//   - full/fribourg/index.html
//   - full/western/index.html
//   - full/eastern/index.html
//   - full/ticino/index.html
//   - full/beyond/index.html  (no slide-region — outside Switzerland)
//
// What it does NOT touch:
//   - full/intro/, full/map/, full/index.html, full/browse/, full/swipe/,
//     full/saved/   (these are different page types, not chapter pages)
//   - /full/img/<file>.jpg   (we only emit refs by basename; the file has
//     to already exist on disk; that is the responsibility of the photo
//     pipeline / the user's working tree)
//
//   node scripts/build-chapter-html.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FULL = join(ROOT, "full");
const CONTENT = join(ROOT, "content.yaml");
const CREDITS = join(ROOT, "credits.yaml");

// short label used in the sidebar (the full chapter name is in title= attrs)
const SIDEBAR_LABEL = {
  central: "Central",
  valais: "Valais",
  fribourg: "Fribourg",
  western: "Western",
  eastern: "Eastern",
  ticino: "Ticino",
  beyond: "Beyond",
};

const CONVEX_URL = "https://whimsical-sparrow-336.convex.cloud";

// ── load yaml ─────────────────────────────────────────────────────────
const content = yaml.load(readFileSync(CONTENT, "utf8"));
const creditsYaml = yaml.load(readFileSync(CREDITS, "utf8"));

// Same credit-resolver shape as scripts/seed-from-content-yaml.mjs so the
// rendered text on first paint matches what Convex will hand back.
function renderCredit(key) {
  if (!key) return null;
  if (key === "placeholder" || key === "xxx") return null;
  const ph = creditsYaml?.photographers ?? {};
  const ext = creditsYaml?.external ?? {};
  if (ph[key]) return `@${key}`;
  if (ext[key]) return ext[key].name ?? key;
  // Unknown key — leave it visible so the omission stands out instead of
  // silently being attributed to Leon.
  return key;
}

// Returns the `<img src>` path the chapter HTML should use for a spot's
// primary photo. Always points at the derivative ladder (build-image-
// derivatives is a prerequisite of this script). PhotoId convention is
// <spotId>_p<N>; idx 0 is the primary, idx 1+ are extras from spot.photos[].
const DERIVATIVES = join(FULL, "img", "derivatives");
const CHAPTER_DERIVATIVES = join(FULL, "img", "chapters");
function primarySrc(spotId) {
  const photoId = `${spotId}_p0`;
  return `../img/derivatives/${photoId}/w1800.webp`;
}
// Spread images live alongside the parent spot's photos. yamlSrc looks
// like "spots/<parentSpotId>/<file>"; resolve to the matching derivative.
function spreadImgSrc(yamlSrc) {
  if (!yamlSrc) return `../img/derivatives/_missing/w1800.webp`;
  const m = yamlSrc.match(/^spots\/([^/]+)\/(.+)$/);
  if (!m) return yamlSrc;
  const [, parentSpotId, fileName] = m;
  const idx = spotPhotoIndex(parentSpotId, fileName);
  if (idx < 0) return `../img/derivatives/${parentSpotId}_p0/w1800.webp`;
  return `../img/derivatives/${parentSpotId}_p${idx}/w1800.webp`;
}
function chapterCoverSrc(chapterId) {
  return `../img/chapters/${chapterId}/w1800.webp`;
}
function chapterCoverThumbSrc(chapterId) {
  return `../img/chapters/${chapterId}/w400.webp`;
}
// Build a {spotId → [filenames in sorted order]} cache by reading the
// content.yaml spot's photos[] alongside the implicit main.<ext>. This
// avoids a filesystem walk while keeping spread photoIds stable.
const _photoListCache = new Map();
function spotPhotoFiles(spotId) {
  if (_photoListCache.has(spotId)) return _photoListCache.get(spotId);
  const spot = (content.spots ?? []).find(s => s.id === spotId);
  if (!spot) { _photoListCache.set(spotId, []); return []; }
  // Primary's filename: pull the basename out of spot.image (could be
  // main.jpg, main.jpeg, main.png).
  const list = [];
  if (spot.image) list.push(basename(spot.image));
  for (const p of (spot.photos ?? [])) if (p.file) list.push(p.file);
  _photoListCache.set(spotId, list);
  return list;
}
function spotPhotoIndex(spotId, fileName) {
  return spotPhotoFiles(spotId).indexOf(fileName);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function colorTriple(rgbFloats) {
  // content.yaml stores [r, g, b] as 0..1 floats; chapter HTML wants
  // "R, G, B" 0..255 ints inside `--region-color:`.
  if (!Array.isArray(rgbFloats) || rgbFloats.length !== 3) return "0, 0, 0";
  return rgbFloats.map(v => Math.round(v * 255)).join(", ");
}

// ── build per-chapter parts ──────────────────────────────────────────
function renderSidebar(currentChapter) {
  const items = [];
  items.push(
    `  <a class="sb-home" href="../index.html" title="Home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></svg></a>`,
  );
  items.push(
    `  <a class="sb-thumb" href="../intro/index.html" title="Front matter"><img src="../img/front_matter/page_05.jpg" alt="" /><span class="lbl">Intro</span></a>`,
  );
  for (const chap of content.chapters) {
    const isCur = chap.id === currentChapter ? " is-current" : "";
    const label = SIDEBAR_LABEL[chap.id];
    items.push(
      `  <a class="sb-thumb${isCur}" href="../${chap.id}/index.html" title="${escapeHtml(chap.name)}"><img src="${chapterCoverThumbSrc(chap.id)}" alt="" /><span class="lbl">${escapeHtml(label)}</span></a>`,
    );
  }
  return `  <aside class="sidebar" aria-label="Chapters">\n${items.join("\n")}\n</aside>`;
}

function renderCover(chapter) {
  // "Beyond the Border" sits outside Switzerland — no Swiss-map silhouette.
  // It keeps the photo cover. All other chapters use the cv-map variant
  // with the region SVG on a dark editorial backdrop tinted by --region-color.
  if (chapter.id === "beyond") {
    return `    <section class="slide slide-cover" id="cover">
  <img class="cv-img" src="${chapterCoverSrc(chapter.id)}" alt="" />
  <div class="cv-content">
    <p class="cv-kicker">Region</p>
    <h1>${escapeHtml(chapter.name)}</h1>
    <p class="cv-deck">${escapeHtml(chapter.intro)}</p>
  </div>
</section>`;
  }
  return `    <section class="slide slide-cover" id="cover" style="--region-color: ${colorTriple(chapter.color)};">
  <div class="cv-map">
    <img src="../img/region-${chapter.id}.svg" alt="${escapeHtml(chapter.name)} on the Swiss map" />
  </div>
  <div class="cv-content">
    <p class="cv-kicker">Region</p>
    <h1>${escapeHtml(chapter.name)}</h1>
    <p class="cv-deck">${escapeHtml(chapter.intro)}</p>
  </div>
</section>`;
}

function renderRegion(chapter, spotCount) {
  // The "Beyond the Border" chapter is outside Switzerland, no Swiss map.
  if (chapter.id === "beyond") return "";
  return `    <section class="slide slide-region" style="--region-color: ${colorTriple(chapter.color)};">
  <a class="rg-link" href="../map/index.html">
    <div class="rg-text">
      <p class="rg-kicker">On the map</p>
      <h2 class="rg-title">${escapeHtml(chapter.name)}</h2>
      <p class="rg-meta">${spotCount} spots in this region</p>
      <span class="rg-cta">
        Open the full map
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </span>
    </div>
    <div class="rg-svg">
      <img src="../img/region-${chapter.id}.svg" alt="${escapeHtml(chapter.name)} on the Swiss map" />
    </div>
  </a>
</section>`;
}

const MAPS_PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

function renderSpot(spot) {
  const credit = renderCredit(spot.image_credit);
  const creditPill = credit
    ? `<span class="credit-pill">Photo · ${escapeHtml(credit)}</span>`
    : "";

  const bodyParas = (spot.body || []).map(p => `      <p>${escapeHtml(p)}</p>`).join("\n");

  const specs = [];
  if (spot.region) specs.push(`      <div class="spec"><span class="lbl">Region</span><span class="val">${escapeHtml(spot.region)}</span></div>`);
  if (spot.access) specs.push(`      <div class="spec"><span class="lbl">Access</span><span class="val">${escapeHtml(spot.access)}</span></div>`);
  if (spot.effort) specs.push(`      <div class="spec"><span class="lbl">Effort</span><span class="val">${escapeHtml(spot.effort)}</span></div>`);
  if (spot.best_light) specs.push(`      <div class="spec"><span class="lbl">Best light</span><span class="val">${escapeHtml(spot.best_light)}</span></div>`);

  const mapsLink = spot.maps_url
    ? `      <a class="locked" href="${escapeHtml(spot.maps_url)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:500;">${MAPS_PIN_SVG}Open in Maps</a>`
    : "";

  return `    <section class="slide slide-spot" id="${spot.id}">
  <div class="sp-photo">
    <img src="${primarySrc(spot.id)}" alt="${escapeHtml(spot.title)}" />
    ${creditPill}
  </div>
  <div class="sp-body">
    <p class="sp-kicker">${escapeHtml(spot.kicker || "")}</p>
    <h2 class="sp-title">${escapeHtml(spot.title)}</h2>
    <p class="sp-deck">${escapeHtml(spot.deck || "")}</p>
    <div class="body">
${bodyParas}
    </div>
    <div class="specs">
${specs.join("\n")}
    </div>
    <div class="sp-foot">
${mapsLink}
    </div>
  </div>
</section>`;
}

function renderSpread(spread) {
  const photos = (spread.images || []).map(im => {
    const cred = renderCredit(im.credit);
    const pill = cred ? `<span class="credit-pill">Photo · ${escapeHtml(cred)}</span>` : "";
    return `  <div class="sp-photo"><img src="${spreadImgSrc(im.src)}" alt="" />${pill}</div>`;
  }).join("\n");
  return `    <section class="slide slide-spread" id="${spread.id}">
${photos}
</section>`;
}

function renderExtras(extras) {
  const cells = (extras.entries || []).map(e =>
    `        <div class="plan-cell"><span class="num">·</span><div><h3>${escapeHtml(e.heading)}</h3><p>${escapeHtml(e.text)}</p></div></div>`,
  ).join("\n");
  return `<section class="slide slide-preface no-photo" id="${extras.id}">
  <div class="pf-body">
    <p class="sp-kicker">${escapeHtml(extras.kicker || "")}</p>
    <h2 class="sp-title">${escapeHtml(extras.title || "")}</h2>
    <p class="sp-deck">${escapeHtml(extras.deck || "")}</p>
  </div>
  <div class="pf-extras">
    <div class="plan-grid">
${cells}
    </div>
  </div>
</section>`;
}

function renderSpotTile(spot) {
  // Compact tile that links to the spot's detail page. Used inside the
  // chapter TOC grid (replaces the old per-spot scroll-through cards).
  return `    <a class="ch-tile" href="../spot/${escapeHtml(spot.id)}/" title="${escapeHtml(spot.title)}">
      <div class="ch-tile-photo">
        <img src="${primarySrc(spot.id)}" alt="${escapeHtml(spot.title)}" loading="lazy" />
      </div>
      <div class="ch-tile-meta">
        <p class="ch-tile-kicker">${escapeHtml(spot.kicker || "")}</p>
        <h3 class="ch-tile-title">${escapeHtml(spot.title)}</h3>
      </div>
    </a>`;
}

function renderChapter(chapter) {
  // Keep the order the yaml gives — preserves the editorial run-order of
  // the spots in this chapter.
  const items = (content.spots || []).filter(s => s.chapter === chapter.id);
  const spotItems = items.filter(s => (s.kind || "spot") === "spot");
  const extrasItems = items.filter(s => s.kind === "extras");
  const spotCount = spotItems.length;

  // Chapter is now a table of contents:
  //   1. Cover (with region map silhouette).
  //   2. Grid of clickable spot tiles — each opens /full/spot/<spotId>/.
  //   3. Any kind=extras "more spots coming" rollups, kept inline as a
  //      simple list since they have no detail pages.
  // Spreads are skipped here: their photos live on the parent spot's
  // detail page via the photoset, so they don't need their own card on
  // the chapter TOC.
  const slides = [];
  slides.push(renderCover(chapter));

  const tiles = spotItems.map(renderSpotTile).join("\n");
  slides.push(`    <section class="chapter-grid" aria-label="${escapeHtml(chapter.name)} spots">
      <div class="chapter-grid-head">
        <p class="chapter-grid-kicker">Spots in this chapter</p>
        <p class="chapter-grid-meta">${spotCount} ${spotCount === 1 ? "spot" : "spots"}</p>
      </div>
      <div class="chapter-grid-inner">
${tiles}
      </div>
    </section>`);

  for (const it of extrasItems) slides.push(renderExtras(it));

  // The crumb counter (X / Y) was meaningful when the chapter was a
  // multi-slide scroll. With the TOC layout it always reads 1 / 1, so
  // social.js's IntersectionObserver keeps working but the indicator
  // collapses to "1 / 1".
  const crumbTotal = slides.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>${escapeHtml(chapter.name)} · Hidden Gems · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../../images/favicon.jpg" />
<link rel="stylesheet" href="../preview.css" />
</head>
<body>
<div class="topbar">
  <a class="brand" href="../index.html">
    <img src="../../images/avatar.jpg" alt="" />
    <span>Hidden Gems · ${escapeHtml(chapter.name)}</span>
  </a>
  <span class="crumb"><b id="crumbCur">1</b> / <span id="crumbTotal">${crumbTotal}</span></span>
  <div class="topbar-right">
    <a class="pill" href="../index.html">Overview</a>
  </div>
</div>

<div class="app">

${renderSidebar(chapter.id)}

  <div class="viewer" id="viewer">

${slides.join("\n\n")}

  </div>
</div>

<footer class="legal">
  <a href="../../imprint.html">Imprint</a><span class="sep">·</span>
  <a href="../../privacy.html">Privacy</a><span class="sep">·</span>
  © Hikebeast
</footer>

<script src="../preview.js"></script>
<script src="../img/spot-images.js"></script>
<script src="../lib/convex.js"></script>
<script>window.HB_CONVEX_URL = "${CONVEX_URL}";</script>
<script src="../social.js"></script>
</body>
</html>
`;
}

// ── write all chapter pages ──────────────────────────────────────────
let written = 0;
for (const chapter of content.chapters) {
  const html = renderChapter(chapter);
  const dst = join(FULL, chapter.id, "index.html");
  writeFileSync(dst, html);
  written++;
  console.log(`  wrote ${dst}`);
}
console.log(`\nDONE. Generated ${written} chapter HTMLs from content.yaml.`);
