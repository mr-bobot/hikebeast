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

  // Synthesize _fbp if Meta's Pixel SDK didn't set it. Happens for the
  // ~20-40% of users who run an ad blocker (uBlock Origin, Brave, etc.)
  // — fbevents.js never loads, so the _fbp cookie stays empty and the
  // server-side CAPI Purchase / Lead events arrive without a browser
  // identifier. Events Manager on 2026-05-21 flagged this:
  //   "Similar advertisers who sent Browser ID (fbp) for Purchase saw a
  //    11.44% median increase in additional conversions reported."
  //
  // Same format Meta's SDK uses (fb.1.{timestamp}.{10-digit-random}) so
  // when the SDK DOES load later, it can read+reuse our synthesized
  // value rather than overwriting it. Persists 90 days like Meta's own
  // cookie.
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

  // Delay synthesis by one tick so Meta's SDK has a chance to set
  // _fbp first (when it's not blocked). On ad-blocked browsers the
  // SDK never sets the cookie, so we synthesize.
  setTimeout(synthesizeFbpIfMissing, 0);

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
