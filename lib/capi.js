// Meta Conversions API helper.
//
// One place to build CAPI events so api/checkout/webhook.js (Purchase),
// api/sample.js (Lead), and api/visit.js (InitiateCheckout server-side
// mirror) all hash + format user_data the same way.
//
// What "user_data" means: the more identity signals we send, the better
// Meta can match the event to a Facebook account, the higher our Event
// Match Quality (EMQ) score, the cheaper our ad CPA. Events Manager
// flagged this on 2026-05-20 — quote: "advertisers who sent Click ID
// (fbc) for Purchase saw a 91.81% median increase in conversions
// reported".
//
// Fields we currently send and where each comes from:
//
//   em  · hashed email             ← Stripe customer_details.email
//   fn  · hashed first name        ← Stripe metadata.first_name
//   ln  · hashed last name         ← last word of customer_details.name
//   ct  · hashed city              ← customer_details.address.city
//   zp  · hashed postal code       ← customer_details.address.postal_code
//   country · hashed ISO code      ← Stripe metadata.ip_country
//   fbc · Facebook Click ID        ← _fbc cookie (synthesised from fbclid URL param)
//   fbp · Facebook Browser ID      ← _fbp cookie (Meta pixel auto-sets)
//   client_ip_address              ← Vercel header x-real-ip / first x-forwarded-for hop
//   client_user_agent              ← user-agent header
//
// Phone (ph) is intentionally omitted: Stripe Checkout is configured
// for email-only collection, so we never have a phone to hash.
//
// Hashing rules (per Meta's CAPI spec):
// - All identity fields are SHA-256 hex (no salt), lowercased + trimmed
//   before hashing. fbc, fbp, IP, UA are NOT hashed.
// - Emails, names, city: lowercase.
// - Country: 2-letter ISO lowercased.
// - Zip: lowercased, trimmed.

import crypto from "node:crypto";

const META_GRAPH = "https://graph.facebook.com/v18.0";

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
}

// Split "Hans Müller" or "Hans Peter Müller" into ["Hans", "Müller"].
// The first token is treated as fn; the last token as ln. Single-word
// names get only fn populated. Empty / null input returns ["", ""].
export function splitName(full) {
  const s = typeof full === "string" ? full.trim() : "";
  if (!s) return ["", ""];
  const parts = s.split(/\s+/);
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts[parts.length - 1]];
}

// Pull the buyer's IP from Vercel's reverse-proxy headers. `x-real-ip`
// is set by Vercel directly; `x-forwarded-for` is a comma-separated
// chain (client, hop1, hop2, ...) and we take the first hop.
export function clientIpFromHeaders(headers) {
  if (!headers) return "";
  const real = headers["x-real-ip"];
  if (typeof real === "string" && real) return real;
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return "";
}

export function clientUserAgentFromHeaders(headers) {
  if (!headers) return "";
  const ua = headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : "";
}

// Build the `user_data` object for a CAPI event. Omits fields that are
// empty so Meta doesn't see "undefined" values count as match attempts.
// `email`, `firstName`, `lastName`, `city`, `zip`, `country` get hashed;
// `fbc`, `fbp`, `clientIp`, `clientUserAgent` are passed raw.
//
// `external_id` defaults to the hashed email when not explicitly set.
// Meta uses external_id as a stable cross-session identifier alongside
// em; sending both is what they recommend (Events Manager 2026-05-21
// quoted +11.44% additional conversions reported for advertisers who
// added Browser ID + External ID to Purchase).
export function buildUserData({
  email, firstName, lastName, city, zip, country,
  fbc, fbp, clientIp, clientUserAgent, externalId,
}) {
  const ud = {};
  const emailHash = email ? sha256Hex(email) : undefined;
  if (emailHash) ud.em = [emailHash];
  if (firstName) ud.fn = [sha256Hex(firstName)];
  if (lastName) ud.ln = [sha256Hex(lastName)];
  if (city) ud.ct = [sha256Hex(city.replace(/\s+/g, ""))]; // Meta wants city with spaces stripped
  if (zip) ud.zp = [sha256Hex(zip)];
  if (country) ud.country = [sha256Hex(country)];
  if (fbc) ud.fbc = fbc;
  if (fbp) ud.fbp = fbp;
  if (clientIp) ud.client_ip_address = clientIp;
  if (clientUserAgent) ud.client_user_agent = clientUserAgent;
  // external_id: explicit value wins; otherwise reuse the email hash
  // so events from the same buyer correlate across sessions even when
  // fbc/fbp are missing (ad blockers, fresh devices).
  const extId = externalId || emailHash;
  if (extId) ud.external_id = [extId];
  return ud;
}

// Fire one CAPI event. Returns silently on env-var or network failure
// (CAPI is best-effort: the browser pixel is the redundancy).
//
// `eventName` is the standard event name (Purchase, Lead, InitiateCheckout).
// `eventId` MUST match the eventID the browser pixel passes so Meta can
// dedupe — see api/checkout/webhook.js comment on event_id = paymentIntent.
//
// `eventTime` is unix seconds. For Purchase from Stripe webhooks, pass
// `event.created` (the original Stripe event time) so Stripe retries days
// later land with the SAME timestamp the first attempt used, and Meta's
// dedup window can still collapse them. Defaults to "now" when omitted
// (Lead, InitiateCheckout: the browser event is concurrent with the
// server event, so Date.now() is fine).
export async function fireCapi({
  eventName,
  eventId,
  eventTime,
  userData,
  customData,
  sourceUrl,
  actionSource = "website",
}) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: typeof eventTime === "number" ? eventTime : Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: actionSource,
      event_source_url: sourceUrl,
      user_data: userData,
      ...(customData ? { custom_data: customData } : {}),
    }],
  };

  try {
    const r = await fetch(
      `${META_GRAPH}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      },
    );
    // Surface non-2xx so token rotations, EMQ drift, and malformed
    // user_data become visible in Vercel logs instead of vanishing
    // silently. Before this, a rejected payload looked identical to a
    // successful one from the caller's perspective.
    if (!r.ok) {
      let body = "";
      try { body = (await r.text()).slice(0, 500); } catch (e) {}
      console.error(`Meta CAPI ${eventName} HTTP ${r.status}:`, body);
    }
  } catch (err) {
    console.error(`Meta CAPI ${eventName} failed:`, err?.message || err);
  }
}
