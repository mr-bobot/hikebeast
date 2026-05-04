// Vercel Edge Middleware -- gates /full/* behind a signed session cookie.
//
// Flow:
//   1. User hits /full/anything
//   2. Middleware looks for a valid `hb_full_auth` cookie
//   3. If valid -> pass through
//   4. If missing or invalid -> 302 redirect to /login?next=<original-path>
//   5. Trailing-slash fixer: /full -> /full/ (so relative asset URLs work)
//
// /map/ used to be gated here while the embedded Stripe checkout was being
// wired up. Once Stripe Live launched (2026-05-04) we removed it from the
// matcher so the landing page is public. The trailing-slash redirect for
// /map -> /map/ now lives in vercel.json `redirects`.
//
// The cookie value is HMAC-SHA256(PREVIEW_PASS, "hb_full_auth_v1") -- the
// same string that /api/login sets after a successful sign-in. It rotates
// automatically when PREVIEW_PASS rotates.
//
// Defense in depth (none of these are sole-line-of-defense):
//   - this middleware (auth + redirect) for /full/
//   - vercel.json /full/(.*) -> X-Robots-Tag noindex,
//     Cache-Control private, Referrer-Policy no-referrer
//   - robots.txt: Disallow /full/ for every UA
//   - per-page <meta robots> noindex on every generated HTML

export const config = {
  matcher: ['/full', '/full/:path*'],
};

const COOKIE_NAME = 'hb_full_auth';
const COOKIE_LABEL = 'hb_full_auth_v1';

const NOINDEX_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

async function hmacSha256Hex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // Trailing-slash fix: /full -> /full/ (otherwise relative asset URLs
  // resolve against / instead of the section root, breaking CSS and images).
  // /map -> /map/ is handled in vercel.json `redirects` since /map is no
  // longer in this middleware's matcher.
  if (url.pathname === '/full') {
    return Response.redirect(`${url.origin}/full/`, 308);
  }

  const user = process.env.PREVIEW_USER;
  const pass = process.env.PREVIEW_PASS;
  if (!user || !pass) {
    return new Response('Auth not configured', {
      status: 503,
      headers: { ...NOINDEX_HEADERS, 'Content-Type': 'text/plain' },
    });
  }

  // Cookie-based session check
  const cookies = parseCookies(request.headers.get('cookie'));
  const provided = cookies[COOKIE_NAME];
  if (provided) {
    const expected = await hmacSha256Hex(pass, COOKIE_LABEL);
    if (timingSafeEqualHex(provided, expected)) {
      // Authorized -- fall through. Response headers come from vercel.json.
      return;
    }
  }

  // Not signed in -- send to /login with the original target preserved.
  const next = url.pathname + url.search;
  const loginUrl = `${url.origin}/login/?next=${encodeURIComponent(next)}`;
  return Response.redirect(loginUrl, 302);
}
