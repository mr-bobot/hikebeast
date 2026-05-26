import { addTag } from "../lib/manychat.js";
import {
  fireCapi,
  buildUserData,
  clientIpFromHeaders,
  clientUserAgentFromHeaders,
} from "../lib/capi.js";

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
    // visitor_id · client-generated UUID, sticky in localStorage.
    // Added 2026-05-24 for the AllVisits tracking sheet · the only
    // identifier that's present even for anonymous Linktree / ad
    // traffic that has no ManyChat subscriber_id.
    visitor_id,
    // referrer · document.referrer at landed time. Lets us trace
    // traffic source for AllVisits rows that lack utm_*.
    referrer,
    // Meta CAPI InitiateCheckout signal · sent by landing pages when
    // the buyer first interacts with the embedded Stripe form.
    session_id,
    value,
    currency,
    fbc,
    fbp,
  } = req.body ?? {};
  // Whitelist of beacon event names. Anything else gets dropped before
  // hitting Apps Script so the column writers don't receive bogus values.
  // `engaged` + `session_end` added 2026-05-16 for the v12 hero split test.
  // `initiate_checkout` added 2026-05-20 to mirror the pixel IC event
  // via Meta CAPI for better ad-optimization signal.
  const ALLOWED_EVENTS = new Set(["scrolled", "video_clicked", "engaged", "session_end", "initiate_checkout"]);
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

  // Identifiers for Signups attribution · subscriber_id (ManyChat),
  // token (legacy email funnel), safeEvent (beacon update on existing
  // row). Default-landed pings without ANY of these used to be 400'd ·
  // since 2026-05-24 anonymous landed beacons are accepted because we
  // now log them to AllVisits (separate spreadsheet) via visitor_id.
  // The Signups-side handleVisit is no-op'd in that case (no row
  // append without subscriber_id) so the change is purely additive.
  const safeVisitorId = typeof visitor_id === "string"
    ? visitor_id.slice(0, 64)
    : "";
  const safeReferrer = typeof referrer === "string" ? referrer.slice(0, 500) : "";
  const hasAnyId = !!(subscriber_id || token || safeEvent || safeVisitorId);
  if (!hasAnyId) {
    return res.status(400).json({ error: "subscriber_id, token, event, or visitor_id required" });
  }

  const tasks = [];
  if (subscriber_id && !safeEvent) {
    // Page-specific ManyChat tag so flows can branch on guide-visit signal.
    // Only fire on the default landing visit, not for beacon events.
    const tag = page === "guide" ? "visited_guide" : "site_landed";
    tasks.push(addTag(subscriber_id, tag));
  }

  const url = process.env.SHEETS_WEBHOOK_URL;
  const safeBrowserLang = typeof browser_language === "string" ? browser_language.slice(0, 20) : "";

  // Signups-side log · only fire when there's a ManyChat/token identifier
  // to match against. Apps Script handleVisit either appends a fresh
  // row (subscriber_id case) or no-ops (anonymous beacon). Direct/
  // Linktree/ad traffic skips this entirely and lives in AllVisits.
  if (url && (subscriber_id || token || safeEvent)) {
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
          browser_language: safeBrowserLang,
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

  // AllVisits sheet · REMOVED 2026-05-24. The page-side va('event',
  // {name: 'hero_seen', ...}) call hits Vercel Analytics directly with
  // hero_variant + source_page as custom-event properties. Aggregate
  // counts (variant impressions, buy rate per variant via UTM funnel)
  // are computed in the Vercel dashboard. Removed the second Apps
  // Script fetch because (a) it doubled lambda outbound calls for zero
  // user-visible benefit, (b) the va() approach is GDPR-aggregate by
  // design with no stable cross-session identifier, and (c) Vercel
  // Analytics is already wired on every /map9/ page header. visitor_id
  // and referrer are still accepted in the request body for the
  // Signups-side path's hasAnyId gate, but the AllVisits fork is gone.

  // Meta CAPI InitiateCheckout fire · only when the browser sends the
  // beacon after a real user interaction with #checkout. session_id is
  // the dedup key the browser pixel also passes as eventID.
  if (safeEvent === "initiate_checkout" && typeof session_id === "string" && session_id.startsWith("cs_")) {
    const safeFbc = typeof fbc === "string" ? fbc.slice(0, 200) : "";
    const safeFbp = typeof fbp === "string" ? fbp.slice(0, 100) : "";
    const safeValue = Number.isFinite(value) && value > 0 && value < 10_000 ? Number(value) : undefined;
    const safeCurrency = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
      ? currency.toUpperCase()
      : undefined;
    tasks.push(
      fireCapi({
        eventName: "InitiateCheckout",
        eventId: session_id,
        userData: buildUserData({
          country: ipCountry || undefined,
          fbc: safeFbc || undefined,
          fbp: safeFbp || undefined,
          clientIp: clientIpFromHeaders(req.headers) || undefined,
          clientUserAgent: clientUserAgentFromHeaders(req.headers) || undefined,
        }),
        customData: {
          value: safeValue,
          currency: safeCurrency,
        },
        sourceUrl: typeof req.headers?.referer === "string" ? req.headers.referer : undefined,
      }).catch(() => {}),
    );
  }

  await Promise.all(tasks);

  return res.status(200).json({ ok: true });
}
