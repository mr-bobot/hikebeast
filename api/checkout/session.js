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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    console.error("STRIPE_SECRET_KEY not set");
    return res.status(503).json({ error: "stripe_not_configured" });
  }

  const body = await readJsonBody(req);

  // Currency: client-provided wins over IP default. Validate against allow-list.
  const ipCountry = req.headers["x-vercel-ip-country"] || "";
  const requestedCurrency = typeof body.currency === "string" ? body.currency.toLowerCase() : "";
  const allowed = new Set(["chf", "eur", "usd"]);
  const currency = allowed.has(requestedCurrency)
    ? requestedCurrency
    : defaultCurrencyForCountry(ipCountry);

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

  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-12-18.acacia" });

  const origin = (req.headers.origin && /^https?:\/\//.test(req.headers.origin))
    ? req.headers.origin
    : "https://hikebeast.ch";

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      automatic_tax: { enabled: true },
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
      },
      // Forwarded into the underlying PaymentIntent so the webhook can join
      // the same identifiers without re-hydrating the session object.
      payment_intent_data: {
        metadata: {
          t,
          s,
          first_name: firstName,
        },
      },
      // After payment, Stripe loads the return URL inside the embedded
      // iframe; we read ?session_id= there to fetch the completed session
      // and render the success state.
      return_url: `${origin}/map/success?session_id={CHECKOUT_SESSION_ID}`,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      client_secret: session.client_secret,
      session_id: session.id,
      currency,
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
