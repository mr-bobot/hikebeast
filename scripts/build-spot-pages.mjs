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
// When a spot carries any of {trip_facts, routes, hut, cable_car,
// description_extra, wildCamping.note} fields, the .slide-spot card is
// wrapped in a CSS flip-card with a planning-panel back side. Spots
// without those fields render identically to before.
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
const HIKES      = join(ROOT, "hikes.yaml");
const CABLE_CARS = join(ROOT, "cable_cars.yaml");
const HUTS       = join(ROOT, "huts.yaml");
const CREDITS    = join(ROOT, "credits.yaml");

const CONVEX_URL = "https://whimsical-sparrow-336.convex.cloud";

const content = yaml.load(readFileSync(CONTENT, "utf8"));
const creditsYaml = yaml.load(readFileSync(CREDITS, "utf8"));

// Sibling entity yamls. Cable cars and huts are first-class records that can
// be referenced from multiple hikes and (in the cable car case) from spots
// that ARE the cable car / cog railway (gelmerbahn, brienzer_rothorn).
const cableCarsYaml = (() => {
  try { return yaml.load(readFileSync(CABLE_CARS, "utf8")); }
  catch { return { cable_cars: [] }; }
})();
const cableCarsById = Object.fromEntries((cableCarsYaml.cable_cars || []).map(c => [c.id, c]));

const hutsYaml = (() => {
  try { return yaml.load(readFileSync(HUTS, "utf8")); }
  catch { return { huts: [] }; }
})();
const hutsById = Object.fromEntries((hutsYaml.huts || []).map(h => [h.id, h]));

// Hikes live in a sibling hikes.yaml. Each spot references them by id via
// spot.hike_ids[]. We resolve those references in-memory so the rest of this
// script can keep reading spot.routes the way it did before the migration.
//
// `quickest` is a transient flag we set per-spot when this hike is the
// shortest-duration option for that spot. The persisted form is
// `quickest_for: [spot_id, ...]` on the hike. Restored at build time so the
// rendering code doesn't need to know about the multi-spot shape.
const hikesYaml = (() => {
  try { return yaml.load(readFileSync(HIKES, "utf8")); }
  catch { return { hikes: [] }; }
})();

// Resolve cable_car_ids / hut_ids on each hike into full objects. The
// renderer expects `r.cable_car` / `r.hut` (singular) — for routes with
// multiple references we surface the first as the primary; the rest stay
// available as `r.cable_cars[]` / `r.huts[]` for future multi-step rendering.
function resolveInfrastructure(hike) {
  const out = { ...hike };
  if (Array.isArray(hike.cable_car_ids)) {
    const ccs = hike.cable_car_ids.map(id => cableCarsById[id]).filter(Boolean);
    if (ccs.length) {
      out.cable_cars = ccs;
      out.cable_car  = ccs[0];
    }
  }
  if (Array.isArray(hike.hut_ids)) {
    const hs = hike.hut_ids.map(id => hutsById[id]).filter(Boolean);
    if (hs.length) {
      out.huts = hs;
      out.hut  = hs[0];
    }
  }
  return out;
}
const hikesById = Object.fromEntries((hikesYaml.hikes || []).map(h => [h.id, resolveInfrastructure(h)]));

for (const spot of content.spots || []) {
  // Resolve cable_car_id / hut_id on the spot itself (for spots that ARE
  // the cable car or hut, like gelmerbahn).
  if (spot.cable_car_id && cableCarsById[spot.cable_car_id]) {
    spot.cable_car = cableCarsById[spot.cable_car_id];
  }
  if (spot.hut_id && hutsById[spot.hut_id]) {
    spot.hut = hutsById[spot.hut_id];
  }
  if (!Array.isArray(spot.hike_ids)) continue;
  spot.routes = spot.hike_ids
    .map(hid => {
      const hike = hikesById[hid];
      if (!hike) return null;
      const quickest = Array.isArray(hike.quickest_for) && hike.quickest_for.includes(spot.id);
      return { ...hike, quickest };
    })
    .filter(Boolean);
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
  return `../../img/derivatives/${spotId}_p0/w1000.webp`;
}
function primarySrcset(spotId) {
  return [400, 1000, 1800, 2800]
    .map(w => `../../img/derivatives/${spotId}_p0/w${w}.webp ${w}w`)
    .join(", ");
}

const MAPS_PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ARROW_LEFT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`;
const ARROW_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
const CHEV_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const ICON_ELEV = `<svg viewBox="0 0 24 24"><path d="M3 20l5-9 4 6 3-4 6 7"/></svg>`;
const ICON_DIFF = `<svg viewBox="0 0 24 24"><path d="M4 20l8-14 8 14"/><path d="M9 14h6"/></svg>`;
const ICON_TIME = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const ICON_GAIN = `<svg viewBox="0 0 24 24"><path d="M3 18l7-9 4 5 7-9"/><path d="M14 5h7v7"/></svg>`;
const ICON_BUSY = `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M14 19c0-2 2-3 4-3s3 1 3 3"/></svg>`;
// Distance: a footsteps-track icon (two oblong soles).
const ICON_DIST = `<svg viewBox="0 0 24 24"><path d="M8 4c-1.5 0-2.5 2-2 4.5.4 2 1.4 3 2.4 3s2-1 2-3-1-4.4-2.4-4.5z"/><path d="M6 14h4l-.5 2.5c-.2 1.4-1.5 2-2.4 1.5-.9-.5-1.4-1.7-1.1-2.7L6 14z"/><path d="M16 9c-1.5 0-2.5 2-2 4.5.4 2 1.4 3 2.4 3s2-1 2-3-1-4.4-2.4-4.5z"/><path d="M14 19h4l-.5 2.5c-.2 1.4-1.5 2-2.4 1.5-.9-.5-1.4-1.7-1.1-2.7L14 19z"/></svg>`;

const BRAND_SPRITES = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="brand-gmaps" viewBox="0 0 32 32">
  <clipPath id="gmaps-pin"><path d="M16 2 C9.4 2 4 7.4 4 14 C4 23 16 30 16 30 C16 30 28 23 28 14 C28 7.4 22.6 2 16 2 Z"/></clipPath>
  <g clip-path="url(#gmaps-pin)">
    <rect x="0"  y="0"  width="16" height="15" fill="#ea4335"/>
    <rect x="16" y="0"  width="16" height="15" fill="#4285f4"/>
    <rect x="0"  y="15" width="16" height="17" fill="#fbbc04"/>
    <rect x="16" y="15" width="16" height="17" fill="#34a853"/>
  </g>
  <circle cx="16" cy="13.5" r="4" fill="#ffffff"/>
</symbol>
<symbol id="brand-swisstopo" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#e3dcc7"/>
  <path d="M14 15 Q19 13 24 16 L25 20 Q22 23 17 22 Z" fill="#b5be88" opacity="0.55"/>
  <path d="M2 11 Q9 8 16 10 T31 11" stroke="#7c6536" stroke-width="0.9" fill="none" opacity="0.85"/>
  <path d="M2 17 Q9 14 18 16 T31 17" stroke="#7c6536" stroke-width="0.9" fill="none" opacity="0.75"/>
  <path d="M2 23 Q10 20 19 22 T31 23" stroke="#7c6536" stroke-width="0.9" fill="none" opacity="0.65"/>
  <path d="M3 27 Q7 25 10 27 T16 27" stroke="#5b91c3" stroke-width="1.2" fill="none"/>
  <path d="M20 19 L23 22 M23 19 L20 22" stroke="#1f1f1f" stroke-width="1.3" stroke-linecap="round"/>
  <circle cx="22" cy="25" r="0.9" fill="#4f6f33"/>
  <circle cx="24.5" cy="26.5" r="0.9" fill="#4f6f33"/>
  <circle cx="20.5" cy="27" r="0.9" fill="#4f6f33"/>
  <path d="M2 2 L11 2 L11 7 C11 9 6.5 10.5 6.5 10.5 C6.5 10.5 2 9 2 7 Z" fill="#dc2828"/>
  <rect x="5.7" y="3.5" width="1.6" height="5" fill="white"/>
  <rect x="3.8" y="5.4" width="5.4" height="1.6" fill="white"/>
</symbol>
<symbol id="brand-applemaps" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#f5f1eb"/>
  <path d="M0 22 L10 18 L14 24 L0 28 Z" fill="#a8d49b" opacity="0.8"/>
  <path d="M0 11 Q9 8 18 12 T32 11" stroke="#fcd34d" stroke-width="2.2" fill="none"/>
  <path d="M0 26 Q10 21 22 26 T32 25" stroke="#86efac" stroke-width="1.8" fill="none"/>
  <circle cx="20" cy="14" r="7" fill="#3478f6"/>
  <path d="M20 9.5 L23.2 18.5 L20 17 L16.8 18.5 Z" fill="white"/>
</symbol>
</defs></svg>`;

// ─── Helpers for the planning panel ─────────────────────────────────────

// Show the "How to get there →" CTA + planning panel when the spot has
// either real route data OR an `access` block (drive-up / boat / transit
// instructions for spots without a hike). Either is enough to flip.
function hasPlanningData(spot) {
  if (hasAccessData(spot)) return true;
  if (!Array.isArray(spot.routes) || spot.routes.length === 0) return false;
  return spot.routes.some(r =>
    r.sac_grade || r.duration_min || r.start || r.transit || r.swisstopo_url
  );
}

function hasAccessData(spot) {
  // `arrival` is our drive-up / transit object. Distinct from the legacy
  // `access` string used in the front-side spec grid ("Drive + short hike").
  const a = spot.arrival;
  if (!a || typeof a !== "object") return false;
  return !!(a.by_car || a.by_train_bus || a.by_boat || a.best_time || a.operating);
}

function fmtDuration(min) {
  if (!min) return null;
  if (min < 60) return { value: String(min), unit: "min" };
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? { value: `${h}h ${m}`, unit: "" } : { value: `${h}h`, unit: "" };
}

function fmtThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function busyDotsHtml(n) {
  if (!n) return `<span class="missing">—</span>`;
  let out = `<span class="hb-busy">`;
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= n ? "on" : ""}"></span>`;
  return out + `</span>`;
}

function statCell(label, valueHtml, iconSvg) {
  return `<div class="hb-stats-cell">
    <span class="icon">${iconSvg}</span>
    <span class="value">${valueHtml}</span>
    <span class="label">${label}</span>
  </div>`;
}

// Back-overview stats bar: 3 cells (Altitude, Accessibility, Crowdedness).
// "Accessibility" surfaces the easiest grade across all the spot's hikes —
// what's the gentlest way in. For drive-up-only spots it shows "Drive-up".
function renderOverviewStatsBar(spot) {
  const tf = spot.trip_facts || {};
  const alt = tf.elevation_m ? `${fmtThousands(tf.elevation_m)}<span class="unit">m</span>` : `<span class="missing">—</span>`;

  // Lowest sac_grade across the spot's routes. T-grades sort by their number;
  // K-grades (via ferrata) fall behind T-grades since they imply gear.
  let access = `<span class="missing">—</span>`;
  if (Array.isArray(spot.routes) && spot.routes.length) {
    const ranked = spot.routes
      .filter(r => r.sac_grade)
      .map(r => {
        const g = String(r.sac_grade);
        const t = g.startsWith("T") ? parseInt(g.slice(1), 10) || 9 : 99;
        return { route: r, sort: t };
      })
      .sort((a, b) => a.sort - b.sort);
    if (ranked.length) {
      const easiest = ranked[0].route;
      const label = easiest.effort_label || "";
      access = `${escapeHtml(easiest.sac_grade)}${label ? `<span class="unit">· ${escapeHtml(label)}</span>` : ""}`;
    }
  } else if (hasAccessData(spot)) {
    access = `Drive-up`;
  }

  return `<div class="hb-stats-bar hb-stats-bar--compact">
    ${statCell("Altitude", alt, ICON_ELEV)}
    ${statCell("Accessibility", access, ICON_DIFF)}
    ${statCell("Crowdedness", busyDotsHtml(tf.busyness), ICON_BUSY)}
  </div>`;
}

// Per-route stats bar: 5 cells (Altitude, Difficulty, Duration, Elevation
// change, Distance). Altitude is a spot-level constant; the rest are
// route-specific. Crowdedness is NOT shown here — it's a spot attribute,
// not a route attribute.
//
// Elevation change cell shows "+gain" when only ascent is known, or
// "+gain / -loss" when descent_m differs. Distance shows "—" when unknown.
//
// Called server-side once with the first route as a placeholder; the JS in
// flipScriptFor swaps the route-specific values per click.
function fmtElevationChange(gainM, descentM) {
  if (!gainM && !descentM) return null;
  // Default descent to gain when descent is unset — most hikes are
  // out-and-back, so a missing descent_m means "same as gain". Where a
  // hike has explicit asymmetric descent (one-way ridge / traverse),
  // descent_m is set explicitly. Always rendering both makes the cell
  // self-explanatory.
  const up = gainM || descentM;
  const down = descentM != null ? descentM : gainM;
  return `+${up}<span class="unit">m</span> <span class="unit">/</span> -${down}<span class="unit">m</span>`;
}

function renderRouteStatsBar(spot, route) {
  const tf = spot.trip_facts || {};
  const r = route || (spot.routes && spot.routes[0]) || {};
  const alt = tf.elevation_m ? `${fmtThousands(tf.elevation_m)}<span class="unit">m</span>` : `<span class="missing">—</span>`;
  const sac = r.sac_grade ? `<span data-rd-sac>${escapeHtml(r.sac_grade)}</span>${r.effort_label ? `<span class="unit"><span data-rd-sac-sep>·</span> <span data-rd-sac-label>${escapeHtml(r.effort_label)}</span></span>` : `<span class="unit" data-rd-sac-tail></span>`}` : `<span class="missing" data-rd-sac>—</span><span class="unit" data-rd-sac-tail></span>`;
  const t = fmtDuration(r.duration_min);
  const time = t
    ? `<span data-rd-dur>${t.value}</span>${t.unit ? `<span class="unit" data-rd-dur-unit>${t.unit}</span>` : `<span class="unit" data-rd-dur-unit></span>`}`
    : `<span class="missing" data-rd-dur>—</span><span class="unit" data-rd-dur-unit></span>`;
  const elevChange = fmtElevationChange(r.gain_m, r.descent_m);
  const elev = elevChange
    ? `<span data-rd-elev-change>${elevChange}</span>`
    : `<span class="missing" data-rd-elev-change>—</span>`;
  const dist = r.distance_km
    ? `<span data-rd-dist>${r.distance_km}</span><span class="unit">km</span>`
    : `<span class="missing" data-rd-dist>—</span>`;

  return `<div class="hb-stats-bar">
    ${statCell("Altitude", alt, ICON_ELEV)}
    ${statCell("Difficulty", sac, ICON_DIFF)}
    ${statCell("Duration", time, ICON_TIME)}
    ${statCell("Elevation change", elev, ICON_GAIN)}
    ${statCell("Distance", dist, ICON_DIST)}
  </div>`;
}

// Google Maps + Apple Maps point at the spot itself.
// SwissTopo points at the quickest route's deeplink when one exists (which is
// route-specific). Each route's own detail panel will also have its own
// SwissTopo button.
// Parse WGS84 lat/lon out of a Google Maps URL.
// Google's URLs encode coordinates two different ways:
//   1. !8m2!3d{lat}!4d{lon}  — the PLACE'S actual coordinates (preferred)
//   2. @{lat},{lon},{zoom}    — the CAMERA / viewport position. Can be miles
//                                from the actual place (sometimes default
//                                view of Europe).
// Always prefer (1); fall back to (2) only if absent (rare).
// Short share URLs (maps.app.goo.gl) carry no coords inline.
function extractLatLon(mapsUrl) {
  if (!mapsUrl) return null;
  const placeMatch = mapsUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (placeMatch) {
    return { lat: parseFloat(placeMatch[1]), lon: parseFloat(placeMatch[2]) };
  }
  const camMatch = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (camMatch) {
    return { lat: parseFloat(camMatch[1]), lon: parseFloat(camMatch[2]) };
  }
  return null;
}

// WGS84 -> CH1903+ / LV95 (the coordinate system map.geo.admin.ch uses).
// Standard approximation formulas from swisstopo's navref. Accurate to
// within ~1 m for our use case (centering the SwissTopo viewer on a spot).
function wgs84ToLv95(lat, lon) {
  const phi = (lat * 3600 - 169028.66) / 10000;   // latitude offset from Bern
  const lam = (lon * 3600 - 26782.5) / 10000;     // longitude offset from Bern
  const E = 2600072.37
          + 211455.93 * lam
          - 10938.51 * lam * phi
          - 0.36 * lam * phi * phi
          - 44.54 * lam * lam * lam;
  const N = 1200147.07
          + 308807.95 * phi
          + 3745.25 * lam * lam
          + 76.63 * phi * phi
          - 194.56 * lam * lam * phi
          + 119.79 * phi * phi * phi;
  return { E: Math.round(E), N: Math.round(N) };
}

function renderLinksRow(spot) {
  const gmaps = spot.maps_url
    ? `<a class="hb-link-pill" href="${escapeHtml(spot.maps_url)}" target="_blank" rel="noopener"><span class="hb-brand-icon"><svg><use href="#brand-gmaps"/></svg></span>Google Maps</a>`
    : "";
  const apple = spot.maps_url
    ? `<a class="hb-link-pill" href="${escapeHtml(spot.maps_url.replace("google.com/maps", "maps.apple.com"))}" target="_blank" rel="noopener"><span class="hb-brand-icon"><svg><use href="#brand-applemaps"/></svg></span>Apple Maps</a>`
    : "";
  // SwissTopo: deeplink that actually centers on the spot. Parse lat/lon
  // out of the maps_url, convert to CH1903+ (LV95), build a map.geo.admin.ch
  // URL with E/N + a marker. Skip for `beyond` chapter spots (SwissTopo
  // only covers Swiss territory) and spots without parseable coords.
  let topoUrl = null;
  if (spot.chapter !== "beyond" && spot.maps_url) {
    const ll = extractLatLon(spot.maps_url);
    if (ll) {
      const { E, N } = wgs84ToLv95(ll.lat, ll.lon);
      topoUrl = `https://map.geo.admin.ch/?lang=en&zoom=10&crosshair=marker&E=${E}&N=${N}`;
    }
  }
  const topo = topoUrl
    ? `<a class="hb-link-pill" href="${topoUrl}" target="_blank" rel="noopener"><span class="hb-brand-icon"><svg><use href="#brand-swisstopo"/></svg></span>SwissTopo</a>`
    : "";
  if (!gmaps && !topo && !apple) return "";
  return `<div class="hb-links-row">${gmaps}${topo}${apple}</div>`;
}

// Thumbnail strategy for a route row:
//   1. If route.thumb is explicitly set in content.yaml, use it verbatim.
//   2. Otherwise pick a derivative from the spot's photo gallery, cycled by
//      route index so different routes get different photos. p0 is main.jpg,
//      p1 is photos[0], p2 is photos[1], etc.
//   3. Clamp the index to the number of available photos so we never reach
//      for a derivative that doesn't exist.
function routeThumbSrc(spot, idx) {
  const totalPhotos = 1 + (Array.isArray(spot.photos) ? spot.photos.length : 0);
  const photoIdx = Math.min(idx, totalPhotos - 1);
  return `../../img/derivatives/${spot.id}_p${photoIdx}/w1800.webp`;
}

function routeRow(spot, route, idx) {
  const t = fmtDuration(route.duration_min);
  const stats = [];
  if (t) stats.push(`<span class="hb-route-stat">${ICON_TIME}<span class="v">${t.value}${t.unit ? " " + t.unit : ""}</span></span>`);
  if (route.sac_grade) stats.push(`<span class="hb-route-stat">${ICON_DIFF}<span class="v">${escapeHtml(route.sac_grade)}${route.effort_label ? " · " + escapeHtml(route.effort_label) : ""}</span></span>`);
  if (route.gain_m) stats.push(`<span class="hb-route-stat">${ICON_GAIN}<span class="v">${route.gain_m} m gain</span></span>`);

  const badge = route.quickest ? `<span class="hb-route-badge">Quickest</span>` : "";
  // Prefer the hike's curated `name` (perspective-independent, set when two
  // hikes for the same spot share a trailhead label or when "Hike from X"
  // reads awkwardly because the spot itself IS X). Fall back to the
  // trailhead string, then to a numeric placeholder.
  const name = route.name
    ? escapeHtml(route.name)
    : route.start
      ? `Hike from ${escapeHtml(route.start)}`
      : `Route ${idx + 1}`;

  // Surface operating hours for cable cars and huts at a glance so the user
  // doesn't have to drill into the route detail view to find them.
  const opening = [];
  if (route.cable_car && route.cable_car.open_raw) {
    opening.push(`Cable car: ${escapeHtml(route.cable_car.open_raw)}`);
  }
  if (route.hut && route.hut.open_raw) {
    opening.push(`Hut: ${escapeHtml(route.hut.open_raw)}`);
  }
  const openingHtml = opening.length
    ? `<div class="hb-route-operating">${opening.join(" · ")}</div>`
    : "";

  const thumbSrc = route.thumb || routeThumbSrc(spot, idx);
  const thumb = `<div class="hb-route-thumb"><img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" /></div>`;

  return `<button type="button" class="hb-route-row" data-route-idx="${idx}">
    ${thumb}
    <div class="hb-route-meta">
      <div class="hb-route-name">${name} ${badge}</div>
      <div class="hb-route-stats">${stats.join("")}</div>
      ${openingHtml}
    </div>
    <span class="hb-route-chev">${CHEV_RIGHT_SVG}</span>
  </button>`;
}

function renderRoutesList(spot) {
  if (!spot.routes || !spot.routes.length) return "";
  const rows = spot.routes.map((r, i) => routeRow(spot, r, i)).join("");
  return `<p class="hb-section-h">Routes</p>
  <div class="hb-routes-list">${rows}</div>`;
}

function renderWildcampingNote(spot) {
  const note = spot.wildCamping?.note;
  if (!note) return "";
  return `<p class="hb-wildcamping-note">${escapeHtml(note)}</p>`;
}

// Renders the "How to get there" Access section for drive-up / boat /
// transit-accessed spots. Sub-blocks are only emitted when the spot has
// that data — empty fields don't render.
function renderAccessSection(spot) {
  // Prefer the longer paragraph form (`access_long`) on the back if it's been
  // authored. Otherwise fall back to the short front-side `access` string
  // ("Firstbahn cable car + 50-60 min hike"). For hike-only spots without an
  // arrival object, this paragraph IS the whole "How to get there" section.
  // We skip rendering anything if neither summary nor structured data exists —
  // there'd be nothing left to show.
  const accessSummary = (typeof spot.access_long === "string" && spot.access_long.trim())
    ? spot.access_long.trim()
    : (typeof spot.access === "string" && spot.access.trim())
      ? spot.access.trim()
      : null;
  const hasArrival = hasAccessData(spot);
  if (!accessSummary && !hasArrival) return "";
  const a = spot.arrival || {};
  const blocks = [];

  if (a.by_car) {
    const car = a.by_car;
    const lines = [];
    if (car.directions) lines.push(escapeHtml(car.directions));
    if (car.parking) lines.push(`<span class="hb-access-detail">Parking</span> ${escapeHtml(car.parking)}`);
    if (car.walk_to_spot_min) lines.push(`<span class="hb-access-detail">Walk to spot</span> ${car.walk_to_spot_min} min`);
    blocks.push(`<div class="hb-access-block">
      <p class="hb-access-mode"><span class="hb-access-icon">🚗</span>By car</p>
      <div class="hb-access-body">${lines.map(l => `<p>${l}</p>`).join("")}</div>
    </div>`);
  }
  if (a.by_train_bus) {
    const tb = a.by_train_bus;
    const lines = [];
    if (typeof tb === "string") lines.push(escapeHtml(tb));
    else {
      if (tb.route) lines.push(escapeHtml(tb.route));
      if (tb.walk_from_stop_min) lines.push(`<span class="hb-access-detail">Walk from stop</span> ${tb.walk_from_stop_min} min`);
    }
    blocks.push(`<div class="hb-access-block">
      <p class="hb-access-mode"><span class="hb-access-icon">🚆</span>By train + bus</p>
      <div class="hb-access-body">${lines.map(l => `<p>${l}</p>`).join("")}</div>
    </div>`);
  }
  if (a.by_boat) {
    const bo = a.by_boat;
    const lines = [];
    if (typeof bo === "string") lines.push(escapeHtml(bo));
    else {
      if (bo.route) lines.push(escapeHtml(bo.route));
      if (bo.walk_from_stop_min) lines.push(`<span class="hb-access-detail">Walk from stop</span> ${bo.walk_from_stop_min} min`);
    }
    blocks.push(`<div class="hb-access-block">
      <p class="hb-access-mode"><span class="hb-access-icon">⛴</span>By boat</p>
      <div class="hb-access-body">${lines.map(l => `<p>${l}</p>`).join("")}</div>
    </div>`);
  }
  if (a.best_time) {
    blocks.push(`<div class="hb-access-block">
      <p class="hb-access-mode"><span class="hb-access-icon">🕒</span>When to go</p>
      <div class="hb-access-body"><p>${escapeHtml(a.best_time)}</p></div>
    </div>`);
  }
  if (a.operating) {
    blocks.push(`<div class="hb-access-block">
      <p class="hb-access-mode"><span class="hb-access-icon">📅</span>Hours / season</p>
      <div class="hb-access-body"><p>${escapeHtml(a.operating)}</p></div>
    </div>`);
  }

  const summaryHtml = accessSummary
    ? `<p class="hb-access-summary">${escapeHtml(accessSummary)}</p>`
    : "";
  const cardHtml = blocks.length
    ? `<div class="hb-access-card">${blocks.join("")}</div>`
    : "";
  return `<p class="hb-section-h">How to get there</p>${summaryHtml}${cardHtml}`;
}

function renderBackOverview(spot) {
  // The "How to get there" section is rendered ONLY for drive-up-only spots
  // (no hikes). When the spot has hikes, the per-route details cover access,
  // so a separate access paragraph would be redundant or contradictory.
  const hasHikes = Array.isArray(spot.routes) && spot.routes.length > 0;
  const arrivalSection = !hasHikes ? renderAccessSection(spot) : "";
  return `<div class="hb-flip-back-view hb-flip-back-view-overview">
    <div class="hb-back-topbar">
      <button type="button" class="hb-back-flip-back" data-action="flip-front">${ARROW_LEFT_SVG}Back to photo</button>
      <p class="hb-back-title">Planning · <b>${escapeHtml(spot.title)}</b></p>
    </div>
    ${renderLinksRow(spot)}
    ${renderOverviewStatsBar(spot)}
    ${arrivalSection}
    ${renderRoutesList(spot)}
    ${renderWildcampingNote(spot)}
  </div>`;
}

function renderRouteDetailView(spot) {
  // Placeholder route detail. JS swaps the content per-route at runtime.
  // The hut / cable-car / description slots only appear when the active
  // route carries that data — the JS hides empty ones.
  //
  // The 5-cell stats bar reuses the overview bar's design (same .hb-stats-bar
  // class), populated per-route. Elevation + Crowdedness are spot-level
  // constants so they stay static; Difficulty / Duration / Gain change per
  // route via the data-rd-* hooks.
  return `<div class="hb-flip-back-view hb-flip-back-view-route">
    <div class="hb-back-topbar">
      <button type="button" class="hb-back-route-btn" data-action="flip-overview">${ARROW_LEFT_SVG}Routes</button>
      <p class="hb-back-title">Approach to <b>${escapeHtml(spot.title)}</b></p>
    </div>
    <div class="hb-rd-head">
      <p class="hb-rd-kicker">Route</p>
      <h3 class="hb-rd-name"><span data-rd-name>—</span></h3>
    </div>
    <p class="hb-spot-description" data-rd-description hidden></p>
    ${renderRouteStatsBar(spot)}
    <div class="hb-detail-card"><div class="hb-detail-grid">
      <div><span class="lbl">Equipment</span><span class="val" data-rd-equipment>—</span></div>
      <div><span class="lbl">Start</span><span class="val" data-rd-start>—</span></div>
      <div><span class="lbl">Transit</span><span class="val" data-rd-transit>—</span></div>
    </div></div>

    <div data-rd-hut hidden>
      <p class="hb-section-h">Mountain hut</p>
      <div class="hb-detail-card hb-detail-card--compact"><div class="hb-detail-grid">
        <div><span class="lbl">Name</span><span class="val" data-rd-hut-name>—</span></div>
        <div><span class="lbl">Cost</span><span class="val" data-rd-hut-cost>—</span></div>
        <div><span class="lbl">Open</span><span class="val" data-rd-hut-open>—</span></div>
        <div><span class="lbl">Website</span><span class="val" data-rd-hut-website>—</span></div>
      </div></div>
    </div>

    <div data-rd-cable hidden>
      <p class="hb-section-h">Cable car</p>
      <div class="hb-detail-card hb-detail-card--compact"><div class="hb-detail-grid">
        <div><span class="lbl">Name</span><span class="val" data-rd-cable-line>—</span></div>
        <div><span class="lbl">Open</span><span class="val" data-rd-cable-open>—</span></div>
        <div><span class="lbl">Website</span><span class="val" data-rd-cable-info>—</span></div>
      </div></div>
    </div>

    <div class="hb-links-row" data-rd-actions></div>

    <div class="hb-route-sources" data-rd-sources hidden>
      <p class="hb-sources-h">Sources</p>
      <ul class="hb-sources-list" data-rd-sources-list></ul>
    </div>
  </div>`;
}

function renderBackSide(spot) {
  return `<section class="slide-spot-back" data-view="overview" data-spot-id="${escapeHtml(spot.id)}">
    ${renderBackOverview(spot)}
    ${renderRouteDetailView(spot)}
  </section>`;
}

// ─── Front render (existing, plus the optional "How to get there →" CTA) ─

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

  // When a spot has planning data, the bottom row becomes the full-width
  // "How to get there →" CTA that flips to the planning panel. On mobile
  // it scrolls the panel into view instead. When a spot has no planning
  // data, fall back to the production .sp-foot with "Open in Maps".
  const mapsLink = (!hasPlanningData(spot) && spot.maps_url)
    ? `      <a class="locked" href="${escapeHtml(spot.maps_url)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:500;">${MAPS_PIN_SVG}Open in Maps</a>`
    : "";
  const flipCta = hasPlanningData(spot)
    ? `      <button type="button" class="hb-flip-cta-row" data-action="flip-back">How to get there ${ARROW_RIGHT_SVG}</button>`
    : "";

  const front = `    <section class="slide slide-spot" id="${escapeHtml(spot.id)}">
  <div class="sp-photo">
    <img src="${primarySrc(spot.id)}" srcset="${primarySrcset(spot.id)}" sizes="(min-width: 768px) 800px, 100vw" alt="${escapeHtml(spot.title)}" fetchpriority="high" decoding="async" />
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
    ${hasPlanningData(spot)
      ? flipCta
      : `<div class="sp-foot">\n${mapsLink}\n    </div>`}
  </div>
</section>`;

  if (!hasPlanningData(spot)) return front;

  return `<div class="hb-flip-shell"><div class="hb-flip-card" data-hb-flip-card>
${front}
${renderBackSide(spot)}
  </div></div>`;
}

// ─── Flip + route detail JS (inlined per spot page) ─────────────────────

function flipScriptFor(spot) {
  const routesJson = JSON.stringify(spot.routes || []).replace(/</g, "\\u003c");
  return `
<script>
(function(){
  const card = document.querySelector('[data-hb-flip-card]');
  if (!card) return;
  const back = card.querySelector('.slide-spot-back');
  const ROUTES = ${routesJson};

  // Brand sprite definitions for the route-detail action row
  const SPRITE = {
    gmaps:    '<svg><use href="#brand-gmaps"/></svg>',
    topo:     '<svg><use href="#brand-swisstopo"/></svg>',
    apple:    '<svg><use href="#brand-applemaps"/></svg>',
  };

  function fmtDuration(min) {
    if (!min) return null;
    if (min < 60) return { value: String(min), unit: 'min' };
    const h = Math.floor(min / 60), m = min % 60;
    return m ? { value: h + 'h ' + m, unit: '' } : { value: h + 'h', unit: '' };
  }

  function fmtElevationChange(gainM, descentM) {
    if (!gainM && !descentM) return null;
    // Default descent to gain (most hikes are out-and-back). Asymmetric
    // routes set descent_m explicitly.
    const up = gainM || descentM;
    const down = descentM != null ? descentM : gainM;
    return '+' + up + 'm / -' + down + 'm';
  }

  function setText(sel, txt) {
    const el = back.querySelector(sel);
    if (el) el.textContent = txt;
  }
  function setHTML(sel, html) {
    const el = back.querySelector(sel);
    if (el) el.innerHTML = html;
  }
  function toggle(sel, on) {
    const el = back.querySelector(sel);
    if (!el) return;
    if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }
  function escAttr(s) { return String(s).replaceAll('&','&amp;').replaceAll('"','&quot;'); }

  function showRoute(i) {
    const r = ROUTES[i];
    if (!r) return;

    setText('[data-rd-name]', r.name || (r.start ? ('Hike from ' + r.start) : ('Route ' + (i + 1))));
    const badgeHost = back.querySelector('.hb-rd-name');
    let badge = badgeHost.querySelector('.hb-route-badge');
    if (r.quickest) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'hb-route-badge';
        badge.textContent = 'Quickest';
        badgeHost.appendChild(badge);
      }
    } else if (badge) badge.remove();

    // Per-route description sits at the top, just under the title.
    const descEl = back.querySelector('[data-rd-description]');
    if (r.description_extra) {
      descEl.textContent = r.description_extra;
      descEl.removeAttribute('hidden');
    } else {
      descEl.setAttribute('hidden', '');
    }

    // SAC grade cell: separate spans for the grade vs. the optional "· Label"
    // suffix so the JS can populate them independently. setText handles the
    // missing case by clearing the cell.
    const sacEl       = back.querySelector('[data-rd-sac]');
    const sacSepEl    = back.querySelector('[data-rd-sac-sep]');
    const sacLabelEl  = back.querySelector('[data-rd-sac-label]');
    if (sacEl) {
      if (r.sac_grade) {
        sacEl.textContent = r.sac_grade;
        sacEl.classList.remove('missing');
        if (r.effort_label && sacLabelEl) {
          sacLabelEl.textContent = r.effort_label;
          if (sacSepEl) sacSepEl.textContent = '·';
        } else if (sacLabelEl) {
          sacLabelEl.textContent = '';
          if (sacSepEl) sacSepEl.textContent = '';
        }
      } else {
        sacEl.textContent = '—';
        sacEl.classList.add('missing');
        if (sacLabelEl) sacLabelEl.textContent = '';
        if (sacSepEl) sacSepEl.textContent = '';
      }
    }

    // Duration cell: split value + unit so units stay subtle.
    const durEl     = back.querySelector('[data-rd-dur]');
    const durUnitEl = back.querySelector('[data-rd-dur-unit]');
    if (durEl) {
      const fd = fmtDuration(r.duration_min);
      if (fd) {
        durEl.textContent = fd.value;
        durEl.classList.remove('missing');
        if (durUnitEl) durUnitEl.textContent = fd.unit || '';
      } else {
        durEl.textContent = '—';
        durEl.classList.add('missing');
        if (durUnitEl) durUnitEl.textContent = '';
      }
    }

    // Elevation change cell: always show "+up m / -down m". Wraps each
    // "m" suffix + the "/" in unit-styled spans so they sit subtly in the
    // value. Built by tokenizing the formatted string instead of a regex
    // to avoid the template-literal escape pitfall.
    const elevEl = back.querySelector('[data-rd-elev-change]');
    if (elevEl) {
      const ec = fmtElevationChange(r.gain_m, r.descent_m);
      if (ec) {
        // ec looks like "+1075m / -2015m". Wrap each "m" and the "/" in unit spans.
        const styled = ec
          .replaceAll('m / ', '<span class="unit">m</span> <span class="unit">/</span> ')
          .replace(/m$/, '<span class="unit">m</span>');
        elevEl.innerHTML = styled;
        elevEl.classList.remove('missing');
      } else {
        elevEl.textContent = '—';
        elevEl.classList.add('missing');
      }
    }

    // Distance cell
    const distEl = back.querySelector('[data-rd-dist]');
    if (distEl) {
      if (r.distance_km) {
        distEl.textContent = r.distance_km;
        distEl.classList.remove('missing');
      } else {
        distEl.textContent = '—';
        distEl.classList.add('missing');
      }
    }
    // Prefer the concrete equipment_list (array of items). Fall back to the
    // legacy boolean for any hikes that haven't been migrated yet. Empty array
    // explicitly means "no gear needed", not unknown.
    if (Array.isArray(r.equipment_list)) {
      setText('[data-rd-equipment]', r.equipment_list.length ? r.equipment_list.join(' · ') : 'None');
    } else if (r.equipment_required === undefined) {
      setText('[data-rd-equipment]', '—');
    } else {
      setText('[data-rd-equipment]', r.equipment_required ? 'Required' : 'None');
    }

    if (r.start) {
      // Prefer an explicit start_maps_url (deep-link to the exact start
      // point, set per-hike in hikes.yaml). Falls back to a generic
      // Google Maps search of the start string — only good when the
      // string is unambiguous, so explicit URLs are encouraged for
      // anything ambiguous (cable car top stations, alpine hamlets).
      const startUrl = r.start_maps_url
        ? r.start_maps_url
        : ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.start));
      setHTML('[data-rd-start]',
        '<a href="' + escAttr(startUrl) +
        '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;display:inline-flex;gap:5px;align-items:center;">' +
        r.start +
        ' <svg viewBox="0 0 24 24" style="width:12px;height:12px;" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg></a>');
    } else {
      setText('[data-rd-start]', '—');
    }

    const tParts = [];
    if (r.transit && r.transit.train)     tParts.push('Train: ' + r.transit.train);
    if (r.transit && r.transit.bus)       tParts.push('Bus: ' + r.transit.bus);
    if (r.transit && r.transit.cable_car) tParts.push('Cable car: ' + r.transit.cable_car);
    if (r.transit && r.transit.ferry)     tParts.push('Ferry: ' + r.transit.ferry);
    setHTML('[data-rd-transit]', tParts.length ? tParts.join('<br>') : '—');

    // Hut block · route-level
    if (r.hut) {
      toggle('[data-rd-hut]', true);
      setText('[data-rd-hut-name]',  r.hut.name || '—');
      setText('[data-rd-hut-cost]',  r.hut.cost_chf_raw || '—');
      setText('[data-rd-hut-open]',  r.hut.open_raw || '—');
      setHTML('[data-rd-hut-website]',
        r.hut.website ? ('<a href="' + escAttr(r.hut.website) + '" target="_blank" rel="noopener" style="color:var(--accent);">Visit ↗</a>') : '—');
    } else {
      toggle('[data-rd-hut]', false);
    }

    // Cable car block · route-level. Uses the canonical cable_cars.yaml
    // entity shape (name, cost_chf_raw, open_raw, website) rather than the
    // legacy embedded fields (line, info_url) which no longer exist on the
    // resolved entity, so the cells would always read "—".
    if (r.cable_car) {
      toggle('[data-rd-cable]', true);
      setText('[data-rd-cable-line]', r.cable_car.name || r.cable_car.line || '—');
      setText('[data-rd-cable-open]', r.cable_car.open_raw || '—');
      setHTML('[data-rd-cable-info]',
        r.cable_car.website ? ('<a href="' + escAttr(r.cable_car.website) + '" target="_blank" rel="noopener" style="color:var(--accent);">Visit ↗</a>') : '—');
    } else {
      toggle('[data-rd-cable]', false);
    }

    // Actions row · Google Maps to start, Apple Maps to start, SwissTopo for this route
    const acts = [];
    if (r.start) {
      const q = encodeURIComponent(r.start);
      // Honor explicit deep-link if provided; falls back to query search.
      const gmapsUrl = r.start_maps_url
        ? r.start_maps_url
        : ('https://www.google.com/maps/search/?api=1&query=' + q);
      acts.push('<a class="hb-link-pill" href="' + escAttr(gmapsUrl) + '" target="_blank" rel="noopener"><span class="hb-brand-icon">' + SPRITE.gmaps + '</span>Google Maps</a>');
      acts.push('<a class="hb-link-pill" href="https://maps.apple.com/?q=' + q + '" target="_blank" rel="noopener"><span class="hb-brand-icon">' + SPRITE.apple + '</span>Apple Maps</a>');
    }
    if (r.swisstopo_url) {
      acts.push('<a class="hb-link-pill" href="' + r.swisstopo_url + '" target="_blank" rel="noopener"><span class="hb-brand-icon">' + SPRITE.topo + '</span>SwissTopo</a>');
    }
    setHTML('[data-rd-actions]', acts.join(''));

    // Sources (per-hike, from hikes.yaml). Hidden when empty.
    const srcs = Array.isArray(r.sources) ? r.sources : [];
    const srcWrap = back.querySelector('[data-rd-sources]');
    const srcList = back.querySelector('[data-rd-sources-list]');
    if (srcs.length) {
      srcList.innerHTML = srcs.map(s => {
        const url = String(s);
        // Non-URL strings are rendered as plain text (no link)
        if (!/^https?:/.test(url)) {
          return '<li class="hb-source-item hb-source-text">' + escAttr(url) + '</li>';
        }
        // Shorten display: hostname + first path segment
        let display = url;
        try {
          const u = new URL(url);
          display = u.hostname.replace(/^www\\./, '');
        } catch (e) {}
        return '<li class="hb-source-item"><a href="' + escAttr(url) + '" target="_blank" rel="noopener">' + escAttr(display) + '</a></li>';
      }).join('');
      srcWrap.removeAttribute('hidden');
    } else {
      srcWrap.setAttribute('hidden', '');
    }

    back.dataset.view = 'route-detail';
  }

  // The card keeps the front's natural height through the flip. The back's
  // content is vertically centred (see .hb-flip-back-view CSS) so any
  // remaining space sits evenly above and below rather than dangling.

  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

  document.addEventListener('click', (e) => {
    const flipBack = e.target.closest('[data-action="flip-back"]');
    if (flipBack) {
      card.classList.add('is-flipped');
      // On mobile the flip is CSS-disabled; the planning panel sits below
      // the spot card in normal flow. Scroll it into view as a hint.
      if (isMobile()) back.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const flipFront = e.target.closest('[data-action="flip-front"]');
    if (flipFront) { card.classList.remove('is-flipped'); return; }
    const flipOverview = e.target.closest('[data-action="flip-overview"]');
    if (flipOverview) { back.dataset.view = 'overview'; return; }
    const routeRow = e.target.closest('.hb-route-row');
    if (routeRow) { showRoute(parseInt(routeRow.dataset.routeIdx, 10)); return; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (back.dataset.view === 'route-detail') back.dataset.view = 'overview';
    else card.classList.remove('is-flipped');
  });
})();
</script>`;
}

function renderSpotPage(spot) {
  const chapter = content.chapters.find(c => c.id === spot.chapter);
  const chapterName = chapter?.name || spot.chapter;
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
<link rel="manifest" href="../../../manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Hikebeast" />
<meta name="mobile-web-app-capable" content="yes" />
<link rel="stylesheet" href="../../preview.css?v=${Date.now()}" />
<link rel="preconnect" href="https://whimsical-sparrow-336.convex.cloud" crossorigin />
</head>
<body data-page="spot-detail">
${hasPlanningData(spot) ? BRAND_SPRITES : ""}
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
${hasPlanningData(spot) ? flipScriptFor(spot) : ""}
</body>
</html>
`;
}

let written = 0;
let enriched = 0;
for (const item of (content.spots ?? [])) {
  const kind = item.kind || "spot";
  if (kind !== "spot") continue;
  const html = renderSpotPage(item);
  const dst = join(FULL, "spot", item.id, "index.html");
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, html);
  written++;
  if (hasPlanningData(item)) enriched++;
}
console.log(`\nDONE. Generated ${written} spot detail pages at full/spot/<spotId>/index.html`);
console.log(`     ${enriched} of those have the flip-card planning panel.`);
