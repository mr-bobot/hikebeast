#!/usr/bin/env node
//
// Runs the full build pipeline in order:
//   1. webp derivative ladder (assets/spots/* → full/img/derivatives)
//   2. static asset copy (assets/ui, assets/front_matter → full/img)
//   3. chapter HTML (content.yaml → full/<chapter>/index.html)
//   4. spot detail pages (one per spot, pre-rendered)
//   5. spot-images sidecar (content.yaml → full/img/spot-images.js)
//   6. inject-convex-url — swap the prod Convex URL with $CONVEX_URL when
//      it differs (staging / preview deploys); no-op for prod builds and
//      for any local build without CONVEX_URL set.
//
// Convex seeding is intentionally NOT part of this — `npm run seed` runs it
// separately, since it pushes to a live deployment.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-all.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STEPS = [
  "build-image-derivatives.mjs",
  "build-static-assets.mjs",
  "build-chapter-html.mjs",
  "build-spot-pages.mjs",
  "build-spot-images.mjs",
  "inject-wildcamping-to-sidecar.mjs",
  "inject-convex-url.mjs",
];

for (const step of STEPS) {
  console.log(`\n=== ${step} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, step)], { stdio: "inherit" });
  if (r.status !== 0) { console.error(`FAILED: ${step}`); process.exit(r.status ?? 1); }
}
console.log("\n[build-all] DONE");
