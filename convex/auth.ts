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
  isAdmin: boolean;
  createdAt: number;
};

function toPublic(u: Doc<"users">): PublicUser {
  return {
    _id: u._id,
    username: u.username,
    email: u.email ?? null,
    handle: u.handle ?? null,
    isAdmin: !!u.isAdmin,
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
// avatar pill appears as soon as a token is set.
export const currentUser = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const u = await userFromSession(ctx, sessionToken);
    return u ? toPublic(u) : null;
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
    username:   v.string(),
    password:   v.string(),
    email:      v.optional(v.string()),
    handle:     v.optional(v.string()),
    isAdmin:    v.optional(v.boolean()),
    adminToken: v.string(),
  },
  handler: async (ctx, { username, password, email, handle, isAdmin, adminToken }) => {
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
      createdAt:   now,
      lastSeenAt:  now,
    });
    return { id, username: norm };
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
