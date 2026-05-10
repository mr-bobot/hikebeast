import { addTag } from "../lib/manychat.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { subscriber_id, token, page, browser_language } = req.body ?? {};
  // Need at least one identifier so the row can be matched to a person.
  // Anonymous /guide visits (PDF-link traffic with no params) hit Vercel
  // Analytics only, never the sheet — those are filtered out client-side.
  if (!subscriber_id && !token) {
    return res.status(400).json({ error: "subscriber_id or token required" });
  }

  const tasks = [];
  if (subscriber_id) {
    // Page-specific ManyChat tag so flows can branch on guide-visit signal.
    const tag = page === "guide" ? "visited_guide" : "site_landed";
    tasks.push(addTag(subscriber_id, tag));
  }

  const url = process.env.SHEETS_WEBHOOK_URL;
  if (url) {
    tasks.push(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "visit",
          secret: process.env.SHEETS_SECRET,
          subscriber_id: subscriber_id || "",
          token: token || "",
          page: page || "landing",
          visited_at: new Date().toISOString(),
          browser_language: typeof browser_language === "string" ? browser_language.slice(0, 20) : "",
        }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.error("Visit log failed:", err)),
    );
  }

  await Promise.all(tasks);

  return res.status(200).json({ ok: true });
}
