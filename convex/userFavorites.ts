// userFavorites.ts -- per-user saved-spot list, server-synced.
//
// Reactive: list() is the canonical source of truth for the frontend's
// HB.favorites façade. When toggle/bulkAdd/clear mutate, every subscribed
// page re-renders without explicit refetch.
//
// Anonymous users never call into this file -- the frontend keeps their
// favorites in localStorage and migrates them in via bulkAdd on first sign-in.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./auth";

// Hard cap to keep a runaway client from filling the table. 500 is more
// than the entire catalog (112 spots today, ~150 long-term).
const MAX_FAVORITES = 500;

export const list = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    if (!sessionToken) return { spotKeys: [] as string[], signedIn: false as const };
    const user = await requireUser(ctx, sessionToken);
    const rows = await ctx.db
      .query("favorites")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    rows.sort((a, b) => b.addedAt - a.addedAt);
    return {
      spotKeys: rows.map(r => r.spotKey),
      signedIn: true as const,
    };
  },
});

export const toggle = mutation({
  args: {
    sessionToken: v.string(),
    spotKey:      v.string(),
  },
  handler: async (ctx, { sessionToken, spotKey }) => {
    const user = await requireUser(ctx, sessionToken);
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { added: false as const, spotKey };
    }
    const count = (await ctx.db
      .query("favorites")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect()).length;
    if (count >= MAX_FAVORITES) {
      throw new Error(`Favorites limit reached (${MAX_FAVORITES})`);
    }
    await ctx.db.insert("favorites", {
      userId:  user._id,
      spotKey,
      addedAt: Date.now(),
    });
    return { added: true as const, spotKey };
  },
});

// Explicit add / remove for cases where the client knows the desired state
// (e.g. swipe deck "save" forces add even if already present).
export const setFavorite = mutation({
  args: {
    sessionToken: v.string(),
    spotKey:      v.string(),
    on:           v.boolean(),
  },
  handler: async (ctx, { sessionToken, spotKey, on }) => {
    const user = await requireUser(ctx, sessionToken);
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    if (on && !existing) {
      await ctx.db.insert("favorites", {
        userId:  user._id,
        spotKey,
        addedAt: Date.now(),
      });
      return { state: "added" as const };
    }
    if (!on && existing) {
      await ctx.db.delete(existing._id);
      return { state: "removed" as const };
    }
    return { state: "unchanged" as const };
  },
});

// One-shot localStorage-to-Convex migration on first sign-in. Idempotent:
// existing favorites for this user are kept; duplicates are ignored.
export const bulkAdd = mutation({
  args: {
    sessionToken: v.string(),
    spotKeys:     v.array(v.string()),
  },
  handler: async (ctx, { sessionToken, spotKeys }) => {
    const user = await requireUser(ctx, sessionToken);
    if (spotKeys.length === 0) return { added: 0, skipped: 0 };
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    const have = new Set(existing.map(r => r.spotKey));
    const now = Date.now();
    let added = 0;
    let skipped = 0;
    // De-dupe input too in case the client uploaded a dirty list.
    const seen = new Set<string>();
    for (const key of spotKeys) {
      if (!key || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      if (have.has(key)) { skipped++; continue; }
      await ctx.db.insert("favorites", { userId: user._id, spotKey: key, addedAt: now });
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
      .query("favorites")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});
