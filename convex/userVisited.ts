// userVisited.ts -- per-user "been there" pile, server-only.
//
// Mirrors userFavorites except for one key difference: there is NO
// localStorage fallback or anonymous flow. The "Been there" feature is
// gated behind a paid account; if no session token is attached, list()
// returns signedIn: false and the frontend hides the kebab item, the
// menu sheet row, and redirects /full/visited/ to sign-in.
//
// Reactive: list() is the canonical source of truth for the frontend's
// HB.visited façade. When toggle/setVisited mutate, every subscribed
// page re-renders without explicit refetch.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./auth";

// Same hard cap as favorites — far above the catalog size, but cheap
// insurance against a runaway client.
const MAX_VISITED = 500;

export const list = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    if (!sessionToken) return { spotKeys: [] as string[], signedIn: false as const };
    const user = await requireUser(ctx, sessionToken);
    const rows = await ctx.db
      .query("visited")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    rows.sort((a, b) => b.visitedAt - a.visitedAt);
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
      .query("visited")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { added: false as const, spotKey };
    }
    const count = (await ctx.db
      .query("visited")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect()).length;
    if (count >= MAX_VISITED) {
      throw new Error(`Visited limit reached (${MAX_VISITED})`);
    }
    await ctx.db.insert("visited", {
      userId:    user._id,
      spotKey,
      visitedAt: Date.now(),
    });
    return { added: true as const, spotKey };
  },
});

// Explicit add / remove for cases where the client knows the desired state.
export const setVisited = mutation({
  args: {
    sessionToken: v.string(),
    spotKey:      v.string(),
    on:           v.boolean(),
  },
  handler: async (ctx, { sessionToken, spotKey, on }) => {
    const user = await requireUser(ctx, sessionToken);
    const existing = await ctx.db
      .query("visited")
      .withIndex("by_user_spot", q => q.eq("userId", user._id).eq("spotKey", spotKey))
      .unique();
    if (on && !existing) {
      await ctx.db.insert("visited", {
        userId:    user._id,
        spotKey,
        visitedAt: Date.now(),
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

export const clearAll = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireUser(ctx, sessionToken);
    const rows = await ctx.db
      .query("visited")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});
