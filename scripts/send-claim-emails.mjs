// scripts/send-claim-emails.mjs · one-off · 2026-05-11
//
// Sends a "claim your webapp account" email to the 11 customers who paid
// for Swiss Gems but haven't set up a Hikebeast account yet. For each:
//   1. Create the Convex account (random throwaway password, email set,
//      username derived from IG or email localpart). Skipped if it
//      already exists.
//   2. Mint a 7-day claim magic link via auth:adminMintClaimLink.
//   3. Render + (optionally) send a Resend email pointing at /reset/?t=.
//
// Usage:
//   node scripts/send-claim-emails.mjs                 # dry run (default)
//   node scripts/send-claim-emails.mjs --send          # actually send
//   node scripts/send-claim-emails.mjs --only <email>  # one recipient
//
// Dry runs write rendered HTML to /tmp/claim-preview/<email>.html and
// print the magic-link URL to stdout. Idempotent: re-running mints a new
// claim link (the old one gets invalidated server-side) but does not
// re-create accounts.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Env loading ────────────────────────────────────────────────────────────
// Walk up from ROOT looking for the first .env.local. Worktrees may not
// have their own; in that case we want the main repo's at the top of the
// tree. Process env wins over file values (useful for one-off overrides).
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
  // Fall back to process env alone if no file was found anywhere upstream.
  return { ...process.env };
}

const env = loadEnv();
const CONVEX_URL = env.CONVEX_URL;
const ADMIN_TOKEN = env.ADMIN_TOKEN;
if (!CONVEX_URL || !ADMIN_TOKEN) throw new Error("CONVEX_URL + ADMIN_TOKEN required");

// Default to prod. Overridable via --lambda <url> when smoke-testing
// against a Vercel preview deployment.
const SITE = "https://hikebeast.ch";
const SEND_LAMBDA = (() => {
  const i = process.argv.indexOf("--lambda");
  return i >= 0 ? process.argv[i + 1] : `${SITE}/api/login`;
})();
// Inter via Google Fonts — matches the Hikebeast brand pages (/, /map/).
// SF Pro fallback for Outlook Windows and other Google-Fonts-stripping
// clients so the email never falls back to Times.
const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";
// Same hero as the purchase email — the full-bleed "Swiss Hidden Gems"
// title artwork. Buyer recognises it from the receipt they got on day
// one, so this email feels like a continuation, not a new pitch.
const HERO_IMG = `${SITE}/images/thanks-email.jpg?v=2`;

// ── Recipients ─────────────────────────────────────────────────────────────
// 11 buyers without a Convex account as of 2026-05-11. Source: cross-check
// of Stripe LIVE payments export + Whop export against Convex users table.
// `firstName` derived best-effort from Whop CSV / IG handle / email localpart.
const RECIPIENTS = [
  { ig: "sarahandau",   email: "sarahandau@gmail.com",        firstName: "Sarah",   username: "sarahandau" },
  { ig: "lillyyykim",   email: "lilly.girke@gmail.com",       firstName: "Lilly",   username: "lillyyykim" },
  { ig: "clins_james",  email: "clinsjames1996@gmail.com",    firstName: "",        username: "clins_james" },
  { ig: "tom.tshl",     email: "tom.teuschl@icloud.com",      firstName: "Tom",     username: "tom.tshl" },
  { ig: "tobiasstaudt", email: "tobias.staudt@bluewin.ch",    firstName: "Tobias",  username: "tobiasstaudt" },
  { ig: "222michi222",  email: "michael.rohrer22@gmail.com",  firstName: "Michael", username: "222michi222" },
  { ig: "toni_gra4",    email: "tonigraf2004@gmail.com",      firstName: "Toni",    username: "toni_gra4" },
  { ig: "livia_menge",  email: "liviarmenge@gmail.com",       firstName: "Livia",   username: "livia_menge" },
  { ig: "",             email: "barrouq88@gmail.com",         firstName: "",        username: "barrouq88" },
  { ig: "",             email: "lenasugus@gmail.com",         firstName: "Lena",    username: "lenasugus" },
  { ig: "",             email: "gronddeborah@gmail.com",      firstName: "Deborah", username: "gronddeborah" },
];

// ── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const send = args.includes("--send");
const onlyIdx = args.indexOf("--only");
const onlyEmail = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const list = onlyEmail
  ? RECIPIENTS.filter(r => r.email.toLowerCase() === onlyEmail.toLowerCase())
  : RECIPIENTS;
if (onlyEmail && list.length === 0) throw new Error(`No recipient with email ${onlyEmail}`);

// ── Convex HTTP client ─────────────────────────────────────────────────────
async function convexMutation(path, args) {
  const r = await fetch(`${CONVEX_URL.replace(/\/$/, "")}/api/mutation`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ path, args, format: "json" }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`convex http ${r.status}: ${json?.errorMessage || r.statusText}`);
  if (json?.status === "error") throw new Error(json.errorMessage || "convex mutation failed");
  return json?.value;
}

function randomPassword() {
  return randomBytes(18).toString("base64url");
}

// ── Email template ─────────────────────────────────────────────────────────
function emailHtml({ firstName, claimUrl, email }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Swiss Gems webapp is ready</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
        <tr><td>
          <img src="${HERO_IMG}" alt="Swiss Gems of Switzerland" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
        </td></tr>
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">You bought Swiss Gems a while back, and the WebApp side of it is now open. It has a few more spots but is way more interactive. More ways to explore new spots, or save the ones you actually want to visit.</p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#1d1d1f;">
              <a href="${claimUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Claim your account</a>
            </td>
          </tr></table>

          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;line-height:1.5;">
            Link expires in 7 days. Signs you in as ${email}.
          </p>

          <p style="margin:0 0 4px;font-size:16px;">Have fun out there,</p>
          <p style="margin:0 0 32px;font-size:16px;">Leon</p>

          <hr style="border:0;border-top:1px solid rgba(0,0,0,0.08);margin:0 0 20px;" />
          <p style="margin:0;font-size:12px;color:#6e6e73;">Questions? Reply to this email.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;"><tr>
        <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
          <div>© Hikebeast</div>
          <div><a href="${SITE}/terms.html" style="color:#6e6e73;text-decoration:none;">Terms</a> · <a href="${SITE}/imprint.html" style="color:#6e6e73;text-decoration:none;">Imprint</a> · <a href="${SITE}/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</body>
</html>`;
}

function emailText({ firstName, claimUrl, email }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  return `${greeting}

You bought Swiss Gems a while back, and the WebApp side of it is now open. It has a few more spots but is way more interactive. More ways to explore new spots, or save the ones you actually want to visit.

Claim your account:
${claimUrl}

Link expires in 7 days. Signed in for ${email}.

Have fun out there,
Leon

---
© Hikebeast
${SITE}/terms.html · ${SITE}/imprint.html · ${SITE}/privacy.html
`;
}

// ── Run ────────────────────────────────────────────────────────────────────
const PREVIEW_DIR = "/tmp/claim-preview";
if (!send) mkdirSync(PREVIEW_DIR, { recursive: true });

console.log(`\n${send ? `SENDING via ${SEND_LAMBDA}` : "DRY RUN"} · ${list.length} recipients\n`);

const results = [];
for (const r of list) {
  let createNote = "";
  try {
    await convexMutation("auth:adminCreateUser", {
      username:   r.username,
      password:   randomPassword(),
      email:      r.email,
      adminToken: ADMIN_TOKEN,
    });
    createNote = "created";
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes("Username already taken") || msg.includes("Email already taken")) {
      createNote = "exists";
    } else {
      results.push({ email: r.email, ok: false, error: msg });
      console.log(`  ✗ ${r.email.padEnd(34)} adminCreateUser failed: ${msg}`);
      continue;
    }
  }

  let token;
  try {
    const out = await convexMutation("auth:adminMintClaimLink", {
      email:      r.email,
      adminToken: ADMIN_TOKEN,
    });
    token = out.token;
  } catch (err) {
    results.push({ email: r.email, ok: false, error: String(err.message || err) });
    console.log(`  ✗ ${r.email.padEnd(34)} adminMintClaimLink failed: ${err.message || err}`);
    continue;
  }

  const claimUrl = `${SITE}/reset/?t=${encodeURIComponent(token)}`;
  const tpl = { firstName: r.firstName, claimUrl, email: r.email };
  const html = emailHtml(tpl);
  const text = emailText(tpl);

  if (!send) {
    const file = join(PREVIEW_DIR, `${r.email.replace(/[@.]/g, "_")}.html`);
    writeFileSync(file, html);
    console.log(`  · ${r.email.padEnd(34)} ${createNote.padEnd(8)} ${claimUrl}`);
    console.log(`    preview: ${file}`);
    results.push({ email: r.email, ok: true, claimUrl, file });
  } else {
    // Route through the Vercel lambda so Resend's Sensitive env var stays
    // server-side. The script never sees RESEND_API_KEY.
    const lambdaResp = await fetch(SEND_LAMBDA, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        action:     "admin_send_email",
        adminToken: ADMIN_TOKEN,
        to:         r.email,
        subject:    "Your Swiss Gems webapp is ready",
        html,
        text,
      }),
    });
    const lambdaJson = await lambdaResp.json().catch(() => ({}));
    if (!lambdaResp.ok || lambdaJson.error) {
      const msg = lambdaJson.message || lambdaJson.error || lambdaResp.statusText;
      results.push({ email: r.email, ok: false, error: msg });
      console.log(`  ✗ ${r.email.padEnd(34)} lambda send failed: ${msg}`);
    } else {
      results.push({ email: r.email, ok: true, id: lambdaJson.id });
      console.log(`  ✓ ${r.email.padEnd(34)} ${createNote.padEnd(8)} sent (resend id ${lambdaJson.id})`);
    }
  }
}

console.log(`\nDone. ok=${results.filter(r => r.ok).length} · failed=${results.filter(r => !r.ok).length}`);
if (!send) {
  console.log(`\nReview HTML in ${PREVIEW_DIR}/ · re-run with --send to actually email.`);
}
