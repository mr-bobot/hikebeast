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

if (errors.length) {
  console.error(`Tracking pipeline lint FAILED · ${errors.length} issue(s) found across ${indexes.length} pages, ${checkedCalls} fetch sites, ${checkedFields} field references:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Tracking pipeline OK · ${indexes.length} pages, ${checkedCalls} fetch sites, ${checkedFields} field references all wired through.`);
