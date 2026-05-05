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
const HI_ROOT = "/Users/lost/Documents/Claude/Projects/Hiking Influencer";
const CONTENT = join(HI_ROOT, "rebuild/content.yaml");
const CREDITS = join(HI_ROOT, "rebuild/credits.yaml");

// chapter id -> filename in /full/img/ for the chapter cover thumbnail.
// (content.yaml's `cover_image` field points at the source under
// images-full/chapters/, which is *_cover_v2.jpg today; the static HTML
// has always used the flat *_cover.jpg in /full/img/, and changing that
// is out of scope for this generator.)
const CHAPTER_COVER = {
  central: "central_cover.jpg",
  valais: "valais_cover.jpg",
  fribourg: "fribourg_cover.jpg",
  western: "leman_cover.jpg",
  eastern: "east_cover.jpg",
  ticino: "ticino_cover.jpg",
  beyond: "beyond_cover.jpg",
};

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
// primary photo. Prefer the derivative ladder (definitely exists after
// build-image-derivatives runs, matches what social.js sets after Convex
// hydration → no flash). Falls back to /full/img/<basename> for spots
// that don't have a derivative yet (placeholders, brand-new spots).
const DERIVATIVES = join(FULL, "img", "derivatives");
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function primarySrc(chapterId, spotId, yamlImagePath) {
  const photoId = `${slugify(chapterId)}_${slugify(spotId)}_p0`;
  const derivative = join(DERIVATIVES, photoId, "w1800.webp");
  if (existsSync(derivative)) return `../img/derivatives/${photoId}/w1800.webp`;
  return `../img/${yamlImagePath ? basename(yamlImagePath) : "zdk_placeholder.jpg"}`;
}
// Spread images don't have a stable photoId (their order depends on extras
// counts), so we keep the basename approach for them. The build-image-
// derivatives pipeline does generate webps for spread photos, but social.js
// rewrites the carousel anyway — first paint just needs to not 404.
function spreadImgSrc(yamlPath) {
  if (!yamlPath) return "../img/zdk_placeholder.jpg";
  return `../img/${basename(yamlPath)}`;
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
    `  <a class="sb-thumb" href="../intro/index.html" title="Front matter"><img src="../img/page_05.jpg" alt="" /><span class="lbl">Intro</span></a>`,
  );
  for (const chap of content.chapters) {
    const isCur = chap.id === currentChapter ? " is-current" : "";
    const cover = CHAPTER_COVER[chap.id];
    const label = SIDEBAR_LABEL[chap.id];
    items.push(
      `  <a class="sb-thumb${isCur}" href="../${chap.id}/index.html" title="${escapeHtml(chap.name)}"><img src="../img/${cover}" alt="" /><span class="lbl">${escapeHtml(label)}</span></a>`,
    );
  }
  return `  <aside class="sidebar" aria-label="Chapters">\n${items.join("\n")}\n</aside>`;
}

function renderCover(chapter) {
  const cover = CHAPTER_COVER[chapter.id];
  return `    <section class="slide slide-cover" id="cover">
  <img class="cv-img" src="../img/${cover}" alt="" />
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
    <img src="${primarySrc(spot.chapter, spot.id, spot.image)}" alt="${escapeHtml(spot.title)}" />
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

function renderChapter(chapter) {
  // Keep the order the yaml gives — preserves spread/extras placement.
  const items = (content.spots || []).filter(s => s.chapter === chapter.id);
  const spotCount = items.filter(s => (s.kind || "spot") === "spot").length;

  const slides = [];
  slides.push(renderCover(chapter));
  const region = renderRegion(chapter, spotCount);
  if (region) slides.push(region);
  for (const it of items) {
    const kind = it.kind || "spot";
    if (kind === "spot") slides.push(renderSpot(it));
    else if (kind === "spread") slides.push(renderSpread(it));
    else if (kind === "extras") slides.push(renderExtras(it));
  }

  // crumbTotal counts the visible cards in the viewer (cover + optional
  // region + every slide rendered above). Matches what social.js uses for
  // the breadcrumb.
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
