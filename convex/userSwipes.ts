// userSwipes.ts -- per-user swipe history (save / no decisions).
//
// Mirrors the localStorage shape today: hb:fav:v1 carried "save" decisions
// (those become rows in `favorites`) and hb:skipped:v1 carried "no" decisions.
// Server-side we keep BOTH in `swipeDecisions` so the swipe deck can rebuild
// the queue exactly: spots without a row are still candidates; spots with
// any decision are skipped.
//
// On a "save" swipe the client calls record() AND userFavorites.setFavorite()
// so the heart appears everywhere. On a "no" swipe only record() is called.
//
// Reads gated by sessionToken; anonymous users keep using localStorage.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./auth";

const DECISION_VALIDATOR = v.union(v.literal("save"), v.literal("no"));

export const list = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    if (!sessionToken) {
      return {
        decisions: [] as { spotKey: string; decision: "save" | "no"; decidedAt: number }[],
        signedIn:  false as const,
      };
    }
    const user = await requireUser(ctx, sessionToken);
    const rows = await ctx.db
      .query("swipeDecisions")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    rows.sort((a, b) => b.decidedAt - a.decidedAt);
    return {
      decisions: rows.map(r => ({
        spotKey:   r.spotKey,
        decision:  r.decision,
        decidedAt: r.decidedAt,
      })),
      signedIn: true as const,
    };
  },
});

// Upsert by (userId, spotKey). A second decision on the same spot replaces
// the first (e.g. user swiped "no" earlier, now hits "save" via the heart).
export const record = mutation({
  args: {
    sessionToken: v.string(),
    spotKey:      v.string(),
    decision:     DECISION_VALIDATOR,
  },
  handler: async (ctx, { sessionToken, spotKey, decision }) => {
    const user = await requireUser(ctx, sessionToken);
    const existing = await ctx.db
      .query("swipeDecisions")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    const now = Date.now();
    if (existing) {
      if (existing.decision === decision) return { state: "unchanged" as const };
      await ctx.db.patch(existing._id, { decision, decidedAt: now });
      return { state: "updated" as const };
    }
    await ctx.db.insert("swipeDecisions", {
      userId:    user._id,
      spotKey,
      decision,
      decidedAt: now,
    });
    return { state: "created" as const };
  },
});

// Remove a decision (e.g. user un-swipes a "no" so the spot re-enters the deck).
export const undo = mutation({
  args: {
    sessionToken: v.string(),
    spotKey:      v.string(),
  },
  handler: async (ctx, { sessionToken, spotKey }) => {
    const user = await requireUser(ctx, sessionToken);
    const existing = await ctx.db
      .query("swipeDecisions")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    if (!existing) return { state: "noop" as const };
    await ctx.db.delete(existing._id);
    return { state: "removed" as const };
  },
});

// localStorage migration on first sign-in. Idempotent: pre-existing rows
// win (the user's current device state is the truth, in case they were
// already partially synced from another device).
export const bulkAdd = mutation({
  args: {
    sessionToken: v.string(),
    decisions: v.array(v.object({
      spotKey:  v.string(),
      decision: DECISION_VALIDATOR,
    })),
  },
  handler: async (ctx, { sessionToken, decisions }) => {
    const user = await requireUser(ctx, sessionToken);
    if (decisions.length === 0) return { added: 0, skipped: 0 };
    const existing = await ctx.db
      .query("swipeDecisions")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    const have = new Set(existing.map(r => r.spotKey));
    const now = Date.now();
    let added = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const d of decisions) {
      if (!d.spotKey || seen.has(d.spotKey)) { skipped++; continue; }
      seen.add(d.spotKey);
      if (have.has(d.spotKey)) { skipped++; continue; }
      await ctx.db.insert("swipeDecisions", {
        userId:    user._id,
        spotKey:   d.spotKey,
        decision:  d.decision,
        decidedAt: now,
      });
      added++;
    }
    return { added, skipped };
  },
});

export const clearAll = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireUser(ctx, sessionToken);
    const rows = await ctx.db
      .query("swipeDecisions")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});
