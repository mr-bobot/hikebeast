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
import { userFromSession } from "./auth";

const COMMISSION_BASIS_POINTS = 5000;  // 50.00%

// Webhook → Convex: write a referral row when a paid checkout arrives with
// a `?r=` slug stamped into Stripe metadata. Idempotent on stripeSessionId
// (Stripe redelivers webhooks on transient errors). The slug is stored
// lowercased so the account page query can match it against
// users.username (which is also lowercased).
export const recordPurchase = mutation({
  args: {
    refSlug:               v.string(),
    stripeSessionId:       v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    buyerEmail:            v.optional(v.string()),
    buyerIg:               v.optional(v.string()),
    purchaseAmountCents:   v.number(),
    currency:              v.string(),
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

    const commissionCents = Math.floor(args.purchaseAmountCents * COMMISSION_BASIS_POINTS / 10_000);
    const referralId = await ctx.db.insert("referrals", {
      refSlug:               slug,
      stripeSessionId:       args.stripeSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId || undefined,
      buyerEmail:            args.buyerEmail ? args.buyerEmail.trim().toLowerCase() : undefined,
      buyerIg:               args.buyerIg ? args.buyerIg.replace(/^@+/, "").trim().toLowerCase() || undefined : undefined,
      purchaseAmountCents:   args.purchaseAmountCents,
      currency:              args.currency.toLowerCase(),
      commissionCents,
      status:                "pending",
      createdAt:             Date.now(),
    });

    // Match the slug to an actual influencer (isAffiliate=true). The
    // webhook reads this back to send the "you earned X" email. Returns
    // null when:
    //   - the slug doesn't match any user (orphan ref, reconcile later)
    //   - the matched user isn't an influencer (someone trying to use
    //     a paying customer's username as a ref slug)
    //   - the influencer hasn't set an email yet (they need to add one
    //     in /full/account/ to receive notifications)
    const affiliateUser = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", slug))
      .unique();
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
    await ctx.db.patch(row._id, { status: "voided" });
    return { ok: true as const, alreadyVoided: false };
  },
});

// Account page query: every referral whose refSlug matches the signed-in
// user's username. Sorted newest-first. Returns aggregate totals so the
// page can render headline numbers without a second round trip.
//
// Eligibility gate: only users with isAffiliate=true get data back.
// We return a discriminated shape so the UI can paint a dedicated
// "not eligible" state without ambiguity (vs. returning null which is
// also used for "not signed in").
export const listForCurrentUser = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const user = await userFromSession(ctx, sessionToken);
    if (!user) return null;
    if (!user.isAffiliate) {
      return { eligible: false as const, username: user.username };
    }
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
