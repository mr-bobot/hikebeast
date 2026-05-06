// Dump every spot with its current subheadline fallback (deck) to a markdown
// file the user can edit by hand. Format: chapter heading, then per-spot
// "Name:" / "Subheadline:" pairs separated by blank lines.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content.yaml");
const OUT = path.join(ROOT, "subheadlines.md");

const data = yaml.load(fs.readFileSync(CONTENT, "utf8"));
const chapters = data.chapters || [];
const allSpots = data.spots || [];

const byChapter = new Map();
for (const ch of chapters) byChapter.set(ch.id, []);
for (const s of allSpots) {
  const list = byChapter.get(s.chapter);
  if (list) list.push(s);
  else {
    if (!byChapter.has("__unassigned__")) byChapter.set("__unassigned__", []);
    byChapter.get("__unassigned__").push(s);
  }
}

const lines = [];
lines.push("# Subheadlines");
lines.push("");
lines.push("One or two sentences per spot, shown in the chapter Reader view.");
lines.push("Spots without a `subheadline` field fall back to `deck`; replace");
lines.push("with intentional Subheadline copy below and I'll wire it into");
lines.push("content.yaml. Spots that already have an explicit `subheadline`");
lines.push("are marked with `(set)` next to the name.");
lines.push("");

for (const ch of chapters) {
  const list = byChapter.get(ch.id) || [];
  if (!list.length) continue;
  lines.push(`## ${ch.name || ch.id}`);
  lines.push("");
  for (const s of list) {
    const hasSub = typeof s.subheadline === "string" && s.subheadline.trim().length > 0;
    const subhead = hasSub ? s.subheadline : s.deck || "";
    const tag = hasSub ? " (set)" : "";
    lines.push(`Name: ${s.title || s.id}${tag}`);
    lines.push(`Subheadline: ${subhead}`);
    lines.push("");
  }
}

const unassigned = byChapter.get("__unassigned__") || [];
if (unassigned.length) {
  lines.push("## Unassigned");
  lines.push("");
  for (const s of unassigned) {
    const hasSub = typeof s.subheadline === "string" && s.subheadline.trim().length > 0;
    const subhead = hasSub ? s.subheadline : s.deck || "";
    const tag = hasSub ? " (set)" : "";
    lines.push(`Name: ${s.title || s.id}${tag}`);
    lines.push(`Subheadline: ${subhead}`);
    lines.push("");
  }
}

fs.writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${allSpots.length} spots to ${path.relative(ROOT, OUT)}`);
