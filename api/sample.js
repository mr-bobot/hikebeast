import { Resend } from "resend";
import crypto from "node:crypto";
import { addTag, setEmail } from "../lib/manychat.js";
import {
  fireCapi,
  buildUserData,
  clientIpFromHeaders,
  clientUserAgentFromHeaders,
} from "../lib/capi.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "Leon · Hikebeast <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const SITE = "https://hikebeast.ch";
const HERO_IMG = `${SITE}/images/thumb-free.jpg`;
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";

// Email upsell points at the soft-sell /guide page (not /api/buy directly),
// so we get a tracked "visited_guide_at" beat before they hit checkout.
// /guide forwards t+s onto its own /api/buy CTAs so attribution carries through.
const guideLink = (token, subscriberId) => {
  const params = new URLSearchParams();
  if (token) params.set("t", token);
  if (subscriberId) params.set("s", subscriberId);
  const qs = params.toString();
  return qs ? `${SITE}/guide?${qs}` : `${SITE}/guide`;
};

const greeting = (firstName) => firstName ? `Hey ${firstName},` : "Hey,";

const html = (link, upsell, firstName) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Swiss Gems of Switzerland free sample</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
          <tr>
            <td>
              <img src="${HERO_IMG}" alt="Swiss Gems of Switzerland" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
              <p style="margin:0 0 16px;font-size:16px;">${greeting(firstName)}</p>
              <p style="margin:0 0 24px;font-size:16px;">Here is your download link to the free sample of the guide:</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:999px;background:#0071e3;">
                    <a href="${link}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-0.01em;">Download the Free Sample</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 32px;font-size:15px;color:#6e6e73;">Save the PDF to your phone for offline use on the trail.</p>
              <p style="margin:0 0 4px;font-size:16px;">Have fun out there,</p>
              <p style="margin:0 0 32px;font-size:16px;">Leon</p>
              <hr style="border:0;border-top:1px solid rgba(0,0,0,0.08);margin:0 0 24px;" />
              <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#6e6e73;letter-spacing:0.08em;text-transform:uppercase;">Ready for the full map?</p>
              <p style="margin:0 0 14px;font-size:14px;color:#6e6e73;line-height:1.5;">The full edition has 100+ hidden gems with exact GPS coordinates, wildcamp rules, best time of day &amp; year, and lifetime updates.</p>
              <p style="margin:0;"><a href="${upsell}" style="color:#0071e3;text-decoration:none;font-weight:500;font-size:14px;">Get the full guide for $49 →</a></p>
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;margin-top:24px;">
          <tr>
            <td align="center" style="font-family:${FONT};font-size:12px;color:#6e6e73;line-height:1.6;">
              <div>© Hikebeast · Leon Helg</div>
              <div><a href="${SITE}/imprint.html" style="color:#6e6e73;text-decoration:none;">Imprint</a> · <a href="${SITE}/privacy.html" style="color:#6e6e73;text-decoration:none;">Privacy</a></div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const text = (link, upsell, firstName) => `${greeting(firstName)}

Here is your download link to the free sample of the guide:

${link}

Save the PDF to your phone for offline use on the trail.

Have fun out there,
Leon

---

Ready for the full map?
The full edition has 100+ hidden gems with exact GPS coordinates, wildcamp rules, best time of day & year, and lifetime updates.
Get the full guide for $49: ${upsell}

© Hikebeast · Leon Helg
${SITE}/imprint.html · ${SITE}/privacy.html
`;

async function logSignup({ email, firstName, subscriberId, token, sentAt, funnel, utm }) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "signup",
        secret: process.env.SHEETS_SECRET,
        sent_at: sentAt,
        email,
        first_name: firstName || "",
        subscriber_id: subscriberId || "",
        token,
        funnel: funnel || "",
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Sheet log failed:", err);
  }
}

// Server-side Meta CAPI `Lead` event. Mirrors `fireCapiPurchase` in
// `api/checkout/webhook.js`. event_id = the per-signup `token` so a
// client-side fbq("track","Lead",...) on /free/ dedups against this
// server-side event. Originally closed the long-open Meta CAPI TODO
// from 2026-04-23 (ad-blockers / iOS privacy were eating ~40-50% of
// Lead pixel fires); upgraded 2026-05-20 to include fbc/fbp/ip/ua
// for higher EMQ ahead of the first paid-ad campaign.
async function fireCapiLead({
  eventId, email, firstName, ipCountry,
  fbc, fbp, clientIp, clientUserAgent, sourceUrl,
}) {
  return fireCapi({
    eventName: "Lead",
    eventId,
    userData: buildUserData({
      email: email || undefined,
      firstName: firstName || undefined,
      country: ipCountry || undefined,
      fbc: fbc || undefined,
      fbp: fbp || undefined,
      clientIp: clientIp || undefined,
      clientUserAgent: clientUserAgent || undefined,
    }),
    sourceUrl: sourceUrl || `${SITE}/free/`,
  });
}

async function createResendContact(email) {
  const audienceId = process.env.RESEND_SEGMENT_ID;
  if (!audienceId) return;
  try {
    const { error } = await resend.contacts.create({
      audienceId,
      email,
      unsubscribed: false,
    });
    if (error) {
      console.error("Resend contact error name:", error.name);
      console.error("Resend contact error message:", error.message);
    }
  } catch (err) {
    console.error("Resend contact threw:", err?.message || String(err));
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, first_name, subscriber_id, funnel, utm_source, utm_medium, utm_campaign, fbc, fbp } = req.body ?? {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const firstName = typeof first_name === "string" ? first_name.trim().slice(0, 60) : "";
  // Meta CAPI identity signals from the buyer's browser. Sent by the
  // /free/ + /sample/ landing pages via window.HBMeta.getCookies()
  // (defined in /lib/meta-cookies.js). Truncated for safety.
  const safeFbc = typeof fbc === "string" ? fbc.slice(0, 200) : "";
  const safeFbp = typeof fbp === "string" ? fbp.slice(0, 100) : "";

  const utm = {
    source: utm_source || "",
    medium: utm_medium || "",
    campaign: utm_campaign || "",
  };

  const token = crypto.randomBytes(12).toString("base64url");
  const link = subscriber_id
    ? `${SITE}/api/g?t=${token}&s=${encodeURIComponent(subscriber_id)}`
    : `${SITE}/api/g?t=${token}`;
  const upsell = guideLink(token, subscriber_id);
  const sentAt = new Date().toISOString();

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject: "Gems of Switzerland · Your download link is ready.",
      html: html(link, upsell, firstName),
      text: text(link, upsell, firstName),
    });
    if (error) {
      console.error("Resend error:", error);
      return res.status(500).json({ error: "Email failed to send" });
    }
    // Source URL: use the referer if present (covers /free/ and /de/free/
     // and any future variant) so Meta groups events sensibly. Falls back
     // to /free/ when the header is stripped.
    const referer = typeof req.headers?.referer === "string" ? req.headers.referer : "";
    const ipCountry = req.headers?.["x-vercel-ip-country"] || "";

    const sideEffects = [
      logSignup({ email, firstName, subscriberId: subscriber_id, token, sentAt, funnel: funnel || "", utm }),
      createResendContact(email),
      fireCapiLead({
        eventId:   token,         // dedupes with client-side fbq("track","Lead") on /free/
        email,
        firstName,
        ipCountry,
        fbc: safeFbc,
        fbp: safeFbp,
        clientIp: clientIpFromHeaders(req.headers),
        clientUserAgent: clientUserAgentFromHeaders(req.headers),
        sourceUrl: referer || `${SITE}/free/`,
      }),
    ];
    if (subscriber_id) {
      sideEffects.push(
        setEmail(subscriber_id, email),
        addTag(subscriber_id, "email_submitted"),
      );
    }
    await Promise.all(sideEffects);
    // `lead_event_id` returned so the browser fbq("track","Lead") on
    // /free/ can pass it as `eventID`, matching the CAPI Lead event we
    // just fired (event_id = token). Without this Meta double-counts
    // every signup as a separate pixel + CAPI event, same class of bug
    // the Purchase dedup fix addressed on 2026-05-15.
    return res.status(200).json({ ok: true, lead_event_id: token });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
