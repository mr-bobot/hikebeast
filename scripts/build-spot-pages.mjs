#!/usr/bin/env node
//
// Generates a per-spot detail page at full/spot/<spotId>/index.html for
// every kind=spot row in content.yaml. The chapter pages still exist as
// the editorial scroll-through, but every entry point that lands on a
// single spot (Explore, Map popup, Browse, Saved, Random, Swipe, Home
// featured card) routes here instead of `<chapter>/index.html#<spotId>`.
//
// The page is a thin variant of the chapter render: same .slide-spot card,
// same rail (injected by social.js), same Convex hydration. Image paths
// shift one level up because the page lives 2 segments under /full/.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-spot-pages.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FULL = join(ROOT, "full");
const CONTENT = join(ROOT, "content.yaml");
const CREDITS = join(ROOT, "credits.yaml");

const CONVEX_URL = "https://whimsical-sparrow-336.convex.cloud";

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const creditsYaml = yaml.load(readFileSync(CREDITS, "utf8"));

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function renderCredit(key) {
  if (!key) return null;
  if (key === "placeholder" || key === "xxx") return null;
  const ph = creditsYaml?.photographers ?? {};
  const ext = creditsYaml?.external ?? {};
  if (ph[key]) return `@${key}`;
  if (ext[key]) return ext[key].name ?? key;
  return key;
}

// Spot detail pages live at /full/spot/<spotId>/index.html, so every
// reference to /full/img/... goes up two levels.
function primarySrc(spotId) {
  return `../../img/derivatives/${spotId}_p0/w1800.webp`;
}

const MAPS_PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ARROW_LEFT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`;

function renderSpotCard(spot) {
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

  return `    <section class="slide slide-spot" id="${escapeHtml(spot.id)}">
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

function renderSpotPage(spot) {
  const chapter = content.chapters.find(c => c.id === spot.chapter);
  const chapterName = chapter?.name || spot.chapter;
  // Count of sibling spots in the same chapter — surfaced in the crumb
  // slot so the spot detail page shows context ("28 spots") instead of
  // the meaningless 1/N counter.
  const chapterSpotCount = (content.spots || []).filter(
    s => s.chapter === spot.chapter && (s.kind || "spot") === "spot",
  ).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>${escapeHtml(spot.title)} · Gems of Switzerland · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../../../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../../../images/favicon.jpg" />
<link rel="stylesheet" href="../../preview.css" />
<link rel="preconnect" href="https://whimsical-sparrow-336.convex.cloud" crossorigin />
</head>
<body data-page="spot-detail">
<!-- Spot detail pages render a single slide full-bleed. The chapter
     name + spot count crumb that other topbars show is intentionally
     omitted: the user already knows which chapter they came from
     (back-button label) and the count is information they don't need
     while reading one spot. The topbar exists only to host the
     mobile burger (injected by social.js) and the account FAB. -->
<div class="topbar topbar-detail">
  <div class="topbar-right"></div>
</div>

<div class="app">
  <div class="viewer" id="viewer">

    <a class="pill hb-back app-back" data-chapter="${escapeHtml(spot.chapter)}" data-spot="${escapeHtml(spot.id)}" href="../../${escapeHtml(spot.chapter)}/" title="Back to chapter">${ARROW_LEFT_SVG}<span>Back</span></a>

${renderSpotCard(spot)}

  </div>
</div>

<footer class="legal">
  <a href="../../../imprint.html">Imprint</a><span class="sep">·</span>
  <a href="../../../privacy.html">Privacy</a><span class="sep">·</span>
  <a href="../../../terms.html">Terms</a><span class="sep">·</span>
  © Hikebeast
</footer>

<script src="../../preview.js"></script>
<script src="../../img/spot-images.js"></script>
<script src="../../lib/convex.js"></script>
<script>window.HB_CONVEX_URL = "${CONVEX_URL}";</script>
<script src="../../social.js"></script>
</body>
</html>
`;
}

let written = 0;
for (const item of (content.spots ?? [])) {
  const kind = item.kind || "spot";
  if (kind !== "spot") continue;
  const html = renderSpotPage(item);
  const dst = join(FULL, "spot", item.id, "index.html");
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, html);
  written++;
}
console.log(`\nDONE. Generated ${written} spot detail pages at full/spot/<spotId>/index.html`);
