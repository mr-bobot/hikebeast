// referrals.ts — affiliate referral records.
//
// Trust model:
//   - `recordPurchase` / `voidByPaymentIntent` are called by
//     api/checkout/webhook.js after Stripe signature verification, so the
//     mutations themselves are unauthenticated (same pattern as
//     auth:createPaidUser). Anyone hitting Convex directly could spam
//     referral rows, but Leon reconciles payouts against Stripe monthly,
//     so a row without a matching Stripe session never gets paid out.
//   - `listForCurrentUser` is a session-gated query so only the signed-in
//     user sees their own referrals (matched by username == refSlug).
//
// Data shape:
//   - Referrals are keyed by Stripe session id, not by buyer email or user
//     id. A buyer never has to be a Hikebeast user for the referral to
//     count; the *affiliate* is the one who needs a username.
//   - Commission is 50% of gross at write time (no after-the-fact
//     repricing). If the rate ever changes, set it on new rows only —
//     existing rows keep their original commission.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userFromSession, requireAdmin } from "./auth";

const COMMISSION_BASIS_POINTS = 5000;  // 50.00%

// Default product key for the affiliate program. Hikebeast has exactly
// one product today (the Hidden Gems guide), but every referral row
// carries `productKey` so the "one commission per buyer-product pair"
// rule scales cleanly when a second product (Full Guide, etc.) ships.
const DEFAULT_PRODUCT_KEY = "hidden_gems";

// Webhook → Convex: write a referral row when a paid checkout arrives with
// a `?r=` slug stamped into Stripe metadata. Idempotent on stripeSessionId
// (Stripe redelivers webhooks on transient errors). The slug is stored
// lowercased so the account page query can match it against
// users.username (which is also lowercased).
//
// Guards (added 2026-05-27 with the "everyone is an affiliate" rollout):
//   - self-referral: if the affiliate's email matches the buyer's email,
//     no row is written. Without this, a buyer with their own affiliate
//     link could click it from a different device, buy, and pay themselves
//     50% — i.e. a 50% discount via self-attribution.
//   - duplicate buyer-product: if the same buyer email already has a
//     non-voided referral for the same product, no new row is written.
//     Prevents a single buyer from triggering repeated commissions for
//     one affiliate via repurchases, and prevents two different affiliates
//     from both earning on the same buyer's first purchase of a product.
export const recordPurchase = mutation({
  args: {
    refSlug:               v.string(),
    stripeSessionId:       v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    buyerEmail:            v.optional(v.string()),
    buyerIg:               v.optional(v.string()),
    purchaseAmountCents:   v.number(),
    currency:              v.string(),
    // Optional · defaults to "hidden_gems" since that's the only product
    // shipped from /map9/ today. Forward a different key from the webhook
    // when a second product launches; recordPurchase doesn't validate
    // against an enum so the webhook stays the source of truth on what's
    // a real product.
    productKey:            v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const slug = args.refSlug.trim().toLowerCase();
    if (!slug) return { ok: false as const, reason: "empty_slug" };
    if (!args.stripeSessionId.startsWith("cs_")) {
      return { ok: false as const, reason: "bad_session_id" };
    }
    if (!Number.isFinite(args.purchaseAmountCents) || args.purchaseAmountCents <= 0) {
      return { ok: false as const, reason: "bad_amount" };
    }

    // Idempotent: Stripe webhook may redeliver the same session.
    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_stripeSession", q => q.eq("stripeSessionId", args.stripeSessionId))
      .unique();
    if (existing) {
      return { ok: true as const, referralId: existing._id, deduped: true };
    }

    const normalizedBuyerEmail = args.buyerEmail
      ? args.buyerEmail.trim().toLowerCase()
      : undefined;
    const productKey = (args.productKey && args.productKey.trim())
      ? args.productKey.trim().toLowerCase()
      : DEFAULT_PRODUCT_KEY;

    // Match the slug to an actual user. The lookup happens BEFORE insert
    // so the self-referral guard can compare emails and bail without
    // writing a row. The webhook reads `notify` back from the success
    // path to send the "you earned X" email.
    const affiliateUser = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", slug))
      .unique();

    // Self-referral guard: bail if the affiliate's stored email matches
    // the buyer's email (case-insensitive). Requires both sides to have
    // an email on file; if either is missing we can't validate and we
    // let the row through (orphan-by-design, Leon reconciles monthly).
    if (
      affiliateUser
      && affiliateUser.email
      && normalizedBuyerEmail
      && affiliateUser.email.toLowerCase() === normalizedBuyerEmail
    ) {
      return { ok: false as const, reason: "self_referral" };
    }

    // Duplicate buyer-product guard: only runs when we have a buyer
    // email to look up. The index includes `productKey` so a future
    // second product naturally gets its own commission line per buyer.
    // We filter out voided rows so a previously-refunded sale doesn't
    // permanently lock a buyer out of being a fresh referral.
    if (normalizedBuyerEmail) {
      const dupe = await ctx.db
        .query("referrals")
        .withIndex("by_buyerEmail_product", q =>
          q.eq("buyerEmail", normalizedBuyerEmail).eq("productKey", productKey)
        )
        .filter(q => q.neq(q.field("status"), "voided"))
        .first();
      if (dupe) {
        return { ok: false as const, reason: "duplicate_buyer_product" };
      }
    }

    const commissionCents = Math.floor(args.purchaseAmountCents * COMMISSION_BASIS_POINTS / 10_000);
    const referralId = await ctx.db.insert("referrals", {
      refSlug:               slug,
      stripeSessionId:       args.stripeSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId || undefined,
      buyerEmail:            normalizedBuyerEmail,
      buyerIg:               args.buyerIg ? args.buyerIg.replace(/^@+/, "").trim().toLowerCase() || undefined : undefined,
      purchaseAmountCents:   args.purchaseAmountCents,
      currency:              args.currency.toLowerCase(),
      commissionCents,
      status:                "pending",
      productKey,
      createdAt:             Date.now(),
    });

    // Notify rules (unchanged):
    //   - slug doesn't match any user → null (orphan ref, reconcile later)
    //   - user matched but isAffiliate=false → null (someone trying to
    //     use a non-affiliate's username as a ref slug)
    //   - user matched but no email on file → null (they need to add
    //     one in /full/account/ to receive notifications)
    // After 2026-05-27 every paid buyer has isAffiliate=true by default,
    // so the second branch is mostly redundant but stays as a safety net.
    const notify = (affiliateUser && affiliateUser.isAffiliate && affiliateUser.email)
      ? {
          email:     affiliateUser.email,
          firstName: affiliateUser.handle ?? affiliateUser.username,
        }
      : null;

    return { ok: true as const, referralId, deduped: false, notify };
  },
});

// Webhook → Convex: flip referral to `voided` when the underlying charge
// is refunded. We look up by paymentIntent because that's what the
// `charge.refunded` event carries; the session id is only on the
// completed event.
//
// `voidedAt` is captured so the monthly payout cron can distinguish:
//   - pre-payout voids (most refunds; paidAt undefined → no clawback)
//   - post-payout voids (paidAt set, voidedAt > lastPayout → clawback
//     against the next month's balance)
export const voidByPaymentIntent = mutation({
  args: {
    stripePaymentIntentId: v.string(),
  },
  handler: async (ctx, { stripePaymentIntentId }) => {
    const row = await ctx.db
      .query("referrals")
      .withIndex("by_paymentIntent", q => q.eq("stripePaymentIntentId", stripePaymentIntentId))
      .unique();
    if (!row) return { ok: false as const, reason: "not_found" };
    if (row.status === "voided") return { ok: true as const, alreadyVoided: true };
    await ctx.db.patch(row._id, { status: "voided", voidedAt: Date.now() });
    return { ok: true as const, alreadyVoided: false };
  },
});

// One-shot backfill: set productKey="hidden_gems" on every existing
// referral row that's missing it. Pairs with the 2026-05-27 schema
// addition of `productKey` + `by_buyerEmail_product` index. Without
// this, the duplicate-buyer guard in recordPurchase would miss pre-
// migration rows (their productKey is undefined and the index query
// filters on a specific value).
//
// Idempotent: re-running only patches rows still missing the field.
// Run staging then prod, same as adminBackfillAllUsersAffiliate.
export const adminBackfillProductKey = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, { adminToken }) => {
    await requireAdmin(adminToken);
    const rows = await ctx.db.query("referrals").collect();
    let touched = 0;
    for (const r of rows) {
      if (!r.productKey) {
        await ctx.db.patch(r._id, { productKey: DEFAULT_PRODUCT_KEY });
        touched++;
      }
    }
    return { totalRows: rows.length, touched };
  },
});

// Account page query: every referral whose refSlug matches the signed-in
// user's username. Sorted newest-first. Returns aggregate totals so the
// page can render headline numbers without a second round trip.
//
// 2026-05-27 · eligibility gate dropped (was: only isAffiliate=true users
// got data back). Every signed-in /full/ user is now an affiliate by
// default, so the gate is a no-op; removed to simplify the contract.
// Field `eligible: true` stays in the return shape for backward compat
// with older client builds in the wild.
export const listForCurrentUser = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const user = await userFromSession(ctx, sessionToken);
    if (!user) return null;
    const rows = await ctx.db
      .query("referrals")
      .withIndex("by_refSlug", q => q.eq("refSlug", user.username))
      .order("desc")
      .collect();

    // Per-currency totals. Different buyers can pay in CHF / EUR / USD,
    // so we don't sum across currencies — the UI shows one line per
    // currency under each status.
    const totals: Record<string, { pending: number; paid: number; voided: number }> = {};
    for (const r of rows) {
      const cur = r.currency || "chf";
      if (!totals[cur]) totals[cur] = { pending: 0, paid: 0, voided: 0 };
      totals[cur][r.status] += r.commissionCents;
    }

    return {
      eligible: true as const,
      username: user.username,
      commissionRate: COMMISSION_BASIS_POINTS / 10_000,   // 0.5
      referrals: rows.map(r => ({
        _id:                 r._id,
        createdAt:           r.createdAt,
        status:              r.status,
        currency:            r.currency,
        purchaseAmountCents: r.purchaseAmountCents,
        commissionCents:     r.commissionCents,
        buyerEmail:          r.buyerEmail ?? null,
        buyerIg:             r.buyerIg ?? null,
        paidAt:              r.paidAt ?? null,
        payoutNote:          r.payoutNote ?? null,
      })),
      totals,
    };
  },
});
