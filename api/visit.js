import { addTag } from "../lib/manychat.js";
import {
  fireCapi,
  buildUserData,
  clientIpFromHeaders,
  clientUserAgentFromHeaders,
  sha256Hex,
} from "../lib/capi.js";

export const config = {
  // Vercel Hobby default lambda timeout is 10s. /api/visit does up to 4
  // parallel network calls (ManyChat tag, Signups Sheet write, AllVisits
  // Sheet write, Meta CAPI IC). Apps Script's 15s per-call timeout means
  // a single slow Sheet write can push past 10s and kill the lambda
  // mid-Promise.all, which dropped the CAPI IC POST silently. Observed
  // 2026-05-26: only 2 InitiateCheckout events landed at Meta for 1340
  // landing-page-views. Bumping to 30s matches the webhook config and
  // pairs with the reorder below (CAPI fires first + awaited) so CAPI
  // IC always completes before slower tasks can starve the lambda.
  maxDuration: 30,
};

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
    // Re-enabled 2026-05-26 for the revived AllVisits tracking sheet ·
    // the only identifier that's present even for anonymous Linktree /
    // ad traffic that has no ManyChat subscriber_id.
    visitor_id,
    // referrer · document.referrer at landed time. Lets us trace
    // traffic source for AllVisits rows that lack utm_*.
    referrer,
    // Classified traffic source · "manychat" | "affiliate" | "linktree"
    // | "facebook_ads" | "instagram_ads" | "referral" | "direct" |
    // "unknown". Computed client-side at page-load by HB_SOURCE, mirror
    // of the Vercel Analytics property of the same name.
    source,
    // Color scheme at page-load · "dark" | "light" | "unknown".
    // Derived via prefers-color-scheme media query.
    theme,
    // Affiliate slug from ?r=<username> (sticky 60-day localStorage
    // stash on the landing page). Lets the AllVisits sheet answer
    // "how much traffic did each affiliate bring".
    affiliate_ref,
    // Purchase-side fields, only on `purchased` event from success page.
    product,
    paid_at,
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
  // `purchased` added 2026-05-26 · fired from the success page after
  // /api/checkout/session confirms paid:true so the AllVisits sheet
  // gets a row joinable to the visit beacons by visitor_id.
  const ALLOWED_EVENTS = new Set(["scrolled", "video_clicked", "engaged", "session_end", "initiate_checkout", "purchased"]);
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
  // source / theme · 24-char cap, enum-ish so a hostile client can't
  // pollute the column with arbitrary strings. The classifier produces
  // values up to ~16 chars ("instagram_ads"), 24 is plenty of margin.
  const safeSource = typeof source === "string" ? source.slice(0, 24) : "";
  const safeTheme = typeof theme === "string" && /^(dark|light|unknown)$/.test(theme) ? theme : "";
  // affiliate_ref · same regex as the Sheet attribution path
  // (a-z0-9._-, 2-32 chars). Sticky from ?r=<slug> on landing.
  const safeAffiliateRef = typeof affiliate_ref === "string" && /^[a-z0-9._-]{2,32}$/.test(affiliate_ref)
    ? affiliate_ref
    : "";
  // purchase-only fields
  const safeProduct = typeof product === "string" ? product.slice(0, 64) : "";
  const safePaidAt = typeof paid_at === "string" ? paid_at.slice(0, 64) : "";
  // 2026-05-26 · relaxed gate. Anonymous traffic on older landing pages
  // (/map3-8/, /map/, /themap/, /gems/, /de/map*/, /sample/, /free/,
  // /read/, /guide/) doesn't send visitor_id (only /map9/ does), and
  // anonymous visitors have no subscriber_id/token from ManyChat ·
  // those were 400'd before this change, which made the bulk of real
  // traffic invisible to AllVisits. Now any request with at least a
  // source_page passes the gate · the row lands in AllVisits with an
  // empty visitor_id (impression-only, no per-event join possible, but
  // the count is what we actually need for those legacy pages). Pure
  // empty bodies (no subscriber_id / token / event / visitor_id /
  // source_page) still 400 so we filter out broken or hostile calls.
  const hasAnyId = !!(subscriber_id || token || safeEvent || safeVisitorId || safeSourcePage);
  if (!hasAnyId) {
    return res.status(400).json({ error: "subscriber_id, token, event, visitor_id, or source_page required" });
  }

  // ── Meta CAPI InitiateCheckout · fires FIRST and AWAITED ──────────────
  // 2026-05-27 reorder: previously this was just one of many parallel tasks
  // inside Promise.all([appsScript, manychat, capi]). Apps Script's slow
  // 15s timeout was killing the lambda before CAPI could complete its own
  // 5s POST, dropping the IC signal at Meta. Same root cause as the
  // webhook fix in PR #86. Now CAPI runs first, awaited; the slower
  // Sheet/ManyChat tasks come after in a Promise.all that can take the
  // remaining lambda budget (maxDuration: 30 above) without endangering
  // the CAPI delivery.
  if (safeEvent === "initiate_checkout" && typeof session_id === "string" && session_id.startsWith("cs_")) {
    const safeFbc = typeof fbc === "string" ? fbc.slice(0, 200) : "";
    const safeFbp = typeof fbp === "string" ? fbp.slice(0, 100) : "";
    const safeValue = Number.isFinite(value) && value > 0 && value < 10_000 ? Number(value) : undefined;
    const safeCurrency = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)
      ? currency.toUpperCase()
      : undefined;
    // external_id · stable cross-session identifier for Meta to match
    // this IC event back to the same person across sessions / devices.
    // Priority: ManyChat subscriber_id (most stable, but only ~30% of
    // traffic since direct-from-ad buyers don't have one), then
    // visitor_id (client-generated UUID, sticky in localStorage,
    // covers everyone). buildUserData expects a pre-hashed value here
    // (the fallback inside the helper is the already-hashed email
    // hash); we hash with sha256Hex to match. Events Manager prognosis
    // 2026-05-27: External ID alone +15.14% additional conversions
    // reported. We don't have email at IC time (buyer hasn't entered
    // it in Stripe yet) so this is the highest-impact field we can
    // add server-side without changing the landing-page POST shape.
    const icExternalIdRaw = subscriber_id || safeVisitorId || "";
    const icExternalId = icExternalIdRaw ? sha256Hex(icExternalIdRaw) : undefined;
    try {
      await fireCapi({
        eventName: "InitiateCheckout",
        eventId: session_id,
        userData: buildUserData({
          country: ipCountry || undefined,
          fbc: safeFbc || undefined,
          fbp: safeFbp || undefined,
          clientIp: clientIpFromHeaders(req.headers) || undefined,
          clientUserAgent: clientUserAgentFromHeaders(req.headers) || undefined,
          externalId: icExternalId,
        }),
        customData: {
          value: safeValue,
          currency: safeCurrency,
        },
        sourceUrl: typeof req.headers?.referer === "string" ? req.headers.referer : undefined,
      });
    } catch (err) {
      console.error("Meta CAPI IC failed (continuing):", err?.message || err);
    }
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
  // 2026-05-30 (Fix C): dropped `|| safeEvent` from the gate. Anonymous
  // engagement beacons (engaged / session_end / initiate_checkout /
  // purchased with no subscriber_id/token) were firing this call only to
  // no-op inside handleVisit, but the non-match-only ones (purchased,
  // initiate_checkout) still ACQUIRED the single Apps Script ScriptLock,
  // contending with the real `purchase` webhook write. Under FB-ad bursts
  // that lock contention dropped ~2.7% of buyers from Signups (86 "Lock
  // timeout" rows in the _errors tab, confirmed 2026-05-30). Removing the
  // no-op calls frees lock capacity for the writes that matter.
  if (url && (subscriber_id || token)) {
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

  // AllVisits sheet · re-enabled 2026-05-26. Fires for EVERY visit
  // that carries either a source_page (landed beacons from any landing
  // page) OR a visitor_id (engagement / session_end / purchased events
  // that update an existing row). initiate_checkout beacons (no
  // source_page, no visitor_id · only event + session_id + value +
  // currency + fbc + fbp) used to slip through here and Apps Script's
  // log_visit append-path would create useless empty rows · 2026-05-26
  // post-PR-#113 cleanup. The Meta CAPI fork below still fires for
  // initiate_checkout · those signals just don't belong in AllVisits.
  if (url && (safeSourcePage || safeVisitorId)) {
    const allEvent = safeEvent || "landed";
    tasks.push(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log_visit",
          secret: process.env.SHEETS_SECRET,
          event_type: allEvent,
          source_page: safeSourcePage,
          visitor_id: safeVisitorId,
          hero_variant: safeHeroVariant,
          subscriber_id: subscriber_id || "",
          referrer: safeReferrer,
          utm_source: safeUtmSource,
          utm_medium: safeUtmMedium,
          utm_campaign: safeUtmCampaign,
          browser_language: safeBrowserLang,
          device_type: safeDeviceType,
          is_ig_webview: safeIsIgWebview,
          ip_country: ipCountry,
          time_on_site_ms: safeActiveMs || undefined,
          source: safeSource,
          theme: safeTheme,
          affiliate_ref: safeAffiliateRef,
          product: safeProduct,
          paid_at: safePaidAt,
        }),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => console.error("AllVisits log failed:", err)),
    );
  }

  // (CAPI InitiateCheckout was moved ABOVE this block — see the 2026-05-27
  // comment block. Don't re-add it here; doing so would re-introduce the
  // parallel-with-AppsScript timeout problem we just fixed.)

  await Promise.all(tasks);

  return res.status(200).json({ ok: true });
}
