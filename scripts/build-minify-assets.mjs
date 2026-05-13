#!/usr/bin/env node
//
// In-place minification of the two big design assets — full/preview.css
// (156 KB authored) and full/social.js (137 KB authored). Runs ONLY in the
// Vercel build environment so local `npm run build` keeps the readable
// versions in the working tree (the dev workflow assumes `preview.css` and
// `social.js` are inspectable + line-anchored in the browser devtools).
//
// Vercel sets process.env.VERCEL === "1" on the build runner.
// To test minification locally, run with `VERCEL=1 npm run build`.
//
// Drops roughly:
//   - preview.css : 156 KB → ~60 KB
//   - social.js   : 137 KB → ~70 KB
//
// Vercel already serves both with brotli/gzip, so the wire savings on top
// of that are smaller (~10-20 KB each), but parse time on first-load
// scales with the raw byte count and that's the real win.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const IS_VERCEL = process.env.VERCEL === "1";
if (!IS_VERCEL) {
  console.log("[minify-assets] skipping (not in Vercel build env)");
  process.exit(0);
}

const esbuild = await import("esbuild");

const TARGETS = [
  { file: "full/preview.css", loader: "css" },
  { file: "full/social.js",   loader: "js"  },
  { file: "full/preview.js",  loader: "js"  },
];

for (const { file, loader } of TARGETS) {
  const abs = path.join(REPO, file);
  if (!fs.existsSync(abs)) {
    console.warn(`[minify-assets] skipping missing ${file}`);
    continue;
  }
  const before = fs.statSync(abs).size;
  const src = fs.readFileSync(abs, "utf8");
  const result = await esbuild.transform(src, {
    loader,
    minify: true,
    target: loader === "js" ? "es2018" : undefined,
    legalComments: "none",
  });
  fs.writeFileSync(abs, result.code);
  const after = fs.statSync(abs).size;
  const pct = Math.round((1 - after / before) * 100);
  console.log(`[minify-assets] ${file}: ${before} → ${after} (${pct}%)`);
}
