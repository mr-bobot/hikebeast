// api/account-login.js — sign in via a per-user Convex account.
//
// Flow:
//   1. Browser POSTs { username, password, next? } from /login/.
//   2. We call Convex `auth:signIn` server-side via the HTTP client.
//   3. On success, we set the legacy `hb_full_auth` cookie (HMAC of
//      PREVIEW_PASS) so the existing middleware lets the user reach /full/.
//   4. We return { ok, sessionToken, user, next } so the page can persist
//      the Convex session in localStorage and redirect.
//
// This keeps two layers in place:
//   - middleware.js still gates /full/* behind the cookie (defense in depth)
//   - Convex session = per-user identity, drives saved spots / swipes
// And lets users who only know the legacy shared password keep using
// /api/login as the emergency back door.

import crypto from 'node:crypto';

// We talk to Convex via its plain HTTP API instead of pulling in the
// convex/browser SDK. Two reasons:
//   1. The `convex` package is ~36 MB on disk and Vercel's `nft` file
//      tracer struggles to bundle it cleanly into a serverless function;
//      the deploy step kept failing silently after a successful build.
//   2. We only need a single mutation call -- not worth the dependency
//      surface. Same Convex deployment, same mutation, just one fetch.
//
// HTTP API contract (https://docs.convex.dev/http-api):
//   POST <CONVEX_URL>/api/mutation
//   body: { path: "module:function", args: {...}, format: "json" }
//   response: { status: "success"|"error", value?, errorMessage?, errorData? }

async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, '')}/api/mutation`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path, args, format: 'json' }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`convex http ${res.status}: ${json?.errorMessage || res.statusText}`);
    err.convexStatus = res.status;
    throw err;
  }
  if (json?.status === 'error') {
    const err = new Error(json.errorMessage || 'convex mutation failed');
    err.convexErrorData = json.errorData;
    throw err;
  }
  return json?.value;
}

const COOKIE_NAME  = 'hb_full_auth';
const COOKIE_LABEL = 'hb_full_auth_v1';
const MAX_AGE_DAYS = 30;

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

// Only allow redirect targets under /full/ to prevent open-redirect.
function safeNext(next) {
  if (typeof next !== 'string' || !next) return '/full/';
  if (next === '/full' || next === '/full/') return '/full/';
  if (next.startsWith('/full/')) return next;
  return '/full/';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const previewPass = process.env.PREVIEW_PASS;
  const convexUrl   = process.env.CONVEX_URL;
  if (!previewPass || !convexUrl) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  const body     = await readJsonBody(req);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const next     = safeNext(body.next);
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_credentials' });
  }

  // Server-to-server call. auth:signIn throws on bad creds (Convex turns
  // that into status:"error", we re-throw, then return 401).
  let result;
  try {
    result = await convexMutation(convexUrl, 'auth:signIn', {
      usernameOrEmail: username,
      password,
    });
  } catch (err) {
    // Slow-down to mildly throttle credential stuffing (mirrors /api/login).
    await new Promise((r) => setTimeout(r, 350));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // Set the legacy cookie that middleware.js verifies. HMAC of PREVIEW_PASS
  // means rotating PREVIEW_PASS instantly revokes every outstanding cookie.
  const cookieValue = tokenFor(previewPass);
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; '));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    ok: true,
    sessionToken: result.sessionToken,
    user: result.user,
    next,
  });
}
