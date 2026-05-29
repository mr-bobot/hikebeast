// Meta-cookie capture · runs on every landing/funnel page that ships
// the Meta Pixel. Two responsibilities:
//
// 1. Synthesise `_fbc` from a `?fbclid=…` URL parameter the first time
//    the buyer lands on the site from a Facebook/Instagram ad. Meta's
//    Pixel SDK does this itself, but only on the FIRST page hit and
//    only if the SDK loads before any other script reads cookies. To
//    avoid that race, we set the cookie ourselves on every page that
//    has fbclid in the URL, using Meta's documented format.
//
// 2. Expose `window.HBMeta.getCookies()` so the inline checkout-fetch
//    code can read fbc + fbp values and forward them to the server.
//    Cookies are HttpOnly:false, SameSite=Lax, scoped to .hikebeast.ch
//    so they ride through the EN ↔ DE auto-redirect on first visit.
//
// _fbc format (per Meta):  fb.{subdomain-index}.{creation-timestamp-ms}.{fbclid}
// _fbp format (Meta-set):  fb.{subdomain-index}.{creation-timestamp-ms}.{random-10-digit}
//
// Subdomain-index = 1 for hikebeast.ch (root + one level deep, e.g. /map5/).
//
// Load this file with: <script src="/lib/meta-cookies.js"></script>
// AFTER the Meta Pixel init block (so `_fbp` is set by the SDK before
// we read it).

(function () {
  var COOKIE_DOMAIN = "";  // empty = current host; Meta recommends host-only for the Pixel cookies
  var FBC_LIFETIME_DAYS = 90;
  var SUBDOMAIN_INDEX = 1;

  function readCookie(name) {
    try {
      var prefix = name + "=";
      var parts = document.cookie.split(";");
      for (var i = 0; i < parts.length; i++) {
        var c = parts[i].trim();
        if (c.indexOf(prefix) === 0) return decodeURIComponent(c.substring(prefix.length));
      }
    } catch (e) {}
    return "";
  }

  function setCookie(name, value, days) {
    try {
      var expires = "";
      if (days) {
        var d = new Date();
        d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
        expires = "; expires=" + d.toUTCString();
      }
      document.cookie = name + "=" + encodeURIComponent(value)
        + expires + "; path=/; SameSite=Lax"
        + (COOKIE_DOMAIN ? "; domain=" + COOKIE_DOMAIN : "")
        + (location.protocol === "https:" ? "; Secure" : "");
    } catch (e) {}
  }

  // Pull fbclid out of the URL and persist as _fbc the first time we
  // see it. Subsequent navigations reuse the existing cookie (the user
  // clicked the same ad, but Meta wants the FIRST-touch fbclid). If a
  // new fbclid arrives later (different ad campaign), we DO overwrite —
  // that's also Meta's recommendation: most-recent click wins.
  function captureFbclid() {
    try {
      var url = new URLSearchParams(window.location.search);
      var fbclid = url.get("fbclid");
      if (!fbclid) return;
      var now = Date.now();
      var fbc = "fb." + SUBDOMAIN_INDEX + "." + now + "." + fbclid;
      setCookie("_fbc", fbc, FBC_LIFETIME_DAYS);
    } catch (e) {}
  }

  captureFbclid();

  // Synthesize _fbp if Meta's Pixel SDK hasn't already set it. Two
  // reasons this matters:
  //
  // 1. ~20-40% of users run an ad blocker (uBlock Origin, Brave, etc.)
  //    — fbevents.js never loads, so the _fbp cookie stays empty and
  //    the server-side CAPI Purchase / Lead events arrive without a
  //    browser identifier.
  //
  // 2. Even when NOT blocked, fbevents.js loads via `defer` so the SDK
  //    only sets _fbp AFTER document parsing finishes. Meanwhile the
  //    landing-page checkout-mount POST to /api/checkout/session fires
  //    on DOMContentLoaded and reads cookies synchronously — beating
  //    the SDK to the cookie jar.
  //
  // SYNCHRONOUS execution (no setTimeout) is critical: if we defer
  // synthesis by even one event-loop tick, mountCheckout()'s POST
  // reads an empty _fbp and CAPI gets no fbp. Events Manager
  // 2026-05-22 confirmed this in real data: "Server FBP 0 (0%)".
  //
  // Same format Meta's SDK uses (fb.1.{timestamp}.{10-digit-random}).
  // Per Meta docs: if a _fbp cookie already exists when the SDK
  // initializes, the SDK reuses it instead of generating a new one —
  // so our synthetic value ends up matching browser pixel events too.
  function synthesizeFbpIfMissing() {
    try {
      if (readCookie("_fbp")) return;
      var now = Date.now();
      // 10-digit pseudo-random integer. Doesn't need cryptographic
      // entropy — _fbp is a session-correlation token, not a secret.
      var rand = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
      var fbp = "fb." + SUBDOMAIN_INDEX + "." + now + "." + rand;
      setCookie("_fbp", fbp, FBC_LIFETIME_DAYS);
    } catch (e) {}
  }

  synthesizeFbpIfMissing();

  // Public helper for inline scripts that POST to our APIs. Returns
  // empty strings if a cookie is missing, never throws.
  window.HBMeta = window.HBMeta || {};
  window.HBMeta.getCookies = function () {
    return {
      fbc: readCookie("_fbc"),
      fbp: readCookie("_fbp"),
    };
  };
})();
