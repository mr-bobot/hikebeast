#!/usr/bin/env node
//
// Generates the PWA icon set from images/favicon.jpg:
//   - images/icon-192.png  (Android home-screen icon, "any" purpose)
//   - images/icon-512.png  (high-res Android, splash screen)
//   - images/icon-512-maskable.png (any-shape mask: icon content lives in
//     the central 80% safe zone, padded by white background so any mask
//     shape — circle, squircle, rounded square — keeps the logo intact)
//
// Re-runs are idempotent: outputs are overwritten on every invocation.
//
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/build-pwa-icons.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "images", "favicon.jpg");
const OUT_DIR = path.join(REPO, "images");

async function plainResize(size, out) {
  await sharp(SRC).resize({ width: size, height: size, fit: "cover" }).png().toFile(out);
  console.log(`[pwa] ${path.relative(process.cwd(), out)}`);
}

async function maskableIcon(size, out) {
  // Maskable safe zone: central 80% of the canvas. Render the logo at
  // 80% on a white background so the OS shape mask can crop the outer
  // 10% on each side without touching the icon.
  const inner = Math.round(size * 0.8);
  const logo = await sharp(SRC).resize({ width: inner, height: inner, fit: "cover" }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(out);
  console.log(`[pwa] ${path.relative(process.cwd(), out)}`);
}

await plainResize(192, path.join(OUT_DIR, "icon-192.png"));
await plainResize(512, path.join(OUT_DIR, "icon-512.png"));
await maskableIcon(512, path.join(OUT_DIR, "icon-512-maskable.png"));
