import { Resend } from 'resend';

// Receives a user-submitted photo from the /full/ webapp's "Submit photo"
// modal and forwards it to Leon's inbox via Resend as an attachment. The
// frontend resizes images to 2000px on the long edge before posting, so
// payloads land in the 200 KB - 1 MB range -- comfortable below the Vercel
// serverless body limit (4.5 MB by default).
//
// Body shape (JSON):
//   { spot, title, ig, note, dataUrl }
// where dataUrl is a "data:image/...;base64,..." string.

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const TO = process.env.PHOTO_SUBMIT_TO || 'leon.helg@hotmail.de';
const FROM = process.env.PHOTO_SUBMIT_FROM || 'Hikebeast Submissions <hello@hikebeast.ch>';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'mailer_not_configured' });
  }

  const body = await readJson(req);
  const spot = String(body.spot || '').slice(0, 120);
  const title = String(body.title || '').slice(0, 200);
  const ig = String(body.ig || '').slice(0, 80).replace(/[^A-Za-z0-9._@-]/g, '');
  const note = String(body.note || '').slice(0, 1200);
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';

  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid_image' });

  const mime = m[1];
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const base64 = m[2];

  // Cap attachment size as a defense in depth (frontend already resizes,
  // but a malicious / buggy client could still post anything).
  if (base64.length > 6_000_000) {  // ~4.5 MB raw
    return res.status(413).json({ error: 'image_too_large' });
  }

  const safeSpot = spot.replace(/[^a-z0-9_#-]/gi, '_').slice(0, 80) || 'unknown';
  const filename = `${safeSpot}_${Date.now()}.${ext}`;

  const subject = `Photo submission: ${title || spot || '(untitled)'}`;
  const text = [
    `Spot: ${title}${spot ? ` (${spot})` : ''}`,
    `Photographer IG: ${ig || '(none provided)'}`,
    `Note: ${note || '(none)'}`,
    '',
    'Submitted via /full/ Submit Photo flow.',
  ].join('\n');

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: FROM,
      to: TO,
      subject,
      text,
      attachments: [{ filename, content: base64 }],
    });
    if (result.error) {
      console.error('resend error', result.error);
      return res.status(502).json({ error: 'mailer_failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('submit-photo error', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
