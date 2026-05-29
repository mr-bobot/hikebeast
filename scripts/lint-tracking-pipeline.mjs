#!/usr/bin/env node
// Tracking-pipeline lint.
//
// Catches the "page sends field X, API silently drops X" class of bug.
// Reads every `*/index.html` file, extracts the body of each
// `fetch("/api/X", { body: JSON.stringify({...}) })` call, and verifies
// that every field the page sends is referenced by name in the receiving
// `api/X.js` file. If a field name appears in the page payload but never
// in the API source, the field is silently dropped server-side — which
// means whatever attribution / tracking the field was meant to enable
// doesn't work end-to-end.
//
// Background: 2026-05-15 the utm_source/utm_medium/utm_campaign fields were
// passed by all 8 landing-page variants but neither `api/visit.js` nor
// `api/checkout/webhook.js` extracted them. Result: months of orphan-
// channel traffic without UTM attribution. This script exists so the next
// such gap fails CI instead of silently leaking.
//
// Usage:
//   node scripts/lint-tracking-pipeline.mjs
// Exits 0 when clean, 1 when leaks are found.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

// Directories we never want to traverse · build output, scratch, vendored code.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vercel",
  ".claude",
  "_archive",
  "_drafts",
  "_proto",
  "scripts",
  "convex",
]);

// Field names that are scaffolding, not tracked payload. The API never needs
// to reference these by name so we don't flag them when the page sends them.
const SCAFFOLDING_FIELDS = new Set([
  "action",
  "secret",
  "method",
  "headers",
  "body",
  "credentials",
  "signal",
  "keepalive",
]);

function listIndexHtml(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name === "index.html") out.push(full);
    }
  }
  walk(root);
  return out;
}

// Extracts each `fetch("/api/...", { ... body: JSON.stringify({ ... }) ... })`
// invocation from a page source. Returns one record per call site.
function findApiCallsInHtml(html) {
  const calls = [];
  // Match the endpoint path and the body block. The body block is non-greedy
  // up to the first `})` that closes the JSON.stringify, which is fine for
  // the flat-object shape these payloads use throughout the codebase.
  const re = /fetch\s*\(\s*["']?(\/api\/[^"'`,)\s]+)["']?[\s\S]*?body\s*:\s*JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const endpoint = m[1];
    const block = m[2];
    const fields = new Set();
    for (const rawLine of block.split("\n")) {
      // Strip line comments so a documented-but-not-sent field doesn't
      // count as actually sent.
      const code = rawLine.replace(/\/\/.*$/, "").trim();
      // Top-level keys look like `name:` or `"name":`. We intentionally
      // ignore nested objects · payloads are flat in this codebase.
      const km = code.match(/^["']?([a-zA-Z_$][\w$]*)["']?\s*:/);
      if (km) fields.add(km[1]);
    }
    calls.push({ endpoint, fields: [...fields] });
  }
  return calls;
}

// Maps an endpoint like /api/checkout/session to api/checkout/session.js.
// Strips query string and template placeholders so `/api/x?id=` and
// `/api/x?id=${foo}` both resolve to `api/x.js`.
function findApiFile(endpoint) {
  const clean = endpoint.split(/[?#]/)[0].replace(/^\//, "");
  return join(repoRoot, clean + ".js");
}

const indexes = listIndexHtml(repoRoot);
const errors = [];
let checkedCalls = 0;
let checkedFields = 0;

for (const htmlPath of indexes) {
  const content = readFileSync(htmlPath, "utf8");
  const calls = findApiCallsInHtml(content);
  for (const call of calls) {
    checkedCalls++;
    const apiPath = findApiFile(call.endpoint);
    let apiSrc;
    try { apiSrc = readFileSync(apiPath, "utf8"); }
    catch {
      errors.push(`Missing API file: ${relative(repoRoot, htmlPath)} fetches ${call.endpoint} but ${relative(repoRoot, apiPath)} does not exist`);
      continue;
    }
    for (const field of call.fields) {
      if (SCAFFOLDING_FIELDS.has(field)) continue;
      checkedFields++;
      const re = new RegExp(`\\b${field}\\b`);
      if (!re.test(apiSrc)) {
        errors.push(`Field leak: ${relative(repoRoot, htmlPath)} sends "${field}" to ${call.endpoint} but ${relative(repoRoot, apiPath)} never references it`);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Meta pixel dedup wiring checks.
//
// Two regressions caught by hand on 2026-05-15 and 2026-05-20 that this
// lint now catches automatically:
//
// 1. Every browser-side `fbq("track","Purchase",...)` call must pass an
//    `eventID` parameter matching the CAPI event_id from
//    api/checkout/webhook.js. Without it Meta double-counts pixel + CAPI
//    as separate events (3.3x inflation observed on 2026-05-20: 387 Meta
//    Purchase events for 117 actual paid).
//
// 2. Every landing page that mounts an embedded Stripe Checkout
//    (`mountCheckout` pattern) and fires InitiateCheckout must do so via
//    the `attachInitiateCheckoutSignal()` pointerdown/focusin listener,
//    NOT inside the mount itself. Firing it on auto-mount turns every
//    page paint into a "checkout intent" signal (2.4K InitiateCheckout
//    events for ~50 buyers on 2026-05-15).
//
// Both regressions happened when new /map*/ pages were spun up by
// copying an older template that predated the fix.
let metaCheckedFiles = 0;
let metaCheckedCalls = 0;
const metaErrors = [];

for (const htmlPath of indexes) {
  const rel = relative(repoRoot, htmlPath);
  const content = readFileSync(htmlPath, "utf8");
  metaCheckedFiles++;

  // Check 1 · Purchase pixel must include eventID. Applies repo-wide:
  // any fbq("track","Purchase",...) without an eventID is broken dedup,
  // not just on /map*/success/ pages.
  const purchaseRe = /fbq\s*\(\s*["']track["']\s*,\s*["']Purchase["']/g;
  let pm;
  while ((pm = purchaseRe.exec(content)) !== null) {
    metaCheckedCalls++;
    // Look at the ~800 chars after the call opening. The eventID parameter
    // is the 4th positional arg, typically within ~300 chars but we allow
    // headroom for multi-line custom_data objects.
    const slice = content.slice(pm.index, pm.index + 800);
    if (!/eventID\s*:/.test(slice)) {
      metaErrors.push(`Meta dedup: ${rel} fires fbq("track","Purchase",...) without an eventID parameter. Meta will count pixel + CAPI as separate events. Pass { eventID: data.payment_intent } as the 4th arg to fbq, matching the event_id sent by api/checkout/webhook.js.`);
    }
  }

  // Check 2 · mountCheckout + InitiateCheckout must use the intent
  // pattern. /guide/, /free/, /sample/, /read/ fire InitiateCheckout
  // from click handlers (correct), so we gate on mountCheckout being
  // present — that's the Stripe-embedded auto-load pattern that needs
  // the workaround.
  if (/\bmountCheckout\b/.test(content) && /fbq\s*\(\s*["']track["']\s*,\s*["']InitiateCheckout["']/.test(content)) {
    metaCheckedCalls++;
    if (!/attachInitiateCheckoutSignal/.test(content)) {
      metaErrors.push(`Meta intent: ${rel} fires fbq("track","InitiateCheckout",...) on a page that also auto-mounts Stripe Checkout. Without attachInitiateCheckoutSignal() the event fires on every page paint, not on real buyer intent — inflates Meta's IC count and degrades ad optimization. Pattern lives in map/index.html since 2026-05-15.`);
    }
  }

  // Check 3 · Lead pixel must include eventID *when the page also posts
  // to /api/sample*. api/sample.js fires CAPI Lead with event_id = token
  // and returns it as `lead_event_id` so the pixel can dedupe against
  // it. Pages that fire fbq("track","Lead",…) without posting to
  // /api/sample (e.g. /free/download/, /de/free/download/) trigger no
  // CAPI Lead and so are standalone pixel events — no dedup needed.
  //
  // We allow multiple Lead pixel calls per file as long as AT LEAST
  // ONE in the same conditional block carries eventID — the typical
  // shape is `if (leadEventId) fbq(..., { eventID }) else fbq(...)`
  // for graceful degradation when the server didn't return the token.
  const postsToSample = /fetch\s*\(\s*["'][^"']*\/api\/sample[^"']*["']|action\s*=\s*["'][^"']*\/api\/sample[^"']*["']/.test(content);
  if (postsToSample) {
    const hasLeadPixel = /fbq\s*\(\s*["']track["']\s*,\s*["']Lead["']/.test(content);
    if (hasLeadPixel) {
      metaCheckedCalls++;
      // Require at least one Lead pixel call with eventID. The fallback
      // (no-eventID) branch is allowed for graceful degradation.
      const hasEventIdLead = /fbq\s*\(\s*["']track["']\s*,\s*["']Lead["'][\s\S]{0,800}?eventID\s*:/.test(content);
      if (!hasEventIdLead) {
        metaErrors.push(`Meta dedup: ${rel} fires fbq("track","Lead",...) on a page that posts to /api/sample (which fires CAPI Lead). Without { eventID: leadEventId } on at least one branch Meta counts pixel + CAPI as separate events. Pass the lead_event_id returned by api/sample.js.`);
      }
    }
  }

  // Check 4 · Purchase guard must use localStorage, not sessionStorage.
  // sessionStorage is scoped per-tab, so when buyers re-opened the Stripe
  // receipt email link in a new tab the guard didn't see the prior fire
  // and the Purchase pixel re-fired with the same payment_intent — Events
  // Manager's dedup diagnostic on 2026-05-24 showed 2-5 browser events
  // per single purchase. localStorage survives across tabs / windows /
  // refreshes, which is what we actually want for "did this buyer's
  // Purchase pixel already fire?". This check is scoped to pages that
  // touch hb:purchase_fired (the existing guard key) so it doesn't
  // false-positive on unrelated sessionStorage usage elsewhere.
  if (/hb:purchase_fired/.test(content)) {
    metaCheckedCalls++;
    if (/sessionStorage\.(getItem|setItem)\(\s*purchaseKey/.test(content)) {
      metaErrors.push(`Meta dedup: ${rel} uses sessionStorage for the hb:purchase_fired guard. sessionStorage is per-tab — when buyers re-open the Stripe receipt link in a new tab the Purchase pixel re-fires for the same payment_intent. Use localStorage.getItem / localStorage.setItem instead. Fixed across all 18 success pages on 2026-05-24.`);
    }
  }
}

// ─── Lang-redirect check ─────────────────────────────────────────────────
//
// Catches the "page added to the family but missing from its OWN EN→DE
// auto-redirect regex" bug class. Background:
//
//   2026-05-21: /map7/ shipped as the new bio-link target but its
//     head-script regex still listed only `(map5|map4|map3|themap|map)`,
//     missing `map7` itself. DE-language visitors stayed stuck on the
//     English page. Zero clicks on /de/map7/ until Leon noticed.
//
//   2026-05-22: I tried to fix this structurally by refactoring all 7 EN
//     map pages to a self-deriving form (`'/de' + location.pathname`).
//     Empirically broke Instagram in-app browser compatibility — verified
//     by Leon's girlfriend on a real DE iPhone in IAB (PR #78 diagnostic).
//     IAB honors the regex form but not the concat form, for reasons we
//     don't fully understand but no longer need to.
//
// So the canonical form IS the regex-with-alternation. This lint enforces
// that each EN landing page's regex alternation includes the page's own
// slug. Adding a new page = add its slug to its own regex. Forgetting it
// fails the build instead of silently losing DE traffic.
//
// DE pages don't have an auto-redirect script and are skipped.
let langCheckedPages = 0;
const langErrors = [];
for (const htmlPath of indexes) {
  const rel = relative(repoRoot, htmlPath);
  if (rel.startsWith("de/")) continue;
  const content = readFileSync(htmlPath, "utf8");
  if (!/localStorage\.getItem\(['"]hb_lang['"]\)/.test(content)) continue;
  langCheckedPages++;
  // Skip the root index.html — its redirect form is different
  // (no slug alternation, just "/" → "/de/").
  if (rel === "index.html") continue;
  // Extract the page slug from the path: "map5/index.html" → "map5".
  const ownSlug = rel.replace(/\/index\.html$/, "");
  // Find the regex alternation in the redirect script:
  // `location.pathname.replace(/^\/(slug1|slug2|...)\b/, '/de/$1')`
  const m = content.match(
    /location\.pathname\.replace\s*\(\s*\/\^\\\/\(([^)]+)\)\\b\/[\s\S]{0,40}?['"]\/de\//
  );
  if (!m) {
    langErrors.push(`Lang redirect: ${rel} has the EN→DE redirect script but the regex alternation could not be parsed. Expected shape: \`location.pathname.replace(/^\\/(${ownSlug}|...)\\b/, '/de/$1')\`. Self-deriving forms like '/de' + pathname were tried 2026-05-22 and broke Instagram in-app browser — stick with the regex.`);
    continue;
  }
  const slugs = m[1].split("|").map(s => s.trim());
  if (!slugs.includes(ownSlug)) {
    langErrors.push(`Lang redirect: ${rel} regex alternation is (${m[1]}) but the page's own slug "${ownSlug}" is missing. DE visitors landing here will not be redirected to /de/${ownSlug}/. Add "${ownSlug}" to the alternation.`);
  }
}

if (errors.length || metaErrors.length || langErrors.length) {
  const total = errors.length + metaErrors.length + langErrors.length;
  console.error(`Tracking pipeline lint FAILED · ${total} issue(s) found across ${indexes.length} pages, ${checkedCalls} fetch sites, ${checkedFields} field references, ${metaCheckedCalls} Meta pixel calls, ${langCheckedPages} lang redirects:`);
  for (const e of errors) console.error(`  - ${e}`);
  for (const e of metaErrors) console.error(`  - ${e}`);
  for (const e of langErrors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Tracking pipeline OK · ${indexes.length} pages, ${checkedCalls} fetch sites, ${checkedFields} field references, ${metaCheckedCalls} Meta pixel calls, ${langCheckedPages} lang redirects all wired through.`);
