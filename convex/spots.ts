// spots.ts -- one row per catalogued spot.
//
// Each row holds the spot's queryable metadata (title, lat/lon, kicker,
// region, etc.) plus its photo array. Index 0 is the primary photo;
// additional photos get appended when admin approves a submission.
//
// Reads are public; the /full/* webapp gates access via Vercel middleware.
// Writes are gated by `ADMIN_TOKEN` until phase 2 (real per-user auth)
// lands. Same constant-time-compare pattern as `galleries.ts`.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// --- Admin gate ----------------------------------------------------------

const enc = new TextEncoder();
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
async function constantTimeEq(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
async function requireAdmin(provided: string): Promise<void> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw new Error("ADMIN_TOKEN not configured on this deployment");
  if (!provided || !(await constantTimeEq(provided, expected))) {
    throw new Error("Unauthorized");
  }
}

// --- Validators (mirror schema.ts) --------------------------------------

const photoArg = v.object({
  photoId:    v.optional(v.string()),
  staticPath: v.optional(v.string()),
  storageId:  v.optional(v.id("_storage")),
  credit:     v.optional(v.string()),
  caption:    v.optional(v.string()),
  sourceUrl:  v.optional(v.string()),
  width:      v.optional(v.number()),
  height:     v.optional(v.number()),
  order:      v.optional(v.number()),
  addedAt:    v.optional(v.number()),
});

const spotArg = v.object({
  spotKey:   v.string(),
  title:     v.string(),
  kicker:    v.optional(v.string()),
  chapter:   v.string(),
  chapterId: v.string(),
  lat:       v.optional(v.number()),
  lon:       v.optional(v.number()),
  color:     v.string(),
  mapsUrl:   v.optional(v.string()),
  href:      v.string(),
  photos:    v.array(photoArg),
  deck:      v.optional(v.string()),
  body:      v.optional(v.array(v.string())),
  specs:     v.optional(v.array(v.object({
    label: v.string(),
    value: v.string(),
  }))),
  kind:      v.optional(v.union(
               v.literal("spot"),
               v.literal("extras_entry"),
             )),
  origin:    v.optional(v.string()),
  properties: v.optional(v.array(v.string())),
  wildCamping: v.optional(v.object({
    verdict: v.union(
      v.literal("tolerated"),
      v.literal("restricted"),
      v.literal("discouraged"),
      v.literal("forbidden"),
      v.literal("unknown"),
    ),
    reason:      v.optional(v.string()),
    canton:      v.optional(v.string()),
    protections: v.optional(v.array(v.string())),
  })),
});

// --- Reads ---------------------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("spots").collect(),
});

export const bySpotKey = query({
  args: { spotKey: v.string() },
  handler: async (ctx, { spotKey }) =>
    await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spotKey))
      .unique(),
});

export const byChapter = query({
  args: { chapterId: v.string() },
  handler: async (ctx, { chapterId }) =>
    await ctx.db
      .query("spots")
      .withIndex("by_chapterId", q => q.eq("chapterId", chapterId))
      .collect(),
});

// --- Writes (admin-gated) -----------------------------------------------

// Insert or update a whole spot row, including its photos. Used by the
// migration script and any future admin "edit spot" path. Idempotent.
export const upsertSpot = mutation({
  args: { spot: spotArg, adminToken: v.string() },
  handler: async (ctx, { spot, adminToken }) => {
    await requireAdmin(adminToken);
    const now = Date.now();
    const photos = spot.photos.map((p, i) => ({
      photoId:    p.photoId,
      staticPath: p.staticPath,
      storageId:  p.storageId,
      credit:     p.credit,
      caption:    p.caption,
      sourceUrl:  p.sourceUrl,
      width:      p.width,
      height:     p.height,
      order:      p.order ?? i,
      addedAt:    p.addedAt ?? now,
    }));

    const existing = await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spot.spotKey))
      .unique();

    const row = {
      spotKey:   spot.spotKey,
      title:     spot.title,
      kicker:    spot.kicker,
      chapter:   spot.chapter,
      chapterId: spot.chapterId,
      lat:       spot.lat,
      lon:       spot.lon,
      color:     spot.color,
      mapsUrl:   spot.mapsUrl,
      href:      spot.href,
      photos,
      deck:      spot.deck,
      body:      spot.body,
      specs:     spot.specs,
      kind:      spot.kind,
      origin:    spot.origin,
      properties:  spot.properties,
      wildCamping: spot.wildCamping,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, row);
      return { id: existing._id, action: "updated" as const };
    }
    const id = await ctx.db.insert("spots", row);
    return { id, action: "created" as const };
  },
});

// Append one photo to a spot's photos array. The spot must exist (the
// migration seeds every catalogued spot up front, so this should always be
// true once we've migrated).
export const appendPhoto = mutation({
  args: {
    spotKey:    v.string(),
    photo:      photoArg,
    adminToken: v.string(),
  },
  handler: async (ctx, { spotKey, photo, adminToken }) => {
    await requireAdmin(adminToken);
    const row = await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spotKey))
      .unique();
    if (!row) throw new Error(`No spot for ${spotKey} -- run the migration first`);

    const now = Date.now();
    const newPhoto = {
      photoId:    photo.photoId,
      staticPath: photo.staticPath,
      storageId:  photo.storageId,
      credit:     photo.credit,
      caption:    photo.caption,
      sourceUrl:  photo.sourceUrl,
      width:      photo.width,
      height:     photo.height,
      order:      row.photos.length,
      addedAt:    photo.addedAt ?? now,
    };
    await ctx.db.patch(row._id, {
      photos: [...row.photos, newPhoto],
      updatedAt: now,
    });
    return { id: row._id, photoIndex: row.photos.length };
  },
});

export const removePhoto = mutation({
  args: {
    spotKey:    v.string(),
    photoIndex: v.number(),
    adminToken: v.string(),
  },
  handler: async (ctx, { spotKey, photoIndex, adminToken }) => {
    await requireAdmin(adminToken);
    const row = await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spotKey))
      .unique();
    if (!row) throw new Error(`No spot for ${spotKey}`);
    if (photoIndex < 0 || photoIndex >= row.photos.length) {
      throw new Error(`photoIndex ${photoIndex} out of range`);
    }
    const next = row.photos.filter((_, i) => i !== photoIndex)
      .map((p, i) => ({ ...p, order: i }));
    await ctx.db.patch(row._id, { photos: next, updatedAt: Date.now() });
    return { action: "patched" as const, photosLeft: next.length };
  },
});

export const reorderPhotos = mutation({
  args: {
    spotKey:    v.string(),
    order:      v.array(v.number()),
    adminToken: v.string(),
  },
  handler: async (ctx, { spotKey, order, adminToken }) => {
    await requireAdmin(adminToken);
    const row = await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spotKey))
      .unique();
    if (!row) throw new Error(`No spot for ${spotKey}`);
    if (order.length !== row.photos.length) {
      throw new Error(`order length ${order.length} != photos length ${row.photos.length}`);
    }
    const seen = new Set(order);
    if (seen.size !== order.length || [...seen].some(i => i < 0 || i >= row.photos.length)) {
      throw new Error("order must be a permutation of [0..length-1]");
    }
    const next = order.map((oldIdx, newIdx) => ({ ...row.photos[oldIdx], order: newIdx }));
    await ctx.db.patch(row._id, { photos: next, updatedAt: Date.now() });
    return { action: "reordered" as const };
  },
});

// Targeted delete by spotKey. Used for one-shot cleanup of duplicate rows
// when an orphan import lands at a different slug than the extras_entry
// placeholder that already covered the same location.
export const deleteBySpotKey = mutation({
  args: { spotKey: v.string(), adminToken: v.string() },
  handler: async (ctx, { spotKey, adminToken }) => {
    await requireAdmin(adminToken);
    const row = await ctx.db
      .query("spots")
      .withIndex("by_spotKey", q => q.eq("spotKey", spotKey))
      .unique();
    if (!row) return { action: "noop" as const };
    await ctx.db.delete(row._id);
    return { action: "deleted" as const, spotKey };
  },
});

// One-shot cleanup: drops every row from the deprecated `galleries` table
// once spots is the source of truth. Idempotent.
export const dropDeprecatedGalleries = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, { adminToken }) => {
    await requireAdmin(adminToken);
    const rows = await ctx.db.query("galleries").collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});
