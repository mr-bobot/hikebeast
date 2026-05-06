// scripts/create-user.mjs -- manual account creation (early access).
//
// Usage:
//   node scripts/create-user.mjs <username> [--email <email>] [--admin]
//
// You'll be prompted for the password (hidden). Username is normalised to
// lowercase. Email is optional today; future Stripe-buyer auto-provisioning
// will pre-fill it.
//
// Reads CONVEX_URL + ADMIN_TOKEN from .env.local (this worktree first, then
// the parent repo). Calls the auth:adminCreateUser mutation.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Env loading ────────────────────────────────────────────────────────────
function loadEnv() {
  // Try the worktree's .env.local first; fall back to the parent repo's
  // (worktrees often share env with their main checkout).
  const candidates = [
    join(ROOT, ".env.local"),
    resolve(ROOT, "..", "Hikebeast", ".env.local"),
  ];
  let path = candidates.find(p => existsSync(p));
  if (!path) {
    throw new Error(`No .env.local found at any of:\n  ${candidates.join("\n  ")}`);
  }
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.CONVEX_URL)  throw new Error(`CONVEX_URL missing from ${path}`);
  if (!env.ADMIN_TOKEN) throw new Error(`ADMIN_TOKEN missing from ${path}`);
  return { env, path };
}

// ── Args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { username: null, email: null, admin: false, handle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") args.email = argv[++i];
    else if (a === "--admin") args.admin = true;
    else if (a === "--handle") args.handle = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/create-user.mjs <username> [--email <email>] [--handle <name>] [--admin]`);
      process.exit(0);
    } else if (!a.startsWith("--") && args.username === null) {
      args.username = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.username) throw new Error("Username is required.\nUsage: node scripts/create-user.mjs <username>");
  return args;
}

// ── Hidden password prompt ────────────────────────────────────────────────
// Disable terminal echo while the user types.
function prompt(label) {
  return new Promise((resolveFn) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => { rl.close(); resolveFn(answer); });
  });
}

function promptHidden(label) {
  return new Promise((resolveFn, rejectFn) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      const c = ch.toString("utf8");
      switch (c) {
        case "\n": case "\r": case "":
          if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw || false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolveFn(buf);
          break;
        case "":  // Ctrl-C
          if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw || false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rejectFn(new Error("Cancelled"));
          break;
        case "":  // backspace
          if (buf.length) buf = buf.slice(0, -1);
          break;
        default:
          buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args  = parseArgs(process.argv.slice(2));
  const { env, path: envPath } = loadEnv();

  console.log(`CONVEX_URL = ${env.CONVEX_URL}`);
  console.log(`Env source = ${envPath}`);
  console.log(`Username   = ${args.username.toLowerCase()}`);
  if (args.email)  console.log(`Email      = ${args.email}`);
  if (args.handle) console.log(`Handle     = ${args.handle}`);
  if (args.admin)  console.log(`Admin      = yes`);

  const password = await promptHidden("Password (hidden, min 8 chars): ");
  if (password.length < 8) throw new Error("Password too short (min 8 chars)");
  const confirm = await promptHidden("Confirm password: ");
  if (confirm !== password) throw new Error("Passwords do not match");

  const client = new ConvexHttpClient(env.CONVEX_URL);
  const result = await client.mutation(api.auth.adminCreateUser, {
    username:   args.username,
    password,
    email:      args.email || undefined,
    handle:     args.handle || undefined,
    isAdmin:    args.admin || undefined,
    adminToken: env.ADMIN_TOKEN,
  });
  console.log(`\nCreated user ${result.username} (id ${result.id}).`);
}

main().catch(err => {
  console.error(`\nError: ${err.message || err}`);
  process.exit(1);
});
