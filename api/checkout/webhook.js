// Stripe webhook receiver.
//
// Handles `checkout.session.completed` (the success event for embedded
// Checkout Sessions) and `charge.refunded` (revoke the buyer's access).
//
// Idempotency: Stripe retries on non-2xx, and may also redeliver after
// transient connection issues. We guard every side effect with the event id
// or the payment_intent id and rely on downstream services (Sheet, Resend,
// Meta CAPI) being themselves idempotent on the event_id we forward.
//
// Side effects on success:
//   1. Issue a per-customer access token (HMAC).
//   2. Send the purchase email via Resend with the access link + download link.
//   3. Log the purchase row to the Sheet via Apps Script (same shape as the
//      Whop webhook so the existing reporting keeps working).
//   4. Fire Meta CAPI Purchase event server-side (closes the cap-api TODO
//      that's been open since 2026-04-23, see brain).
//   5. Add `purchased` tag on the originating ManyChat subscriber, if known.
//
// Side effects on refund:
//   - Append payment_intent_id to a deny-list (env var DENIED_PAYMENT_IDS for
//     now; promote to KV when it grows). Future /access and /download calls
//     for that buyer return 403.

import Stripe from "stripe";
import crypto from "node:crypto";
import { Resend } from "resend";
import { issueToken } from "../../lib/access-token.js";
import { addTag, setEmail } from "../../lib/manychat.js";

export const config = {
  api: { bodyParser: false },
};

const TOKEN_VERSION = "v1";
const FROM = "Leon · Hikebeast <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const SITE = "https://hikebeast.ch";
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";
// Same hero image as the /map/success page, so the receipt feels like a
// continuation of the post-purchase moment.
const HERO_IMG = `${SITE}/map/img/thanks-email.jpg`;
// Customer-view Drive folder. Latest version of the guide always lives
// here so the URL stays stable across releases. Linked here as the
// "view in browser" alternative to the direct download.
const DRIVE_URL = "https://drive.google.com/drive/folders/182_BdFNwF9jptpp9ax7G8sHNYb01nCa0?usp=share_link";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function accessLink(token) {
  return `${SITE}/api/checkout/access?t=${encodeURIComponent(token)}`;
}

function downloadLink(token) {
  return `${SITE}/api/checkout/download?t=${encodeURIComponent(token)}`;
}

function purchaseEmailHtml({ firstName, downloadUrl, amountFormatted, orderId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Swiss Hidden Gems · Your guide is ready</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
        <tr><td>
          <img src="${HERO_IMG}" alt="Swiss Hidden Gems" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
        </td></tr>
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">You're all set to discover the best spots Switzerland has to offer.</p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#1d1d1f;">
              <a href="${downloadUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Download the guide</a>
            </td>
          </tr></table>

          <!-- Secondary link: open the customer-view Drive folder. Same
               PDF, but viewable in browser without downloading first. -->
          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;line-height:1.5;">
            Or <a href="${DRIVE_URL}" style="color:#0071e3;text-decoration:none;">open in Google Drive</a>.
          </p>

          <p style="margin:0 0 16px;font-size:15px;color:#6e6e73;">Save the PDF to your phone for offline use on the trail. On iPhone: tap the button, then the share icon, then "Save to Files".</p>

          <p style="margin:0 0 4px;font-size:16px;">Have fun out there,</p>
          <p style="margin:0 0 32px;font-size:16px;">Leon</p>

          <hr style="border:0;border-top:1px solid rgba(0,0,0,0.08);margin:0 0 20px;" />
          <p style="margin:0 0 4px;font-size:12px;color:#6e6e73;">Receipt: ${amountFormatted} · Order ${orderId}</p>
          <p style="margin:0;font-size:12px;color:#6e6e73;">Questions? Reply to this email.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;"><tr>
        <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
          <div>© Hikebeast · Saftladen GmbH</div>
          <div><a href="${SITE}/imprint.html" style="color:#6e6e73;text-decoration:none;">Imprint</a> · <a href="${SITE}/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</body>
</html>`;
}

function purchaseEmailText({ firstName, downloadUrl, amountFormatted, orderId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  return `${greeting}

You're all set to discover the best spots Switzerland has to offer.

Download the guide:
${downloadUrl}

Or open in Google Drive:
${DRIVE_URL}

Save the PDF to your phone for offline use. On iPhone: tap the link, share, "Save to Files".

Have fun out there,
Leon

---
Receipt: ${amountFormatted} · Order ${orderId}
Questions? Reply to this email.

© Hikebeast · Saftladen GmbH
${SITE}/imprint.html · ${SITE}/privacy.html
`;
}

async function logPurchase(fields) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "purchase",
        secret: process.env.SHEETS_SECRET,
        ...fields,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Purchase log failed:", err);
  }
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
}

async function fireCapiPurchase({ eventId, email, firstName, amount, currency, ipCountry, sourceUrl }) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return;

  const payload = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: sourceUrl || `${SITE}/map/`,
      user_data: {
        em: email ? [sha256Hex(email)] : undefined,
        fn: firstName ? [sha256Hex(firstName)] : undefined,
        country: ipCountry ? [sha256Hex(ipCountry)] : undefined,
      },
      custom_data: {
        currency: (currency || "").toUpperCase() || undefined,
        value: typeof amount === "number" ? Number((amount / 100).toFixed(2)) : undefined,
      },
    }],
  };

  try {
    await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Meta CAPI Purchase failed:", err);
  }
}

function formatAmount(amountTotal, currency) {
  if (typeof amountTotal !== "number" || !currency) return "";
  const value = (amountTotal / 100).toFixed(2);
  return `${value} ${currency.toUpperCase()}`;
}

async function handleSessionCompleted({ stripe, event }) {
  const session = event.data.object;

  // Re-fetch with line items + payment_intent expanded so we have everything
  // we need without trusting the webhook payload shape across API versions.
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["payment_intent", "customer_details"],
  });

  const email = full.customer_details?.email || full.customer_email || "";
  const firstName = full.metadata?.first_name || "";
  const subscriberId = full.metadata?.s || "";
  const cohortToken = full.metadata?.t || "";
  const ipCountry = full.metadata?.ip_country || "";

  if (!email) {
    console.error("Session completed without email:", full.id);
    return;
  }

  const paymentIntent = typeof full.payment_intent === "string"
    ? full.payment_intent
    : full.payment_intent?.id;
  if (!paymentIntent) {
    console.error("Session completed without payment_intent:", full.id);
    return;
  }

  const accessToken = issueToken({ email, paymentIntentId: paymentIntent });
  const downloadUrl = downloadLink(accessToken);
  const amountFormatted = formatAmount(full.amount_total, full.currency);

  // 1. Send purchase email (Resend). One CTA: Download the guide.
  // (The access-token cookie flow for /full/ webapp is still wired, but
  // not surfaced in the email until the webapp is opened to paid customers.
  // /api/checkout/access?t=<token> still works if needed manually.)
  let emailOk = false;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject: "Swiss Hidden Gems · Your guide is ready",
      html: purchaseEmailHtml({ firstName, downloadUrl, amountFormatted, orderId: full.id }),
      text: purchaseEmailText({ firstName, downloadUrl, amountFormatted, orderId: full.id }),
    });
    if (error) console.error("Resend purchase email error:", error);
    else emailOk = true;
  } catch (err) {
    console.error("Resend purchase email threw:", err?.message || err);
  }

  // 2. Log to Sheet (same shape as Whop webhook for cohort math).
  const sideEffects = [
    logPurchase({
      email,
      amount: typeof full.amount_total === "number" ? (full.amount_total / 100).toFixed(2) : "",
      currency: (full.currency || "").toUpperCase(),
      product: "Swiss Hidden Gems",
      product_id: "swiss-hidden-gems",
      plan_id: "",
      membership_id: "",
      payment_id: paymentIntent,
      event_id: event.id,
      paid_at: new Date(event.created * 1000).toISOString(),
      metadata_t: cohortToken,
      metadata_s: subscriberId,
      provider: "stripe",
      session_id: full.id,
      email_sent: emailOk ? "1" : "0",
    }),
    fireCapiPurchase({
      eventId: paymentIntent, // dedupes with client-side fbq using same event_id
      email,
      firstName,
      amount: full.amount_total,
      currency: full.currency,
      ipCountry,
      sourceUrl: `${SITE}/map/`,
    }),
  ];

  // 3. ManyChat tagging on the originating subscriber, if any.
  if (subscriberId) {
    sideEffects.push(addTag(subscriberId, "purchased"));
    sideEffects.push(setEmail(subscriberId, email));
  }

  await Promise.all(sideEffects);
}

async function handleChargeRefunded({ event }) {
  const charge = event.data.object;
  const paymentIntent = charge?.payment_intent;
  if (!paymentIntent) return;

  // For now just log the refund to the Sheet. Operator manually appends
  // the payment_intent id to DENIED_PAYMENT_IDS in Vercel env. This is the
  // intentional half-step before promoting revoke storage to Vercel KV.
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "refund",
        secret: process.env.SHEETS_SECRET,
        payment_id: paymentIntent,
        amount: typeof charge.amount_refunded === "number" ? (charge.amount_refunded / 100).toFixed(2) : "",
        currency: (charge.currency || "").toUpperCase(),
        refunded_at: new Date(event.created * 1000).toISOString(),
        event_id: event.id,
        provider: "stripe",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Refund log failed:", err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("Stripe webhook env not configured");
    return res.status(503).json({ error: "stripe_not_configured" });
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-12-18.acacia" });
  const sigHeader = req.headers["stripe-signature"];
  const raw = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sigHeader, webhookSecret);
  } catch (err) {
    console.error("Stripe signature verification failed:", err?.message || err);
    return res.status(400).json({ error: "bad_signature" });
  }

  // Do the work BEFORE responding. Vercel serverless functions terminate
  // execution as soon as the response is sent, so any "ack first, work
  // after" pattern silently drops the side effects (email, Sheet log, Meta
  // CAPI). Stripe's webhook timeout is 30s, comfortable for our 2-3s of
  // outbound HTTP calls.
  try {
    if (event.type === "checkout.session.completed") {
      await handleSessionCompleted({ stripe, event });
    } else if (event.type === "charge.refunded") {
      await handleChargeRefunded({ event });
    }
  } catch (err) {
    console.error(`Stripe webhook handler error (${event.type}):`, err);
    // Still ack 200 so Stripe doesn't retry forever -- the Sheet log and
    // any partial state already happened, and a retry would just duplicate.
  }

  return res.status(200).json({ ok: true });
}
