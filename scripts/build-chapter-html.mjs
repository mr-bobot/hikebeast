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
  return `../img/derivatives/${photoId}/w1000.webp`;
}
// Returns the {srcset, sizes} pair for a spot photo derivative. Combined
// with src=… this lets the browser pick the right WebP variant for the
// viewport instead of pulling the 1800-wide one everywhere.
function spotPhotoSrcset(photoId) {
  return [400, 1000, 1800]
    .map(w => `../img/derivatives/${photoId}/w${w}.webp ${w}w`)
    .join(", ");
}
// Spread images live alongside the parent spot's photos. yamlSrc looks
// like "spots/<parentSpotId>/<file>"; resolve to the matching derivative.
function spreadImgSrc(yamlSrc) {
  if (!yamlSrc) return `../img/derivatives/_missing/w1000.webp`;
  const m = yamlSrc.match(/^spots\/([^/]+)\/(.+)$/);
  if (!m) return yamlSrc;
  const [, parentSpotId, fileName] = m;
  const idx = spotPhotoIndex(parentSpotId, fileName);
  if (idx < 0) return `../img/derivatives/${parentSpotId}_p0/w1000.webp`;
  return `../img/derivatives/${parentSpotId}_p${idx}/w1000.webp`;
}
function spreadImgSrcset(yamlSrc) {
  if (!yamlSrc) return "";
  const m = yamlSrc.match(/^spots\/([^/]+)\/(.+)$/);
  if (!m) return "";
  const [, parentSpotId, fileName] = m;
  const idx = spotPhotoIndex(parentSpotId, fileName);
  const photoId = idx < 0 ? `${parentSpotId}_p0` : `${parentSpotId}_p${idx}`;
  return spotPhotoSrcset(photoId);
}
function chapterCoverSrc(chapterId) {
  return `../img/chapters/${chapterId}/w1000.webp`;
}
function chapterCoverSrcset(chapterId) {
  return [400, 1000, 1800]
    .map(w => `../img/chapters/${chapterId}/w${w}.webp ${w}w`)
    .join(", ");
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
    `  <a class="sb-thumb" href="../intro/index.html" title="Front matter"><img src="../img/front_matter/page_05-w192.webp" srcset="../img/front_matter/page_05-w192.webp 192w, ../img/front_matter/page_05-w480.webp 480w" sizes="96px" alt="" /><span class="lbl">Intro</span></a>`,
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
    // Photo cover is the LCP for this chapter — eager + fetchpriority + srcset.
    return `    <section class="slide slide-cover" id="cover">
  <img class="cv-img" src="${chapterCoverSrc(chapter.id)}" srcset="${chapterCoverSrcset(chapter.id)}" sizes="100vw" alt="" fetchpriority="high" decoding="async" />
  <div class="cv-content">
    <p class="cv-kicker">Region</p>
    <h1>${escapeHtml(chapter.name)}</h1>
    <p class="cv-deck">${escapeHtml(chapter.intro)}</p>
  </div>
</section>`;
  }
  return `    <section class="slide slide-cover" id="cover" style="--region-color: ${colorTriple(chapter.color)};">
  <div class="cv-map">
    <img src="../img/region-${chapter.id}.svg" alt="${escapeHtml(chapter.name)} on the Swiss map" fetchpriority="high" decoding="async" />
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

// Chevron icons — match the SVG_CHEV_* used by social.js injectMultiImage so
// the chapter Reader carousel and the spot-detail carousel share identical
// arrow visuals.
const CHEV_LEFT_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const CHEV_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

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
  // Grid view is hidden behind a toggle, so every image is lazy + small.
  const photoId = `${spot.id}_p0`;
  const srcset = spotPhotoSrcset(photoId);
  return `    <a class="ch-tile" href="../spot/${escapeHtml(spot.id)}/" title="${escapeHtml(spot.title)}">
      <div class="ch-tile-photo">
        <img src="${primarySrc(spot.id)}" srcset="${srcset}" sizes="(min-width: 900px) 320px, 45vw" alt="${escapeHtml(spot.title)}" loading="lazy" />
      </div>
      <div class="ch-tile-meta">
        <p class="ch-tile-kicker">${escapeHtml(spot.kicker || "")}</p>
        <h3 class="ch-tile-title">${escapeHtml(spot.title)}</h3>
      </div>
    </a>`;
}

function renderSpotEbookCard(spot, spotIdx) {
  // Large reader-view card for the chapter scroll (ebook mode). Photo
  // on the left, content on the right (stacks on mobile). Uses the
  // `subheadline` field when set; falls back to `deck`. Body paragraphs
  // are intentionally skipped — the long-form copy lives on the spot
  // detail page; the scroll is meant as a fast curated browse.
  //
  // The whole card is clickable (data-href + JS). When the spot has
  // multiple photos we pre-render the same .hb-multi structure that
  // social.js injectMultiImage produces (slides + counter + dots +
  // chevron arrows + credit pill), so chapter and spot-detail share
  // identical carousel visuals.
  //
  // spotIdx (0-based) lets us mark only the first spot's first photo as
  // eager+LCP; all other photos are lazy. The chapter used to ship 26+
  // eager w1800 WebPs on first paint — most below the fold — which made
  // chapter navigation feel sluggish on desktop.
  const subhead = spot.subheadline || spot.deck || "";
  const kicker = spot.kicker || "HIDDEN GEMS";
  const href = `../spot/${spot.id}/`;
  const isFirstSpot = spotIdx === 0;
  const sizes = "(min-width: 900px) 600px, 90vw";

  const files = spotPhotoFiles(spot.id);
  const count = Math.max(1, files.length);
  const credit = renderCredit(spot.image_credit);
  const creditText = credit ? `Photo · ${escapeHtml(credit)}` : "";

  let photosBlock;
  if (count <= 1) {
    const photoId = `${spot.id}_p0`;
    const srcset = spotPhotoSrcset(photoId);
    const loading = isFirstSpot ? "eager" : "lazy";
    const fp = isFirstSpot ? ` fetchpriority="high"` : "";
    // Plain image — no carousel, no dots, no counter.
    photosBlock = `      <div class="cl-photos">
        <img src="${primarySrc(spot.id)}" srcset="${srcset}" sizes="${sizes}" alt="${escapeHtml(spot.title)}" loading="${loading}"${fp} />
        ${creditText ? `<span class="credit-pill">${creditText}</span>` : ""}
      </div>`;
  } else {
    const slides = Array.from({ length: count }, (_, i) => {
      const photoId = `${spot.id}_p${i}`;
      const isLcp = isFirstSpot && i === 0;
      const loading = isLcp ? "eager" : "lazy";
      const fp = isLcp ? ` fetchpriority="high"` : "";
      const srcset = spotPhotoSrcset(photoId);
      const src = `../img/derivatives/${photoId}/w1000.webp`;
      return `        <img class="hb-slide${i === 0 ? " is-current" : ""}" src="${src}" srcset="${srcset}" sizes="${sizes}" alt="${i === 0 ? escapeHtml(spot.title) : ""}" loading="${loading}"${fp} draggable="false" />`;
    }).join("\n");
    const dotSpans = Array.from({ length: count }, (_, i) =>
      `<span class="${i === 0 ? "is-on" : ""}"></span>`,
    ).join("");
    photosBlock = `      <div class="cl-photos hb-multi">
${slides}
        <span class="hb-counter">1 / ${count}</span>
        ${creditText ? `<span class="credit-pill hb-credit">${creditText}</span>` : ""}
        <div class="hb-dots" aria-hidden="true">${dotSpans}</div>
        <button type="button" class="hb-arrow hb-arrow-prev" aria-label="Previous photo">${CHEV_LEFT_SVG}</button>
        <button type="button" class="hb-arrow hb-arrow-next" aria-label="Next photo">${CHEV_RIGHT_SVG}</button>
      </div>`;
  }

  const specs = [];
  if (spot.region) specs.push(`        <div class="cl-spec"><span class="cl-lbl">Region</span><span class="cl-val">${escapeHtml(spot.region)}</span></div>`);
  if (spot.access) specs.push(`        <div class="cl-spec"><span class="cl-lbl">Access</span><span class="cl-val">${escapeHtml(spot.access)}</span></div>`);
  if (spot.effort) specs.push(`        <div class="cl-spec"><span class="cl-lbl">Effort</span><span class="cl-val">${escapeHtml(spot.effort)}</span></div>`);
  if (spot.best_light) specs.push(`        <div class="cl-spec"><span class="cl-lbl">Best light</span><span class="cl-val">${escapeHtml(spot.best_light)}</span></div>`);

  const mapsCta = spot.maps_url
    ? `      <a class="cl-maps" href="${escapeHtml(spot.maps_url)}" target="_blank" rel="noopener">${MAPS_PIN_SVG}<span>Open in Maps</span></a>`
    : "";

  return `    <article class="cl-card" id="${escapeHtml(spot.id)}" data-href="${escapeHtml(href)}" tabindex="0" role="link" aria-label="${escapeHtml(spot.title)}">
${photosBlock}
      <div class="cl-body">
        <p class="cl-kicker">${escapeHtml(kicker)}</p>
        <h2 class="cl-title">${escapeHtml(spot.title)}</h2>
        <p class="cl-subhead">${escapeHtml(subhead)}</p>
        <div class="cl-specs">
${specs.join("\n")}
        </div>
${mapsCta}
      </div>
    </article>`;
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

  // The chapter renders BOTH layouts; CSS toggles which one is visible
  // based on body[data-chapter-view]. Default is "reader" (the ebook
  // scroll), with a toggle pill to switch to "grid" (compact tiles).
  // The user's preference is persisted in localStorage by the inline
  // toggle script at the bottom of the page.
  const tiles = spotItems.map(renderSpotTile).join("\n");
  const cards = spotItems.map(renderSpotEbookCard).join("\n");

  slides.push(`    <section class="chapter-views" aria-label="${escapeHtml(chapter.name)} spots">
      <div class="chapter-views-head">
        <p class="chapter-views-meta">${spotCount} ${spotCount === 1 ? "spot" : "spots"}</p>
        <div class="chapter-view-toggle" role="tablist" aria-label="Chapter view">
          <button type="button" class="ch-view-btn" data-view="reader" role="tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg><span>Reader</span></button>
          <button type="button" class="ch-view-btn" data-view="grid" role="tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>Grid</span></button>
        </div>
      </div>
      <div class="chapter-list">
${cards}
      </div>
      <div class="chapter-grid-inner">
${tiles}
      </div>
    </section>`);

  for (const it of extrasItems) slides.push(renderExtras(it));

  // The legacy crumb counter (X / Y, driven by an IntersectionObserver in
  // preview.js) was meaningful when chapters were a multi-slide scroll.
  // Now that the chapter is just cover + Reader/Grid views, we replace it
  // with a static "N spots" pill — the spot count is the only thing worth
  // surfacing in that slot.

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<script>(function(){try{if(localStorage.getItem('hb-theme')==='dark'){document.documentElement.setAttribute('data-theme','dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','#0b0d10');}}catch(e){}})();</script>
<title>${escapeHtml(chapter.name)} · Gems of Switzerland · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../../images/favicon.jpg" />
<link rel="manifest" href="../../manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Hikebeast" />
<meta name="mobile-web-app-capable" content="yes" />
<link rel="stylesheet" href="../preview.css" />
<link rel="preconnect" href="https://whimsical-sparrow-336.convex.cloud" crossorigin />
</head>
<body>
<div class="topbar">
  <a class="brand" href="../index.html">
    <span>${escapeHtml(chapter.name)}</span>
  </a>
  <span class="crumb"><b>${spotCount}</b> ${spotCount === 1 ? "spot" : "spots"}</span>
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
  <a href="../../terms.html">Terms</a><span class="sep">·</span>
  © Hikebeast
</footer>

<script>
  var HB_CHAPTER_ID = ${JSON.stringify(chapter.id)};

  // Restore scroll position when arriving back from a spot detail page.
  // The chapter card click handler below saves window.scrollY into
  // sessionStorage just before navigating; on return the saved Y wins.
  // Time-bounded to 10 min so an old session can't randomly snap an
  // unrelated visit. We also disable the browser's automatic scroll
  // restoration for this navigation so it doesn't fight our manual one.
  (function () {
    try {
      var KEY = 'hb:chapterScroll:' + HB_CHAPTER_ID;
      var raw = sessionStorage.getItem(KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      sessionStorage.removeItem(KEY);
      if (!data || typeof data.y !== 'number') return;
      if (Date.now() - (data.ts || 0) > 10 * 60 * 1000) return;
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      function setY(y) {
        try { window.scrollTo(0, y); } catch (_) {}
        try { document.documentElement.scrollTop = y; } catch (_) {}
        try { document.body.scrollTop = y; } catch (_) {}
      }
      // Apply now (script at end of body — DOM laid out), then again on
      // next frame and after the load event so lazy-loaded images and
      // Convex hydration can not bounce us back to the top.
      setY(data.y);
      requestAnimationFrame(function () { setY(data.y); });
      window.addEventListener('load', function () { setY(data.y); });
    } catch (_) {}
  })();

  // Chapter view toggle: reader (ebook scroll) vs grid (compact tiles).
  // Persists in localStorage so a visitor's preference survives navigation.
  // Default is "reader" — the chapter is meant to read like a curated guide.
  (function () {
    var KEY = 'hb:chapter-view';
    var view = localStorage.getItem(KEY) || 'reader';
    document.body.dataset.chapterView = view;
    function applyActive() {
      document.querySelectorAll('.ch-view-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.view === view);
        b.setAttribute('aria-selected', b.dataset.view === view ? 'true' : 'false');
      });
    }
    applyActive();
    document.querySelectorAll('.ch-view-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        view = b.dataset.view;
        localStorage.setItem(KEY, view);
        document.body.dataset.chapterView = view;
        applyActive();
      });
    });
  })();

  // Reader cards: whole-card navigation + photo carousel.
  // Click anywhere on the card → open the spot detail page, except when
  // the click lands on the Maps CTA or on a carousel control (arrow /
  // dot). The .hb-multi carousel uses opacity-based slide transitions
  // matching the spot-detail carousel from social.js — so the chapter
  // and detail views share one visual.
  (function () {
    function rememberScroll(card) {
      try {
        sessionStorage.setItem('hb:chapterScroll:' + HB_CHAPTER_ID, JSON.stringify({
          y: window.scrollY || document.documentElement.scrollTop || 0,
          spotId: card.id || '',
          ts: Date.now(),
        }));
      } catch (_) {}
    }
    document.querySelectorAll('.cl-card[data-href]').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('.cl-maps')) return;
        if (e.target.closest('.hb-arrow')) return;
        if (e.target.closest('.hb-dots')) return;
        var href = card.dataset.href;
        if (!href) return;
        rememberScroll(card);
        window.location.href = href;
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          var href = card.dataset.href;
          if (!href) return;
          rememberScroll(card);
          window.location.href = href;
        }
      });
    });

    // Carousel wiring on every .cl-photos.hb-multi block. Single-photo
    // cards have no .hb-multi class so they are skipped automatically.
    document.querySelectorAll('.cl-photos.hb-multi').forEach(function (wrap) {
      var slides = Array.prototype.slice.call(wrap.querySelectorAll('.hb-slide'));
      var dots   = Array.prototype.slice.call(wrap.querySelectorAll('.hb-dots > span'));
      var prev   = wrap.querySelector('.hb-arrow-prev');
      var next   = wrap.querySelector('.hb-arrow-next');
      var counter = wrap.querySelector('.hb-counter');
      if (slides.length < 2) return;

      var idx = 0;
      function show(target) {
        var n = ((target % slides.length) + slides.length) % slides.length;
        if (n === idx) return;
        slides[idx].classList.remove('is-current');
        slides[n].classList.add('is-current');
        if (dots[idx]) dots[idx].classList.remove('is-on');
        if (dots[n])   dots[n].classList.add('is-on');
        if (counter) counter.textContent = (n + 1) + ' / ' + slides.length;
        idx = n;
      }

      if (prev) prev.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        show(idx - 1);
      });
      if (next) next.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        show(idx + 1);
      });
      // Touch swipe on the photo: > 40 px horizontal travel + clearly
      // horizontal direction (not a scroll gesture).
      var tx = null, ty = null;
      wrap.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        tx = e.touches[0].clientX;
        ty = e.touches[0].clientY;
      }, { passive: true });
      wrap.addEventListener('touchend', function (e) {
        if (tx === null) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - tx;
        var dy = t.clientY - ty;
        tx = ty = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          show(idx + (dx < 0 ? 1 : -1));
        }
      });
    });
  })();
</script>
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
