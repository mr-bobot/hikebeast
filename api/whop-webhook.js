import crypto from "node:crypto";

export const config = {
  api: { bodyParser: false },
};

const TOLERANCE_SECONDS = 300;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function timingSafeEqualBase64(a, b) {
  const aBuf = Buffer.from(a, "base64");
  const bBuf = Buffer.from(b, "base64");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifySignature({ id, timestamp, body, signatureHeader, secret }) {
  const cleaned = secret.startsWith("whsec_")
    ? secret.slice(6)
    : secret.startsWith("ws_")
    ? secret.slice(3)
    : secret;
  const key = Buffer.from(cleaned, "base64");
  const signed = `${id}.${timestamp}.${body}`;
  const expected = crypto.createHmac("sha256", key).update(signed).digest("base64");

  const parts = signatureHeader.split(" ");
  for (const part of parts) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig && timingSafeEqualBase64(sig, expected)) {
      return true;
    }
  }
  return false;
}

function pick(obj, ...paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object" || !(p in cur)) {
        ok = false;
        break;
      }
      cur = cur[p];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

async function logPurchase(fields) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "purchase",
        secret: process.env.SHEETS_SECRET,
        ...fields,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Purchase log failed:", err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("WHOP_WEBHOOK_SECRET not set");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const id = req.headers["webhook-id"];
  const timestamp = req.headers["webhook-timestamp"];
  const signatureHeader = req.headers["webhook-signature"];
  if (!id || !timestamp || !signatureHeader) {
    return res.status(400).json({ error: "Missing webhook headers" });
  }

  const now = Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(drift) || drift > TOLERANCE_SECONDS) {
    return res.status(400).json({ error: "Stale timestamp" });
  }

  const rawBody = await readRawBody(req);

  const valid = verifySignature({
    id,
    timestamp,
    body: rawBody,
    signatureHeader,
    secret,
  });
  if (!valid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  res.status(200).json({ ok: true });

  const type = event.action || event.type || event.event;
  if (type !== "payment.succeeded") return;

  const data = event.data ?? event;
  const email =
    pick(data, "user.email", "member.email", "customer.email", "email") || "";
  const amount =
    pick(data, "final_amount", "subtotal", "amount", "total") ?? "";
  const currency = pick(data, "currency", "currency_code") || "";
  const productId = pick(data, "product_id", "product.id") || "";
  const productName =
    pick(data, "product.title", "product.name", "plan.product.title", "plan.product.name") || "";
  const planId = pick(data, "plan_id", "plan.id") || "";
  const membershipId = pick(data, "membership_id", "membership.id") || "";
  const paymentId = pick(data, "id", "payment_id") || "";

  await logPurchase({
    email,
    amount,
    currency,
    product: productName || productId,
    product_id: productId,
    plan_id: planId,
    membership_id: membershipId,
    payment_id: paymentId,
    event_id: id,
    paid_at: new Date(Number(timestamp) * 1000).toISOString(),
  });
}
