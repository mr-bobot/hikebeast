// Per-customer access redirect.
//
// Flow:
//   1. Buyer clicks the "Open the guide" link in the purchase email.
//   2. Link is /api/checkout/access?t=<signed-access-token>.
//   3. We verify the HMAC, set the same hb_full_auth cookie that
//      middleware.js already validates, and 302 to /full/.
//   4. Subsequent /full/* requests pass the existing middleware gate.
//
// The cookie is intentionally identical to the one set by /api/login --
// shared-password and per-customer paths converge on the same gate while
// the migration is in flight.
//
// Token TTL: we set the cookie for 90 days but accept tokens up to 365 days
// old at this endpoint. The buyer might come back from an archived email
// months later and still expect a click-through to work. The cookie age
// (90d) is the real session lifetime; the email link is a re-bootstrap
// mechanism.

import { verifyToken, fullAuthCookieValue } from "../../lib/access-token.js";

const COOKIE_NAME = "hb_full_auth";
const MAX_AGE_DAYS = 90;
const TOKEN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const NOINDEX_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function applyHeaders(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

export default async function handler(req, res) {
  applyHeaders(res, NOINDEX_HEADERS);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = typeof req.query?.t === "string" ? req.query.t : "";
  const result = verifyToken(token, { maxAgeMs: TOKEN_MAX_AGE_MS });
  if (!result.valid) {
    return res.status(403).json({ error: "invalid_or_expired_token", reason: result.reason });
  }

  let cookieValue;
  try {
    cookieValue = fullAuthCookieValue();
  } catch (err) {
    console.error("fullAuthCookieValue failed:", err?.message || err);
    return res.status(503).json({ error: "auth_not_configured" });
  }

  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  const cookie = [
    `${COOKIE_NAME}=${cookieValue}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);

  // Optional ?next= deep-link, only allowed under /full/.
  const nextRaw = typeof req.query?.next === "string" ? req.query.next : "";
  const next = nextRaw.startsWith("/full/") || nextRaw === "/full"
    ? (nextRaw === "/full" ? "/full/" : nextRaw)
    : "/full/";

  res.redirect(302, next);
}
