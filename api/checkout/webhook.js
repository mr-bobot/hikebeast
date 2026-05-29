// Stripe webhook receiver.
//
// Handles `checkout.session.completed` (the success event for embedded
// Checkout Sessions) and `charge.refunded` (revoke the buyer's access).
//
// Idempotency: Stripe retries on non-2xx, and may also redeliver after
// transient connection issues. We guard every side effect with the event id
// or the payment_intent id and rely on downstream services (Resend, Meta
// CAPI, Convex action) being themselves idempotent on the event_id we
// forward.
//
// Side effects on success (in execution order):
//   1. Issue a per-customer access token (HMAC) and download link.
//   2. Fire Meta CAPI Purchase event server-side. Awaited because Meta's
//      CAPI is fast (<2s) and this is the load-bearing ad-attribution
//      signal — must land before any slower call can starve the lambda.
//   3. Send the purchase email via Resend with the download link. Awaited
//      because the buyer is on the success page waiting for it.
//   4. Schedule slow side effects (Apps Script Sheet log + ManyChat IG
//      handle lookup + ManyChat tags + affiliate referral row + affiliate
//      Resend email) via the Convex action
//      `webhookHandlers:scheduleWebhookSideEffects`. Convex runs that work
//      in its own runtime, decoupled from the Vercel lambda budget.
//
// History:
//   - PR #86 (2026-05-24): reordered to fire CAPI FIRST + plumbed
//     event.created as stable eventTime for retry dedup.
//   - This PR (2026-05-27): split slow side effects out of the lambda
//     into Convex after Stripe Dashboard showed 41% webhook timeout rate.
//     Apps Script Sheet writes were observed at 30-80+ seconds, blowing
//     past Vercel Hobby's 30s lambda budget. Convex's scheduler-based
//     async runner has its own (5-min) timeout budget and isn't tied to
//     the webhook lambda's lifetime.
//
// Side effects on refund:
//   - Append payment_intent_id to a deny-list (env var DENIED_PAYMENT_IDS for
//     now; promote to KV when it grows). Future /access and /download calls
//     for that buyer return 403.

import Stripe from "stripe";
import crypto from "node:crypto";
import { Resend } from "resend";
import { issueToken } from "../../lib/access-token.js";
// ManyChat helpers (addTag, setEmail, setCustomField, getSubscriberIgUsername)
// were moved to convex/webhookHandlers.ts on 2026-05-27. They run there
// inside the async side-effects action instead of inline in this lambda.
import { fireCapi, buildUserData, splitName } from "../../lib/capi.js";

export const config = {
  api: { bodyParser: false },
  // Vercel Hobby default lambda timeout is 10s. The webhook awaits Stripe
  // retrieve + Resend send + Apps Script Sheet write + Meta CAPI POST in
  // sequence; any one slow third-party (Resend image fetch, Apps Script
  // cold-start) could push the total past 10s. When that happened, Vercel
  // killed the lambda mid-Promise.all, Meta CAPI never fired, and Stripe
  // retried the webhook hours later with a fresh `event_time` that Meta's
  // dedup window couldn't reconcile against the original eventID, causing
  // both 0-server-event misses and 3-server-event overfires in Events
  // Manager's deduplication diagnostic (2026-05-24). Bumping to 30s
  // matches Stripe's own webhook timeout, which is the upper bound that
  // matters here. Hobby plan caps maxDuration at 60s, so 30 is allowed.
  maxDuration: 30,
};

const TOKEN_VERSION = "v1";
const FROM = "Leon · Hikebeast <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const SITE = "https://hikebeast.ch";
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";
// Same hero image as the /map/success page, so the receipt feels like a
// continuation of the post-purchase moment. Hosted under /images/ (not
// /map/) so the gating middleware leaves it alone -- email clients never
// send the auth cookie, so any /map/* asset would 302 to /login and
// render a broken image in the email body.
// Cache-bust query string bumped when the file changes. Some email clients
// aggressively cache previously-fetched URLs (Gmail proxy, Outlook image
// cache); a new ?v= guarantees subscribers see the current artwork.
const HERO_IMG = `${SITE}/images/thanks-hero.jpg?v=1`;
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

// Talk to Convex via the plain HTTP API (same approach as
// api/checkout/session.js — keeps the lambda small and dodges the
// generated convex/_generated module that isn't built during Vercel's
// build). Throws on transport / handler errors so the caller can decide
// whether to swallow.
async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, "")}/api/mutation`;
  const r = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ path, args, format: "json" }),
    signal:  AbortSignal.timeout(5000),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`convex http ${r.status}: ${json?.errorMessage || r.statusText}`);
  }
  if (json?.status === "error") {
    throw new Error(json.errorMessage || "convex mutation failed");
  }
  return json?.value;
}

function accessLink(token) {
  return `${SITE}/api/checkout/access?t=${encodeURIComponent(token)}`;
}

function downloadLink(token) {
  return `${SITE}/api/checkout/download?t=${encodeURIComponent(token)}`;
}

// Affiliate "you earned X" notification template was moved to
// convex/webhookHandlers.ts on 2026-05-27 (it's only used by the
// affiliate Resend send, which now lives in the Convex side-effects
// action). If the email copy changes, edit it there.

function purchaseEmailHtml({ firstName, downloadUrl, amountFormatted, orderId, sessionId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  // Onboarding return-link points at the same /map/success page. The page
  // already calls GET /api/checkout/session?session_id=... server-side to
  // verify the session is paid before showing the form, so handing out
  // session_id in an email is safe -- it's already in Stripe's redirect URL.
  const onboardingUrl = `${SITE}/map/success/?session_id=${encodeURIComponent(sessionId || "")}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Swiss Gems · Your guide is ready</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
        <tr><td>
          <img src="${HERO_IMG}" alt="Swiss Gems" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
        </td></tr>
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">You're all set to discover the best spots Switzerland has to offer.</p>

          <!-- Primary CTA (added 2026-05-07): the webapp. Links back to the
               success page so the buyer can finish onboarding (set username
               + password) any time. The page re-verifies the Stripe session
               server-side before showing the form. -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#0071e3;">
              <a href="${onboardingUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Open the Swiss Gems App</a>
            </td>
          </tr></table>
          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;line-height:1.5;">
            Save spots and sync them across your devices.
          </p>

          <!-- Secondary CTA — outlined to differentiate from the primary
               webapp button above. Same shape and size for symmetry. -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#ffffff;border:1.5px solid #1d1d1f;">
              <a href="${downloadUrl}" style="display:inline-block;padding:12.5px 26.5px;color:#1d1d1f;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Download the guide</a>
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
          <p style="margin:0 0 8px;font-size:12px;color:#6e6e73;">Receipt: ${amountFormatted} · Order ${orderId}</p>
          <!-- Mirror the /map/ landing-page guarantee so the receipt
               doubles as proof of the promise the buyer just bought
               into. Same conditional wording. -->
          <p style="margin:0 0 4px;font-size:12px;color:#6e6e73;">30-day money-back guarantee. If the guide doesn't help you find a single new spot, just reply to this email within 30 days.</p>
          <p style="margin:0;font-size:12px;color:#6e6e73;">Questions? Reply to this email.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;"><tr>
        <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
          <div>© Hikebeast</div>
          <div><a href="${SITE}/terms.html" style="color:#6e6e73;text-decoration:none;">Terms</a> · <a href="${SITE}/imprint.html" style="color:#6e6e73;text-decoration:none;">Imprint</a> · <a href="${SITE}/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</body>
</html>`;
}

function purchaseEmailText({ firstName, downloadUrl, amountFormatted, orderId, sessionId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  const onboardingUrl = `${SITE}/map/success/?session_id=${encodeURIComponent(sessionId || "")}`;
  return `${greeting}

You're all set to discover the best spots Switzerland has to offer.

Open the Swiss Gems App (save spots, sync across devices):
${onboardingUrl}

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

© Hikebeast
${SITE}/terms.html · ${SITE}/imprint.html · ${SITE}/privacy.html
`;
}

// German variants. Triggered by session.metadata.locale === "de", which
// is set when the buyer paid from /de/map/. Strings come from the
// brand-voice draft in _drafts/mail-translations.md · keep them in sync
// if you tweak this.
function purchaseEmailDeHtml({ firstName, downloadUrl, amountFormatted, orderId, sessionId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  // DE-buyer onboarding link points at /de/map/success so the page is in
  // German. Same Stripe session id; the page does the re-verify.
  const onboardingUrl = `${SITE}/de/map/success/?session_id=${encodeURIComponent(sessionId || "")}`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Swiss Gems · Dein Guide ist bereit</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
        <tr><td>
          <img src="${HERO_IMG}" alt="Swiss Gems" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
        </td></tr>
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">Bist du bereit, die schönsten Spots in der Schweiz zu entdecken?</p>

          <!-- Primärer CTA (added 2026-05-07): die Webapp. Linkt zurück zur
               Success-Page, damit du das Onboarding (Username + Passwort)
               jederzeit abschliessen kannst. -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#0071e3;">
              <a href="${onboardingUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Swiss Gems App öffnen</a>
            </td>
          </tr></table>
          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;line-height:1.5;">
            Speichere deine Spots und synce sie geräteübergreifend.
          </p>

          <!-- Secondary CTA — outlined, parallels the English template. -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
            <td style="border-radius:999px;background:#ffffff;border:1.5px solid #1d1d1f;">
              <a href="${downloadUrl}" style="display:inline-block;padding:12.5px 26.5px;color:#1d1d1f;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Guide herunterladen</a>
            </td>
          </tr></table>

          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;line-height:1.5;">
            Oder <a href="${DRIVE_URL}" style="color:#0071e3;text-decoration:none;">in Google Drive öffnen</a>.
          </p>

          <p style="margin:0 0 16px;font-size:15px;color:#6e6e73;">Speichere das PDF auf deinem Handy, um es unterwegs offline zu nutzen. Auf dem iPhone: "Teilen" Knopf drücken, dann "In Dateien speichern".</p>

          <p style="margin:0 0 4px;font-size:16px;">Viel Spass</p>
          <p style="margin:0 0 32px;font-size:16px;">Leon</p>

          <hr style="border:0;border-top:1px solid rgba(0,0,0,0.08);margin:0 0 20px;" />
          <p style="margin:0 0 8px;font-size:12px;color:#6e6e73;">Rechnung: ${amountFormatted} · Bestellung ${orderId}</p>
          <p style="margin:0 0 4px;font-size:12px;color:#6e6e73;">30 Tage Geld-Zurück-Garantie. Wenn dir der Guide nicht geholfen hat, einen einzigen neuen Spot zu finden, antworte innert 30 Tagen einfach auf diese Mail.</p>
          <p style="margin:0;font-size:12px;color:#6e6e73;">Fragen? Antworte auf diese Mail.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;"><tr>
        <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
          <div>© Hikebeast</div>
          <div><a href="${SITE}/de/terms.html" style="color:#6e6e73;text-decoration:none;">AGB</a> · <a href="${SITE}/de/imprint.html" style="color:#6e6e73;text-decoration:none;">Impressum</a> · <a href="${SITE}/de/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</body>
</html>`;
}

function purchaseEmailDeText({ firstName, downloadUrl, amountFormatted, orderId, sessionId }) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  const onboardingUrl = `${SITE}/de/map/success/?session_id=${encodeURIComponent(sessionId || "")}`;
  return `${greeting}

Bist du bereit, die schönsten Spots in der Schweiz zu entdecken?

Swiss Gems App öffnen (Spots speichern, geräteübergreifend syncen):
${onboardingUrl}

Lade den Guide runter:
${downloadUrl}

Oder öffne in Google Drive:
${DRIVE_URL}

Speichere das PDF auf deinem Handy, um es unterwegs offline zu nutzen. Auf dem iPhone: "Teilen" Knopf drücken, dann "In Dateien speichern".

Viel Spass
Leon

---
Rechnung: ${amountFormatted} · Bestellung ${orderId}
Fragen? Antworte auf diese Mail.

© Hikebeast
${SITE}/de/terms.html · ${SITE}/de/imprint.html · ${SITE}/de/privacy.html
`;
}

// Subject line + body picker keyed off the locale stamped in session
// metadata. Falls back to EN if locale is missing or unknown.
const EMAIL_COPY = {
  en: {
    subject: "Swiss Gems · Your guide is ready",
    html: purchaseEmailHtml,
    text: purchaseEmailText,
  },
  de: {
    subject: "Swiss Gems · Dein Guide ist bereit",
    html: purchaseEmailDeHtml,
    text: purchaseEmailDeText,
  },
};

function pickEmailCopy(locale) {
  return EMAIL_COPY[String(locale || "").toLowerCase()] || EMAIL_COPY.en;
}

// logPurchase (Apps Script Sheet write for purchases) was moved to
// convex/webhookHandlers.ts on 2026-05-27. The Apps Script call was the
// dominant blocker for the Vercel lambda — observed at 30-80+ seconds
// under prod lock contention, blowing past maxDuration:30 and causing
// Stripe to retry (41% timeout rate in the Stripe Webhooks dashboard,
// which then caused CAPI overfire on the retry-succeeded path AND CAPI
// underfire on the all-retries-failed path).
//
// The Sheet refund logger below stays here because refund volume is low
// and the refund handler doesn't have other slow side effects to
// compound with.

// Fire the Purchase CAPI event with the maximum identity signal Stripe
// gives us back: email + first/last name + city + zip + country, plus
// fbc/fbp/ip/ua piped through Stripe metadata from the landing page.
// More fields = higher EMQ = lower ad CPA. See lib/capi.js for the
// per-field semantics and which ones get SHA-256 hashed.
//
// `eventId` MUST match the `eventID` the browser pixel passes on the
// success page (currently the Stripe paymentIntent id) so Meta dedupes.
async function fireCapiPurchase({
  eventId, eventTime, email, firstName, lastName, city, zip, country, amount, currency,
  fbc, fbp, clientIp, clientUserAgent, sourceUrl,
}) {
  return fireCapi({
    eventName: "Purchase",
    eventId,
    // Stable event_time tied to the Stripe event, not Date.now(). If Stripe
    // retries the same webhook hours later, the eventID is the same but
    // Date.now() would shift; Meta's dedup window only collapses events
    // when (event_id, event_name, event_time) align closely. Anchoring to
    // event.created keeps retries collapsible. (2026-05-24)
    eventTime,
    userData: buildUserData({
      email: email || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      city: city || undefined,
      zip: zip || undefined,
      country: country || undefined,
      fbc: fbc || undefined,
      fbp: fbp || undefined,
      clientIp: clientIp || undefined,
      clientUserAgent: clientUserAgent || undefined,
    }),
    customData: {
      currency: (currency || "").toUpperCase() || undefined,
      value: typeof amount === "number" ? Number((amount / 100).toFixed(2)) : undefined,
    },
    sourceUrl: sourceUrl || `${SITE}/map/`,
  });
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
  // Locale of the page the buyer paid from. Set by /api/checkout/session
  // when creating the checkout. Drives the EN vs DE purchase email.
  const localeHint = full.metadata?.locale || "";
  // Affiliate ref slug. Empty when the buyer didn't arrive via ?r=.
  const refSlug = full.metadata?.r || "";
  // Which landing variant the buyer paid from. Forwarded to the Sheet's
  // `source_page` column for A/B attribution (map / themap / map3 +
  // their de_ variants).
  const sourcePage = full.metadata?.source_page || "";
  // UTM params · stamped into Stripe metadata by /api/checkout/session
  // from the buyer's URL params. Forwarded to the Sheet's utm_* columns
  // so off-platform traffic (TikTok bio, Linktree, ads) can be attributed.
  const utmSource = full.metadata?.utm_source || "";
  const utmMedium = full.metadata?.utm_medium || "";
  const utmCampaign = full.metadata?.utm_campaign || "";
  // v12 hero split-test bucket the buyer was assigned to. Empty if not
  // in the test. Forwarded to the Sheet's `hero_variant` column to
  // close the conversion loop per variant.
  const heroVariant = full.metadata?.hero_variant || "";
  // Meta CAPI identity signals · stamped into Stripe metadata by
  // api/checkout/session.js when the buyer first hit the page. Read
  // back here so fireCapiPurchase can include them in user_data and
  // Meta's EMQ score goes up. fbc + fbp = ad attribution; client_ip
  // and client_ua = browser-fingerprint signals Meta uses when the
  // hashed PII has weak coverage.
  const metaFbc = full.metadata?.fbc || "";
  const metaFbp = full.metadata?.fbp || "";
  const metaClientIp = full.metadata?.client_ip || "";
  const metaClientUa = full.metadata?.client_ua || "";

  // Address fields Stripe collects in the embedded form. The buyer's
  // name is one string ("Hans Müller") that we split into first/last;
  // city + zip live on customer_details.address. Each adds match-bits
  // for Meta's user lookup.
  const fullName = full.customer_details?.name || "";
  const [, lastNameFromStripe] = splitName(fullName);
  // Prefer the metadata first_name (collected pre-checkout) over the
  // Stripe-collected one to avoid casing/normalisation drift between
  // what the buyer typed in our pre-form and what they typed in Stripe.
  const firstNameForCapi = firstName || splitName(fullName)[0] || "";
  const city = full.customer_details?.address?.city || "";
  const zip = full.customer_details?.address?.postal_code || "";

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

  // buyerIg lookup moved to convex/webhookHandlers.ts (2026-05-27). It used
  // to be inline here, but the ManyChat GET adds ~1-3s to the lambda
  // budget and the only consumers (Sheet log row + affiliate referral row
  // + affiliate email) are now all in the Convex side-effects action
  // anyway. One lookup, three uses, all in the same async runtime.

  // 0. Fire Meta CAPI Purchase FIRST, awaited synchronously, before any
  // slower side effect. fireCapi self-times-out at 5s. Stripe-retry
  // dedupes via stable eventID + event_time (anchored to event.created).
  // This was reordered on 2026-05-24 (PR #86) after Events Manager's dedup
  // diagnostic showed 0-server-event misses on ~40% of purchases. The
  // 2026-05-27 cut to Convex (this comment) further reduced lambda
  // duration by moving the slow side-effects out entirely — CAPI fire is
  // still here because it's the load-bearing ad-attribution signal and
  // Meta's CAPI endpoint is itself fast (consistently <2s).
  try {
    await fireCapiPurchase({
      eventId: paymentIntent, // dedupes with client-side fbq using same event_id
      eventTime: typeof event.created === "number" ? event.created : Math.floor(Date.now() / 1000),
      email,
      firstName: firstNameForCapi,
      lastName: lastNameFromStripe,
      city,
      zip,
      country: ipCountry,
      amount: full.amount_total,
      currency: full.currency,
      fbc: metaFbc,
      fbp: metaFbp,
      clientIp: metaClientIp,
      clientUserAgent: metaClientUa,
      sourceUrl: `${SITE}/map/`,
    });
  } catch (err) {
    console.error("fireCapiPurchase threw (continuing):", err?.message || err);
  }

  // 1. Send purchase email (Resend). One CTA: Download the guide.
  // (The access-token cookie flow for /full/ webapp is still wired, but
  // not surfaced in the email until the webapp is opened to paid customers.
  // /api/checkout/access?t=<token> still works if needed manually.)
  let emailOk = false;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const copy = pickEmailCopy(localeHint);
    // sessionId is passed alongside orderId so email templates can build the
    // /map/success?session_id=... return-link. They're the same value today
    // (orderId === Stripe session.id) but we keep them distinct in case
    // Stripe ever splits them, and so the contract of each template arg is
    // explicit about what URL parameter it ends up in.
    const tplArgs = { firstName, downloadUrl, amountFormatted, orderId: full.id, sessionId: full.id };
    // Idempotency-Key dedupes within Resend's 24h window. Protects against
    // Stripe webhook retries (which fire when the handler exceeds Stripe's
    // 30s timeout — e.g. slow Apps Script Sheet writes) re-sending the
    // same purchase email. Bug from 2026-05-17: Vicky received the
    // confirmation 4× over 24h before this guard.
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject: copy.subject,
      html: copy.html(tplArgs),
      text: copy.text(tplArgs),
    }, { idempotencyKey: event.id });
    if (error) console.error("Resend purchase email error:", error);
    else emailOk = true;
  } catch (err) {
    console.error("Resend purchase email threw:", err?.message || err);
  }

  // 1.5 Add the buyer to the Resend audience (broadcast / newsletter list).
  // Fire-and-forget · mirrors createResendContact in api/sample.js and the
  // admin_add_resend_contact path in api/login.js (same shape that the
  // 2026-05-13 backfill used to load the initial 273 contacts).
  //
  // This webhook historically only SENT the guide email and never added
  // buyers to the audience — the only live add-path was the free-sample
  // flow (api/sample.js), which the current purchase funnel bypasses. So
  // after the one-time 2026-05-13 backfill the list froze: every new buyer
  // got their email but never landed in the audience. Wiring the add here
  // closes that gap (2026-05-29).
  //
  // contacts.create is idempotent · a duplicate returns an "already exists"
  // error we swallow. Errors are logged, never thrown, so a Resend hiccup
  // can't fail the webhook or block the Sheet/ManyChat side effects below.
  try {
    const audienceId = process.env.RESEND_SEGMENT_ID;
    if (audienceId && email) {
      const resendContacts = new Resend(process.env.RESEND_API_KEY);
      const { error: contactError } = await resendContacts.contacts.create({
        audienceId,
        email,
        firstName: firstName || undefined,
        unsubscribed: false,
      });
      if (contactError) {
        const msg = String(contactError.message || "");
        const isDupe = /already exists|already in/i.test(msg);
        if (!isDupe) console.error("Resend audience add error:", contactError.name, msg);
      }
    } else if (!audienceId) {
      console.warn("RESEND_SEGMENT_ID not set — skipping audience add");
    }
  } catch (err) {
    console.error("Resend audience add threw:", err?.message || err);
  }

  // 2. Schedule the slow side effects (Sheet log + ManyChat IG lookup +
  // ManyChat tag writes + affiliate referral row + affiliate "you earned"
  // email) via the Convex action `webhookHandlers:scheduleWebhookSideEffects`.
  //
  // Why this is a single Convex call instead of inline Promise.all:
  // ---------------------------------------------------------------
  // Apps Script's logPurchase write was observed at 30-80+ seconds
  // (execution log 2026-05-27 morning: 82.7s, 69.9s, 51.4s, 49.8s in one
  // hour). Combined with the ManyChat writes and the affiliate flow, the
  // Vercel lambda routinely blew past its 30s budget. Stripe Dashboard
  // showed 41% webhook timeout rate; retries caused CAPI Purchase
  // overfire AND missed CAPI on the "all retries timed out" cases (Event
  // Dedup sample on 2026-05-27 showed both patterns: 0 server_events for
  // some pi, 3 server_events for others).
  //
  // Convex's scheduler runs `processWebhookSideEffects` in Convex's own
  // runtime, decoupled from the Vercel lambda. The HTTP call below
  // returns in ~100ms (mutation just schedules and returns), so the
  // Vercel webhook finishes in ~10s total instead of timing out at 30s.
  // The actual Apps Script + ManyChat + affiliate work then takes
  // whatever time it takes in Convex (default 5min budget, plenty of
  // headroom for Apps Script's worst case).
  //
  // If the Convex scheduling call itself fails (network blip), the
  // Purchase event has already been registered with Meta CAPI above and
  // the buyer has the Resend confirmation email — we lose the Sheet row
  // and ManyChat tags for that one purchase, recoverable from Stripe
  // truth via the get_snapshot endpoint.
  const convexUrl = process.env.CONVEX_URL;
  if (convexUrl) {
    try {
      await convexMutation(convexUrl, "webhookHandlers:scheduleWebhookSideEffects", {
        sessionId:     full.id,
        paymentIntent,
        eventId:       event.id,
        email,
        firstName:     firstName || undefined,
        subscriberId:  subscriberId || undefined,
        cohortToken:   cohortToken || undefined,
        refSlug:       refSlug || undefined,
        amountCents:   typeof full.amount_total === "number" ? full.amount_total : 0,
        currency:      (full.currency || "").toLowerCase(),
        paidAt:        new Date(event.created * 1000).toISOString(),
        sourcePage:    sourcePage || undefined,
        utmSource:     utmSource || undefined,
        utmMedium:     utmMedium || undefined,
        utmCampaign:   utmCampaign || undefined,
        heroVariant:   heroVariant || undefined,
        ipCountry:     ipCountry || undefined,
        locale:        localeHint || undefined,
        emailOk,
      });
    } catch (err) {
      console.error("scheduleWebhookSideEffects failed (Sheet/ManyChat/affiliate will be missing for this purchase):", err?.message || err);
    }
  } else {
    console.error("CONVEX_URL not set; cannot schedule webhook side effects");
  }
}

async function handleChargeRefunded({ event }) {
  const charge = event.data.object;
  const paymentIntent = charge?.payment_intent;
  if (!paymentIntent) return;

  // For now just log the refund to the Sheet. Operator manually appends
  // the payment_intent id to DENIED_PAYMENT_IDS in Vercel env. This is the
  // intentional half-step before promoting revoke storage to Vercel KV.
  const url = process.env.SHEETS_WEBHOOK_URL;
  const tasks = [];
  if (url) {
    tasks.push(
      fetch(url, {
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
      }).catch(err => console.error("Refund log failed:", err)),
    );
  }

  // Void any affiliate referral linked to this payment_intent. No-op when
  // there's no referral row (most refunds), so we don't gate on `refSlug`
  // — we just look it up by paymentIntent in Convex.
  const convexUrl = process.env.CONVEX_URL;
  if (convexUrl) {
    tasks.push(
      convexMutation(convexUrl, "referrals:voidByPaymentIntent", {
        stripePaymentIntentId: paymentIntent,
      }).catch(err => console.error("referrals:voidByPaymentIntent failed:", err?.message || err)),
    );
  }

  await Promise.all(tasks);
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
