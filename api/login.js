import crypto from 'node:crypto';

// Validates the credentials, sets a 30-day HMAC-signed session cookie, and
// returns the redirect target. The cookie value is HMAC-SHA256(pass, label),
// so it rotates automatically when PREVIEW_PASS rotates -- no separate
// secret to manage.
//
// The middleware verifies the cookie on every /full/* request.

const COOKIE_NAME = 'hb_full_auth';
const COOKIE_LABEL = 'hb_full_auth_v1';
const MAX_AGE_DAYS = 30;

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedUser = process.env.PREVIEW_USER;
  const expectedPass = process.env.PREVIEW_PASS;
  if (!expectedUser || !expectedPass) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  const body = await readJsonBody(req);
  const user = typeof body.user === 'string' ? body.user.trim() : '';
  const pass = typeof body.pass === 'string' ? body.pass : '';
  const next = typeof body.next === 'string' ? body.next : '';

  // Constant-time compare for both fields to avoid leaking whether
  // the username was correct via response timing.
  const userOk = user.length === expectedUser.length &&
    crypto.timingSafeEqual(Buffer.from(user.padEnd(expectedUser.length, '\0')), Buffer.from(expectedUser.padEnd(expectedUser.length, '\0')));
  const passOk = pass.length === expectedPass.length &&
    crypto.timingSafeEqual(Buffer.from(pass.padEnd(expectedPass.length, '\0')), Buffer.from(expectedPass.padEnd(expectedPass.length, '\0')));

  if (!userOk || !passOk) {
    // Small artificial delay so brute-force is mildly throttled.
    await new Promise((r) => setTimeout(r, 350));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = tokenFor(expectedPass);
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  const cookie = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');

  // Validate redirect target to prevent open-redirect. Only allow paths
  // under /full/ (with optional query/fragment).
  let nextUrl = '/full/';
  if (next.startsWith('/full/') || next === '/full') {
    nextUrl = next === '/full' ? '/full/' : next;
  }

  res.setHeader('Set-Cookie', cookie);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, next: nextUrl });
}
