// Per-customer access tokens for paid /full/* content.
//
// Replaces the shared PREVIEW_PASS gate with a token bound to the buyer's
// email + Stripe payment_intent_id. Token is HMAC-SHA256(MASTER_ACCESS_SECRET,
// payload), verified server-side without a database -- the Sheet is the audit
// log, validation is pure crypto.
//
// Format:   <base64url(payload-json)>.<base64url(hmac-sha256)>
// Payload:  { e: email, p: payment_intent_id, t: issued_at_ms }
//
// Validation pattern mirrors middleware.js / api/login.js (timing-safe HMAC
// compare). No expiry baked into the token itself; expiry is enforced at use
// site (e.g. download endpoint = 7d, access endpoint = 90d cookie).
//
// Revocation: a small deny-list lookup against env var DENIED_PAYMENT_IDS
// (comma-separated). On refund, the webhook appends the payment_intent_id
// there and the next /access or /download call returns 403. Good enough for
// our volume; promote to Vercel KV when the list grows past ~50 entries.

import crypto from "node:crypto";

const TOKEN_VERSION = "v1";

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

function base64urlDecodeToString(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

function timingSafeEqualBuffer(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Issue a new access token for a buyer.
 * @param {{email: string, paymentIntentId: string, issuedAtMs?: number}} args
 * @returns {string} token
 */
export function issueToken({ email, paymentIntentId, issuedAtMs }) {
  const secret = process.env.MASTER_ACCESS_SECRET;
  if (!secret) throw new Error("MASTER_ACCESS_SECRET not set");
  if (!email || !paymentIntentId) throw new Error("issueToken requires email and paymentIntentId");

  const payload = {
    v: TOKEN_VERSION,
    e: String(email).toLowerCase(),
    p: String(paymentIntentId),
    t: typeof issuedAtMs === "number" ? issuedAtMs : Date.now(),
  };
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = base64urlEncode(hmac(secret, body));
  return `${body}.${sig}`;
}

/**
 * Verify an access token. Returns { valid, payload, reason }.
 * Caller decides what to do with payload.t (e.g. enforce 7d for downloads).
 *
 * @param {string} token
 * @param {{maxAgeMs?: number}} [options]
 * @returns {{valid: boolean, payload?: object, reason?: string}}
 */
export function verifyToken(token, options = {}) {
  const secret = process.env.MASTER_ACCESS_SECRET;
  if (!secret) return { valid: false, reason: "secret_not_set" };
  if (typeof token !== "string" || !token) return { valid: false, reason: "missing" };

  const dot = token.indexOf(".");
  if (dot === -1) return { valid: false, reason: "malformed" };

  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!body || !sigPart) return { valid: false, reason: "malformed" };

  let providedSig;
  try {
    providedSig = Buffer.from(sigPart, "base64url");
  } catch {
    return { valid: false, reason: "malformed" };
  }

  const expectedSig = hmac(secret, body);
  if (!timingSafeEqualBuffer(providedSig, expectedSig)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToString(body));
  } catch {
    return { valid: false, reason: "bad_payload" };
  }

  if (payload?.v !== TOKEN_VERSION) return { valid: false, reason: "bad_version" };
  if (!payload.e || !payload.p || typeof payload.t !== "number") {
    return { valid: false, reason: "bad_payload" };
  }

  if (typeof options.maxAgeMs === "number") {
    const age = Date.now() - payload.t;
    if (age > options.maxAgeMs || age < -60000) {
      return { valid: false, reason: "expired", payload };
    }
  }

  if (isRevoked(payload.p)) {
    return { valid: false, reason: "revoked", payload };
  }

  return { valid: true, payload };
}

/**
 * Check whether a payment_intent_id has been revoked (refund, fraud, manual).
 * Reads DENIED_PAYMENT_IDS env var (comma-separated). Cheap and good enough
 * for low volume; swap for Vercel KV when the list grows.
 */
export function isRevoked(paymentIntentId) {
  const raw = process.env.DENIED_PAYMENT_IDS;
  if (!raw) return false;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(paymentIntentId);
}

/**
 * Build the HMAC value of the existing /full/ session cookie. Reuses the
 * pattern from api/login.js so the two systems stay interoperable.
 *
 * Used by /api/checkout/access.js after a fresh purchase: instead of asking
 * the buyer to type a password, we set the same hb_full_auth cookie that
 * middleware.js already verifies, and they pass the gate.
 *
 * Note: this still depends on PREVIEW_PASS being set (the existing shared
 * gate). When we deprecate the shared password later, the cookie value
 * derivation moves to MASTER_ACCESS_SECRET and middleware.js gets updated
 * in the same change.
 */
export function fullAuthCookieValue() {
  const pass = process.env.PREVIEW_PASS;
  if (!pass) throw new Error("PREVIEW_PASS not set");
  return crypto.createHmac("sha256", pass).update("hb_full_auth_v1").digest("hex");
}
