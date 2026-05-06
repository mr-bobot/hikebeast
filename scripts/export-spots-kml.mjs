// Export every catalogued spot from Convex into a Google-Earth KML.
//
//   node scripts/export-spots-kml.mjs              # full names + descriptions
//   node scripts/export-spots-kml.mjs --anonymize  # numbered #1..#N, no descriptions
//
// Output:
//   scripts/output/hikebeast-spots.kml            (full)
//   scripts/output/hikebeast-spots-anonymized.kml (anonymize flag)
//
// Spots are grouped into <Folder>s by chapter (Central, Western, etc.) so
// Google Earth's left-rail tree mirrors the guide. Spots without lat/lon
// are skipped (logged at the end).

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) throw new Error(".env.local not found");
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL) throw new Error("CONVEX_URL missing from .env.local");
  return env;
}

const CHAPTER_NAME = {
  central:  "01 · Central",
  western:  "02 · Western",
  eastern:  "03 · Eastern",
  ticino:   "04 · Ticino",
  valais:   "05 · Valais",
  fribourg: "06 · Fribourg",
  beyond:   "07 · Beyond",
};

const xmlEscape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// Convex stores colors as "R,G,B" decimal triplets. KML wants AABBGGRR hex.
function rgbToKmlColor(rgb, alpha = "ff") {
  const parts = String(rgb || "")
    .split(",")
    .map((n) => Math.max(0, Math.min(255, parseInt(n.trim(), 10) || 0)));
  if (parts.length !== 3) return alpha + "ffffff";
  const [r, g, b] = parts;
  const hex = (n) => n.toString(16).padStart(2, "0");
  return alpha + hex(b) + hex(g) + hex(r);
}

function descriptionFor(spot) {
  const lines = [];
  if (spot.kicker) lines.push(`<i>${xmlEscape(spot.kicker)}</i>`);
  if (spot.deck)   lines.push(xmlEscape(spot.deck));
  if (Array.isArray(spot.specs)) {
    for (const s of spot.specs) {
      lines.push(`<b>${xmlEscape(s.label)}:</b> ${xmlEscape(s.value)}`);
    }
  }
  if (spot.properties?.length) {
    lines.push(`<b>Tags:</b> ${xmlEscape(spot.properties.join(", "))}`);
  }
  if (spot.wildCamping?.verdict) {
    const wc = spot.wildCamping;
    lines.push(
      `<b>Wild camping:</b> ${xmlEscape(wc.verdict)}` +
      (wc.reason ? ` — ${xmlEscape(wc.reason)}` : "")
    );
  }
  if (spot.mapsUrl) {
    lines.push(`<a href="${xmlEscape(spot.mapsUrl)}">Open in Google Maps</a>`);
  }
  return lines.join("<br/>");
}

function buildKml(spots, { anonymize = false } = {}) {
  // Group by chapterId, preserving the legend order from `chapter`.
  const byChapter = new Map();
  for (const s of spots) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    if (!byChapter.has(s.chapterId)) byChapter.set(s.chapterId, []);
    byChapter.get(s.chapterId).push(s);
  }
  const ordered = [...byChapter.entries()].sort((a, b) => {
    const ca = a[1][0]?.chapter ?? "99";
    const cb = b[1][0]?.chapter ?? "99";
    return ca.localeCompare(cb);
  });

  // Number anonymized placemarks globally in folder iteration order, so #1
  // is the first pin in the first chapter and the numbering is stable across
  // re-runs as long as the catalog is unchanged.
  let counter = 0;

  // One <Style> per chapter (color is uniform within a chapter).
  const styles = ordered.map(([chapterId, list]) => {
    const color = rgbToKmlColor(list[0].color);
    return `  <Style id="chapter-${xmlEscape(chapterId)}">
    <IconStyle>
      <color>${color}</color>
      <scale>1.1</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.85</scale></LabelStyle>
  </Style>`;
  }).join("\n");

  const folders = ordered.map(([chapterId, list]) => {
    const folderName = CHAPTER_NAME[chapterId] ?? chapterId;
    const placemarks = list
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((s) => {
        counter += 1;
        const name = anonymize ? `#${counter}` : s.title;
        const descBlock = anonymize
          ? ""
          : `\n      <description><![CDATA[${descriptionFor(s)}]]></description>`;
        return `    <Placemark>
      <name>${xmlEscape(name)}</name>
      <styleUrl>#chapter-${xmlEscape(chapterId)}</styleUrl>${descBlock}
      <Point><coordinates>${s.lon},${s.lat},0</coordinates></Point>
    </Placemark>`;
      }).join("\n");
    return `  <Folder>
    <name>${xmlEscape(folderName)}</name>
${placemarks}
  </Folder>`;
  }).join("\n");

  const docName = anonymize
    ? "Hikebeast — Gems of Switzerland (anonymized)"
    : "Hikebeast — Gems of Switzerland of Switzerland";
  const docDesc = anonymize
    ? "All catalogued spots, names redacted as #1..#N."
    : "All catalogued spots, grouped by chapter.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${xmlEscape(docName)}</name>
  <description>${xmlEscape(docDesc)}</description>
${styles}
${folders}
</Document>
</kml>
`;
}

async function main() {
  const anonymize = process.argv.includes("--anonymize");
  const env = loadEnv();
  const client = new ConvexHttpClient(env.CONVEX_URL);
  const spots = await client.query(api.spots.list, {});
  console.log(`Fetched ${spots.length} spots from Convex.`);

  const skipped = spots.filter(
    (s) => typeof s.lat !== "number" || typeof s.lon !== "number"
  );
  const kml = buildKml(spots, { anonymize });

  const outDir = join(ROOT, "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const outName = anonymize
    ? "hikebeast-spots-anonymized.kml"
    : "hikebeast-spots.kml";
  const outPath = join(outDir, outName);
  writeFileSync(outPath, kml, "utf8");

  const placed = spots.length - skipped.length;
  console.log(`Wrote ${placed} placemarks to ${outPath}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} spots without coords:`);
    for (const s of skipped) console.log(`  - ${s.spotKey} (${s.title})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
