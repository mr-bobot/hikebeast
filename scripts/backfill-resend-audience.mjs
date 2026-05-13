// scripts/backfill-resend-audience.mjs · one-off · 2026-05-11
//
// Walks every unique email from `Hikebeast Email List-6.xlsx` (buyer +
// non-buyer alike) and POSTs each one to /api/login with
// action=admin_add_resend_contact. The lambda calls Resend's
// contacts.create (idempotent — duplicates return {status:"existed"}).
//
// Tallies created/existed/failed so we get definitive proof of whether
// the pre-2026-04-27 capture bug actually left contacts behind.
//
// Usage:
//   node scripts/backfill-resend-audience.mjs                 # dry-run
//   node scripts/backfill-resend-audience.mjs --send          # actually backfill
//   node scripts/backfill-resend-audience.mjs --send --concurrency 5
//   node scripts/backfill-resend-audience.mjs --xlsx <path>   # alt source

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  let dir = ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      const env = {};
      for (const line of readFileSync(candidate, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { ...env, ...process.env };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return { ...process.env };
}

const env = loadEnv();
const ADMIN_TOKEN = env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error("ADMIN_TOKEN required");

// ── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const send = args.includes("--send");
const concIdx = args.indexOf("--concurrency");
const CONCURRENCY = concIdx >= 0 ? Math.max(1, Number(args[concIdx + 1]) || 5) : 5;
const xlsxIdx = args.indexOf("--xlsx");
const XLSX_PATH = xlsxIdx >= 0 ? args[xlsxIdx + 1] : "/Users/lost/Downloads/Hikebeast Email List-6.xlsx";
const lambdaIdx = args.indexOf("--lambda");
const SEND_LAMBDA = lambdaIdx >= 0 ? args[lambdaIdx + 1] : "https://hikebeast.ch/api/login";

if (!existsSync(XLSX_PATH)) throw new Error(`xlsx not found: ${XLSX_PATH}`);

// ── Extract emails (delegate to Python since openpyxl is the cleanest path) ─
const py = spawnSync("python3", ["-c", `
import openpyxl, json
wb = openpyxl.load_workbook(${JSON.stringify(XLSX_PATH)}, data_only=True)
ws = wb["Signups"]
headers = [c.value for c in ws[1]]
H = {h:i for i,h in enumerate(headers)}
seen = {}
for row in ws.iter_rows(min_row=2, values_only=True):
    email = row[H["email"]]
    if not email: continue
    en = str(email).strip().lower()
    if en in seen: continue
    seen[en] = {
        "email":     en,
        "firstName": (row[H["first_name"]] or "").strip() if row[H["first_name"]] else "",
        "purchased": (str(row[H["purchased"]]).lower() == "yes"),
    }
print(json.dumps(list(seen.values())))
`], { encoding: "utf-8" });
if (py.status !== 0) {
  console.error("python xlsx read failed:", py.stderr);
  process.exit(1);
}
const RECIPIENTS = JSON.parse(py.stdout.trim());

const buyerCount = RECIPIENTS.filter(r => r.purchased).length;
console.log(`${send ? `SENDING via ${SEND_LAMBDA}` : "DRY RUN"} · ${RECIPIENTS.length} unique emails (${buyerCount} buyers, ${RECIPIENTS.length - buyerCount} non-buyers) · concurrency ${CONCURRENCY}\n`);

if (!send) {
  console.log("First 5:");
  for (const r of RECIPIENTS.slice(0, 5)) console.log(`  ${r.email}  ${r.firstName || ""}  purchased=${r.purchased}`);
  console.log(`\nRe-run with --send to actually POST.`);
  process.exit(0);
}

// ── Concurrent worker pool ─────────────────────────────────────────────────
const stats = { created: 0, existed: 0, failed: 0 };
const failures = [];

async function processOne(r) {
  try {
    const resp = await fetch(SEND_LAMBDA, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        action:     "admin_add_resend_contact",
        adminToken: ADMIN_TOKEN,
        email:      r.email,
        firstName:  r.firstName || undefined,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      stats.failed++;
      failures.push({ email: r.email, error: data.message || data.error || resp.statusText });
      return "failed";
    }
    if (data.status === "existed") { stats.existed++; return "existed"; }
    if (data.status === "created") { stats.created++; return "created"; }
    stats.failed++;
    failures.push({ email: r.email, error: "unexpected response: " + JSON.stringify(data) });
    return "failed";
  } catch (err) {
    stats.failed++;
    failures.push({ email: r.email, error: String(err.message || err) });
    return "failed";
  }
}

let idx = 0;
let done = 0;
async function worker() {
  while (idx < RECIPIENTS.length) {
    const my = idx++;
    const r = RECIPIENTS[my];
    const status = await processOne(r);
    done++;
    const marker = status === "created" ? "+" : status === "existed" ? "=" : "✗";
    process.stdout.write(`${marker} ${r.email.padEnd(40)} (${done}/${RECIPIENTS.length})\n`);
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

console.log(`\nDone.  created=${stats.created}  existed=${stats.existed}  failed=${stats.failed}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures.slice(0, 20)) console.log(`  ${f.email}: ${f.error}`);
  if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
}
