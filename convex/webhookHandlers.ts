// webhookHandlers.ts — async side-effect runner for Stripe checkout.session.completed.
//
// Why this exists:
// ----------------
// api/checkout/webhook.js was doing ALL purchase side effects (Apps Script
// Sheet write, ManyChat tags, ManyChat IG lookup, affiliate Resend email)
// inline in the Vercel lambda. Apps Script Sheet writes were observed
// taking 30-80+ seconds (see Apps Script execution log on 2026-05-27 morning:
// 82.7s, 69.9s, 51.4s, 49.8s in a single hour), blowing past Vercel Hobby's
// 30s lambda budget. Stripe Dashboard showed 41% webhook timeout rate;
// retries caused CAPI overfire AND missed CAPI on the failed-completely
// cases (Event Dedup diagnostic 47.31% coverage).
//
// PR #86 partially helped by firing CAPI synchronously before the slow
// side effects. But the await Promise.all([logPurchase, manychatTags,
// affiliate]) at the end of the handler still made Stripe wait the full
// 30s+ and gave up.
//
// Architecture after this file:
//   1. api/checkout/webhook.js does ONLY the synchronous critical work
//      (Stripe retrieve · CAPI Purchase fire · Resend buyer email).
//   2. Calls scheduleWebhookSideEffects via Convex HTTP — returns in ~100ms.
//   3. Convex schedules processWebhookSideEffects to run immediately in
//      Convex's own runtime, completely decoupled from the Vercel lambda.
//   4. Stripe gets its 200 OK in ~10s instead of timing out at 30s.
//   5. The slow Apps Script + ManyChat work happens in Convex's runtime
//      where 60s+ per call is fine.
//
// The new processWebhookSideEffects is the source of truth for:
//   - ManyChat IG handle lookup (used by Sheet log + referral + affiliate email)
//   - Apps Script logPurchase
//   - ManyChat addTag("purchased") · setEmail · setCustomField("Bought Guide", true)
//   - referrals:recordPurchase mutation call (when refSlug present)
//   - Affiliate "you earned X" email (when recordPurchase returns notify)
//
// All external calls use fetch() directly so the file works in Convex's
// V8 runtime without Node-specific SDK dependencies.

import { mutation, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

const MANYCHAT_API_BASE = "https://api.manychat.com/fb";
const RESEND_API = "https://api.resend.com/emails";

// Same constants as the webhook used for the affiliate email body. Inlined
// here so the Convex action has no cross-runtime imports.
const SITE = "https://hikebeast.ch";
const FROM = "Leon · Hikebeast <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";

// Shared arg shape between the mutation (scheduling) and the internal
// action (doing). Kept verbose so the webhook can pass through everything
// it would have logged itself, without the Convex action needing to
// re-derive anything from Stripe.
const webhookSideEffectArgs = v.object({
  // Identifiers
  sessionId:      v.string(),                 // cs_live_...
  paymentIntent:  v.string(),                 // pi_...
  eventId:        v.string(),                 // evt_... · for Sheet event_id column + dedupe
  // Buyer / cohort identity
  email:          v.string(),
  firstName:      v.optional(v.string()),
  subscriberId:   v.optional(v.string()),     // ManyChat sub id from session metadata
  cohortToken:    v.optional(v.string()),     // metadata.t
  refSlug:        v.optional(v.string()),     // metadata.r (affiliate)
  // Stripe amounts
  amountCents:    v.number(),                 // session.amount_total
  currency:       v.string(),                 // session.currency (ISO, lowercase)
  paidAt:         v.string(),                 // ISO timestamp · event.created
  // Page / UTM / cohort attribution
  sourcePage:     v.optional(v.string()),     // metadata.source_page
  utmSource:      v.optional(v.string()),
  utmMedium:      v.optional(v.string()),
  utmCampaign:    v.optional(v.string()),
  heroVariant:    v.optional(v.string()),
  ipCountry:      v.optional(v.string()),
  locale:         v.optional(v.string()),
  // Outcome of the synchronous Resend purchase email — the webhook fires
  // that itself (buyer is waiting on the success page), so this is just
  // a passthrough for the Sheet's email_sent column.
  emailOk:        v.boolean(),
});

// Public mutation called from api/checkout/webhook.js via the Convex HTTP
// API. Synchronous: validates the args, schedules the action, returns.
// The HTTP round-trip from Vercel → Convex → Vercel is ~50-150ms; the
// action then runs in Convex's runtime independently of whether the Vercel
// lambda is still alive.
export const scheduleWebhookSideEffects = mutation({
  args: webhookSideEffectArgs.fields,
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.webhookHandlers.processWebhookSideEffects, args);
    return { scheduled: true as const, paymentIntent: args.paymentIntent };
  },
});

// The actual side-effect runner. internalAction = only callable from
// other Convex functions (via the scheduler), not directly via HTTP.
// That's the right scope: this function does Apps Script + ManyChat +
// Resend HTTP calls and we don't want arbitrary clients triggering them.
export const processWebhookSideEffects = internalAction({
  args: webhookSideEffectArgs.fields,
  handler: async (ctx, args) => {
    const tag = `[webhookSideEffects ${args.paymentIntent}]`;
    console.log(`${tag} start`);

    // ── 1. ManyChat IG handle lookup ────────────────────────────────────
    // Needed by 3 downstream tasks (Sheet row, referral record, affiliate
    // email). One lookup, reused. ManyChat 5s timeout (its API is fast
    // on the GET path; slow only on writes).
    let buyerIg: string | null = null;
    if (args.subscriberId) {
      try {
        buyerIg = await fetchManyChatIgHandle(args.subscriberId);
      } catch (err) {
        console.error(`${tag} ManyChat IG lookup failed:`, err);
      }
    }

    // ── 2. Apps Script Sheet log ────────────────────────────────────────
    // The single Apps Script ScriptLock contends under FB-ad bursts; the
    // purchase write then fails with a FAST 15s "Lock timeout" (the
    // script's own waitLock), not a hang. That is retryable — by the next
    // attempt the lock has usually drained. postToAppsScript now retries
    // up to 2x (added 2026-05-30, after 86 lock-timeout rows
    // in the _errors tab dropped ~2.7% of buyers from the Signups sheet;
    // the old "no retry" note assumed a 60s hang, which is the wrong
    // failure mode). Stripe stays the source of truth; a still-failed row
    // can be backfilled from a Stripe export.
    try {
      await postToAppsScript({
        action:           "purchase",
        secret:           process.env.SHEETS_SECRET ?? "",
        email:            args.email,
        amount:           (args.amountCents / 100).toFixed(2),
        currency:         args.currency.toUpperCase(),
        product:          "Swiss Gems",
        product_id:       "swiss-hidden-gems",
        plan_id:          "",
        membership_id:    "",
        payment_id:       args.paymentIntent,
        event_id:         args.eventId,
        paid_at:          args.paidAt,
        metadata_t:       args.cohortToken ?? "",
        metadata_s:       args.subscriberId ?? "",
        instagram_handle: buyerIg ?? "",
        referral_slug:    args.refSlug ?? "",
        source_page:      args.sourcePage ?? "",
        utm_source:       args.utmSource ?? "",
        utm_medium:       args.utmMedium ?? "",
        utm_campaign:     args.utmCampaign ?? "",
        ip_country:       args.ipCountry ?? "",
        hero_variant:     args.heroVariant ?? "",
        provider:         "stripe",
        session_id:       args.sessionId,
        email_sent:       args.emailOk ? "1" : "0",
      });
      console.log(`${tag} Sheet logPurchase ok`);
    } catch (err) {
      console.error(`${tag} Sheet logPurchase failed:`, err);
    }

    // ── 3. ManyChat tags ────────────────────────────────────────────────
    // Three independent writes, fire in parallel with allSettled so one
    // failing doesn't drop the others. Each call has its own 5s timeout.
    if (args.subscriberId) {
      const subId = args.subscriberId;
      const results = await Promise.allSettled([
        manychatAddTag(subId, "purchased"),
        manychatSetField(subId, "Email", args.email),
        manychatSetField(subId, "Bought Guide", true),
      ]);
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed > 0) console.warn(`${tag} ${failed}/3 ManyChat writes failed`);
    }

    // ── 4. Affiliate referral row + notification ────────────────────────
    // Skips entirely when no refSlug. recordPurchase is idempotent on
    // stripeSessionId so Stripe-retry-redeliveries don't double-credit.
    if (args.refSlug) {
      try {
        const result = await ctx.runMutation(api.referrals.recordPurchase, {
          refSlug:               args.refSlug,
          stripeSessionId:       args.sessionId,
          stripePaymentIntentId: args.paymentIntent,
          buyerEmail:            args.email,
          buyerIg:               buyerIg ?? undefined,
          purchaseAmountCents:   args.amountCents,
          currency:              args.currency.toLowerCase(),
        });

        // notify is null when: orphan slug (no matching user), or matched
        // user isAffiliate=false / no email on file. recordPurchase also
        // returns deduped:true on a redelivery, which means notify was
        // already fired on the original — skip to avoid double-emailing.
        if (result.ok && !("deduped" in result && result.deduped) && "notify" in result && result.notify) {
          try {
            await sendAffiliateEarnedEmail({
              to:        result.notify.email,
              firstName: result.notify.firstName ?? undefined,
              buyerIg:   buyerIg,
              amountCents: Math.floor(args.amountCents / 2),
              currency:  args.currency,
              eventId:   args.eventId,
            });
            console.log(`${tag} affiliate-earned email sent to ${result.notify.email}`);
          } catch (err) {
            console.error(`${tag} affiliate-earned email failed:`, err);
          }
        }
      } catch (err) {
        console.error(`${tag} referrals:recordPurchase failed:`, err);
      }
    }

    console.log(`${tag} done`);
    return { ok: true as const };
  },
});

// ────────────────────────────────────────────────────────────────────────
// Helpers (no exports — internal to this file)
// ────────────────────────────────────────────────────────────────────────

// Mirror of lib/manychat.js#getSubscriberIgUsername, ported to fetch so
// it runs in Convex's V8 runtime without the lib/* file being importable.
async function fetchManyChatIgHandle(subscriberId: string): Promise<string | null> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) return null;
  const url = `${MANYCHAT_API_BASE}/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null) as any;
  if (!j || j.status !== "success") return null;
  const ig = j.data?.ig_username ?? j.data?.username ?? null;
  return ig ? String(ig).replace(/^@+/, "").trim().toLowerCase() || null : null;
}

async function manychatAddTag(subscriberId: string, tagName: string): Promise<void> {
  return manychatPost("/subscriber/addTagByName", {
    subscriber_id: subscriberId,
    tag_name:      tagName,
  });
}

async function manychatSetField(subscriberId: string, fieldName: string, fieldValue: unknown): Promise<void> {
  return manychatPost("/subscriber/setCustomFieldByName", {
    subscriber_id: subscriberId,
    field_name:    fieldName,
    field_value:   fieldValue,
  });
}

async function manychatPost(path: string, body: Record<string, unknown>): Promise<void> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) return;
  await fetch(`${MANYCHAT_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

// Mirror of api/checkout/webhook.js#logPurchase, ported to fetch.
// Retries on a transient "Lock timeout" from the single Apps Script
// ScriptLock. Two important details about the failure mode (confirmed
// 2026-05-30 from the _errors tab): (1) the lock-timeout is a FAST ~15s
// waitLock failure, not a 60s hang, so the next attempt (once the
// lock drains) usually succeeds; (2) Apps Script
// returns that error as HTTP 200 with an `ok:false` / "Lock timeout"
// body, so checking only r.ok silently treats a drop as success — we
// must inspect the body. An unreadable body (e.g. the Drive redirect
// page) is treated as delivered, matching the prior behaviour. No
// explicit backoff between attempts: each retry's own fetch hits the
// Apps Script waitLock(15s), which naturally spaces the attempts while
// the lock drains (and avoids depending on setTimeout in the Convex
// default runtime).
async function postToAppsScript(payload: Record<string, unknown>, retries = 2): Promise<void> {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(45_000),
      });
      if (!r.ok) { lastErr = new Error(`Apps Script HTTP ${r.status}`); continue; }
      const text = await r.text().catch(() => "");
      if (/lock timeout|exklusivbearbeitung|timed out|"ok"\s*:\s*false/i.test(text)) {
        lastErr = new Error("Apps Script lock timeout"); continue;
      }
      return; // ok:true, or an unreadable body we treat as delivered
    } catch (err) {
      lastErr = err; // fetch abort / network error — retry
    }
  }
  throw lastErr ?? new Error("Apps Script write failed after retries");
}

// Affiliate "you earned X" email. Template is duplicated from
// api/checkout/webhook.js#affiliateEarnedHtml — kept inline so the Convex
// action has no cross-runtime imports. If the template ever needs a
// content change, update BOTH places (or move template to a shared
// .html file that both runtimes read at build time).
function formatAmount(amountCents: number, currency: string): string {
  return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function affiliateEarnedHtml({ firstName, buyerIg, amountFormatted, dashboardUrl }: {
  firstName?: string; buyerIg: string | null; amountFormatted: string; dashboardUrl: string;
}): string {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  const buyerLine = buyerIg
    ? `<a href="https://instagram.com/${buyerIg}" style="color:#0071e3;text-decoration:none;">@${buyerIg}</a> just bought Swiss Gems through your link.`
    : `Someone just bought Swiss Gems through your link.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>You earned ${amountFormatted}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" style="max-width:480px;background:#ffffff;border-radius:20px;">
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">${buyerLine} You earned ${amountFormatted}.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;"><tr>
            <td style="border-radius:999px;background:#1d1d1f;">
              <a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Open your dashboard</a>
            </td>
          </tr></table>
          <p style="margin:24px 0 0;font-size:16px;">Leon</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function affiliateEarnedText({ firstName, buyerIg, amountFormatted, dashboardUrl }: {
  firstName?: string; buyerIg: string | null; amountFormatted: string; dashboardUrl: string;
}): string {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  const buyerLine = buyerIg
    ? `@${buyerIg} just bought Swiss Gems through your link.`
    : `Someone just bought Swiss Gems through your link.`;
  return `${greeting}\n\n${buyerLine} You earned ${amountFormatted}.\n\nOpen your dashboard:\n${dashboardUrl}\n\nLeon\n`;
}

async function sendAffiliateEarnedEmail({ to, firstName, buyerIg, amountCents, currency, eventId }: {
  to: string;
  firstName?: string;
  buyerIg: string | null;
  amountCents: number;
  currency: string;
  eventId: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[sendAffiliateEarnedEmail] RESEND_API_KEY not set — skipping");
    return;
  }
  const amountFormatted = formatAmount(amountCents, currency);
  const dashboardUrl = `${SITE}/full/affiliate/`;
  const tplArgs = { firstName, buyerIg, amountFormatted, dashboardUrl };

  const r = await fetch(RESEND_API, {
    method:  "POST",
    headers: {
      "Content-Type":     "application/json",
      "Authorization":    `Bearer ${key}`,
      // Idempotency-Key dedupes within Resend's 24h window. Use the
      // Stripe event id + _affiliate suffix so a redelivered webhook
      // (which would re-call this action) doesn't double-email.
      "Idempotency-Key":  `${eventId}_affiliate`,
    },
    body: JSON.stringify({
      from:      FROM,
      to:        [to],
      reply_to:  REPLY_TO,
      subject:   `You earned ${amountFormatted} on Hikebeast`,
      html:      affiliateEarnedHtml(tplArgs),
      text:      affiliateEarnedText(tplArgs),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Resend HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
}
