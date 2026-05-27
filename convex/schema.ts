// Hikebeast webapp data model.
//
// Phase 1 (live tomorrow / today): galleries — multi-image-per-spot data
// migrated from full/img/spot-images.js. The frontend reads these
// reactively so admin edits show up in the carousel without a reload.
//
// Phases 2-4 are scaffolded so we don't have to reshape the schema later:
//   2. users + authTokens  → magic-link login via Resend
//   3. photoSubmissions    → Submit Photo flow lands rows here for review
//   4. favorites + swipeDecisions → per-user state, syncs across devices
//
// The frontend doesn't query any of those phase-2-4 tables today, but the
// indexes and shapes are final so that wiring them up later is purely
// additive.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// One photo inside a spot's gallery. Exactly one of `photoId` /
// `staticPath` / `storageId` is set:
//   photoId    -> derivative ladder under /full/img/derivatives/<photoId>/wXXX.webp
//                 (current source of truth; built by scripts/build-image-derivatives.mjs)
//   staticPath -> legacy single-tier file at /full/img/<file>.jpg (pre-derivative spots)
//   storageId  -> Convex Storage blob (Submit-Photo flow, not yet wired)
// The frontend renderer prefers photoId, then staticPath, then storageId.
const photoEntry = v.object({
  photoId:    v.optional(v.string()),  // e.g. "central_fulberg_p0" — slug under derivatives/
  staticPath: v.optional(v.string()),
  storageId:  v.optional(v.id("_storage")),
  credit:     v.optional(v.string()),  // e.g. "@leon.helg"
  caption:    v.optional(v.string()),
  sourceUrl:  v.optional(v.string()),  // Unsplash photo URL or IG post URL
  width:      v.optional(v.number()),  // intrinsic dims of the original
  height:     v.optional(v.number()),
  order:      v.number(),              // primary photo = 0, then 1, 2, ...
  addedAt:    v.number(),              // ms epoch
});

export default defineSchema({
  // ── Spots (catalog + photos in one row) ────────────────────────────────
  // One row per spot in the guide. Photos array always has >=1 entry (the
  // primary, from the chapter HTML / spots-data.js); extras get appended
  // when admin publishes a submission. The chapter pages stay as the
  // editorial layer (deck, body, specs); everything queryable lives here.
  spots: defineTable({
    spotKey:    v.string(),     // "<chapter_id>#<anchor>", e.g. "central#fulberg"
    title:      v.string(),
    kicker:     v.optional(v.string()),  // raw, singularised at render time
    chapter:    v.string(),     // legend number "01".."07"
    chapterId:  v.string(),     // url segment "central".."beyond"
    // GPS optional: 17 spots from content.yaml have no coords yet (Ice Cave,
    // Mont Blanc, etc). Map view filters out spots without lat/lon.
    lat:        v.optional(v.number()),
    lon:        v.optional(v.number()),
    color:      v.string(),     // RGB triplet "175,165,122" used by map tinting
    mapsUrl:    v.optional(v.string()),
    href:       v.string(),     // chapter-page anchor (relative to /full/map/)
    photos:     v.array(photoEntry),
    // Editorial content. Optional so spots without text (e.g. brand-new
    // submissions) can still exist as rows. Body is paragraph-by-paragraph
    // so the renderer can inject <p> tags + the migration round-trips
    // cleanly. Specs are an ordered list of label/value pairs (Region,
    // Access, Effort, Best light) -- order matters for the rendered grid.
    deck:       v.optional(v.string()),
    body:       v.optional(v.array(v.string())),
    specs:      v.optional(v.array(v.object({
      label: v.string(),
      value: v.string(),
    }))),
    // Origin marker. "spot" is the default and matches everything currently
    // in the DB (left undefined for those rows). "extras_entry" tags rows
    // exploded out of content.yaml's `kind: extras` wrappers so the future
    // PDF builder can re-group them. `origin` then points at the parent
    // wrapper id (e.g. "central_extras") for round-tripping.
    kind:       v.optional(v.union(
                  v.literal("spot"),
                  v.literal("extras_entry"),
                )),
    origin:     v.optional(v.string()),
    // Multi-select tags (e.g. ["Waterfall","Lake"]) for the future
    // browse-page filter chips. Empty / missing == not yet categorised.
    properties: v.optional(v.array(v.string())),
    // Wild-camping verdict, inlined per spot in content.yaml. Verdict legend:
    //   tolerated   - SAC bivouac OK above tree line, outside protected
    //   restricted  - above tree line but in BLN/park/UNESCO/biosphere
    //   discouraged - below tree line / private / not a SAC site
    //   forbidden   - hard ban (federal reserve, fen, named cantonal ban)
    //   unknown     - data lookup failed or outside Switzerland
    wildCamping: v.optional(v.object({
      verdict: v.union(
        v.literal("tolerated"),
        v.literal("restricted"),
        v.literal("discouraged"),
        v.literal("forbidden"),
        v.literal("unknown"),
      ),
      reason: v.optional(v.string()),
      // Per-spot source attribution. canton drives which cantonal
      // authority is named in the modal's source list; protections is
      // a human-readable list of federal layers (BLN, hunting reserve,
      // park, UNESCO, etc.) that intersect this spot.
      canton:      v.optional(v.string()),
      protections: v.optional(v.array(v.string())),
      // Editorial pin for the /full/wildcamping/ collection. The page
      // filters by `verdict === "tolerated" || featured === true`, so
      // setting this surfaces a spot that has stricter legal status
      // (restricted / forbidden) but is still worth showing in the
      // curated wildcamping list — Leon's discretion.
      featured:    v.optional(v.boolean()),
      // Practical camping style for the wildcamping page sectioning:
      //   tent     - designated tent area (Stellplatz, booked bivy zone)
      //   both     - wildcamping above tree line, tent OR bivouac OK
      //   bivouac  - no tent (legal: French zones; or practical:
      //              exposed alpine ridge where pitching is silly)
      // Optional because most yaml entries pre-date the classification;
      // the page falls back to "both" when style is missing.
      style:       v.optional(v.union(
        v.literal("tent"),
        v.literal("both"),
        v.literal("bivouac"),
      )),
      // One-line pitching tip from Leon's spot-by-spot research
      // (e.g. "Pitch on the moraine, not by the road"). Renders below
      // the tile title on the wildcamping page.
      tip:         v.optional(v.string()),
    })),
    updatedAt:  v.number(),
  }).index("by_spotKey",   ["spotKey"])
    .index("by_chapterId", ["chapterId"]),

  // ── Identity ───────────────────────────────────────────────────────────
  // Username is the canonical login (required, lowercase, unique). Email
  // is optional today and will become the recovery / magic-link channel
  // later, so the index stays in place. Password is stored as a single
  // PHC-style string `pbkdf2$<iters>$<saltB64>$<hashB64>` so iteration
  // count can be bumped without a schema change.
  users: defineTable({
    username:        v.string(),                    // lowercased, unique
    email:           v.optional(v.string()),        // optional, kept for later magic-link / Stripe match
    passwordPhc:     v.string(),                    // pbkdf2$iters$salt$hash
    handle:          v.optional(v.string()),        // display name, separate from username
    // Instagram handle (lowercased, no leading @, ≤40 chars). Captured
    // on the /map9/success/ onboarding form for non-ManyChat buyers
    // (Linktree, ads, organic) so Leon's support pipeline can DM them
    // back. Also written to the Signups sheet via attach_instagram +
    // to Stripe customer metadata in the same lambda call. Added 2026-05-26.
    instagramHandle: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    whopLicenseKey:  v.optional(v.string()),        // future: Stripe / Whop license linkage
    isAdmin:         v.optional(v.boolean()),
    // Affiliate eligibility flag. Gates the /full/affiliate/ dashboard
    // and hides the teaser card on /full/account/ for non-eligible users.
    // Flipped on by adminCreateUser({ isAffiliate: true }) for influencers,
    // or after the fact by adminSetAffiliate. Default false (undefined).
    isAffiliate:     v.optional(v.boolean()),
    createdAt:       v.number(),
    lastSeenAt:      v.number(),
  }).index("by_username", ["username"])
    .index("by_email",    ["email"]),

  // Long-lived auth sessions. Raw token lives in the client's
  // localStorage; we store SHA-256 of it so a DB leak can't impersonate.
  // TTL = 90 days, refreshed on every successful currentUser read.
  sessions: defineTable({
    userId:     v.id("users"),
    tokenHash:  v.string(),
    createdAt:  v.number(),
    expiresAt:  v.number(),
    lastSeenAt: v.number(),
  }).index("by_tokenHash", ["tokenHash"])
    .index("by_user",      ["userId"]),

  // ── Magic-link recovery (password reset) ───────────────────────────────
  // Sparse storage for short-lived password-reset tokens. The plaintext
  // token lives only in the email link; we store SHA-256 of it so a DB
  // leak can't reset anyone's password. Single-use: we mark `usedAt` on
  // redemption and the redeem mutation rejects already-used links.
  // No index on the user side is needed -- the redeem path looks up by
  // tokenHash; the request path scans by user only to invalidate
  // outstanding tokens before issuing a new one.
  magicLinks: defineTable({
    userId:    v.id("users"),
    purpose:   v.union(v.literal("password_reset")),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt:    v.optional(v.number()),
  }).index("by_tokenHash", ["tokenHash"])
    .index("by_user",      ["userId"]),

  // ── Phase 3: photo submissions queue ───────────────────────────────────
  photoSubmissions: defineTable({
    spotKey:             v.string(),
    submitterUserId:     v.optional(v.id("users")),
    submitterEmail:      v.optional(v.string()),
    photographerHandle:  v.optional(v.string()),
    storageId:           v.id("_storage"),
    note:                v.optional(v.string()),
    status:              v.union(
                           v.literal("pending"),
                           v.literal("approved"),
                           v.literal("rejected"),
                         ),
    submittedAt:         v.number(),
    reviewedAt:          v.optional(v.number()),
    reviewedByUserId:    v.optional(v.id("users")),
    rejectionReason:     v.optional(v.string()),
    publishedPhotoIndex: v.optional(v.number()),  // index in galleries.photos[]
  }).index("by_status",    ["status"])
    .index("by_spot",      ["spotKey"])
    .index("by_submitter", ["submitterUserId"]),

  // ── Phase 4: per-user state ────────────────────────────────────────────
  favorites: defineTable({
    userId:  v.id("users"),
    spotKey: v.string(),
    addedAt: v.number(),
  }).index("by_user",      ["userId"])
    .index("by_user_spot", ["userId", "spotKey"]),

  // "Been there" pile — independent of favorites (a spot can be loved AND
  // visited, or one without the other). Sign-in gated: there's no
  // localStorage fallback because anonymous visitors aren't paying
  // customers and shouldn't get the feature. The kebab "Mark as visited"
  // item is hidden when no session is attached.
  visited: defineTable({
    userId:    v.id("users"),
    spotKey:   v.string(),
    visitedAt: v.number(),
  }).index("by_user",      ["userId"])
    .index("by_user_spot", ["userId", "spotKey"]),

  // Tracks both "save" and "no" so we can reconstruct the swipe queue
  // server-side instead of round-tripping through localStorage.
  swipeDecisions: defineTable({
    userId:    v.id("users"),
    spotKey:   v.string(),
    decision:  v.union(v.literal("save"), v.literal("no")),
    decidedAt: v.number(),
  }).index("by_user",      ["userId"])
    .index("by_user_spot", ["userId", "spotKey"]),

  // ── Affiliate referrals ────────────────────────────────────────────────
  // One row per purchase that arrived with a `?r=<slug>` param on the map
  // page. The slug is the raw value (lowercased) and is matched against
  // users.username in the account page query — so any user immediately
  // sees referrals tagged to their handle, and orphan refs (slug never
  // matched a user) just sit unattached until/unless a matching user
  // registers later. Leon does payouts manually monthly, flipping `status`
  // pending → paid and adding a `payoutNote` (Stripe transfer id, etc.).
  // `voided` is set automatically by the webhook on charge.refunded.
  referrals: defineTable({
    refSlug:               v.string(),                          // ?r= value, lowercased
    stripeSessionId:       v.string(),                          // cs_...
    stripePaymentIntentId: v.optional(v.string()),              // pi_..., set when present on the session
    buyerEmail:            v.optional(v.string()),
    // ManyChat IG handle of the buyer, if the purchase came in via the
    // ManyChat IG funnel (subscriberId/`s` in Stripe session metadata).
    // Looked up via lib/manychat.js#getSubscriberIgUsername inside the
    // webhook before recording. Direct-web buyers leave this null and
    // the affiliate page falls back to a date-only row.
    buyerIg:               v.optional(v.string()),
    purchaseAmountCents:   v.number(),                          // gross, in minor units of `currency`
    currency:              v.string(),                          // lowercase ISO (chf/eur/usd)
    commissionCents:       v.number(),                          // 50% of gross, in same currency
    status:                v.union(
                             v.literal("pending"),
                             v.literal("paid"),
                             v.literal("voided"),
                           ),
    createdAt:             v.number(),
    paidAt:                v.optional(v.number()),
    payoutNote:            v.optional(v.string()),              // free-text, e.g. "Stripe transfer tr_..."
    // Product identifier for the "one commission per buyer-product pair"
    // rule. Today there's only one product ("hidden_gems") so this is
    // effectively constant, but the index lets us scale to a second
    // product (Full Guide, etc.) without a schema change. Optional for
    // backward compat with rows written before 2026-05-26 — those are
    // implicitly "hidden_gems" and backfilled by
    // referrals:adminBackfillProductKey.
    productKey:            v.optional(v.string()),
    // Timestamp the row was flipped to "voided" by voidByPaymentIntent.
    // Combined with `paidAt`, lets the monthly payout batch distinguish
    // pre-payout voids (most refunds; paidAt is undefined → no clawback)
    // from post-payout voids (paidAt set + voidedAt > lastPayout →
    // clawback against next month's balance).
    voidedAt:              v.optional(v.number()),
  }).index("by_refSlug",            ["refSlug"])
    .index("by_stripeSession",      ["stripeSessionId"])
    .index("by_paymentIntent",      ["stripePaymentIntentId"])
    // Enforces "one commission per buyer-product pair" in recordPurchase
    // by letting us cheaply look up an existing non-voided row for the
    // (buyerEmail, productKey) tuple before inserting a duplicate.
    .index("by_buyerEmail_product", ["buyerEmail", "productKey"]),
});
