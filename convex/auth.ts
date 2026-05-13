// auth.ts — username + password auth.
//
// Scope today (early access):
//   - Manual account creation via admin CLI (adminCreateUser, ADMIN_TOKEN gated).
//   - Sign in with username (or email, if set on the user) + password.
//   - Long-lived session tokens, sliding expiry (90 days, refreshed on read).
//
// Designed to extend without rework:
//   - users.email is optional; magic-link / Stripe-buyer flows can attach
//     an email later and offer email-based recovery.
//   - sessions table is independent of any specific auth method, so adding
//     a magicLinks table later is purely additive.
//   - Password storage is a single PHC-style string `pbkdf2$<iters>$<salt>$<hash>`,
//     so iter count can be bumped without a schema migration (just rehash on next login).
//
// Security notes:
//   - Convex runs in V8 isolates, so we use the Web Crypto API (no Node `crypto`).
//   - PBKDF2-HMAC-SHA256, 600k iterations (OWASP 2025 recommendation).
//   - Session tokens: 32 random bytes (crypto.getRandomValues), base64url. We
//     store SHA-256 of the raw token, never the raw value.
//   - Constant-time comparison on session lookup (the `by_tokenHash` index
//     does an exact match on the hash, which is fine — there's no early-exit
//     leak because both sides are the same length and structure).

import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

// ── Constants ──────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEYLEN_BITS = 256;          // 32-byte derived key
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 90;  // 90 days
// Refresh `lastSeenAt` and slide the expiry only when the session is older
// than this since its last touch. Avoids one DB write per query.
const SESSION_TOUCH_INTERVAL_MS = 1000 * 60 * 60 * 6;  // 6 hours

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;  // 2-32 chars, lowercase

// ── Encoding helpers ──────────────────────────────────────────────────────
// Convex isolates have base64 via globalThis.btoa/atob (string-only),
// so we go through binary strings. Base64 is fine for storage; tokens
// returned to clients are URL-safe.

function bytesToBase64(arr: Uint8Array): string {
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}
function bytesToBase64Url(arr: Uint8Array): string {
  return bytesToBase64(arr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

// ── Password hashing ──────────────────────────────────────────────────────

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const passKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    passKey,
    PBKDF2_KEYLEN_BITS,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = Number(parts[1]);
  if (!Number.isFinite(iters) || iters < 1000) return false;
  const salt = base64ToBytes(parts[2]);
  const expected = base64ToBytes(parts[3]);
  const got = await pbkdf2(password, salt, iters);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

// ── Session tokens ────────────────────────────────────────────────────────

async function sha256Base64(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToBase64(new Uint8Array(buf));
}

function newSessionToken(): string {
  return bytesToBase64Url(randomBytes(SESSION_TOKEN_BYTES));
}

// ── Admin gate (matches spots.ts) ─────────────────────────────────────────

async function requireAdmin(provided: string): Promise<void> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw new Error("ADMIN_TOKEN not configured on this deployment");
  // Constant-time compare via SHA-256 of both sides (lengths match).
  const [ha, hb] = await Promise.all([sha256Base64(provided || ""), sha256Base64(expected)]);
  if (ha.length !== hb.length) throw new Error("Unauthorized");
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  if (diff !== 0) throw new Error("Unauthorized");
}

// ── Public-shape user (no password / no internal fields) ──────────────────

type PublicUser = {
  _id: Id<"users">;
  username: string;
  email: string | null;
  handle: string | null;
  avatarStorageId: Id<"_storage"> | null;
  isAdmin: boolean;
  isAffiliate: boolean;
  createdAt: number;
};

function toPublic(u: Doc<"users">): PublicUser {
  return {
    _id: u._id,
    username: u.username,
    email: u.email ?? null,
    handle: u.handle ?? null,
    avatarStorageId: u.avatarStorageId ?? null,
    isAdmin: !!u.isAdmin,
    isAffiliate: !!u.isAffiliate,
    createdAt: u.createdAt,
  };
}

// ── Session resolver (shared by every user-scoped query/mutation) ─────────

export async function userFromSession(
  ctx: QueryCtx,
  sessionToken: string | null | undefined,
): Promise<Doc<"users"> | null> {
  if (!sessionToken) return null;
  const tokenHash = await sha256Base64(sessionToken);
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash))
    .unique();
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  const user = await ctx.db.get(session.userId);
  return user ?? null;
}

export async function requireUser(
  ctx: QueryCtx,
  sessionToken: string | null | undefined,
): Promise<Doc<"users">> {
  const u = await userFromSession(ctx, sessionToken);
  if (!u) throw new Error("Not signed in");
  return u;
}

// ── Mutations: sign in / out, admin-create, set-password ──────────────────

// Look up a user by either username or (if set) email. Both paths normalise
// to lowercase. Returns null if no match.
async function findByLogin(ctx: MutationCtx, login: string): Promise<Doc<"users"> | null> {
  const norm = login.trim().toLowerCase();
  if (!norm) return null;
  const byUsername = await ctx.db
    .query("users")
    .withIndex("by_username", q => q.eq("username", norm))
    .unique();
  if (byUsername) return byUsername;
  // Email match only if it looks like an email (cheap sanity check).
  if (!norm.includes("@")) return null;
  const byEmail = await ctx.db
    .query("users")
    .withIndex("by_email", q => q.eq("email", norm))
    .unique();
  return byEmail;
}

export const signIn = mutation({
  args: {
    usernameOrEmail: v.string(),
    password:        v.string(),
  },
  handler: async (ctx, { usernameOrEmail, password }) => {
    const user = await findByLogin(ctx, usernameOrEmail);
    // Always run verifyPassword to keep timing roughly constant whether
    // or not the username exists. Use a dummy PHC if the user wasn't found.
    const phc = user?.passwordPhc
      ?? "pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(password, phc);
    if (!user || !ok) throw new Error("Invalid username or password");

    const now = Date.now();
    const rawToken = newSessionToken();
    const tokenHash = await sha256Base64(rawToken);
    await ctx.db.insert("sessions", {
      userId:     user._id,
      tokenHash,
      createdAt:  now,
      expiresAt:  now + SESSION_TTL_MS,
      lastSeenAt: now,
    });
    await ctx.db.patch(user._id, { lastSeenAt: now });

    return { sessionToken: rawToken, user: toPublic(user) };
  },
});

export const signOut = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const tokenHash = await sha256Base64(sessionToken);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return { ok: true as const };
  },
});

// Reactive: pages subscribe to this so the sign-in modal closes / the
// avatar pill appears as soon as a token is set. Now also resolves
// avatarStorageId → avatarUrl so /full/account/ and the social.js FAB
// can render the user's chosen profile picture without an extra query.
export const currentUser = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const u = await userFromSession(ctx, sessionToken);
    if (!u) return null;
    const base = toPublic(u);
    let avatarUrl: string | null = null;
    if (u.avatarStorageId) {
      try { avatarUrl = await ctx.storage.getUrl(u.avatarStorageId); }
      catch { avatarUrl = null; }
    }
    return { ...base, avatarUrl };
  },
});

// Refresh `lastSeenAt` on a hot session. Called occasionally from the
// client (lazy-touch) so we don't write on every reactive query fire.
export const touchSession = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const tokenHash = await sha256Base64(sessionToken);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash))
      .unique();
    if (!session) return { ok: false as const };
    const now = Date.now();
    if (now - session.lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return { ok: true as const };
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      expiresAt:  now + SESSION_TTL_MS,
    });
    return { ok: true as const };
  },
});

// ── Admin: create / inspect users ─────────────────────────────────────────

export const adminCreateUser = mutation({
  args: {
    username:    v.string(),
    password:    v.string(),
    email:       v.optional(v.string()),
    handle:      v.optional(v.string()),
    isAdmin:     v.optional(v.boolean()),
    isAffiliate: v.optional(v.boolean()),
    adminToken:  v.string(),
  },
  handler: async (ctx, { username, password, email, handle, isAdmin, isAffiliate, adminToken }) => {
    await requireAdmin(adminToken);

    const norm = username.trim().toLowerCase();
    if (!USERNAME_RE.test(norm)) {
      throw new Error("Username must be 2-32 chars, lowercase letters/digits with . _ - in the middle");
    }
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", norm))
      .unique();
    if (existing) throw new Error(`Username already taken: ${norm}`);

    const normEmail = email ? email.trim().toLowerCase() : undefined;
    if (normEmail) {
      const dupe = await ctx.db
        .query("users")
        .withIndex("by_email", q => q.eq("email", normEmail))
        .unique();
      if (dupe) throw new Error(`Email already taken: ${normEmail}`);
    }

    const phc = await hashPassword(password);
    const now = Date.now();
    const id = await ctx.db.insert("users", {
      username:    norm,
      email:       normEmail,
      passwordPhc: phc,
      handle:      handle?.trim() || undefined,
      isAdmin:     isAdmin || undefined,
      isAffiliate: isAffiliate || undefined,
      createdAt:   now,
      lastSeenAt:  now,
    });
    return { id, username: norm };
  },
});

// Mint a 7-day claim-your-account magic link for an existing user.
// Same shape as a password-reset link (purpose=password_reset, /reset/?t=
// page works unchanged), but TTL is long enough for a one-off email blast
// where buyers may not open the message for days. Admin-only.
export const adminMintClaimLink = mutation({
  args: { email: v.string(), adminToken: v.string() },
  handler: async (ctx, { email, adminToken }) => {
    await requireAdmin(adminToken);
    const lower = email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", lower))
      .unique();
    if (!user) throw new Error(`No user with email: ${lower}`);

    // Invalidate prior unused reset links so the inbox has one canonical link.
    const stale = await ctx.db
      .query("magicLinks")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const m of stale) {
      if (m.purpose === "password_reset" && !m.usedAt) await ctx.db.delete(m._id);
    }

    const rawToken = newSessionToken();
    const tokenHash = await sha256Base64(rawToken);
    const now = Date.now();
    await ctx.db.insert("magicLinks", {
      userId:    user._id,
      purpose:   "password_reset",
      tokenHash,
      createdAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });
    return { token: rawToken, username: user.username, handle: user.handle ?? null };
  },
});

// Flip the affiliate flag on an existing user. Useful for promoting
// someone to influencer / affiliate status after the fact, or revoking
// it. Admin-token gated, same as adminCreateUser.
export const adminSetAffiliate = mutation({
  args: {
    username:    v.string(),
    isAffiliate: v.boolean(),
    adminToken:  v.string(),
  },
  handler: async (ctx, { username, isAffiliate, adminToken }) => {
    await requireAdmin(adminToken);
    const norm = username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", norm))
      .unique();
    if (!user) throw new Error(`No user with username: ${norm}`);
    await ctx.db.patch(user._id, { isAffiliate: isAffiliate || undefined });
    return { username: norm, isAffiliate };
  },
});

export const adminListUsers = query({
  args: { adminToken: v.string() },
  handler: async (ctx, { adminToken }) => {
    await requireAdmin(adminToken);
    const rows = await ctx.db.query("users").collect();
    return rows.map(toPublic);
  },
});

// Admin password reset — ships now so manual recovery is trivial. A user-
// facing "change password" mutation can come later (will require sessionToken
// + oldPassword + newPassword).
export const adminSetPassword = mutation({
  args: {
    username:    v.string(),
    newPassword: v.string(),
    adminToken:  v.string(),
  },
  handler: async (ctx, { username, newPassword, adminToken }) => {
    await requireAdmin(adminToken);
    if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");
    const norm = username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", norm))
      .unique();
    if (!user) throw new Error(`No user: ${norm}`);
    const phc = await hashPassword(newPassword);
    await ctx.db.patch(user._id, { passwordPhc: phc });
    // Invalidate every existing session for that user so a leaked password
    // can't keep an attacker signed in after a reset.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);
    return { ok: true as const, sessionsRevoked: sessions.length };
  },
});

// ── Account settings (sessionToken-gated, user changes own data) ──────────
// Three thin mutations the /full/account/ page calls. Each takes the raw
// sessionToken so the existing userFromSession() resolver gates access --
// no admin token, no extra auth machinery. Username + email collisions
// throw so the page can show "that's taken". Password change keeps the
// session valid but invalidates every OTHER session for the user (so a
// stolen password's other sessions get logged out too).

export const updateUsername = mutation({
  args: { sessionToken: v.string(), newUsername: v.string() },
  handler: async (ctx, { sessionToken, newUsername }) => {
    const user = await requireUser(ctx, sessionToken);
    const norm = newUsername.trim().toLowerCase();
    if (!USERNAME_RE.test(norm)) {
      throw new Error("Username must be 2-32 chars, lowercase letters/digits with . _ - in the middle");
    }
    if (norm === user.username) return { ok: true as const, username: user.username };

    const dupe = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", norm))
      .unique();
    if (dupe) throw new Error(`Username already taken: ${norm}`);

    await ctx.db.patch(user._id, { username: norm });
    return { ok: true as const, username: norm };
  },
});

export const updateEmail = mutation({
  args: { sessionToken: v.string(), newEmail: v.string() },
  handler: async (ctx, { sessionToken, newEmail }) => {
    const user = await requireUser(ctx, sessionToken);
    const oldEmail = user.email ?? null;
    const norm = newEmail.trim().toLowerCase();
    if (!norm.includes("@") || norm.length > 200) throw new Error("Invalid email");
    if (norm === (user.email || "")) {
      // No-op change. Surface oldEmail anyway so callers can detect it
      // and skip the notification path.
      return { ok: true as const, email: norm, oldEmail, changed: false as const };
    }

    const dupe = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", norm))
      .unique();
    if (dupe) throw new Error(`Email already in use: ${norm}`);

    await ctx.db.patch(user._id, { email: norm });
    // oldEmail returned so the lambda can fire a "your email changed"
    // notification to the previous address (security).
    return { ok: true as const, email: norm, oldEmail, changed: true as const };
  },
});

export const updatePassword = mutation({
  args: {
    sessionToken: v.string(),
    oldPassword:  v.string(),
    newPassword:  v.string(),
  },
  handler: async (ctx, { sessionToken, oldPassword, newPassword }) => {
    const user = await requireUser(ctx, sessionToken);
    if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");

    const ok = await verifyPassword(oldPassword, user.passwordPhc);
    if (!ok) throw new Error("Current password is wrong");

    const phc = await hashPassword(newPassword);
    await ctx.db.patch(user._id, { passwordPhc: phc });

    // Invalidate every OTHER session so any leaked-password attacker is
    // logged out. The current session (the one that authorised this
    // call) stays valid -- the user just changed their password and
    // shouldn't have to log in again.
    const currentTokenHash = await sha256Base64(sessionToken);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    let revoked = 0;
    for (const s of sessions) {
      if (s.tokenHash !== currentTokenHash) {
        await ctx.db.delete(s._id);
        revoked++;
      }
    }
    return { ok: true as const, sessionsRevoked: revoked };
  },
});

// ── Avatar (profile picture) upload ───────────────────────────────────────
// Two-step pattern (Convex storage convention):
//   1. Client calls generateAvatarUploadUrl → gets a one-time signed URL
//   2. Client POSTs the file to that URL → Convex returns { storageId }
//   3. Client calls setAvatar(storageId) to attach it to the user row
// We delete the prior avatar's storage object on overwrite so the bucket
// doesn't bloat with orphaned uploads.

export const generateAvatarUploadUrl = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireUser(ctx, sessionToken);   // gate on a valid session
    return await ctx.storage.generateUploadUrl();
  },
});

export const setAvatar = mutation({
  args: { sessionToken: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { sessionToken, storageId }) => {
    const user = await requireUser(ctx, sessionToken);
    // Delete the previous avatar to avoid orphaned blobs.
    if (user.avatarStorageId && user.avatarStorageId !== storageId) {
      try { await ctx.storage.delete(user.avatarStorageId); }
      catch { /* tolerable: storage entry may be missing */ }
    }
    await ctx.db.patch(user._id, { avatarStorageId: storageId });
    const url = await ctx.storage.getUrl(storageId);
    return { ok: true as const, avatarStorageId: storageId, avatarUrl: url };
  },
});

export const clearAvatar = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireUser(ctx, sessionToken);
    if (user.avatarStorageId) {
      try { await ctx.storage.delete(user.avatarStorageId); }
      catch {}
      await ctx.db.patch(user._id, { avatarStorageId: undefined });
    }
    return { ok: true as const };
  },
});

// ── Magic-link password recovery ──────────────────────────────────────────
// Two mutations + an internal helper. The lambda layer is the policy
// boundary (rate-limiting, sending the email). These mutations just do
// the database side: mint or redeem a token.
//
// Threat model:
//   - Plaintext token lives ONLY in the email body. We store the SHA-256
//     hash so a DB leak doesn't yield reset-anyone's-password ammunition.
//   - Single-use: redemption marks `usedAt` and the next redeem rejects.
//   - Time-bound: 30-minute expiry (short enough to limit abuse, long
//     enough that a buyer can read the email and click without panic).
//   - Existence enumeration: `requestPasswordReset` ALWAYS returns
//     {ok: true} regardless of whether the email maps to a user. The
//     lambda only sends the email when one exists -- but the response
//     shape never reveals it.

const RESET_TTL_MS = 30 * 60 * 1000;

export const requestPasswordReset = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const lower = email.trim().toLowerCase();
    if (!lower || !lower.includes("@")) {
      // Same shape as the success path -- callers can't distinguish.
      return { ok: true as const, sent: false as const };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", lower))
      .unique();
    if (!user) return { ok: true as const, sent: false as const };

    // Invalidate every outstanding reset link for this user before
    // issuing a new one. Stops a stack of stale links from accumulating
    // in inboxes (and rate-limits via the requesting cadence).
    const stale = await ctx.db
      .query("magicLinks")
      .withIndex("by_user", q => q.eq("userId", user._id))
      .collect();
    for (const m of stale) {
      if (m.purpose === "password_reset" && !m.usedAt) {
        await ctx.db.delete(m._id);
      }
    }

    const rawToken = newSessionToken();           // 32 random bytes, base64url
    const tokenHash = await sha256Base64(rawToken);
    const now = Date.now();
    await ctx.db.insert("magicLinks", {
      userId:    user._id,
      purpose:   "password_reset",
      tokenHash,
      createdAt: now,
      expiresAt: now + RESET_TTL_MS,
    });

    // Plaintext token returned ONLY here so the lambda can put it in the
    // email URL. It is never stored or returned again.
    return {
      ok:        true as const,
      sent:      true as const,
      token:     rawToken,
      email:     lower,
      username:  user.username,
      handle:    user.handle ?? null,
    };
  },
});

export const redeemPasswordReset = mutation({
  args: { token: v.string(), newPassword: v.string() },
  handler: async (ctx, { token, newPassword }) => {
    if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");
    const tokenHash = await sha256Base64(token);

    const link = await ctx.db
      .query("magicLinks")
      .withIndex("by_tokenHash", q => q.eq("tokenHash", tokenHash))
      .unique();
    if (!link) throw new Error("This reset link is invalid or has already been used");
    if (link.usedAt) throw new Error("This reset link has already been used");
    if (link.expiresAt < Date.now()) throw new Error("This reset link has expired -- request a new one");
    if (link.purpose !== "password_reset") throw new Error("Wrong link type");

    const user = await ctx.db.get(link.userId);
    if (!user) throw new Error("Account not found");

    const phc = await hashPassword(newPassword);
    const now = Date.now();
    await ctx.db.patch(link.userId, { passwordPhc: phc });
    await ctx.db.patch(link._id, { usedAt: now });

    // Invalidate every outstanding session: a forgotten-password redeem
    // is exactly the moment when a stolen-session attacker should be
    // booted. We do this AFTER patching the password to avoid a window
    // where the old password works but old sessions are gone.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", q => q.eq("userId", link.userId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    // Mint a fresh session so the redeem page can drop the user straight
    // into /full/ signed-in (same UX as the post-purchase flow).
    const rawToken = newSessionToken();
    const newTokenHash = await sha256Base64(rawToken);
    await ctx.db.insert("sessions", {
      userId:     link.userId,
      tokenHash:  newTokenHash,
      createdAt:  now,
      expiresAt:  now + SESSION_TTL_MS,
      lastSeenAt: now,
    });

    return {
      ok:           true as const,
      sessionToken: rawToken,
      user:         toPublic(user),
    };
  },
});

// ── Paid-buyer onboarding ─────────────────────────────────────────────────
// Called by the Stripe success-page form (api/checkout/session.js) after the
// session has been verified `payment_status === "paid"`. The lambda is the
// trust boundary -- this mutation does NOT re-verify Stripe, it just creates
// the Convex user the lambda asked it to.
//
// Idempotent: if a user already exists for `email`, returns
// `{existing: true, email}` so the success page can route the buyer to
// /login/ instead of erroring out. Otherwise: creates the user, mints a
// session, returns the raw token so the lambda can hand it back to the
// page (which writes localStorage:hb:session:v1 the same way /login/ does).
//
// Username collision handling: the page-supplied username is the user's
// edited choice. If it's taken, we re-roll a 3-digit suffix on a stem
// derived from the firstName (or email-localpart fallback) up to 10 times.
// We always return the actually-stored username so the success page can
// show "Account created as <name>" if needed.
export const createPaidUser = mutation({
  args: {
    email:            v.string(),
    firstName:        v.optional(v.string()),
    paymentIntentId:  v.string(),     // stored in users.whopLicenseKey for now
    username:         v.optional(v.string()),
    password:         v.string(),
  },
  handler: async (ctx, { email, firstName, paymentIntentId, username, password }) => {
    if (password.length < 8) throw new Error("Password must be at least 8 characters");

    const lower = email.trim().toLowerCase();
    if (!lower || !lower.includes("@")) throw new Error("Invalid email");

    // ── Already exists? Idempotent return so the page can redirect to /login.
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", lower))
      .unique();
    if (existing) {
      return { existing: true as const, email: lower, username: existing.username };
    }

    // ── Pick a username, rolling on collision.
    const seed = (firstName && firstName.trim())
      ? firstName.trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 12)
      : lower.split("@")[0].toLowerCase().replace(/[^a-z]/g, "").slice(0, 12);
    const stem = seed || "hiker";

    // V8 isolates: getRandomValues is the supported source.
    function rollSuffix(): string {
      const bytes = new Uint8Array(2);
      crypto.getRandomValues(bytes);
      const n = ((bytes[0] << 8) | bytes[1]) % 1000;
      return String(n).padStart(3, "0");
    }
    function isAcceptableUsername(s: string): boolean {
      return USERNAME_RE.test(s);
    }

    let candidate = (username || "").trim().toLowerCase();
    if (!candidate || !isAcceptableUsername(candidate)) {
      candidate = `${stem}${rollSuffix()}`;
    }

    let collisions = 0;
    while (true) {
      const dupe = await ctx.db
        .query("users")
        .withIndex("by_username", q => q.eq("username", candidate))
        .unique();
      if (!dupe) break;
      collisions++;
      if (collisions > 10) throw new Error("Could not pick a free username after 10 tries");
      candidate = `${stem}${rollSuffix()}`;
      if (!isAcceptableUsername(candidate)) candidate = `hiker${rollSuffix()}`;
    }

    // ── Create the user + a fresh session.
    const phc = await hashPassword(password);
    const now = Date.now();
    const handle = (firstName && firstName.trim()) ? firstName.trim().slice(0, 60) : candidate;

    const userId = await ctx.db.insert("users", {
      username:       candidate,
      email:          lower,
      passwordPhc:    phc,
      handle,
      whopLicenseKey: paymentIntentId,   // re-purpose: stripe payment_intent_id
      createdAt:      now,
      lastSeenAt:     now,
    });

    const rawToken = newSessionToken();
    const tokenHash = await sha256Base64(rawToken);
    await ctx.db.insert("sessions", {
      userId,
      tokenHash,
      createdAt:  now,
      expiresAt:  now + SESSION_TTL_MS,
      lastSeenAt: now,
    });

    const created = await ctx.db.get(userId);
    return {
      existing:     false as const,
      sessionToken: rawToken,
      username:     candidate,
      user:         created ? toPublic(created) : null,
    };
  },
});

// Background-style cleanup (admin invokes occasionally; not on a cron yet).
export const adminPurgeExpiredSessions = mutation({
  args: { adminToken: v.string() },
  handler: async (ctx, { adminToken }) => {
    await requireAdmin(adminToken);
    const now = Date.now();
    const expired = await ctx.db
      .query("sessions")
      .filter(q => q.lt(q.field("expiresAt"), now))
      .collect();
    for (const s of expired) await ctx.db.delete(s._id);
    return { deleted: expired.length };
  },
});
