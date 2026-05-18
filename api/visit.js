import { addTag } from "../lib/manychat.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    subscriber_id,
    token,
    page,
    browser_language,
    event,
    utm_source,
    utm_medium,
    utm_campaign,
    source_page,
    hero_variant,
    active_ms,
    device_type,
    is_ig_webview,
  } = req.body ?? {};
  // Whitelist of beacon event names. Anything else gets dropped before
  // hitting Apps Script so the column writers don't receive bogus values.
  // `engaged` + `session_end` added 2026-05-16 for the v12 hero split test.
  const ALLOWED_EVENTS = new Set(["scrolled", "video_clicked", "engaged", "session_end"]);
  const safeEvent = typeof event === "string" && ALLOWED_EVENTS.has(event) ? event : "";
  // hero_variant is the v12 split-test bucket ID (e.g. "01"..."08"). Tight
  // regex so a malformed client can't pollute the column.
  const safeHeroVariant = typeof hero_variant === "string" && /^[a-z0-9_]{1,8}$/i.test(hero_variant)
    ? hero_variant
    : "";
  const safeActiveMs = Number.isFinite(active_ms) && active_ms >= 0 && active_ms < 86_400_000
    ? Math.round(active_ms)
    : 0;
  // device_type · `mobile` | `desktop` | `tablet`. Used to filter out
  // desktop-tab-on-second-monitor sessions that inflate time_on_site_ms.
  const safeDeviceType = typeof device_type === "string" && /^(mobile|desktop|tablet)$/.test(device_type)
    ? device_type
    : "";
  // is_ig_webview · `1` when user-agent contains "Instagram", else `0`.
  // Lets us isolate real IG-traffic engagement from QA/saved-URL visits.
  const safeIsIgWebview = typeof is_ig_webview === "string" && /^[01]$/.test(is_ig_webview)
    ? is_ig_webview
    : "";

  // UTM passthrough · cap each at 100 chars so a hostile or malformed link
  // can't blow up the Sheet row. Empty string when missing so Apps Script
  // overwrites the column with "" rather than skipping it.
  const safeUtmSource = typeof utm_source === "string" ? utm_source.slice(0, 100) : "";
  const safeUtmMedium = typeof utm_medium === "string" ? utm_medium.slice(0, 100) : "";
  const safeUtmCampaign = typeof utm_campaign === "string" ? utm_campaign.slice(0, 100) : "";

  // Which landing-page variant this visit came from (themap, map3, de_map4,
  // etc.). Hardcoded per page in the page-visit fetch body · mirrors the
  // value `/api/checkout/session` already stamps into Stripe metadata so
  // visit-rows and purchase-rows share the same source_page and per-page
  // conversion math can be done from the Sheet alone.
  const safeSourcePage = typeof source_page === "string" ? source_page.slice(0, 64) : "";

  // IP-derived country from Vercel's geolocation header. ISO-3166-1 alpha-2
  // (e.g. "DE", "CH", "US"). Server-side only · the page can't spoof it.
  // Empty when the request lacks the header (local dev, non-Vercel envs).
  const ipCountry = typeof req.headers["x-vercel-ip-country"] === "string"
    ? req.headers["x-vercel-ip-country"].slice(0, 4)
    : "";

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
          utm_source: safeUtmSource,
          utm_medium: safeUtmMedium,
          utm_campaign: safeUtmCampaign,
          source_page: safeSourcePage,
          ip_country: ipCountry,
          hero_variant: safeHeroVariant,
          active_ms: safeActiveMs,
          device_type: safeDeviceType,
          is_ig_webview: safeIsIgWebview,
        }),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => console.error("Visit log failed:", err)),
    );
  }

  await Promise.all(tasks);

  return res.status(200).json({ ok: true });
}
