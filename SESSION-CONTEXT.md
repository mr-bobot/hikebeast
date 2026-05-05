# Hikebeast webapp · session context

Snapshot for the next session after compaction. Skim this first.

---

## Where we are

- **Worktree**: `/Users/lost/Documents/Development/Hikebeast-social` (git
  worktree on branch `social-v2`).
- **Sister worktree**: `/Users/lost/Documents/Development/Hikebeast` is on
  `main` and hosts the **funnel page** work in another session — do **not**
  edit it from here. They share git history but separate working trees.
- **Local preview**: `python3 -m http.server 8124` running from this
  worktree's root, serving the entire repo. Open
  `http://localhost:8124/full/` for the webapp. The Claude Preview MCP is
  bound to a different working dir, so use plain `curl` / browser for
  verification from this session.
- **Convex hosted dev deployment**: `dev:whimsical-sparrow-336`
  - Client URL: `https://whimsical-sparrow-336.convex.cloud`
  - Site URL:   `https://whimsical-sparrow-336.convex.site`
  - Dashboard:  https://dashboard.convex.dev/d/whimsical-sparrow-336

## Hard environment gotchas

1. **Node version**: the system `node` (`/usr/local/bin/node`) is **18.14.1**,
   which **cannot** run Convex CLI 1.37.0 (uses regex `v` flag, needs
   Node 20). Always prefix Convex commands:

   ```bash
   PATH="/opt/homebrew/opt/node@20/bin:$PATH" node node_modules/convex/dist/cli.bundle.cjs ...
   ```

   `npx convex` will fall back to the wrong Node and crash.

2. **CLI auth uses a device-flow with a 5-minute TTL**. If you need a fresh
   login, run `... cli.bundle.cjs login --login-flow poll --no-open` in the
   background and surface the URL to the user fast — they have to act
   inside 5 min or the code expires.

3. **`v.optional(v.string())` rejects `null`** — only accepts `string` or
   `undefined`. The migration script has a `clean()` helper that strips
   nullish values; reuse it for any new mutation arg.

4. The shared `node_modules` is the **main worktree's**, not this one's,
   when path resolution gets confused. If `npm install convex` complains,
   re-run from inside `Hikebeast-social/`.

## Files / paths cheat sheet

```
convex/
  schema.ts                 # spots + users/authTokens/photoSubmissions/favorites/swipeDecisions
  spots.ts                  # list, bySpotKey, byChapter, upsertSpot, appendPhoto, removePhoto, reorderPhotos, dropDeprecatedGalleries
  _generated/               # gitignored, regenerated on every `convex dev`
.env.local
  CONVEX_DEPLOYMENT, CONVEX_URL, CONVEX_SITE_URL, ADMIN_TOKEN
full/
  index.html                # home (YouTube-style hero + rows; HB.spots-driven)
  social.js                 # rail nav, HB.spots store, HB.galleries shim, applyEditorial, injectMultiImage, rail/heart/3-dots/swipe/random/etc.
  preview.css               # all shared styles
  lib/convex.js             # vendored 155 KB browser bundle (convex@1.37.0). Globals as window.convex.{ConvexClient, ConvexHttpClient, ...}
  map/spots-data.js         # static catalog sidecar (window.SPOTS, window.LEGEND, window.SWITZERLAND_GEOJSON)
  img/spot-images.js        # multi-photo sidecar (window.HB_SPOT_IMAGES)
  img/thumbs/dimensions.js  # image dim sidecar (window.HB_THUMB_DIMS)
  img/m/                    # 1000w mid-tier images (~27 MB, 139 files)
  img/thumbs/               # 160w map markers
  img/                      # full 1800w originals (76 MB)
  intro|central|valais|fribourg|western|eastern|ticino|beyond/index.html
                            # chapter pages with .slide-spot[id] sections
  browse/, saved/, swipe/, map/   # secondary surfaces
api/
  submit-photo.js           # current Submit-Photo flow (emails Leon via Resend; not Convex yet)
scripts/
  build-llms.mjs            # llms.txt generator (untouched by webapp)
  build-thumb-dimensions.mjs    # regen full/img/thumbs/dimensions.js
  build-spot-images.mjs         # regen full/img/spot-images.js (multi-photo extras)
  migrate-spots-to-convex.mjs   # idempotent: spots-data.js + spot-images.js + chapter HTML editorial → Convex `spots`
```

## Architecture · how data flows

```
Chapter HTML (static) ──────┐
spots-data.js (sidecar) ────┤── seed synchronously ──┐
spot-images.js (sidecar) ───┤                        ▼
                             │              ┌─────────────────────┐
                             │              │  HB.spots store     │
                             │              │  (in social.js)     │
                             │              │                     │ ──→ HB.spots.all() / get(key) / subscribe(fn)
                             │              │  Replaces cache on  │     ↑
Convex spots:list ───────────┴── reactive ─▶│  every server diff  │     │
  (websocket via                            └─────────────────────┘     │
   full/lib/convex.js)                                                  │
                                                                       all surfaces:
                                                                       home, browse, saved,
                                                                       swipe, map, chapter
```

- **Reactive**: home, browse, saved, chapter pages re-render on Convex
  push.
- **Snapshot only** (no live updates, by design): swipe deck (don't lose
  in-flight queue), map markers (don't rebuild Leaflet overlays).
- **Editorial overlay**: `applyEditorial(slide, chapterId)` in social.js
  rewrites `.sp-deck`, `.sp-body .body`, `.specs`, and `.sp-foot a.locked`
  href from the DB row whenever the carousel does. Static HTML is the
  fallback when Convex is unreachable.

## Schema in `convex/schema.ts`

- **spots** (live · 112 rows): `spotKey`, `title`, `kicker`, `chapter`,
  `chapterId`, `lat`, `lon`, `color`, `mapsUrl`, `href`, `photos[]`,
  `deck`, `body[]`, `specs[]`, `updatedAt`. Indexes: `by_spotKey`,
  `by_chapterId`. Photo entry: `{ staticPath?, storageId?, credit?, caption?, order, addedAt }`.
- **users** (empty · designed): `email`, `handle?`, `avatarStorageId?`,
  `whopLicenseKey?`, `isAdmin?`, `createdAt`, `lastSeenAt`.
- **authTokens** (empty · designed): `email`, `tokenHash` (sha256, never
  raw), `expiresAt`, `consumedAt?`.
- **photoSubmissions** (empty · designed): `spotKey`, `submitterUserId?`,
  `submitterEmail?`, `photographerHandle?`, `storageId`, `note?`,
  `status`, etc.
- **favorites** (empty · designed): `userId`, `spotKey`, `addedAt`.
- **swipeDecisions** (empty · designed): `userId`, `spotKey`, `decision`,
  `decidedAt`.

## What's done in this branch (across many sessions)

- `/full/` rail nav (Home / Overview / Browse / Map / Swipe / Random /
  Liked + Chapters list + Introduction split). Default-expanded, persists.
- Pinterest-style browse photo wall (CSS Grid + JS row spans, intrinsic
  dims sidecar prevents reshuffle, ~12 property filter chips).
- Saved page (chapter-card design, name always visible).
- Swipe page: 4-button (No / Save / undo / share), heart icon, drag-to-
  decide. `hb:yes:v1` migrated into `hb:skipped:v1`.
- Random animation: fullscreen overlay with 13 swirling cards then a
  winner panel (Open / Re-roll / Close). Cards drawn from all chapters.
- Per-spot 3-dots → Submit Photo modal. Frontend resizes to 2000 px JPEG
  q86, POSTs to `/api/submit-photo`, which emails Leon via Resend.
  **Not yet routed through Convex Storage** — that's phase 3.
- Multi-image carousel on chapter spot cards (dots, chevrons, swipe,
  per-photo credit pill). Hides redundant `slide-spread` cards.
- Map: "Saved only" toggle + zoom-aware marker scaling (CSS variable
  driven via `zoomend`).
- Singular kicker normalisation app-wide (`HB.singularKicker`); property
  filter chips on browse derived from the same map.
- Multi-tier image strategy: 160 w thumbs, 1000 w mid-tier (`/img/m/`),
  1800 w full (`/img/`). Hero + swipe use full-res; rows + thumbs use mid.
- Convex hookup: full database backing for the catalog + photos + full
  editorial, with sidecar fallback. All 112 spots populated.

## Convex functions cheat sheet

```bash
# Reads (public)
... run spots:list
... run spots:bySpotKey '{"spotKey":"central#fulberg"}'
... run spots:byChapter '{"chapterId":"central"}'

# Writes (require ADMIN_TOKEN)
... run spots:upsertSpot     '{"spot":{...},"adminToken":"..."}'
... run spots:appendPhoto    '{"spotKey":"...","photo":{...},"adminToken":"..."}'
... run spots:removePhoto    '{"spotKey":"...","photoIndex":N,"adminToken":"..."}'
... run spots:reorderPhotos  '{"spotKey":"...","order":[...],"adminToken":"..."}'

# Where ... means
PATH="/opt/homebrew/opt/node@20/bin:$PATH" node node_modules/convex/dist/cli.bundle.cjs
```

The migration script is the canonical re-seed:

```bash
PATH="/opt/homebrew/opt/node@20/bin:$PATH" node scripts/migrate-spots-to-convex.mjs
# Idempotent. Run after editing any chapter HTML / spots-data.js to push
# updates into the DB.
```

## What's still NOT in the DB / not built

1. **Phase 2 — magic-link auth** (Resend): schema is scaffolded
   (`users`, `authTokens`). No Convex action yet, no `middleware.js`
   integration, no login UI.
2. **Phase 3 — photo submissions**: schema scaffolded
   (`photoSubmissions`). The current `/api/submit-photo.js` Vercel
   endpoint still emails Leon a base64 attachment via Resend. To migrate:
   client uploads to Convex Storage, mutation inserts a `pending` row,
   admin approves via a `/full/admin/` page (TBD), an "approve" mutation
   appends the photo to `spots.photos`.
3. **Phase 4 — favorites + swipe sync**: schema scaffolded
   (`favorites`, `swipeDecisions`). Frontend still uses
   `localStorage` keys `hb:fav:v1`, `hb:skipped:v1`. Migration on login:
   merge localStorage into the user's row, then switch reads to a
   subscription.
4. **Map + Swipe**: read DB at load time only (no live updates) by design.
5. **Chapter cover sections** (region cover slide, "On the map" intro
   card, end-of-chapter teaser) and the **intro chapter** content (camping
   rules, Top 6 grids) are not in the DB. Different shape from
   per-spot rows; would warrant their own table or extension.

## How to verify everything still works after compaction

1. `cd /Users/lost/Documents/Development/Hikebeast-social`
2. Confirm `git branch --show-current` says `social-v2`.
3. Confirm `python3 -m http.server 8124` is still running, or restart:
   `python3 -m http.server 8124 >/tmp/hb-social-server.log 2>&1 &`
4. `PATH="/opt/homebrew/opt/node@20/bin:$PATH" node node_modules/convex/dist/cli.bundle.cjs run spots:list | grep -c spotKey`
   should return `112`.
5. Browser: open http://localhost:8124/full/central/index.html#fulberg —
   3-photo carousel, full editorial overlaid from DB, websocket
   visible in DevTools → Network → WS.

## House rules (from user memory)

- **No em dashes** anywhere. Use comma / period / colon / middle-dot.
- **No marketing slop copy** (no sensory adjectives, no "p.s." soft-sells).
- **Don't curl prod**: Vercel deploys are gated; trust the push or use
  Vercel MCP.
- **Don't poll send endpoints**: anything that triggers email/SMS/payment
  side effects.
- **Versioned outputs only**: any user-facing PDF / export gets
  `_iter1`, `_iter2` etc filenames; never overwrite.
- **"No, don't X"** in an A/B question means stop, not auto-pick B —
  confirm.

## Brain references

- Project README: `/Users/lost/Documents/Brain/00 Projects/Hikebeast/README.md`
- Session log:    `/Users/lost/Documents/Brain/00 Projects/Hikebeast/99-archive/session-log.md`
- TODO:           `/Users/lost/Documents/Brain/00 Projects/Hikebeast/00 TODO.md`
- IDEAS:          `/Users/lost/Documents/Brain/00 Projects/Hikebeast/IDEAS.md`
- Site overview:  `/Users/lost/Documents/Brain/00 Projects/Hikebeast/04-site/site-overview.md`

Append to `99-archive/session-log.md` after non-trivial sessions; flag
unactioned suggestions in `IDEAS.md`.
