// api/login.js — multi-purpose auth endpoint (kept as one Vercel function
// because we sit at the function-count budget for this project).
//
// Three flows, discriminated by request body:
//
//   1. Convex per-user account login (preferred, used by /login/ form)
//        body: { username, password, next? }
//        -> validates against Convex auth:signIn
//        -> sets the legacy hb_full_auth cookie middleware checks on /full/*
//        -> returns { ok: true, sessionToken, user, next } so the client can
//           persist the Convex session in localStorage:hb:session:v1.
//
//   2. Legacy shared-password login (PREVIEW_USER / PREVIEW_PASS)
//        body: { user, pass, next? }
//        -> kept as the back door if Leon needs to hand out a single
//           shared credential. Sets the same cookie, no sessionToken.
//
//   3. Logout
//        body: { action: "logout", sessionToken? }
//        -> expires the cookie (Set-Cookie Max-Age=0) and best-effort
//           revokes the Convex session if a token is provided.
//
// The middleware verifies the cookie on every /full/* request. Convex
// session tokens are validated server-side by the Convex deployment
// itself; we just relay them.

import crypto from 'node:crypto';

const COOKIE_NAME  = 'hb_full_auth';
const COOKIE_LABEL = 'hb_full_auth_v1';
const MAX_AGE_DAYS = 30;

// ── Helpers ───────────────────────────────────────────────────────────────

function tokenFor(pass) {
  return crypto.createHmac('sha256', pass).update(COOKIE_LABEL).digest('hex');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// Open-redirect safeguard: only honour /full/... targets.
function safeNext(next) {
  if (typeof next !== 'string' || !next) return '/full/';
  if (next === '/full' || next === '/full/') return '/full/';
  if (next.startsWith('/full/')) return next;
  return '/full/';
}

function setSessionCookie(res, value, maxAgeSeconds) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; '));
}

// Talk to Convex via the plain HTTP API instead of pulling in the SDK
// (keeps this function tiny and the Vercel build out of nft trouble).
//
//   POST <CONVEX_URL>/api/mutation
//   body: { path: "module:function", args: {...}, format: "json" }
//   <- { status: "success"|"error", value?, errorMessage?, errorData? }
async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, '')}/api/mutation`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path, args, format: 'json' }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok)                    throw new Error(`convex http ${r.status}: ${json?.errorMessage || r.statusText}`);
  if (json?.status === 'error') throw new Error(json.errorMessage || 'convex mutation failed');
  return json?.value;
}

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = await readJsonBody(req);

  // ── Flow 3: logout ──────────────────────────────────────────────────────
  if (body?.action === 'logout') {
    const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';
    // Best-effort revoke; we don't block on it. The cookie expiry below is
    // the load-bearing part of "logged out".
    if (sessionToken && process.env.CONVEX_URL) {
      try { await convexMutation(process.env.CONVEX_URL, 'auth:signOut', { sessionToken }); } catch {}
    }
    setSessionCookie(res, '', 0);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  const previewUser = process.env.PREVIEW_USER;
  const previewPass = process.env.PREVIEW_PASS;
  if (!previewUser || !previewPass) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  // ── Flow 1: Convex per-user account login ─────────────────────────────
  // Detected by the new field shape ({ username, password }).
  if (typeof body?.username === 'string' && typeof body?.password === 'string') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    const username = body.username.trim();
    const password = body.password;
    const next     = safeNext(body.next);
    if (!username || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }
    let result;
    try {
      result = await convexMutation(convexUrl, 'auth:signIn', {
        usernameOrEmail: username,
        password,
      });
    } catch {
      await new Promise(r => setTimeout(r, 350));
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    setSessionCookie(res, tokenFor(previewPass), MAX_AGE_DAYS * 24 * 60 * 60);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      sessionToken: result.sessionToken,
      user: result.user,
      next,
    });
  }

  // ── Flow 2: legacy shared-password login (kept as the back door) ──────
  const user = typeof body?.user === 'string' ? body.user.trim() : '';
  const pass = typeof body?.pass === 'string' ? body.pass : '';
  const next = typeof body?.next === 'string' ? body.next : '';

  // Constant-time compare for both fields to avoid leaking whether
  // the username was correct via response timing.
  const userOk = user.length === previewUser.length &&
    crypto.timingSafeEqual(
      Buffer.from(user.padEnd(previewUser.length, '\0')),
      Buffer.from(previewUser.padEnd(previewUser.length, '\0')),
    );
  const passOk = pass.length === previewPass.length &&
    crypto.timingSafeEqual(
      Buffer.from(pass.padEnd(previewPass.length, '\0')),
      Buffer.from(previewPass.padEnd(previewPass.length, '\0')),
    );

  if (!userOk || !passOk) {
    await new Promise(r => setTimeout(r, 350));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  setSessionCookie(res, tokenFor(previewPass), MAX_AGE_DAYS * 24 * 60 * 60);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, next: safeNext(next) });
}
