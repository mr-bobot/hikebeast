// api/login.js — multi-purpose auth endpoint (kept as one Vercel function
// because we sit at the function-count budget for this project).
//
// Three flows, discriminated by request body:
//
//   1. Convex per-user account login (preferred, used by /login/ form)
//        body: { username, password, next? }
//        -> validates against Convex auth:signIn
//        -> sets the legacy hb_full_auth cookie middleware checks on /full/*
//        -> returns { ok: true, sessionToken, user, next } so the client can
//           persist the Convex session in localStorage:hb:session:v1.
//
//   2. Legacy shared-password login (PREVIEW_USER / PREVIEW_PASS)
//        body: { user, pass, next? }
//        -> kept as the back door if Leon needs to hand out a single
//           shared credential. Sets the same cookie, no sessionToken.
//
//   3. Logout
//        body: { action: "logout", sessionToken? }
//        -> expires the cookie (Set-Cookie Max-Age=0) and best-effort
//           revokes the Convex session if a token is provided.
//
// The middleware verifies the cookie on every /full/* request. Convex
// session tokens are validated server-side by the Convex deployment
// itself; we just relay them.

import crypto from 'node:crypto';
import { Resend } from 'resend';

const COOKIE_NAME  = 'hb_full_auth';
const COOKIE_LABEL = 'hb_full_auth_v1';
const MAX_AGE_DAYS = 30;

// Same constants used by api/checkout/webhook.js so the reset email
// inherits the brand voice / sender / styling without duplicating them.
const RESEND_FROM     = 'Leon · Hikebeast <leon@hikebeast.ch>';
const RESEND_REPLY_TO = 'leon@hikebeast.ch';
const SITE            = 'https://hikebeast.ch';
const FONT            = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";

// ── Helpers ───────────────────────────────────────────────────────────────

function tokenFor(pass) {
  return crypto.createHmac('sha256', pass).update(COOKIE_LABEL).digest('hex');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// Open-redirect safeguard: only honour /full/... targets.
function safeNext(next) {
  if (typeof next !== 'string' || !next) return '/full/';
  if (next === '/full' || next === '/full/') return '/full/';
  if (next.startsWith('/full/')) return next;
  return '/full/';
}

function setSessionCookie(res, value, maxAgeSeconds) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; '));
}

// Talk to Convex via the plain HTTP API instead of pulling in the SDK
// (keeps this function tiny and the Vercel build out of nft trouble).
//
//   POST <CONVEX_URL>/api/mutation
//   body: { path: "module:function", args: {...}, format: "json" }
//   <- { status: "success"|"error", value?, errorMessage?, errorData? }
async function convexMutation(convexUrl, path, args) {
  const url = `${convexUrl.replace(/\/$/, '')}/api/mutation`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path, args, format: 'json' }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok)                    throw new Error(`convex http ${r.status}: ${json?.errorMessage || r.statusText}`);
  if (json?.status === 'error') throw new Error(json.errorMessage || 'convex mutation failed');
  return json?.value;
}

// Password-reset email body. Plain enough that an inbox preview reads
// "Reset your Hikebeast password — open this link" without a fight.
function resetEmailHtml({ resetUrl, displayName }) {
  const greeting = displayName ? `Hey ${displayName},` : 'Hey,';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Reset your Hikebeast password</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
          <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:16px;">Tap the button below to set a new password for your Swiss Gems account. The link expires in 30 minutes.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr>
            <td style="border-radius:999px;background:#1d1d1f;">
              <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Set a new password</a>
            </td>
          </tr></table>
          <p style="margin:0 0 24px;font-size:14px;color:#6e6e73;">If the button doesn't work, copy this URL into your browser:<br /><span style="word-break:break-all;">${resetUrl}</span></p>
          <p style="margin:0;font-size:14px;color:#6e6e73;">Didn't ask for this? You can safely ignore this email — your password stays the same.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;"><tr>
        <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
          <div>© Hikebeast</div>
          <div><a href="${SITE}/imprint.html" style="color:#6e6e73;text-decoration:none;">Imprint</a> · <a href="${SITE}/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Email-change notifications. Sent on any successful email change so a
// stolen-session attacker who pivots their address gets caught by the
// old-inbox owner. Twin templates -- one to each address -- are
// near-identical but framed differently (security alert vs. confirmation).
function emailChangeOldHtml({ oldEmail, newE }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Your Hikebeast account email was changed</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;"><tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
<p style="margin:0 0 16px;font-size:16px;">Hey,</p>
<p style="margin:0 0 16px;font-size:16px;">The email on your Hikebeast account was changed from <strong>${oldEmail}</strong> to <strong>${newE}</strong>. Future receipts and recovery emails will go to the new address.</p>
<p style="margin:0 0 24px;font-size:15px;color:#6e6e73;">Wasn't you? Reply to this email and I'll lock the account while we sort it out.</p>
<p style="margin:0;font-size:14px;color:#6e6e73;">Leon · Hikebeast</p>
</td></tr></table></td></tr></table></body></html>`;
}
function emailChangeOldText({ oldEmail, newE }) {
  return `Hey,

The email on your Hikebeast account was changed from ${oldEmail} to ${newE}. Future receipts and recovery emails will go to the new address.

Wasn't you? Reply to this email and I'll lock the account.

Leon · Hikebeast
`;
}
function emailChangeNewHtml({ newE }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Your Hikebeast account email is now this address</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;"><tr><td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
<p style="margin:0 0 16px;font-size:16px;">Hey,</p>
<p style="margin:0 0 16px;font-size:16px;">This is now the email on your Hikebeast account. Future receipts and password-reset links will land here.</p>
<p style="margin:0 0 24px;font-size:15px;color:#6e6e73;">If you didn't make this change, reply to this email so I can roll it back.</p>
<p style="margin:0;font-size:14px;color:#6e6e73;">Leon · Hikebeast</p>
</td></tr></table></td></tr></table></body></html>`;
}
function emailChangeNewText({ newE }) {
  return `Hey,

This is now the email on your Hikebeast account. Future receipts and password-reset links will land here.

If you didn't make this change, reply to this email so I can roll it back.

Leon · Hikebeast
`;
}

function resetEmailText({ resetUrl, displayName }) {
  const greeting = displayName ? `Hey ${displayName},` : 'Hey,';
  return `${greeting}

Tap this link to set a new password for your Swiss Gems account. It expires in 30 minutes.

${resetUrl}

Didn't ask for this? You can safely ignore this email -- your password stays the same.

© Hikebeast
${SITE}/imprint.html · ${SITE}/privacy.html
`;
}

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = await readJsonBody(req);

  // ── Flow 3.5: admin-triggered email send (e.g. claim-account blast) ────
  // Body: { action: "admin_send_email", adminToken, to, subject, html, text }
  // Sends a single email via Resend using server-side credentials. Locked
  // down to the same ADMIN_TOKEN that gates Convex admin mutations, so a
  // leaked token compromises both anyway (no widening of blast radius).
  // Used by scripts/send-claim-emails.mjs because Sensitive Vercel env
  // vars (like RESEND_API_KEY) aren't readable outside the Vercel runtime.
  if (body?.action === 'admin_send_email') {
    const expected = process.env.ADMIN_TOKEN || '';
    const provided = typeof body.adminToken === 'string' ? body.adminToken : '';
    if (!expected || provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'resend_not_configured' });

    const to      = typeof body.to === 'string' ? body.to.trim() : '';
    const subject = typeof body.subject === 'string' ? body.subject : '';
    const html    = typeof body.html === 'string' ? body.html : '';
    const text    = typeof body.text === 'string' ? body.text : '';
    if (!to || !to.includes('@') || !subject || (!html && !text)) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    try {
      const resend = new Resend(resendKey);
      const { data, error } = await resend.emails.send({
        from:    RESEND_FROM,
        to,
        replyTo: RESEND_REPLY_TO,
        subject,
        html:    html || undefined,
        text:    text || undefined,
      });
      if (error) return res.status(502).json({ error: 'resend_failed', message: error?.message || String(error) });
      return res.status(200).json({ ok: true, id: data?.id });
    } catch (err) {
      return res.status(502).json({ error: 'resend_threw', message: err?.message || String(err) });
    }
  }

  // ── Flow 3.6: admin add a contact to the Resend audience ──────────────
  // Body: { action: "admin_add_resend_contact", adminToken, email, firstName? }
  // Used by scripts/backfill-resend-audience.mjs to retroactively add
  // historical signups that fell through pre-2026-04-27, when the Resend
  // API key was "Sending only" and resend.contacts.create silently failed
  // with restricted_api_key. The SDK call is idempotent (Resend dedupes
  // on email per audience), so re-running is safe.
  if (body?.action === 'admin_add_resend_contact') {
    const expected = process.env.ADMIN_TOKEN || '';
    const provided = typeof body.adminToken === 'string' ? body.adminToken : '';
    if (!expected || provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const resendKey  = process.env.RESEND_API_KEY;
    const audienceId = process.env.RESEND_SEGMENT_ID;
    if (!resendKey || !audienceId) return res.status(503).json({ error: 'resend_not_configured' });

    const email     = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad_email' });

    try {
      const resend = new Resend(resendKey);
      const { data, error } = await resend.contacts.create({
        audienceId,
        email,
        firstName: firstName || undefined,
        unsubscribed: false,
      });
      if (error) {
        // Resend returns a structured error when the contact already
        // exists in this audience. Treat as success (idempotent intent).
        const msg = String(error.message || '');
        const isDupe = /already exists|already in/i.test(msg) ||
                       error.name === 'invalid_parameter' && /already/i.test(msg);
        if (isDupe) return res.status(200).json({ ok: true, status: 'existed' });
        return res.status(502).json({ error: 'resend_failed', name: error.name, message: msg });
      }
      return res.status(200).json({ ok: true, status: 'created', id: data?.id });
    } catch (err) {
      return res.status(502).json({ error: 'resend_threw', message: err?.message || String(err) });
    }
  }

  // ── Flow 4: password-reset request (email a magic link) ────────────────
  // Body: { action: "request_password_reset", email }
  // Response is ALWAYS {ok: true} regardless of whether `email` matches a
  // user. The mutation already returns {sent: false} for unknown emails;
  // we drop that bit on the floor and tell the caller "ok" either way so
  // a probing attacker can't enumerate accounts.
  if (body?.action === 'request_password_reset') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !email.includes('@')) {
      // Same shape as success so callers can't distinguish bad-input from
      // unknown-email.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    }

    let result;
    try {
      result = await convexMutation(convexUrl, 'auth:requestPasswordReset', { email });
    } catch (err) {
      console.error('requestPasswordReset failed:', err?.message || err);
      // Still return ok to keep the response shape constant. Operator
      // can read the log if a real failure pattern emerges.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    }

    if (result?.sent && result?.token) {
      // Derive the site URL from request headers so a reset triggered
      // from the Vercel preview deploy emails a link pointing at THAT
      // preview (the lambda there talks to staging Convex, where the
      // token was minted). On prod, host = hikebeast.ch and the link
      // points at the production page. Origin > host > hardcoded SITE.
      const reqOrigin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin)
        ? req.headers.origin
        : '';
      const reqHost = typeof req.headers.host === 'string' ? req.headers.host : '';
      const baseUrl = reqOrigin || (reqHost ? `https://${reqHost}` : SITE);
      const resetUrl = `${baseUrl}/reset/?token=${encodeURIComponent(result.token)}`;
      const displayName = (result.handle || result.username || '').toString().trim();
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { error } = await resend.emails.send({
          from:    RESEND_FROM,
          to:      result.email,
          replyTo: RESEND_REPLY_TO,
          subject: 'Reset your Hikebeast password',
          html:    resetEmailHtml({ resetUrl, displayName }),
          text:    resetEmailText({ resetUrl, displayName }),
        });
        if (error) console.error('Resend reset email error:', error);
      } catch (err) {
        console.error('Resend reset email threw:', err?.message || err);
      }
    }

    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  // ── Flow 5: password-reset redeem (consume the magic link) ─────────────
  // Body: { action: "redeem_password_reset", token, newPassword }
  // On success: returns the new sessionToken + sets hb_full_auth so the
  // /reset/ page can drop the buyer straight into /full/ signed-in.
  if (body?.action === 'redeem_password_reset') {
    const convexUrl = process.env.CONVEX_URL;
    const previewPassRedeem = process.env.PREVIEW_PASS;
    if (!convexUrl || !previewPassRedeem) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    const token       = typeof body.token === 'string' ? body.token : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    let result;
    try {
      result = await convexMutation(convexUrl, 'auth:redeemPasswordReset', { token, newPassword });
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '';
      // Surface the user-friendly Convex error verbatim so the page can
      // show "expired" / "already used" instead of a generic failure.
      const cleaned = msg.replace(/^.*?Error:\s*/, '').replace(/\s+at\s+handler.*$/, '');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(400).json({ error: 'reset_failed', message: cleaned });
    }

    setSessionCookie(res, tokenFor(previewPassRedeem), MAX_AGE_DAYS * 24 * 60 * 60);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok:           true,
      sessionToken: result.sessionToken,
      user:         result.user,
    });
  }

  // ── Flow 6: change email + notify both addresses ───────────────────────
  // Body: { action: "change_email", sessionToken, newEmail }
  // Calls auth:updateEmail (sessionToken-gated) and on a real change
  // fires two notification emails: a security alert to the OLD address
  // ("your email was changed -- if not you, reply") and a confirmation
  // to the NEW address. Both fire-and-forget; we don't fail the request
  // if Resend is down.
  if (body?.action === 'change_email') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';
    const newEmail     = typeof body.newEmail     === 'string' ? body.newEmail     : '';
    if (!sessionToken || !newEmail) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    let result;
    try {
      result = await convexMutation(convexUrl, 'auth:updateEmail', {
        sessionToken, newEmail,
      });
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '';
      const cleaned = msg.replace(/^.*?Error:\s*/, '').replace(/\s+at\s+handler.*$/, '');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(400).json({ error: 'change_failed', message: cleaned });
    }

    let notified = false;
    if (result?.changed && result.email) {
      const oldEmail = result.oldEmail || '';
      const newE     = result.email;
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        // Send to NEW first so even if Resend rate-limits we got the
        // confirmation in. Old-address security alert is the second
        // priority but also valuable.
        const sends = [];
        sends.push(resend.emails.send({
          from:    RESEND_FROM,
          to:      newE,
          replyTo: RESEND_REPLY_TO,
          subject: 'Your Hikebeast account email is now this address',
          html:    emailChangeNewHtml({ newE }),
          text:    emailChangeNewText({ newE }),
        }));
        if (oldEmail && oldEmail !== newE) {
          sends.push(resend.emails.send({
            from:    RESEND_FROM,
            to:      oldEmail,
            replyTo: RESEND_REPLY_TO,
            subject: 'Your Hikebeast account email was changed',
            html:    emailChangeOldHtml({ oldEmail, newE }),
            text:    emailChangeOldText({ oldEmail, newE }),
          }));
        }
        const results = await Promise.allSettled(sends);
        notified = results.some(r => r.status === 'fulfilled' && !r.value?.error);
        results.forEach((r) => {
          if (r.status === 'rejected') console.error('email-change Resend rejected:', r.reason);
          else if (r.value?.error)     console.error('email-change Resend error:', r.value.error);
        });
      } catch (err) {
        console.error('email-change Resend threw:', err?.message || err);
      }
    }

    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok:       true,
      email:    result?.email || newEmail,
      changed:  !!result?.changed,
      notified,
    });
  }

  // ── Flow 3: logout ──────────────────────────────────────────────────────
  if (body?.action === 'logout') {
    const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';
    // Best-effort revoke; we don't block on it. The cookie expiry below is
    // the load-bearing part of "logged out".
    if (sessionToken && process.env.CONVEX_URL) {
      try { await convexMutation(process.env.CONVEX_URL, 'auth:signOut', { sessionToken }); } catch {}
    }
    setSessionCookie(res, '', 0);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  const previewUser = process.env.PREVIEW_USER;
  const previewPass = process.env.PREVIEW_PASS;
  if (!previewUser || !previewPass) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(503).json({ error: 'auth_not_configured' });
  }

  // ── Flow 1: Convex per-user account login ─────────────────────────────
  // Detected by the new field shape ({ username, password }).
  if (typeof body?.username === 'string' && typeof body?.password === 'string') {
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(503).json({ error: 'auth_not_configured' });
    }
    const username = body.username.trim();
    const password = body.password;
    const next     = safeNext(body.next);
    if (!username || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }
    let result;
    try {
      result = await convexMutation(convexUrl, 'auth:signIn', {
        usernameOrEmail: username,
        password,
      });
    } catch {
      await new Promise(r => setTimeout(r, 350));
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    setSessionCookie(res, tokenFor(previewPass), MAX_AGE_DAYS * 24 * 60 * 60);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      sessionToken: result.sessionToken,
      user: result.user,
      next,
    });
  }

  // ── Flow 2: legacy shared-password login (kept as the back door) ──────
  const user = typeof body?.user === 'string' ? body.user.trim() : '';
  const pass = typeof body?.pass === 'string' ? body.pass : '';
  const next = typeof body?.next === 'string' ? body.next : '';

  // Constant-time compare for both fields to avoid leaking whether
  // the username was correct via response timing.
  const userOk = user.length === previewUser.length &&
    crypto.timingSafeEqual(
      Buffer.from(user.padEnd(previewUser.length, '\0')),
      Buffer.from(previewUser.padEnd(previewUser.length, '\0')),
    );
  const passOk = pass.length === previewPass.length &&
    crypto.timingSafeEqual(
      Buffer.from(pass.padEnd(previewPass.length, '\0')),
      Buffer.from(previewPass.padEnd(previewPass.length, '\0')),
    );

  if (!userOk || !passOk) {
    await new Promise(r => setTimeout(r, 350));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  setSessionCookie(res, tokenFor(previewPass), MAX_AGE_DAYS * 24 * 60 * 60);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, next: safeNext(next) });
}
