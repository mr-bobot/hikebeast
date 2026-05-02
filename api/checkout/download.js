// Signed PDF-download redirect for paying customers.
//
// Validates the per-customer access token (HMAC), enforces a 7-day download
// window (from token issuance), then 302s to a Vercel Blob URL.
//
// PDF storage:
//   - The full guide PDF (~200 MB, versioned filename) lives in Vercel Blob,
//     not in the repo.
//   - Env var STRIPE_PDF_BLOB_URL holds the canonical (private) blob URL.
//     We don't sign it client-side; Vercel Blob private URLs are tokenised
//     by us when the file is uploaded. For now we just 302 to that URL --
//     the blob token is part of the URL itself.
//   - When we later want per-request signing (e.g. shorter expiry per
//     download instead of per-token), swap to `getDownloadUrl()` from
//     `@vercel/blob` here. The handler signature stays the same.
//
// Token TTL: 7 days from issuance. Buyer can re-trigger a fresh email from
// /map/ "lost your link?" form if their original 7-day window lapsed (TODO,
// not yet built).

import { verifyToken } from "../../lib/access-token.js";

const DOWNLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const NOINDEX_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function applyHeaders(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

async function logDownload(fields) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "paid_download",
        secret: process.env.SHEETS_SECRET,
        ...fields,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Paid download log failed:", err);
  }
}

export default async function handler(req, res) {
  applyHeaders(res, NOINDEX_HEADERS);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const blobUrl = process.env.STRIPE_PDF_BLOB_URL;
  if (!blobUrl) {
    console.error("STRIPE_PDF_BLOB_URL not set");
    return res.status(503).json({ error: "pdf_not_configured" });
  }

  const token = typeof req.query?.t === "string" ? req.query.t : "";
  const result = verifyToken(token, { maxAgeMs: DOWNLOAD_MAX_AGE_MS });
  if (!result.valid) {
    return res.status(403).json({ error: "invalid_or_expired_token", reason: result.reason });
  }

  // Fire-and-forget log; don't block the redirect.
  logDownload({
    payment_id: result.payload.p,
    email: result.payload.e,
    downloaded_at: new Date().toISOString(),
  }).catch(() => {});

  res.redirect(302, blobUrl);
}
