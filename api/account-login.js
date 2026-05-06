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
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

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

  // Server-to-server call. Convex auth:signIn throws on bad credentials,
  // returning a structured error we surface as 401.
  const client = new ConvexHttpClient(convexUrl);
  let result;
  try {
    result = await client.mutation(api.auth.signIn, {
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
