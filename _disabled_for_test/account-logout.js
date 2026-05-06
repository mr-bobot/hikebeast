// api/account-logout.js — server-side counterpart to social.js's signOut.
//
// Two side effects:
//   1. Clears the `hb_full_auth` cookie so the user is kicked out of /full/
//      and bounced to /login on the next request.
//   2. Best-effort revokes the Convex session so a leaked token can't be
//      replayed (we can't depend on the client-side mutation having run --
//      JS may have failed, the user may be on a flaky network, etc).
//
// Body: { sessionToken? }. Missing token is fine -- we still want to clear
// the cookie so the user is signed out at the gate level.

// We talk to Convex via plain HTTP (see account-login.js for why we don't
// import the convex/browser SDK in lambdas).

async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, '')}/api/mutation`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path, args, format: 'json' }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok)                  throw new Error(`convex http ${res.status}`);
  if (json?.status === 'error') throw new Error(json.errorMessage || 'convex error');
  return json?.value;
}

const COOKIE_NAME = 'hb_full_auth';

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
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = await readJsonBody(req);
  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';

  // Best-effort Convex revoke. We swallow errors -- the cookie clear below
  // is the load-bearing part of "logged out".
  if (sessionToken && process.env.CONVEX_URL) {
    try {
      await convexMutation(process.env.CONVEX_URL, 'auth:signOut', { sessionToken });
    } catch {}
  }

  // Expire the cookie. Path + same flags as the issuing endpoint so the
  // browser actually replaces it.
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; '));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
