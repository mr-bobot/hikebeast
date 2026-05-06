#!/usr/bin/env node
//
// inject-convex-url.mjs — swap the source-of-truth Convex URL in HTML files
// with whatever the build environment specifies via process.env.CONVEX_URL.
//
// Why a build step instead of a runtime <script>?  The webapp is a pile of
// static HTML that runs no server logic before paint; the Convex client URL
// is needed before the WebSocket can open. Putting it in a build-time string
// replace keeps the HTML self-contained and skips a request to a /env.js
// endpoint on first paint.
//
// Defaults & invariants:
//   - Source-of-truth prod URL stays hard-coded in the repo
//     (`PROD_CONVEX_URL` below). This is what the page falls back to when
//     served without a build step (e.g. `python3 -m http.server`), so local
//     reading-only browsing always works against production.
//   - When `CONVEX_URL` is set in the build env (Vercel preview / staging),
//     we replace every occurrence of PROD_CONVEX_URL across `*.html` with
//     the env value. Other URLs are not touched.
//   - When `CONVEX_URL` matches PROD_CONVEX_URL (or is absent), this step
//     is a no-op. Production builds are unchanged.
//   - If `CONVEX_URL` is set but ZERO files matched (i.e. someone added a
//     differently-spelled hardcoded URL), we fail the build loudly so the
//     drift gets caught instead of silently shipping the wrong env.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// The canonical production URL that lives in the repo as the default.
// Update this only when production itself moves; staging/preview URLs go
// through CONVEX_URL at build time without touching any source file.
const PROD_CONVEX_URL = "https://whimsical-sparrow-336.convex.cloud";

const target = (process.env.CONVEX_URL || "").trim();
if (!target) {
  console.log(`[inject-convex-url] CONVEX_URL not set — leaving HTML as-is (prod default).`);
  process.exit(0);
}
if (target === PROD_CONVEX_URL) {
  console.log(`[inject-convex-url] CONVEX_URL matches prod default — no replacements needed.`);
  process.exit(0);
}

// Validate the override looks like a Convex URL so we don't ship bizarre
// values into the frontend by accident.
if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(target)) {
  console.error(`[inject-convex-url] CONVEX_URL doesn't look like a Convex deployment URL: ${target}`);
  process.exit(1);
}

// Find every HTML file in the deployable tree. Use git-ls-files so we don't
// pick up build outputs, archive copies, or anything gitignored.
let files;
try {
  files = execSync(`git ls-files '*.html' ':!:_archive/**'`, { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
} catch (err) {
  console.error(`[inject-convex-url] git ls-files failed: ${err.message}`);
  process.exit(1);
}

let touchedFiles = 0;
let totalReplacements = 0;
for (const rel of files) {
  const abs = resolve(ROOT, rel);
  let content;
  try { content = readFileSync(abs, "utf8"); }
  catch { continue; }
  if (!content.includes(PROD_CONVEX_URL)) continue;
  const next = content.split(PROD_CONVEX_URL).join(target);
  const replacements = (content.length - next.length) / (PROD_CONVEX_URL.length - target.length) || 1;
  // length math is off when target is longer; recount exactly:
  const exactCount = (content.match(new RegExp(PROD_CONVEX_URL.replace(/[/.]/g, "\\$&"), "g")) || []).length;
  writeFileSync(abs, next, "utf8");
  touchedFiles++;
  totalReplacements += exactCount;
  console.log(`  rewrote ${exactCount}× in ${rel}`);
}

if (touchedFiles === 0) {
  console.error(`[inject-convex-url] CONVEX_URL was set to ${target} but no HTML files contained ${PROD_CONVEX_URL}.`);
  console.error(`[inject-convex-url] Check whether the prod URL constant in this script still matches the repo.`);
  process.exit(1);
}

console.log(`\n[inject-convex-url] DONE  ${PROD_CONVEX_URL} → ${target}  (${totalReplacements} replacement(s) across ${touchedFiles} file(s))`);
