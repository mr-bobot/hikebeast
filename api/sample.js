import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "Leon Helg <leon@hikebeast.ch>";
const REPLY_TO = "leon@hikebeast.ch";
const SAMPLE_URL = "https://hikebeast.ch/sample.pdf";

const html = (name = "there") => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;color:#1d1d1f;line-height:1.5;max-width:560px;">
    <p>Hey ${name},</p>
    <p>Thanks for grabbing the Swiss Hidden Gems free sample. Your guide is ready:</p>
    <p><a href="${SAMPLE_URL}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:500;">Open the guide →</a></p>
    <p style="color:#6e6e73;font-size:14px;">15 hand-picked spots to get you started. The full edition has 100+ hidden gems with exact GPS coordinates, wildcamp info, and lifetime updates — <a href="https://whop.com/gorped/hidden-gems-switzerland-e8/" style="color:#0071e3;">see it here</a>.</p>
    <p>Have fun out there,<br/>Leon</p>
  </div>
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.body ?? {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject: "Your Swiss Hidden Gems free sample",
      html: html(),
    });
    if (error) {
      console.error("Resend error:", error);
      return res.status(500).json({ error: "Email failed to send" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
