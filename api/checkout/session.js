// Create a Stripe Checkout Session in `embedded` UI mode and return its
// client_secret to the /map/ landing page.
//
// Why Checkout Session (embedded) instead of raw Payment Element:
//   - Stripe Tax automatic, tax-inclusive prices native (`tax_behavior:
//     "inclusive"`).
//   - TWINT, Apple Pay, Google Pay, Link, SEPA all enabled via dashboard
//     payment-method settings. No client wiring.
//   - Multi-currency by switching the Price object up front.
//   - Embedded mode iframes Stripe's payment UI inside our page -- no
//     redirect, the buyer never leaves hikebeast.ch.
//
// Trade: less DOM control over the payment widget than a raw Payment
// Element. We theme via the Stripe dashboard. Acceptable for v1.
//
// Currency selection:
//   - Defaults from `x-vercel-ip-country` header (Vercel adds it server-side).
//   - Client may override via the request body (user toggles the currency
//     dropdown on the landing page).
//   - We map country -> currency -> Stripe Price id via env vars. One Price
//     per currency, all marked tax_behavior=inclusive in Stripe so 27 stays
//     27 to the buyer regardless of region.
//
// Cohort tracking (`t`, `s`) is forwarded into session.metadata so the
// webhook can join purchase rows back to signup rows in the Sheet -- same
// pattern as the legacy Whop redirect.

import Stripe from "stripe";
import crypto from "node:crypto";
import { issueToken } from "../../lib/access-token.js";
import {
  clientIpFromHeaders,
  clientUserAgentFromHeaders,
} from "../../lib/capi.js";

// ── /full/ session cookie helpers ──────────────────────────────────────────
// Mirrors api/login.js so that paid-buyer onboarding sets the same
// hb_full_auth cookie middleware.js checks on /full/*. Two helpers:
//  - tokenFor(PREVIEW_PASS) derives the deterministic HMAC token value.
//  - setSessionCookie(res, ...) emits the Set-Cookie header.
// PREVIEW_PASS is shared across staging + prod, so the cookie value is
// portable between the two Convex deployments (which is intentional --
// localStorage:hb:session:v1 still scopes identity per Convex deployment
// because the token is per-deployment).
const FULL_COOKIE_NAME  = "hb_full_auth";
const FULL_COOKIE_LABEL = "hb_full_auth_v1";
const FULL_MAX_AGE_DAYS = 30;
function tokenForPreview(pass) {
  return crypto.createHmac("sha256", pass).update(FULL_COOKIE_LABEL).digest("hex");
}
function setFullSessionCookie(res, value, maxAgeSeconds) {
  res.setHeader("Set-Cookie", [
    `${FULL_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; "));
}

// Talk to Convex via the plain HTTP API instead of pulling in the SDK
// (matches api/login.js -- same reason: keeps the lambda small and
// dodges convex/_generated, which isn't built during Vercel's build).
async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, "")}/api/mutation`;
  const r = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ path, args, format: "json" }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = json?.errorMessage || r.statusText;
    const e = new Error(`convex http ${r.status}: ${msg}`);
    e.status = r.status;
    throw e;
  }
  if (json?.status === "error") {
    const e = new Error(json.errorMessage || "convex mutation failed");
    e.convexError = true;
    throw e;
  }
  return json?.value;
}

// Customer-view Drive folder. Returned to the success page only when
// the session is verified paid, so view-source on /map/success without
// a paid session_id never exposes the URL. Same value as DRIVE_URL in
// webhook.js -- if this ever changes, update both.
const DRIVE_URL = "https://drive.google.com/drive/folders/182_BdFNwF9jptpp9ax7G8sHNYb01nCa0?usp=share_link";

const EU_COUNTRIES = new Set([
  // EU 27 (use EUR by default)
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE",
  "IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
  // EFTA neighbours that price in EUR for digital goods more often than not
  "LI",
]);

function priceIdForCurrency(currency) {
  switch (currency) {
    case "chf": return process.env.STRIPE_PRICE_ID_CHF;
    case "eur": return process.env.STRIPE_PRICE_ID_EUR;
    case "usd": return process.env.STRIPE_PRICE_ID_USD;
    default:    return null;
  }
}

function defaultCurrencyForCountry(country) {
  if (!country) return "usd";
  const c = country.toUpperCase();
  if (c === "CH") return "chf";
  if (EU_COUNTRIES.has(c)) return "eur";
  return "usd";
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

// GET handler: success-page support.
//
// After payment, /map/success?session_id=cs_test_... loads inside the
// embedded iframe. The page calls GET /api/checkout/session?session_id=...
// to confirm the session is paid and to receive the per-customer access
// token, so it can render a working "Download the guide" button without
// waiting on the email. The webhook still fires the email + Sheet log
// + Meta CAPI server side; this endpoint is purely about UX continuity.
//
// Token expiry mirrors the email link (7 days). The token is also
// available in the email (issued by the webhook) but issuing one here
// directly is fine: HMAC tokens are stateless, multiple valid tokens for
// the same buyer is by design (re-trigger from "lost your link?" form).
async function handleGetSession(req, res, stripe) {
  const sessionId = typeof req.query?.session_id === "string" ? req.query.session_id : "";
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "invalid_session_id" });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer_details"],
    });
  } catch (err) {
    console.error("Stripe session retrieve failed:", err?.message || err);
    return res.status(404).json({ error: "session_not_found" });
  }

  // Only return a token if the session actually completed and was paid.
  // status: "complete" means the buyer finished checkout (any currency).
  // payment_status: "paid" confirms the charge succeeded.
  const paid = session.status === "complete" && session.payment_status === "paid";
  if (!paid) {
    return res.status(200).json({ paid: false, status: session.status, payment_status: session.payment_status });
  }

  const email = session.customer_details?.email || session.customer_email || "";
  const paymentIntent = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id;
  const firstName = session.metadata?.first_name || "";

  if (!email || !paymentIntent) {
    return res.status(500).json({ error: "session_missing_fields" });
  }

  const token = issueToken({ email, paymentIntentId: paymentIntent });
  const origin = (req.headers.origin && /^https?:\/\//.test(req.headers.origin))
    ? req.headers.origin
    : "https://hikebeast.ch";

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    paid: true,
    first_name: firstName,
    email,
    amount_total: session.amount_total,
    currency: (session.currency || "").toUpperCase(),
    download_url: `${origin}/api/checkout/download?t=${encodeURIComponent(token)}`,
    access_url: `${origin}/api/checkout/access?t=${encodeURIComponent(token)}`,
    drive_url: DRIVE_URL,
    order_id: session.id,
    // Returned so the success page can pass it as `eventID` to its
    // client-side fbq("track","Purchase",...) call, matching the
    // event_id the webhook uses for the CAPI Purchase event. Without
    // this Meta counts the pixel + CAPI events separately (Events
    // Manager 2026-05-15 showed 119 Purchase events for 54 buyers).
    payment_intent: paymentIntent,
  });
}

// POST handler #2: paid-buyer onboarding from /map/success.
//
// Trust boundary: the buyer hands us a Stripe Checkout Session id and a
// password. Stripe is the source of truth for "did this person actually
// pay?", so we re-fetch the session and confirm `payment_status === "paid"`
// before we let Convex create anything. The Convex mutation itself does
// no Stripe checks -- it trusts that this lambda already gated the call.
async function handleOnboardingPost(req, res, stripe, body) {
  const sessionId = String(body.sessionId || "");
  const password  = String(body.password || "");
  const username  = typeof body.username === "string" ? body.username.trim().slice(0, 32) : "";
  // Instagram handle · optional capture from the success-page form,
  // 2026-05-24. Used for Leon's manual outreach when a buyer DMs IG
  // for support · the handle is written to the Signups sheet's
  // instagram_handle column (setIfEmpty) so existing ManyChat-sourced
  // handles win on conflict. Empty string or missing field → no-op
  // downstream. We normalise + length-cap here so the downstream call
  // doesn't have to guard.
  const igRaw     = typeof body.instagram_handle === "string" ? body.instagram_handle : "";
  const igHandle  = igRaw.trim().toLowerCase().replace(/^@+/, "").slice(0, 40);

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "invalid_session_id" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer_details"],
    });
  } catch (err) {
    console.error("Stripe session retrieve failed (onboarding):", err?.message || err);
    return res.status(404).json({ error: "session_not_found" });
  }

  const paid = session.status === "complete" && session.payment_status === "paid";
  if (!paid) return res.status(400).json({ error: "session_not_paid" });

  const email = session.customer_details?.email || session.customer_email || "";
  const firstName = session.metadata?.first_name || "";
  const paymentIntent = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id;
  if (!email || !paymentIntent) {
    return res.status(500).json({ error: "session_missing_fields" });
  }

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error("CONVEX_URL not configured (onboarding)");
    return res.status(503).json({ error: "convex_not_configured" });
  }
  const previewPass = process.env.PREVIEW_PASS;
  if (!previewPass) {
    console.error("PREVIEW_PASS not configured (onboarding)");
    return res.status(503).json({ error: "auth_not_configured" });
  }

  let result;
  try {
    result = await convexMutation(convexUrl, "auth:createPaidUser", {
      email,
      firstName,
      paymentIntentId: paymentIntent,
      username: username || undefined,
      password,
      // IG handle fan-out · stored on the users row so the webapp can
      // surface it on /full/account/ and so future support-ping flows
      // can DM the buyer back. Empty string → field stays undefined
      // on the Convex side (the mutation no-ops). 2026-05-26.
      instagramHandle: igHandle || undefined,
    });
  } catch (err) {
    console.error("createPaidUser failed:", err?.message || err);
    return res.status(500).json({ error: err?.convexError ? err.message : "create_failed" });
  }

  // Returning customer (idempotent re-submit). Don't set the auth cookie --
  // the buyer should sign in with their own password rather than us
  // silently picking up the existing session. Surface the existing
  // username so the success page can render "Sign in as <name>" instead
  // of leaving the buyer guessing whether their second-attempt credentials
  // worked (they didn't -- this branch never created anything).
  if (result?.existing) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok:       false,
      existing: true,
      email,
      username: result.username || "",
      redirect: `/login/?email=${encodeURIComponent(email)}`,
    });
  }

  if (!result?.sessionToken) {
    console.error("createPaidUser returned no sessionToken:", result);
    return res.status(500).json({ error: "create_failed" });
  }

  // Fire-and-forget IG-handle write to the Stripe customer's metadata.
  // session.customer is the customer ID (set because we use
  // customer_creation: "always" in the checkout-session create call).
  // Writing to metadata.instagram_handle puts the handle next to the
  // buyer's name/email in the Stripe dashboard, so manual support
  // lookups stay all-in-one-place. Best-effort · we never block the
  // success redirect on a Stripe update.
  if (igHandle) {
    const customerId = typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
    if (customerId) {
      stripe.customers.update(customerId, {
        metadata: { instagram_handle: igHandle },
      }).catch((err) => {
        console.error("Stripe customer instagram_handle update failed:", err?.message || err);
      });
    }
  }

  // Fire-and-forget IG-handle write to the Signups sheet. Best-effort ·
  // we never block account creation on this. The Apps Script
  // attach_instagram action does setIfEmpty so existing ManyChat-sourced
  // handles win on conflict and idempotent re-tries (e.g. buyer
  // re-opens the success page later, re-submits) are safe.
  if (igHandle && process.env.SHEETS_WEBHOOK_URL && process.env.SHEETS_SECRET) {
    try {
      await fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attach_instagram",
          secret: process.env.SHEETS_SECRET,
          email,
          payment_intent: paymentIntent,
          instagram_handle: igHandle,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error("attach_instagram sheet write failed:", err?.message || err);
      // Don't fail the account creation · the buyer can still log in
      // and Leon can see their email match in the Sheet without the
      // IG handle. Worst case Leon has to ask "what's your IG?" in
      // the support DM, which is the same situation as before this
      // field existed.
    }
  }

  // Set the same cookie /api/login sets so middleware lets us into /full/.
  setFullSessionCookie(res, tokenForPreview(previewPass), FULL_MAX_AGE_DAYS * 24 * 60 * 60);
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok:           true,
    sessionToken: result.sessionToken,
    user:         result.user || null,
    username:     result.username,
    redirect:     "/full/",
  });
}

export default async function handler(req, res) {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    console.error("STRIPE_SECRET_KEY not set");
    return res.status(503).json({ error: "stripe_not_configured" });
  }
  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-12-18.acacia" });

  if (req.method === "GET") {
    return handleGetSession(req, res, stripe);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = await readJsonBody(req);

  // ── New POST shape: paid-buyer onboarding ─────────────────────────────
  // The /map/success page calls this with {sessionId, password, username?}
  // after the buyer has filled the post-purchase form. We:
  //   1. Re-verify the Stripe session is paid (server is the trust boundary).
  //   2. Tell Convex to create the user (idempotent: returns existing=true
  //      if a user already has this email; the page redirects to /login).
  //   3. Set hb_full_auth cookie so middleware.js lets the redirect into /full.
  //   4. Return the Convex sessionToken so the page can write it to
  //      localStorage:hb:session:v1 -- same key social.js reads on /full/.
  // Discriminated by the presence of `sessionId` AND `password` in the body
  // so the existing checkout-create POST (first_name/locale/t/s/...) is
  // unaffected.
  if (typeof body?.sessionId === "string" && typeof body?.password === "string") {
    return handleOnboardingPost(req, res, stripe, body);
  }

  // Currency: ALWAYS derived from the buyer's IP country. We deliberately
  // ignore any `currency` field in the request body so a buyer can't pick
  // a cheaper region's price by editing the POST. The server is the only
  // authority on which Stripe Price applies. Falls back to USD for
  // unknown countries (rest-of-world default).
  const ipCountry = req.headers["x-vercel-ip-country"] || "";
  const currency = defaultCurrencyForCountry(ipCountry);

  // Locale for the embedded Stripe iframe (form labels, "Pay" button,
  // error messages). Allow-listed; falls back to "auto" so Stripe
  // matches the buyer's Accept-Language header on its own.
  const allowedLocales = new Set(["de", "en", "auto"]);
  const requestedLocale = typeof body.locale === "string" ? body.locale.toLowerCase() : "";
  const locale = allowedLocales.has(requestedLocale) ? requestedLocale : "auto";

  const priceId = priceIdForCurrency(currency);
  if (!priceId) {
    return res.status(503).json({ error: "price_not_configured", currency });
  }

  // Cohort tracking forwarded from the landing page (originally from ManyChat
  // or PDF-link channel tokens). All optional.
  const t = typeof body.t === "string" ? body.t.slice(0, 200) : "";
  const s = typeof body.s === "string" ? body.s.slice(0, 200) : "";
  const firstName = typeof body.first_name === "string" ? body.first_name.trim().slice(0, 60) : "";
  const utmSource = typeof body.utm_source === "string" ? body.utm_source.slice(0, 100) : "";
  const utmMedium = typeof body.utm_medium === "string" ? body.utm_medium.slice(0, 100) : "";
  const utmCampaign = typeof body.utm_campaign === "string" ? body.utm_campaign.slice(0, 100) : "";

  // Affiliate ref. Stamped into both session.metadata and
  // payment_intent.metadata so the webhook can read it from either side.
  // Same character set as the username regex on the client.
  const refRaw = typeof body.r === "string" ? body.r.trim().toLowerCase() : "";
  const ref = /^[a-z0-9._-]{2,32}$/.test(refRaw) ? refRaw : "";

  // Source-page slug: which landing variant the buyer paid from
  // (`map`, `themap`, `map3`, `de_map`, `de_themap`, `de_map3`). The
  // webhook forwards this to the Sheet's `source_page` column so we can
  // attribute sales to specific A/B variants. Tight allowlist character
  // set to avoid arbitrary strings polluting the column.
  const sourcePageRaw = typeof body.source_page === "string" ? body.source_page.trim().toLowerCase() : "";
  const sourcePage = /^[a-z0-9_]{1,40}$/.test(sourcePageRaw) ? sourcePageRaw : "";

  // v12 hero split-test bucket the buyer was assigned to ("01".."08"). The
  // webhook forwards this to the Sheet's `hero_variant` column for paid_at
  // attribution per variant. Empty if the buyer wasn't in the test.
  const heroVariantRaw = typeof body.hero_variant === "string" ? body.hero_variant.trim() : "";
  const heroVariant = /^[a-z0-9_]{1,8}$/i.test(heroVariantRaw) ? heroVariantRaw : "";

  // ── Meta CAPI identity signals ──────────────────────────────────────────
  // Captured here so they flow through Stripe metadata to the webhook,
  // which fires the Purchase CAPI event with matching event_id. fbc/fbp
  // come from the buyer's browser cookies (set by /lib/meta-cookies.js
  // + Meta's own pixel SDK respectively). client_ip + user_agent come
  // from this request's headers — Vercel-set, trustworthy enough.
  //
  // Truncated to fit Stripe metadata limits (500 chars per value).
  const fbc = typeof body.fbc === "string" ? body.fbc.slice(0, 200) : "";
  const fbp = typeof body.fbp === "string" ? body.fbp.slice(0, 100) : "";
  const clientIp = clientIpFromHeaders(req.headers);
  const clientUa = clientUserAgentFromHeaders(req.headers);

  const origin = (req.headers.origin && /^https?:\/\//.test(req.headers.origin))
    ? req.headers.origin
    : "https://hikebeast.ch";

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      locale,
      line_items: [{ price: priceId, quantity: 1 }],
      // Saftladen GmbH is under the Swiss VAT threshold and not
      // voluntarily registered, so we don't compute tax. The Price
      // objects are tax-inclusive but with no registration there's
      // nothing to allocate. Re-enable when we register for VAT.
      automatic_tax: { enabled: false },
      // The Stripe Price is tax-inclusive (configured on the Price object in
      // dashboard); buyer always sees the same round 27 in their currency.
      payment_method_types: undefined, // let Stripe show all enabled in dashboard
      allow_promotion_codes: true,
      customer_creation: "always",
      metadata: {
        t,
        s,
        first_name: firstName,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        ip_country: typeof ipCountry === "string" ? ipCountry : "",
        // Locale of the page the buyer paid from. The webhook reads
        // this back to pick the EN or DE purchase email body.
        locale: locale === "auto" ? "" : locale,
        // Affiliate ref: ?r=<username> from the landing page, persisted
        // in localStorage on click. Empty string when no affiliate.
        r: ref,
        // Which landing variant the buyer paid from. Sheet attribution.
        source_page: sourcePage,
        // v12 split-test bucket ID. Joined to the Sheet's `hero_variant`
        // column by the webhook for per-variant conversion tracking.
        hero_variant: heroVariant,
        // Meta CAPI identity signals · forwarded to the webhook so the
        // Purchase event can include fbc/fbp/ip/ua. Stripe metadata caps
        // values at 500 chars, already truncated above.
        fbc,
        fbp,
        client_ip: clientIp,
        client_ua: clientUa,
      },
      // Forwarded into the underlying PaymentIntent so the webhook can join
      // the same identifiers without re-hydrating the session object.
      payment_intent_data: {
        metadata: {
          t,
          s,
          first_name: firstName,
          r: ref,
        },
      },
      // After payment, Stripe loads the return URL inside the embedded
      // iframe; we read ?session_id= there to fetch the completed session
      // and render the success state.
      //
      // Routing per source_page (since 2026-05-26 · /map9/ launch):
      //   - source_page=map9              → /map9/success
      //   - source_page=de_map9           → /de/map9/success
      //   - source_page=fr_map9           → /fr/map9/success
      //   - source_page=it_map9           → /it/map9/success
      //   - any other source_page · DE    → /de/map/success
      //   - any other source_page · else  → /map/success
      //
      // The fall-through path mirrors the historical behaviour every
      // /map[3-8]/ + /themap/ checkout has used since the dawn of the
      // funnel · they all redirect to /map/success/. Only /map9/ has
      // its own per-locale success siblings wired up so we don't
      // accidentally route an older sales page to a success page that's
      // missing fields.
      return_url: (function () {
        var path;
        if (sourcePage === "map9") path = "/map9/success";
        else if (sourcePage === "de_map9") path = "/de/map9/success";
        else if (sourcePage === "fr_map9") path = "/fr/map9/success";
        else if (sourcePage === "it_map9") path = "/it/map9/success";
        else path = locale === "de" ? "/de/map/success" : "/map/success";
        return `${origin}${path}?session_id={CHECKOUT_SESSION_ID}`;
      })(),
    });

    // NOTE on CAPI InitiateCheckout: we do NOT fire here. Meta wants
    // server events to mirror pixel events, and the pixel only fires
    // on real user interaction (pointerdown/focusin on #checkout,
    // see attachInitiateCheckoutSignal in the landing pages). Firing
    // CAPI on session-create would inflate the IC count to ~page
    // views again. The browser fires a beacon to /api/visit with
    // event="initiate_checkout" when the user actually engages, and
    // /api/visit fires the CAPI event with event_id = session.id —
    // same event_id the browser passes to fbq, so Meta dedupes.

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      client_secret: session.client_secret,
      session_id: session.id,
      currency,
      // Major-unit amount (e.g. 27 for CHF, 28 for EUR, 31 for USD).
      // The page uses this to replace the static "CHF 27" labels with
      // the actual region-specific amount once the session resolves.
      amount: typeof session.amount_total === "number" ? session.amount_total / 100 : null,
      // Client needs the publishable key to call Stripe(...) before mounting
      // the embedded iframe. Returning it here means the page never has to
      // hardcode it or expose it via a separate endpoint.
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || "",
    });
  } catch (err) {
    console.error("Stripe session create failed:", err?.message || err);
    return res.status(500).json({ error: "stripe_create_failed" });
  }
}
