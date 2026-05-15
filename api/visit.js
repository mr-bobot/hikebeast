import { addTag } from "../lib/manychat.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { subscriber_id, token, page, browser_language, event, source_page } = req.body ?? {};
  // Which landing-page variant this visit came from (themap, map3, de_map4,
  // etc.). Hardcoded per page in the page-visit fetch body; mirrors the
  // value `/api/checkout/session` already stamps into Stripe metadata so
  // page-conversion math can be done from the Sheet alone, without
  // cross-referencing Vercel Analytics for the denominator.
  const safeSourcePage = typeof source_page === "string" ? source_page.slice(0, 64) : "";
  // Whitelist of beacon event names. Anything else gets dropped before
  // hitting Apps Script so the column writers don't receive bogus values.
  const ALLOWED_EVENTS = new Set(["scrolled", "video_clicked"]);
  const safeEvent = typeof event === "string" && ALLOWED_EVENTS.has(event) ? event : "";

  // For default landing pings we need at least one identifier so the row
  // can be matched to a person. Anonymous /guide visits (PDF-link traffic
  // with no params) hit Vercel Analytics only, never the sheet — filtered
  // out client-side. Anonymous beacon events (`safeEvent`) are allowed:
  // Apps Script handleVisit treats them as match-only and no-ops when no
  // row matches, so the lambda just no-ops gracefully.
  if (!subscriber_id && !token && !safeEvent) {
    return res.status(400).json({ error: "subscriber_id or token required" });
  }

  const tasks = [];
  if (subscriber_id && !safeEvent) {
    // Page-specific ManyChat tag so flows can branch on guide-visit signal.
    // Only fire on the default landing visit, not for beacon events.
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
          event: safeEvent,
          visited_at: new Date().toISOString(),
          browser_language: typeof browser_language === "string" ? browser_language.slice(0, 20) : "",
          source_page: safeSourcePage,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.error("Visit log failed:", err)),
    );
  }

  await Promise.all(tasks);

  return res.status(200).json({ ok: true });
}
