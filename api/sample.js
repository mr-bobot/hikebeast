import { Resend } from "resend";
import crypto from "node:crypto";
import { addTag, setEmail } from "../lib/manychat.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "Leon Helg <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const SITE = "https://hikebeast.ch";
const HERO_IMG = `${SITE}/images/thumb-free.jpg`;
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif";

const buyLink = (token, subscriberId) => {
  const params = new URLSearchParams();
  if (token) params.set("t", token);
  if (subscriberId) params.set("s", subscriberId);
  const qs = params.toString();
  return qs ? `${SITE}/api/buy?${qs}` : `${SITE}/api/buy`;
};

const html = (link, upsell) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Swiss Hidden Gems free sample</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;">
          <tr>
            <td>
              <img src="${HERO_IMG}" alt="Swiss Hidden Gems" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px;font-family:${FONT};color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em;">
              <p style="margin:0 0 16px;font-size:16px;">Hey,</p>
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

const text = (link, upsell) => `Hey,

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

async function logSignup({ email, subscriberId, token, sentAt, utm }) {
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
        subscriber_id: subscriberId || "",
        token,
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

  const { email, subscriber_id, utm_source, utm_medium, utm_campaign } = req.body ?? {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  const hasUtm = utm_source || utm_medium || utm_campaign;
  const utm = hasUtm
    ? { source: utm_source || "", medium: utm_medium || "", campaign: utm_campaign || "" }
    : subscriber_id
    ? { source: "manychat", medium: "dm", campaign: "" }
    : { source: "", medium: "", campaign: "" };

  const token = crypto.randomBytes(12).toString("base64url");
  const link = subscriber_id
    ? `${SITE}/api/g?t=${token}&s=${encodeURIComponent(subscriber_id)}`
    : `${SITE}/api/g?t=${token}`;
  const upsell = buyLink(token, subscriber_id);
  const sentAt = new Date().toISOString();

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject: "Hidden Gems - Your download link is ready.",
      html: html(link, upsell),
      text: text(link, upsell),
    });
    if (error) {
      console.error("Resend error:", error);
      return res.status(500).json({ error: "Email failed to send" });
    }
    const sideEffects = [
      logSignup({ email, subscriberId: subscriber_id, token, sentAt, utm }),
      createResendContact(email),
    ];
    if (subscriber_id) {
      sideEffects.push(
        setEmail(subscriber_id, email),
        addTag(subscriber_id, "email_submitted"),
      );
    }
    await Promise.all(sideEffects);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
