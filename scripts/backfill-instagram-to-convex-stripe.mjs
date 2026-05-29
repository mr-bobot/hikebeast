#!/usr/bin/env node
//
// One-shot backfill · mirrors ManyChat-sourced Instagram handles from
// the Signups sheet into Convex (users.instagramHandle) and Stripe
// (customer.metadata.instagram_handle).
//
// Pipeline since 2026-05-26 ships the IG handle to all three places
// for new buyers via the success-page form. This script catches up the
// ~111 historical buyers whose handle exists only in the Sheet column.
//
// Reads:
//   - Signups sheet → Apps Script `get_snapshot` action (hardcoded URL
//     + secret, same as scripts/snapshot.py · public-ish, not the prod
//     write path).
//   - .env.local for CONVEX_URL (prod), ADMIN_TOKEN, STRIPE_SECRET_KEY.
//
// Writes:
//   - Convex `auth:adminSetInstagramHandle` for each (email, ig_handle)
//     pair. setIfEmpty semantics · won't clobber an instagramHandle set
//     by the success-page form (or a previous run of this script).
//   - Stripe `customers.update(id, { metadata.instagram_handle: ig })`.
//     Skips if customer already has it. customer lookup via list by
//     email (1 expected match per buyer because customer_creation:
//     always in the checkout-session create).
//
// Idempotent · safe to re-run. Each row reports `set` / `already_set` /
// `not_found` per side (convex, stripe) so re-running until counts
// stabilize is the validation pattern.
//
// Usage:
//   cd <worktree>
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/backfill-instagram-to-convex-stripe.mjs
//   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/backfill-instagram-to-convex-stripe.mjs --dry-run

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// ── env ──────────────────────────────────────────────────────────────
function loadEnvFile() {
  const envPath = path.join(REPO, ".env.local");
  if (!fs.existsSync(envPath)) {
    // Fall back to the main checkout's .env.local. Worktrees don't always
    // carry env files but the parent clone does.
    const alt = "/Users/lost/Documents/Development/Hikebeast/.env.local";
    if (fs.existsSync(alt)) return parseEnv(fs.readFileSync(alt, "utf8"));
    throw new Error(`.env.local not found at ${envPath} or fallback`);
  }
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}
function parseEnv(raw) {
  const out = {};
  for (const line of raw.split("\n")) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const i = trim.indexOf("=");
    if (i === -1) continue;
    let v = trim.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[trim.slice(0, i)] = v;
  }
  return out;
}

const env = loadEnvFile();
const CONVEX_URL = env.CONVEX_URL;
const ADMIN_TOKEN = env.ADMIN_TOKEN;
const STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
if (!CONVEX_URL) throw new Error("CONVEX_URL missing from .env.local");
if (!ADMIN_TOKEN) throw new Error("ADMIN_TOKEN missing from .env.local");
if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY missing from .env.local");

const DRY_RUN = process.argv.includes("--dry-run");

// ── Snapshot ─────────────────────────────────────────────────────────
const SNAPSHOT_URL = "https://script.google.com/macros/s/AKfycbyEfTrFIeD8ohiVaEyI_aanwXrnKyosoAnbAhvpT3OHpNCNwcIqFHe1NwPUDxQRKNJwTw/exec";
const SNAPSHOT_SECRET = "88ecfbce-f1ad-4649-9f9c-4f10f47e8619";

async function fetchBuyers() {
  const res = await fetch(SNAPSHOT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SNAPSHOT_SECRET, action: "get_snapshot", parts: ["buyers"] }),
  });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const data = await res.json();
  return data?.buyers?.rows ?? [];
}

// ── Convex mutation (HTTP API, no SDK) ───────────────────────────────
async function convexSetIg(email, instagramHandle) {
  const u = CONVEX_URL.replace(/\/$/, "") + "/api/mutation";
  const res = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "auth:adminSetInstagramHandle",
      args: { email, instagramHandle, adminToken: ADMIN_TOKEN },
      format: "json",
    }),
  });
  const body = await res.json();
  if (body.status === "success") return body.value;
  return { ok: false, reason: body.errorMessage || JSON.stringify(body) };
}

// ── Stripe ───────────────────────────────────────────────────────────
const STRIPE_API = "https://api.stripe.com/v1";
async function stripeListCustomerByEmail(email) {
  const params = new URLSearchParams({ email, limit: "1" });
  const res = await fetch(`${STRIPE_API}/customers?${params}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  if (data.error) throw new Error("Stripe list: " + data.error.message);
  return data.data?.[0] ?? null;
}
async function stripeUpdateCustomer(customerId, ig) {
  const body = new URLSearchParams();
  body.set("metadata[instagram_handle]", ig);
  const res = await fetch(`${STRIPE_API}/customers/${customerId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (data.error) throw new Error("Stripe update: " + data.error.message);
  return data;
}

// ── Main loop ────────────────────────────────────────────────────────
function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/^@+/, "").slice(0, 40);
}

async function main() {
  console.log(DRY_RUN ? "DRY RUN · no writes\n" : "LIVE RUN · will write to Convex + Stripe\n");
  const buyers = await fetchBuyers();
  console.log(`Snapshot returned ${buyers.length} buyer rows.\n`);

  const counts = {
    skipped_no_email: 0, skipped_no_ig: 0,
    convex_set: 0, convex_already_set: 0, convex_not_found: 0, convex_error: 0,
    stripe_set: 0, stripe_already_set: 0, stripe_not_found: 0, stripe_error: 0,
  };
  const errors = [];

  for (let i = 0; i < buyers.length; i++) {
    const b = buyers[i];
    const email = String(b.email || "").trim().toLowerCase();
    const ig = norm(b.ig_handle);
    if (!email) { counts.skipped_no_email++; continue; }
    if (!ig) { counts.skipped_no_ig++; continue; }

    const tag = `[${i + 1}/${buyers.length}] ${email} → @${ig}`;
    if (DRY_RUN) { console.log(`${tag}  (dry-run, would update)`); continue; }

    // Convex
    try {
      const r = await convexSetIg(email, ig);
      if (r.ok && r.updated) { counts.convex_set++; console.log(`${tag}  convex: SET (${r.username})`); }
      else if (r.ok && r.skipped === "already_set") { counts.convex_already_set++; console.log(`${tag}  convex: already_set`); }
      else if (r.reason === "user_not_found") { counts.convex_not_found++; console.log(`${tag}  convex: USER NOT FOUND`); }
      else { counts.convex_error++; console.log(`${tag}  convex: ERR ${JSON.stringify(r)}`); errors.push({ email, side: "convex", r }); }
    } catch (err) {
      counts.convex_error++;
      console.log(`${tag}  convex: THROW ${err?.message || err}`);
      errors.push({ email, side: "convex", err: String(err?.message || err) });
    }

    // Stripe
    try {
      const cust = await stripeListCustomerByEmail(email);
      if (!cust) { counts.stripe_not_found++; console.log(`${tag}  stripe: NOT FOUND`); continue; }
      const existing = cust.metadata?.instagram_handle;
      if (existing && existing.trim()) {
        counts.stripe_already_set++; console.log(`${tag}  stripe: already_set (${existing})`);
      } else {
        await stripeUpdateCustomer(cust.id, ig);
        counts.stripe_set++; console.log(`${tag}  stripe: SET on ${cust.id}`);
      }
    } catch (err) {
      counts.stripe_error++;
      console.log(`${tag}  stripe: THROW ${err?.message || err}`);
      errors.push({ email, side: "stripe", err: String(err?.message || err) });
    }
  }

  console.log("\n=== summary ===");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);
  if (errors.length) {
    console.log(`\nerrors · ${errors.length}`);
    for (const e of errors.slice(0, 10)) console.log("  ", JSON.stringify(e));
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
