/* === Social layer · favorites + extended nav · pure frontend, no backend ===
 *
 * Storage:
 *   localStorage 'hb:fav:v1' = JSON array of spot keys
 *   spot key format = `${chapter_id}#${anchor}`  (e.g. "central#engstligen_falls")
 *
 * On every page that loads this script we:
 *   1. Inject extended top-bar nav (Browse · Saved · Random · existing pill)
 *   2. Inject a heart toggle on every `.slide-spot[id]` card
 *   3. Expose window.HB.favorites for ad-hoc use (browse, saved, map pages)
 */
(function () {
  // Defensive theme reapply. The <head> bootstrap in every page is
  // SUPPOSED to set data-theme="dark" before paint when the user has
  // not explicitly chosen light mode (default is now dark, per the
  // dark-default rollout). On some pages — notably the spot detail
  // pages until 2026-05-25 — the bootstrap was missing entirely, so
  // the page rendered light and only flipped to dark after this
  // script ran. Fixed in build-spot-pages.mjs by adding the head
  // bootstrap, but keeping this belt-and-suspenders for bfcache
  // restores and pages we haven't touched yet.
  try {
    if (localStorage.getItem('hb-theme') !== 'light'
        && document.documentElement.getAttribute('data-theme') !== 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      const tc = document.querySelector('meta[name="theme-color"]');
      if (tc) tc.setAttribute('content', '#0b0d10');
    }
  } catch (_e) { /* localStorage blocked in some private modes */ }

  const KEY = 'hb:fav:v1';
  const NO_KEY = 'hb:skipped:v1';
  const SESSION_KEY = 'hb:session:v1';
  const W = window;

  // i18n: full/lib/i18n.js (loaded in <head>) defines window.t + window.hbI18n.
  // Guarantee window.t exists so this script never throws if i18n failed to
  // load; referenced as W.t(...) throughout to avoid colliding with the local
  // `t` variables used inside some handlers (theme string, event target).
  if (typeof W.t !== 'function') {
    W.t = function (k) { return k; };
    W.t.plural = function (k, n) { return String(n); };
  }

  // --- Compute relative path back to /full/ from the current URL.
  // /full/                     -> ''
  // /full/central/             -> '../'
  // /full/map/                 -> '../'
  // /full/something/sub/       -> '../../'
  function computeRel() {
    const path = location.pathname;
    const idx = path.indexOf('/full/');
    if (idx < 0) return '';
    const tail = path.slice(idx + '/full/'.length).replace(/index\.html$/, '');
    const segs = tail.split('/').filter(Boolean);
    return '../'.repeat(segs.length);
  }
  const REL = computeRel();

  // --- Identify which chapter dir we're in (or null on home / map / browse / saved).
  // For per-spot detail pages at /full/spot/<spotId>/ the path segment is
  // 'spot', not a chapter — fall back to the data-chapter attribute baked
  // onto the Back pill so the multi-image carousel + favorites still wire.
  function currentChapterId() {
    const m = location.pathname.match(/\/full\/([^/]+)\/?/);
    if (!m) return null;
    const seg = m[1];
    const known = new Set(['intro', 'central', 'valais', 'fribourg', 'western', 'eastern', 'ticino', 'beyond']);
    if (known.has(seg)) return seg;
    if (seg === 'spot') {
      const back = document.querySelector('.hb-back[data-chapter]');
      const ch = back?.getAttribute('data-chapter');
      if (ch && known.has(ch)) return ch;
    }
    return null;
  }

  // --- Hidden URL filter: ?by=<handle>[,<handle>...] keeps only photos
  // credited to one of those handles (case-insensitive, with or without
  // leading "@"). Originally added to Explore for screen-record demos
  // ("every Leon shot in the guide"); promoted here so every screen —
  // spot detail, chapter scroll, map, saved, swipe, home rows — applies
  // the same view. Spots with zero matching photos drop from listings;
  // navigation links are rewritten in boot() so the filter sticks across
  // page hops.
  const BY_RAW = (() => {
    try { return new URLSearchParams(location.search).get('by') || null; }
    catch { return null; }
  })();
  const BY_HANDLES = (() => {
    if (!BY_RAW) return null;
    const h = BY_RAW.split(',')
      .map(s => s.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
    return h.length ? new Set(h) : null;
  })();
  // ── Preview mode (recording-safe view for affiliates) ───────────────
  // Toggle persisted by /full/affiliate/materials/ to
  // localStorage['hb:preview_mode:v1'] = '1'. When on, the webapp
  // shows a redacted "demo" view so creators can record screen
  // captures without exposing all paid spots / un-released photos.
  //
  // Rule set, per Leon (2026-05-26):
  //   - chapter card list · only spots in PREVIEW_ALLOWED_SPOTS survive
  //   - browse + swipe photos · keep only credit === '@leon.helg'
  //     (single-creator hero so recordings look consistent)
  //   - spot-detail photos · keep '@leon.helg', '@oliwear.j', and
  //     Unsplash photographers (FirstName-LastName style credits ·
  //     they read as "guest photography" rather than competing-creator
  //     IG handles which we don't want visible in promo recordings)
  //
  // The filter composes with the existing ?by=<handle> URL filter ·
  // both have to pass for a photo to be visible.
  const PREVIEW_MODE = (() => {
    try { return localStorage.getItem('hb:preview_mode:v1') === '1'; }
    catch { return false; }
  })();
  // Curated list of recording-safe spot slugs. Leon populates this ·
  // until then the set is empty, which means preview mode hides ALL
  // chapter / browse / swipe content (safe default · keeps the
  // pre-curation state unambiguously "nothing to record yet").
  const PREVIEW_ALLOWED_SPOTS = new Set([
    'tannhorn',
    'augstmatthorn',
    'fulberg',
    'les_cheserys',
    'viewpoint_beatenberg',
    'riffelsee',
    'schafler',
    'falensee',
    'saxer_lucke',
    'bachalpsee',
    'oeschinensee',
    'seealpsee',
    'hardergrat_trail',
    'joriseen',
    'limmernsee',
    'triftbrucke',
    'morteratsch_glacier',
    'gelmersee',
    'pic_de_jallouvre',
    'batoni_wasserfallarena',
  ]);
  function previewSpotAllowed(slug) {
    if (!PREVIEW_MODE) return true;
    if (!slug) return false;
    return PREVIEW_ALLOWED_SPOTS.has(String(slug));
  }
  function previewCreditMode() {
    // 'strict' on browse / swipe (single-creator), 'lenient' on
    // spot-detail (Leon + Oliver + Unsplash), 'off' elsewhere.
    const p = location.pathname || '';
    if (/\/(browse|swipe)\//.test(p)) return 'strict';
    if (/\/spot\//.test(p))           return 'lenient';
    return 'off';
  }
  function previewCreditAllowed(credit) {
    if (!PREVIEW_MODE) return true;
    const mode = previewCreditMode();
    if (mode === 'off') return true;
    if (!credit) return false;
    const c = String(credit);
    if (mode === 'strict') return c === '@leon.helg';
    // 'lenient' · Leon, Oliver, or Unsplash. Unsplash credits are
    // FirstName-LastName format · always start with a capital letter
    // and never carry the @ prefix that IG handles do. zimydakid is
    // lowercase + no @ → fails the capital check, correctly excluded.
    if (c === '@leon.helg' || c === '@oliwear.j') return true;
    return /^[A-Z]/.test(c);
  }

  function matchesByCredit(credit) {
    // Preview mode tightens the photo filter further · runs first so
    // we drop the credit before the ?by= filter even looks at it.
    if (!previewCreditAllowed(credit)) return false;
    if (!BY_HANDLES) return true;
    if (!credit) return false;
    return BY_HANDLES.has(String(credit).toLowerCase().replace(/^@/, ''));
  }
  // Append ?by=<raw> to a same-origin URL (preserving any existing
  // query / hash). Returns the input unchanged when the filter isn't
  // active or the URL is external/anchor/script.
  function withBy(href) {
    if (!BY_RAW || !href) return href;
    if (/^(https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(href)) return href;
    if (href === '#' || href.startsWith('#')) return href;
    if (/[?&]by=/.test(href)) return href;
    const [base, hash] = href.split('#');
    const sep = base.includes('?') ? '&' : '?';
    const param = 'by=' + encodeURIComponent(BY_RAW);
    return base + sep + param + (hash ? '#' + hash : '');
  }

  // ── Shared Convex client ──────────────────────────────────────────────
  // One ConvexClient (= one websocket) shared by spots, session, favorites,
  // and swipes. Returns null if Convex isn't configured on the page.
  let convexClient = null;
  function getConvex() {
    if (convexClient) return convexClient;
    if (!W.convex || !W.HB_CONVEX_URL) return null;
    try { convexClient = new W.convex.ConvexClient(W.HB_CONVEX_URL); }
    catch (e) { console.warn("Convex client init failed:", e); convexClient = null; }
    return convexClient;
  }

  // ── Session ───────────────────────────────────────────────────────────
  // Token lives in localStorage so it survives reloads. The reactive
  // `auth:currentUser` query keeps `user` in sync with the server (e.g.
  // server-side session revocation flips this tab's UI to signed-out).
  const session = (() => {
    let token = null;
    let user  = null;
    let unsubCurrentUser = null;
    const subs = new Set();
    function notify() { subs.forEach(fn => { try { fn(user); } catch {} }); }

    function readToken() {
      try { return localStorage.getItem(SESSION_KEY) || null; } catch { return null; }
    }
    function writeToken(t) {
      try {
        if (t) localStorage.setItem(SESSION_KEY, t);
        else   localStorage.removeItem(SESSION_KEY);
      } catch {}
    }

    function setupReactive() {
      if (unsubCurrentUser) { try { unsubCurrentUser(); } catch {} unsubCurrentUser = null; }
      const c = getConvex();
      if (!c || !token) return;
      const sub = c.onUpdate(
        "auth:currentUser",
        { sessionToken: token },
        (u) => {
          const before = user ? user._id : null;
          const after  = u    ? u._id    : null;
          user = u || null;
          // Server says this token is invalid (revoked or expired) — drop it
          // locally so favorites/swipes flip back to anonymous mode.
          if (!user && token) {
            token = null;
            writeToken(null);
            favorites._reattach();
            visited._reattach();
            swipes._reattach();
          }
          if (before !== after) notify();
        },
        (err) => { console.warn("currentUser subscription error:", err); },
      );
      unsubCurrentUser = sub.unsubscribe;
    }

    async function signIn(usernameOrEmail, password) {
      const c = getConvex();
      if (!c) throw new Error("Convex client unavailable");
      const result = await c.mutation("auth:signIn", { usernameOrEmail, password });
      token = result.sessionToken;
      user  = result.user;
      writeToken(token);
      // Migrate anything saved while anonymous BEFORE we flip the favorites
      // store over to Convex — bulkAdd is idempotent so re-entry is safe.
      try { await migrateLocalToServer(token); } catch (e) { console.warn("migration:", e); }
      setupReactive();
      favorites._reattach();
      visited._reattach();
      swipes._reattach();
      notify();
      return user;
    }

    async function signOut() {
      const tok = token;
      // Local clear first so the UI reacts even if the network call hangs.
      token = null;
      user  = null;
      writeToken(null);
      if (unsubCurrentUser) { try { unsubCurrentUser(); } catch {} unsubCurrentUser = null; }
      favorites._reattach();
      visited._reattach();
      swipes._reattach();
      notify();
      // Server-side logout: revoke the Convex session AND clear the
      // hb_full_auth cookie that middleware.js checks on /full/*. We hit
      // /api/login with action=logout (the same endpoint also handles
      // login flows -- consolidated to fit the function-count budget).
      try {
        await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logout', sessionToken: tok || null }),
          credentials: 'same-origin',
        });
      } catch {}
      // Cookie is gone — the next /full/* request would bounce to /login
      // anyway, so navigate explicitly for a clean transition.
      try { location.assign('/login/'); } catch {}
    }

    function init() {
      token = readToken();
      setupReactive();
    }

    return {
      init,
      signIn,
      signOut,
      token: () => token,
      user:  () => user,
      isSignedIn: () => !!token,
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
  })();

  // ── localStorage → Convex migration on first sign-in ─────────────────
  // Anonymous favorites + skipped-swipes get copied into the user's Convex
  // rows the first time they sign in. Idempotent: bulkAdd skips duplicates.
  // localStorage is cleared on success so the next anonymous session
  // doesn't see ghost state.
  async function migrateLocalToServer(token) {
    const c = getConvex();
    if (!c || !token) return;

    let favKeys = [];
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) favKeys = arr.filter(k => typeof k === "string");
      }
    } catch {}
    if (favKeys.length) {
      try {
        await c.mutation("userFavorites:bulkAdd", { sessionToken: token, spotKeys: favKeys });
        try { localStorage.removeItem(KEY); } catch {}
      } catch (e) { console.warn("favorites migration failed:", e); }
    }

    let noKeys = [];
    try {
      const raw = localStorage.getItem(NO_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) noKeys = arr.filter(k => typeof k === "string");
      }
    } catch {}
    if (noKeys.length) {
      try {
        await c.mutation("userSwipes:bulkAdd", {
          sessionToken: token,
          decisions: noKeys.map(spotKey => ({ spotKey, decision: "no" })),
        });
        try { localStorage.removeItem(NO_KEY); } catch {}
      } catch (e) { console.warn("swipes migration failed:", e); }
    }
  }

  // ── Favorites store ───────────────────────────────────────────────────
  // Public API (has/list/count/toggle/set/clear/subscribe) is unchanged
  // from the original localStorage-only version, so every page that calls
  // HB.favorites continues to work without edits. Internally:
  //   - signed out  → mirror reads/writes localStorage (`hb:fav:v1`)
  //   - signed in   → mirror is fed by a reactive Convex query, mutations
  //                   call userFavorites:* (with optimistic local update)
  // The mirror is a Set kept in memory so .has/.list/.count remain sync.
  const favorites = (() => {
    let mirror = new Set();
    let serverActive = false;
    let unsub = null;
    let ready = false;  // false until first definitive state (local or server)
    const subs = new Set();
    function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

    function readLocal() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
      } catch { return new Set(); }
    }
    function writeLocal(set) {
      try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch {}
    }

    function setEqual(a, b) {
      if (a.size !== b.size) return false;
      for (const k of a) if (!b.has(k)) return false;
      return true;
    }

    function applyServer(spotKeys) {
      const next = new Set(Array.isArray(spotKeys) ? spotKeys : []);
      const wasReady = ready;
      ready = true;
      if (setEqual(mirror, next) && wasReady) return;
      mirror = next;
      notify();
    }

    function attach() {
      if (unsub) { try { unsub(); } catch {} unsub = null; }
      const c = getConvex();
      const tok = session.token();
      if (c && tok) {
        serverActive = true;
        // Wipe stale local state silently and mark not-ready so consumer
        // pages can hold off rendering empty state until the subscription's
        // first response arrives. (Was: clear + notify, which caused a
        // visible "no favorites yet" flash before server data arrived.)
        mirror = new Set();
        ready = false;
        const sub = c.onUpdate(
          "userFavorites:list",
          { sessionToken: tok },
          (res) => {
            if (res && res.signedIn) applyServer(res.spotKeys);
          },
          (err) => { console.warn("favorites subscription error:", err); },
        );
        unsub = sub.unsubscribe;
      } else {
        serverActive = false;
        applyServer([...readLocal()]);
      }
    }

    return {
      has(key)   { return mirror.has(key); },
      list()     { return [...mirror]; },
      count()    { return mirror.size; },
      toggle(key) {
        if (!key) return false;
        const wasOn = mirror.has(key);
        // Optimistic mirror update so consumers repaint immediately.
        if (wasOn) mirror.delete(key); else mirror.add(key);
        notify();
        if (serverActive) {
          const c = getConvex(); const tok = session.token();
          if (c && tok) {
            c.mutation("userFavorites:toggle", { sessionToken: tok, spotKey: key })
              .catch(err => {
                console.warn("favorites:toggle failed, reverting:", err);
                if (wasOn) mirror.add(key); else mirror.delete(key);
                notify();
              });
          }
        } else {
          writeLocal(mirror);
        }
        return mirror.has(key);
      },
      set(key, on) {
        if (!key) return;
        const wasOn = mirror.has(key);
        if (wasOn === on) return;
        if (on) mirror.add(key); else mirror.delete(key);
        notify();
        if (serverActive) {
          const c = getConvex(); const tok = session.token();
          if (c && tok) {
            c.mutation("userFavorites:setFavorite", { sessionToken: tok, spotKey: key, on })
              .catch(err => {
                console.warn("favorites:set failed, reverting:", err);
                if (on) mirror.delete(key); else mirror.add(key);
                notify();
              });
          }
        } else {
          writeLocal(mirror);
        }
      },
      clear() {
        if (mirror.size === 0) return;
        const before = mirror;
        mirror = new Set();
        notify();
        if (serverActive) {
          const c = getConvex(); const tok = session.token();
          if (c && tok) {
            c.mutation("userFavorites:clearAll", { sessionToken: tok })
              .catch(err => {
                console.warn("favorites:clear failed, reverting:", err);
                mirror = before;
                notify();
              });
          }
        } else {
          writeLocal(mirror);
        }
      },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      // Pages hold off rendering "no favorites yet" empty state until this
      // returns true. It flips to true after the first definitive response
      // (localStorage or first Convex push for signed-in users).
      ready() { return ready; },
      // Internal: re-attach to server or fall back to local — called by
      // session on sign-in / sign-out and by the cross-tab storage handler.
      _reattach: attach,
      _onLocalStorageChanged() {
        if (!serverActive) applyServer([...readLocal()]);
      },
    };
  })();

  // ── "Been there" pile (paid users only) ──────────────────────────────
  // Same shape as `favorites` but server-only — there is no
  // localStorage fallback and the API simply reports an empty list +
  // signedIn:false to anonymous visitors. Pages and the kebab menu
  // hide the feature in that case so non-paying customers never see
  // the affordance. On sign-in/out the façade re-attaches via
  // session.subscribe().
  const visited = (() => {
    let mirror = new Set();
    let serverActive = false;
    let unsub = null;
    let ready = false;          // first definitive response received
    let signedIn = false;       // mirror of session state for fast callers
    const subs = new Set();
    function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

    function setEqual(a, b) {
      if (a.size !== b.size) return false;
      for (const k of a) if (!b.has(k)) return false;
      return true;
    }

    function applyServer(spotKeys) {
      const next = new Set(Array.isArray(spotKeys) ? spotKeys : []);
      const wasReady = ready;
      ready = true;
      if (setEqual(mirror, next) && wasReady) return;
      mirror = next;
      notify();
    }

    function attach() {
      if (unsub) { try { unsub(); } catch {} unsub = null; }
      const c = getConvex();
      const tok = session.token();
      mirror = new Set();
      if (c && tok) {
        serverActive = true;
        signedIn = true;
        ready = false;
        const sub = c.onUpdate(
          "userVisited:list",
          { sessionToken: tok },
          (res) => {
            if (res && res.signedIn) applyServer(res.spotKeys);
          },
          (err) => { console.warn("visited subscription error:", err); },
        );
        unsub = sub.unsubscribe;
      } else {
        // Anonymous: feature disabled. Mark ready so consumers don't
        // wait, but signedIn stays false so the UI hides the entry
        // points (kebab item, menu sheet row).
        serverActive = false;
        signedIn = false;
        ready = true;
        notify();
      }
    }

    return {
      has(key)   { return mirror.has(key); },
      list()     { return [...mirror]; },
      count()    { return mirror.size; },
      ready()    { return ready; },
      signedIn() { return signedIn; },
      toggle(key) {
        if (!key || !signedIn) return false;
        const wasOn = mirror.has(key);
        if (wasOn) mirror.delete(key); else mirror.add(key);
        notify();
        const c = getConvex(); const tok = session.token();
        if (c && tok) {
          c.mutation("userVisited:toggle", { sessionToken: tok, spotKey: key })
            .catch(err => {
              console.warn("visited:toggle failed, reverting:", err);
              if (wasOn) mirror.add(key); else mirror.delete(key);
              notify();
            });
        }
        return mirror.has(key);
      },
      set(key, on) {
        if (!key || !signedIn) return;
        const wasOn = mirror.has(key);
        if (wasOn === on) return;
        if (on) mirror.add(key); else mirror.delete(key);
        notify();
        const c = getConvex(); const tok = session.token();
        if (c && tok) {
          c.mutation("userVisited:setVisited", { sessionToken: tok, spotKey: key, on })
            .catch(err => {
              console.warn("visited:set failed, reverting:", err);
              if (on) mirror.delete(key); else mirror.add(key);
              notify();
            });
        }
      },
      clear() {
        if (!signedIn || mirror.size === 0) return;
        const before = mirror;
        mirror = new Set();
        notify();
        const c = getConvex(); const tok = session.token();
        if (c && tok) {
          c.mutation("userVisited:clearAll", { sessionToken: tok })
            .catch(err => {
              console.warn("visited:clear failed, reverting:", err);
              mirror = before;
              notify();
            });
        }
      },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      _reattach: attach,
    };
  })();

  // ── Swipe history store ──────────────────────────────────────────────
  // Mirrors the same shape as favorites but tracks "save" + "no" decisions.
  // Anonymous users keep "no" decisions in `hb:skipped:v1` (existing key)
  // and "save" decisions implicitly via the favorites localStorage. Signed-in
  // users get the unified server view (`userSwipes:list`).
  //
  // Frontend convenience: HB.swipes.has(k) returns true if the spot was
  // swiped either way, so the swipe deck filter becomes a single check
  // instead of "not favorited AND not skipped".
  const swipes = (() => {
    let serverMirror = new Map();   // spotKey → "save" | "no"
    let serverActive = false;
    let unsub = null;
    const subs = new Set();
    function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

    function readLocalNo() {
      try {
        const raw = localStorage.getItem(NO_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
      } catch { return new Set(); }
    }
    function writeLocalNo(set) {
      try { localStorage.setItem(NO_KEY, JSON.stringify([...set])); } catch {}
    }

    function applyServer(decisions) {
      const next = new Map();
      for (const d of decisions || []) if (d && d.spotKey) next.set(d.spotKey, d.decision);
      // Cheap equality check
      let same = next.size === serverMirror.size;
      if (same) for (const [k, v] of next) if (serverMirror.get(k) !== v) { same = false; break; }
      if (same) return;
      serverMirror = next;
      notify();
    }

    function attach() {
      if (unsub) { try { unsub(); } catch {} unsub = null; }
      const c = getConvex();
      const tok = session.token();
      if (c && tok) {
        serverActive = true;
        if (serverMirror.size) { serverMirror = new Map(); notify(); }
        const sub = c.onUpdate(
          "userSwipes:list",
          { sessionToken: tok },
          (res) => {
            if (res && res.signedIn) applyServer(res.decisions);
          },
          (err) => { console.warn("swipes subscription error:", err); },
        );
        unsub = sub.unsubscribe;
      } else {
        serverActive = false;
        serverMirror = new Map();
        notify();
      }
    }

    function get(key) {
      if (!key) return null;
      if (serverActive) return serverMirror.get(key) || null;
      if (favorites.has(key)) return "save";
      if (readLocalNo().has(key)) return "no";
      return null;
    }

    function record(key, decision) {
      if (!key) return;
      if (decision !== "save" && decision !== "no") return;

      if (serverActive) {
        const before = serverMirror.get(key) || null;
        if (before !== decision) {
          serverMirror.set(key, decision);
          notify();
        }
        const c = getConvex(); const tok = session.token();
        if (c && tok) {
          c.mutation("userSwipes:record", { sessionToken: tok, spotKey: key, decision })
            .catch(err => {
              console.warn("swipes:record failed, reverting:", err);
              if (before) serverMirror.set(key, before); else serverMirror.delete(key);
              notify();
            });
        }
        // A "save" swipe also flips the heart on every other surface.
        if (decision === "save") favorites.set(key, true);
      } else {
        if (decision === "save") {
          favorites.set(key, true);
          const noSet = readLocalNo();
          if (noSet.has(key)) { noSet.delete(key); writeLocalNo(noSet); }
        } else {
          // "no" is mutually exclusive with favorite.
          if (favorites.has(key)) favorites.set(key, false);
          const noSet = readLocalNo();
          noSet.add(key);
          writeLocalNo(noSet);
        }
        notify();
      }
    }

    function undo(key) {
      if (!key) return;
      if (serverActive) {
        const before = serverMirror.get(key) || null;
        if (!before) return;
        serverMirror.delete(key);
        notify();
        const c = getConvex(); const tok = session.token();
        if (c && tok) {
          c.mutation("userSwipes:undo", { sessionToken: tok, spotKey: key })
            .catch(err => {
              console.warn("swipes:undo failed, reverting:", err);
              serverMirror.set(key, before);
              notify();
            });
        }
        if (before === "save") favorites.set(key, false);
      } else {
        const noSet = readLocalNo();
        let changed = false;
        if (noSet.has(key))     { noSet.delete(key); writeLocalNo(noSet); changed = true; }
        if (favorites.has(key)) { favorites.set(key, false);              changed = true; }
        if (changed) notify();
      }
    }

    function list() {
      if (serverActive) {
        return [...serverMirror.entries()].map(([spotKey, decision]) => ({ spotKey, decision }));
      }
      const out = [];
      for (const k of favorites.list()) out.push({ spotKey: k, decision: "save" });
      for (const k of readLocalNo())    out.push({ spotKey: k, decision: "no" });
      return out;
    }

    // In local mode, swipes virtual-merges favorites — repaint when favorites changes.
    favorites.subscribe(() => { if (!serverActive) notify(); });

    return {
      has(key) { return get(key) !== null; },
      get,
      record,
      undo,
      list,
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      _reattach: attach,
      _onLocalStorageChanged() {
        if (!serverActive) notify();
      },
    };
  })();

  // --- Build a key from raw inputs.
  function keyFor(chapterId, anchor) {
    if (!chapterId || !anchor) return null;
    return `${chapterId}#${anchor}`;
  }

  // --- Kicker normaliser. The catalog uses a mix of categorical kickers
  // ("WATERFALLS", "VALLEYS") and editorial sentences ("A HIDDEN LAKE IN..."")
  // We display the categorical ones in singular Title Case so cards read
  // "Waterfall" rather than "WATERFALLS". Editorial sentences are returned
  // capitalised but otherwise unchanged.
  const KICKER_SINGULAR = {
    'WATERFALLS': 'Waterfall',
    'VALLEYS': 'Valley',
    'LAKES': 'Lake',
    'GLACIERS': 'Glacier',
    'GLACIER LAKES': 'Glacier lake',
    'ALPINE LAKES': 'Alpine lake',
    'RIDGES': 'Ridge',
    'PEAKS': 'Peak',
    'SUMMITS': 'Summit',
    'VIEWPOINTS': 'Viewpoint',
    'BRIDGES': 'Bridge',
    'SUSPENSION BRIDGES': 'Suspension bridge',
    'CABLE CARS': 'Cable car',
    'VILLAGES': 'Village',
    'CAMPER SPOTS': 'Camper spot',
    'CHAPELS': 'Chapel',
    'GORGES': 'Gorge',
    'RIVERS': 'River',
    'ROADS': 'Road',
    'LANDSCAPES': 'Landscape',
    'REFLECTIONS': 'Reflection',
    'HIDDEN GEMS': 'Hidden gem',
    'EXTRAS': 'Extra',
  };
  function singularKicker(raw) {
    if (!raw) return '';
    const upper = raw.trim();
    if (KICKER_SINGULAR[upper]) return KICKER_SINGULAR[upper];
    // Editorial sentence: title-case the first letter, lowercase the rest.
    const lower = upper.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  // Properties: a spot can belong to multiple categories so the browse
  // filter lets users find "all waterfalls", "all lakes", etc. Primary
  // source is the categorical kicker; secondary is keyword-matching the
  // title (handles editorial-kicker spots like "A HIDDEN LAKE…").
  // Properties cover both categorical kickers ("WATERFALLS", "LAKES") and
  // editorial-kicker spots whose title gives away the type ("...Waterfall",
  // "...lake"). Regexes accept singular AND plural so "WATERFALLS" matches the
  // 'waterfall' rule.
  const PROPERTY_RULES = [
    { id: 'waterfall', label: 'Waterfall', re: /waterfalls?|cascades?|cascatas?|wasserfalls?|\bfalls?\b/i },
    { id: 'lake',      label: 'Lake',      re: /\blakes?\b|\bsees?\b|\blacs?\b/i },
    { id: 'glacier',   label: 'Glacier',   re: /glaciers?/i },
    { id: 'valley',    label: 'Valley',    re: /valleys?|\bvalle\b|\btal\b/i },
    { id: 'ridge',     label: 'Ridge',     re: /\bridges?\b|grats?\b/i },
    { id: 'peak',      label: 'Peak',      re: /peaks?|summits?|horns?\b|spitz|pizzo|aiguille/i },
    { id: 'viewpoint', label: 'Viewpoint', re: /viewpoints?|panorama|outlook/i },
    { id: 'bridge',    label: 'Bridge',    re: /bridges?|br[üu]cke|brug|ponts?/i },
    { id: 'village',   label: 'Village',   re: /villages?|hamlet|chalets?/i },
    { id: 'gorge',     label: 'Gorge',     re: /gorges?|canyons?|schluchts?/i },
    { id: 'hut',       label: 'Hut',       re: /\bhuts?\b|h[üu]tte|cabane|capanna|berghaus/i },
    { id: 'cable',     label: 'Cable car', re: /cable\s*cars?|seilbahn|gondola/i },
    { id: 'river',     label: 'River',     re: /\brivers?\b|fluss/i },
    { id: 'road',      label: 'Road',      re: /\broads?\b|pass(?!es)\b/i },
  ];

  function propertiesOf(spot) {
    // Single source of truth: regex sweep over title+kicker. Anything not
    // covered by PROPERTY_RULES doesn't get a chip (no leaky labels).
    const hay = `${spot.title || ''} ${spot.kicker || ''}`;
    const out = [];
    for (const rule of PROPERTY_RULES) {
      if (rule.re.test(hay)) out.push(rule.id);
    }
    return out;
  }
  // Stable list of properties that actually appear in the catalog -- used
  // to render filter chips in browse. Sorted by count desc so the most
  // useful chips are first.
  function buildPropertyIndex(spots) {
    const counts = {};
    spots.forEach(s => propertiesOf(s).forEach(p => { counts[p] = (counts[p] || 0) + 1; }));
    const known = new Map(PROPERTY_RULES.map(r => [r.id, r.label]));
    return Object.keys(counts)
      .filter(id => counts[id] > 0)
      .map(id => ({ id, label: known.get(id) || id, count: counts[id] }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  // ── Spots store ────────────────────────────────────────────────────────
  // Authoritative source for spot metadata + photos. Single subscription
  // to the Convex `spots:list` query feeds every page (browse, saved,
  // swipe, map, home, chapter carousels). Two-tier reads:
  //
  //   1. Static sidecars (window.SPOTS from full/map/spots-data.js +
  //      window.HB_SPOT_IMAGES from full/img/spot-images.js) seed the
  //      cache synchronously so the first paint is correct even before
  //      Convex's WebSocket has connected.
  //   2. Convex (window.convex + window.HB_CONVEX_URL) opens a reactive
  //      subscription to spots:list. When server data differs we update
  //      the cache and notify subscribers; pages re-render in place.
  //
  // If Convex isn't configured or the WebSocket is down, we keep serving
  // sidecar data -- no functional regression, just no live updates.
  //
  // Each cached spot keeps the legacy spots-data.js shape (snake_case
  // chapter_id, maps_url, single `image`) plus a `photos[]` array, so
  // existing page code can read `s.image` for the primary thumbnail or
  // `s.photos` for the gallery. Pages that already iterate window.SPOTS
  // can switch to `window.HB.spots.all()` with a one-line change.
  const spots = (() => {
    let byKey = new Map();        // spotKey -> normalised spot
    let arr   = [];               // ordered list (matches sidecar order)
    let attached = false;
    const subs = new Set();

    function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

    // Build the canonical spot list from the static sidecars. We use
    // window.SPOTS for the order and metadata, and HB_SPOT_IMAGES for
    // any pre-published multi-photo galleries.
    function seedFromSidecars() {
      const sidecarSpots   = W.SPOTS || [];
      const sidecarPhotos  = W.HB_SPOT_IMAGES || {};
      const list = sidecarSpots.map(s => {
        const anchor = (s.href || '').split('#')[1];
        const spotKey = anchor ? `${s.chapter_id}#${anchor}` : null;
        // Restructure: every spot now has a derivative photoId of
        // <spotId>_p0 (and _p1, _p2, ... for extras). The legacy sidecar
        // doesn't carry photoIds, but the spotId IS the anchor — so we
        // synthesise photoIds from the anchor here. That way every
        // page that calls HB.photoAttrs (swipe, browse, saved, map,
        // home) gets a valid derivative URL even before Convex hydrates.
        let photos = [];
        if (spotKey && sidecarPhotos[spotKey]) {
          photos = sidecarPhotos[spotKey].map((p, i) => ({
            src: p.src,
            photoId: anchor ? `${anchor}_p${i}` : null,
            credit: p.credit || null,
            width: null, height: null,
          }));
        } else if (s.image) {
          photos = [{
            src: s.image,
            photoId: anchor ? `${anchor}_p0` : null,
            credit: null,
            width: null, height: null,
          }];
        }
        return {
          spotKey,
          title:      s.title,
          kicker:     s.kicker,
          chapter:    s.chapter,
          chapter_id: s.chapter_id,
          lat:        s.lat,
          lon:        s.lon,
          color:      s.color,
          maps_url:   s.maps_url,
          href:       s.href,
          image:      photos[0]?.src || s.image || null,
          imagePhotoId: photos[0]?.photoId || null,
          imageWidth:   photos[0]?.width || null,
          imageHeight:  photos[0]?.height || null,
          kind:       'spot',
          properties: [],
          // Sidecar carries inline wildCamping when scripts/inject-wildcamping-
          // to-sidecar.mjs has run; otherwise it's just absent. We pass it
          // through so localhost (and any pre-Convex paint) can show the
          // Wildcamping-status modal without a server round-trip.
          wildCamping: s.wildCamping || null,
          photos,
        };
      });
      arr   = list;
      byKey = new Map(list.filter(s => s.spotKey).map(s => [s.spotKey, s]));
    }
    seedFromSidecars();

    // Project a Convex `spots` row into the legacy shape used by all pages.
    // Each photo carries both legacy `src` (filename) and the new `photoId`
    // (slug under /full/img/derivatives/) so consumers can pick whichever
    // their renderer supports.
    function normaliseConvexRow(row) {
      const anchor = (row.spotKey || '').split('#')[1] || null;
      const photos = (row.photos || []).slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((p, idx) => {
          // Recover photoId so photoUrl()'s derivative branch fires.
          // Two failure modes the migration leaves behind:
          //  1. staticPath holds a derivative path ("derivatives/<id>/...")
          //     but photoId is empty -- parse <id> out.
          //  2. staticPath holds a legacy flat filename ("joriseen.jpg") and
          //     photoId is empty -- synth `<anchor>_p<idx>`. The derivative
          //     ladder is built from the same anchor, so for every spot whose
          //     gallery actually shipped to disk this resolves correctly.
          //     If a spot has no derivatives the URL 404s and the page falls
          //     back gracefully (Featured keeps the prior frame; row cards
          //     show empty), which is no worse than the legacy `img/m/<file>`
          //     route did at width<=1200 when the file wasn't there.
          let photoId = p.photoId || null;
          if (!photoId && p.staticPath) {
            const m = p.staticPath.match(/^derivatives\/([^/]+)\//);
            if (m) photoId = m[1];
          }
          if (!photoId && anchor) photoId = `${anchor}_p${idx}`;
          return {
            src:     p.staticPath || null,
            photoId,
            credit:  p.credit     || null,
            width:   p.width      || null,
            height:  p.height     || null,
          };
        })
        .filter(p => p.src || p.photoId);
      return {
        spotKey:    row.spotKey,
        title:      row.title,
        kicker:     row.kicker,
        chapter:    row.chapter,
        chapter_id: row.chapterId,
        lat:        row.lat ?? null,
        lon:        row.lon ?? null,
        color:      row.color,
        maps_url:   row.mapsUrl,
        href:       row.href,
        image:        photos[0]?.src     || null,
        imagePhotoId: photos[0]?.photoId || null,
        imageWidth:   photos[0]?.width   || null,
        imageHeight:  photos[0]?.height  || null,
        // Editorial — applyEditorial reads these from the store and rewrites
        // the chapter HTML's static text. Dropping these here meant the
        // legacy HTML kept rendering even after the Convex row had been
        // sanitised (e.g. ZDK-prefixed phrasings that violate the brand voice).
        deck:        row.deck  || null,
        body:        (row.body && row.body.length) ? row.body : null,
        specs:       (row.specs && row.specs.length) ? row.specs : null,
        kind:        row.kind || 'spot',
        origin:      row.origin || null,
        properties:  row.properties || [],
        wildCamping: row.wildCamping || null,
        photos,
      };
    }

    // When Convex pushes an update, we merge over the sidecar baseline
    // (preserving spot order) so any spots that exist only locally
    // continue to render until they're added to the DB.
    function applyConvexRows(rows) {
      const dbBySpotKey = new Map(rows.map(r => [r.spotKey, normaliseConvexRow(r)]));
      const sidecarSpots = W.SPOTS || [];
      const before = JSON.stringify(arr);
      const list = sidecarSpots.map(s => {
        const anchor = (s.href || '').split('#')[1];
        const spotKey = anchor ? `${s.chapter_id}#${anchor}` : null;
        if (spotKey && dbBySpotKey.has(spotKey)) {
          const dbRow = dbBySpotKey.get(spotKey);
          // Convex sometimes has a spot row with photos=[] (legacy spots
          // that pre-date the photo migration, or admin cleared the
          // gallery). The sidecar (built from content.yaml + the live
          // Convex hydration pass in build-spot-images.mjs) carries the
          // real photo list in those cases; keep it so Browse doesn't
          // see the tile count change on first Convex push and
          // rebuild → flicker.
          if (dbRow.photos.length === 0) {
            const sidecarRow = byKey.get(spotKey);
            if (sidecarRow && sidecarRow.photos.length > 0) {
              return {
                ...dbRow,
                photos: sidecarRow.photos,
                image: sidecarRow.image,
                imagePhotoId: sidecarRow.imagePhotoId,
                imageWidth: sidecarRow.imageWidth,
                imageHeight: sidecarRow.imageHeight,
              };
            }
          }
          return dbRow;
        }
        // No DB row yet -- fall back to whatever the sidecar gave us.
        return byKey.get(spotKey) || null;
      }).filter(Boolean);
      // Append any DB rows that aren't in the sidecar (newly created spots).
      for (const [k, row] of dbBySpotKey) {
        if (!sidecarSpots.some(s => {
          const anchor = (s.href || '').split('#')[1];
          return anchor && `${s.chapter_id}#${anchor}` === k;
        })) {
          list.push(row);
        }
      }
      arr = list;
      byKey = new Map(list.filter(s => s.spotKey).map(s => [s.spotKey, s]));
      if (before !== JSON.stringify(arr)) notify();
    }

    function init() {
      if (attached) return;
      const c = getConvex();
      if (!c) return;
      try {
        c.onUpdate("spots:list", {}, applyConvexRows, (err) => {
          console.warn("Convex spots subscription error:", err);
        });
        attached = true;
      } catch (e) {
        console.warn("Convex spots subscription failed; using sidecar fallback.", e);
      }
    }

    // When the hidden ?by= URL filter is active, project each spot down to
    // photos credited to one of the handles. Spots with zero matching
    // photos are dropped; the rest get their `image`/`imagePhotoId` cover
    // swapped to the first matching photo so tile renderings on every
    // listing page show the filtered set without per-page changes.
    function viewSpot(spot) {
      if (!spot) return null;
      // Preview mode · drop spots whose slug isn't on Leon's curated
      // recording-safe list. Anchor lives at spotKey's right half.
      // EXCEPTIONS · show ALL spots on the discovery surfaces that
      // affiliate recordings naturally pan across:
      //   - /full/map/           full Switzerland with all pins
      //   - /full/wildcamping/   complete wildcamping landscape
      //   - /full/hidden-gems/   the "look at all these gems" grid
      // The spot detail page is still reachable by direct URL (the
      // spot card on those exempt pages clicks through), so we rely
      // on the photo-credit filter there to keep the recording safe.
      // Chapter / browse / swipe surfaces still respect the 20-spot
      // allowlist · they're the curated narrative path for promos.
      if (PREVIEW_MODE && !/\/full\/(map|wildcamping|hidden-gems)\//.test(location.pathname || '')) {
        const anchor = (spot.spotKey || '').split('#')[1] || null;
        if (!previewSpotAllowed(anchor)) return null;
      }
      if (!BY_HANDLES && !PREVIEW_MODE) return spot;
      const photos = (spot.photos || []).filter(p => matchesByCredit(p.credit));
      if (photos.length === 0) return null;
      const primary = photos[0];
      return {
        ...spot,
        photos,
        image:        primary.src     || spot.image,
        imagePhotoId: primary.photoId || spot.imagePhotoId,
        imageWidth:   primary.width  != null ? primary.width  : null,
        imageHeight: primary.height != null ? primary.height : null,
      };
    }

    return {
      all() {
        if (!BY_HANDLES && !PREVIEW_MODE) return arr;
        return arr.map(viewSpot).filter(Boolean);
      },
      get(spotKey) {
        const raw = byKey.get(spotKey) || null;
        return viewSpot(raw);
      },
      // Unfiltered raw spot for the chapter-page card filter, which needs
      // the full photos[] to know which baked slides to prune.
      rawGet(spotKey) { return byKey.get(spotKey) || null; },
      // Unfiltered raw list · ignores PREVIEW_MODE and BY_HANDLES.
      // Use for "universe of content" displays (e.g. chapter cards on
      // /full/ should show the full N spots regardless of preview filter,
      // since the count is a hint at how much is in the guide, not a
      // count of what's visible in the current session). Always returns
      // a fresh shallow copy so callers can safely mutate / sort.
      rawAll() { return arr.slice(); },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      init,
    };
  })();

  // Backwards-compat shim for the chapter-page carousel, which previously
  // called HB.galleries.get(spotKey) → photos[]. Now it's a thin facade
  // over the unified spots store.
  const galleries = {
    get(spotKey) {
      const spot = spots.get(spotKey);
      if (!spot || spot.photos.length < 2) return null;
      return spot.photos;
    },
    subscribe(fn) {
      // Adapter: spots.subscribe fires once per change with no args, but
      // injectMultiImage expects (spotKey) so it knows which slide to
      // repaint. Call back per-spot since we don't track per-key diffs.
      return spots.subscribe(() => {
        spots.all().forEach(s => { if (s.spotKey) fn(s.spotKey); });
      });
    },
    init: spots.init,
  };

  // --- Walk the page and rewrite any plural kicker to singular.
  // Affects chapter pages (`.sp-kicker`, `.cv-kicker`) and any other static
  // markup. Re-runs on DOM mutations would be overkill; we run once on load.
  function rewriteKickersInPage() {
    const sel = '.sp-kicker, .cv-kicker, .pf-kicker';
    document.querySelectorAll(sel).forEach(el => {
      const raw = el.textContent.trim();
      if (!raw) return;
      const next = singularKicker(raw);
      if (next && next !== raw) el.textContent = next;
    });
  }

  // --- SVG icons (Feather-style stroke matches the rest of the site)
  const SVG_HEART_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const SVG_HEART_FILL = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const SVG_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
  // Shuffle / cross-arrows. The earlier dice icon had its content packed
  // into a 3-21 viewBox subset, which made it visually narrower than the
  // line-based icons next to it -- the "Random" label looked extra-indented.
  const SVG_DICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
  // Two-card stack: signals "swipe through one at a time"
  const SVG_SWIPE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="13" height="16" rx="2" transform="rotate(8 12 12)"/><rect x="3" y="5" width="13" height="16" rx="2" transform="rotate(-8 12 12)"/></svg>';
  const SVG_MAP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
  // Simple tent silhouette · two sloped lines + a base line + center pole.
  const SVG_TENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21 12 4 21 21"/><path d="M9 21 12 14 15 21"/><line x1="3" y1="21" x2="21" y2="21"/></svg>';

  // --- Inject the left-side app rail. Replaces the older topbar pills.
  // Items: Home (brand site) · Overview · Browse · Map · Swipe · Random · Liked.
  // Collapsed by default at 64px wide; toggle expands to 220px showing labels.
  // Mobile: hidden by default, opens as a drawer via the topbar burger button.
  const RAIL_KEY = 'hb:rail:v1';

  // Icons separate from the topbar set so we can size them independently.
  const SVG_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></svg>';
  const SVG_OVERVIEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  const SVG_GEM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M2 9h20"/><path d="M10 3 8 9l4 12 4-12-2-6"/></svg>';
  // Star · used by the Famous Gems collection nav item. 5-point star
  // outline so it visually pairs with .rail-item siblings.
  const SVG_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  // Check-in-circle · "Been there" rail + menu-sheet item. Was previously
  // declared deeper in the file (kebab-menu builder); promoted here so the
  // rail markup that references it doesn't TDZ-fault.
  const SVG_CHECK_CIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 16 10"/></svg>';
  const SVG_CHEVRONS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>';
  const SVG_BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
  // Theme toggle icons (rail bottom). The currently-shown icon
  // previews the *destination* theme: moon in light mode, sun in
  // dark mode — so the user knows what the click will do.
  const SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>';
  const SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  // Chapter list, mirrored from the home page covers. Chapter `id` matches
  // the URL segment under /full/<id>/. Introduction sits at the top of the
  // section as a special "front matter" entry, visually separated from the
  // seven regional chapters by a divider.
  // Cover paths point at the build-image-derivatives output. Intro thumb
  // uses a WebP derivative built by scripts/build-front-matter-derivatives.mjs;
  // matches the sidebar thumb on every chapter page.
  const RAIL_INTRO_CHAPTER = { id: 'intro', label: 'Introduction', cover: 'front_matter/page_05-w192.webp' };
  const RAIL_CHAPTERS = [
    { id: 'central',  label: 'Central',             cover: 'chapters/central/w400.webp' },
    { id: 'valais',   label: 'Valais',              cover: 'chapters/valais/w400.webp' },
    { id: 'fribourg', label: 'Fribourg',            cover: 'chapters/fribourg/w400.webp' },
    { id: 'western',  label: 'Western',             cover: 'chapters/western/w400.webp' },
    { id: 'eastern',  label: 'Eastern',             cover: 'chapters/eastern/w400.webp' },
    { id: 'ticino',   label: 'Ticino',              cover: 'chapters/ticino/w400.webp' },
    { id: 'beyond',   label: 'Outside Switzerland', cover: 'chapters/beyond/w400.webp' },
  ];

  function injectRail() {
    if (document.querySelector('.app-rail')) return;
    // Pages that opt out (e.g. /full/login/) just want the modal + helpers.
    if (document.body.dataset.norail !== undefined) return;
    document.body.classList.add('has-rail');

    // Default = expanded so first-time visitors see labels (it's the
    // YouTube/Apple Music pattern). Users who want it tighter can
    // collapse via the toggle and we remember it for next time.
    let expanded = true;
    try {
      const stored = localStorage.getItem(RAIL_KEY);
      if (stored === '0') expanded = false;
      else if (stored === '1') expanded = true;
    } catch {}
    if (expanded) document.body.classList.add('rail-expanded');

    const rail = document.createElement('aside');
    rail.className = 'app-rail' + (expanded ? ' is-expanded' : '');
    rail.setAttribute('aria-label', W.t('a11y.primary_nav'));

    const here = location.pathname.replace(/index\.html$/, '');
    const cur = (suffix) => here.endsWith(suffix) ? ' is-current' : '';
    // currentChapterId() and the RAIL_CHAPTERS / RAIL_INTRO_CHAPTER
    // constants are still referenced elsewhere in social.js (e.g. for
    // chapter-aware kicker rewriting on spot pages), so keep them
    // declared even though the rail / menu sheet no longer renders a
    // Chapters section · the new "All Regions" entry in Collections
    // (links to /full/regions/) replaces that surface. 2026-05-24.

    rail.innerHTML = `
      <a class="rail-brand" href="${REL}index.html" title="Gems of Switzerland home">
        <img src="${REL}../images/avatar.jpg" alt="" />
        <span class="label">Gems of Switzerland</span>
      </a>
      <div class="rail-scroll">
        <a class="rail-item${cur('/full/') || cur('/full/index.html')}" href="${REL}index.html">
          ${SVG_HOME}<span class="label">${W.t('nav.home')}</span>
        </a>
        <a class="rail-item${cur('/browse/')}" href="${REL}browse/">
          ${SVG_GRID}<span class="label">${W.t('nav.explore')}</span>
        </a>
        <a class="rail-item${cur('/map/')}" href="${REL}map/">
          ${SVG_MAP}<span class="label">${W.t('nav.map')}</span>
        </a>
        <a class="rail-item${cur('/swipe/')}" href="${REL}swipe/">
          ${SVG_SWIPE}<span class="label">${W.t('nav.swipe')}</span>
        </a>
        <button type="button" class="rail-item" data-hb-random>
          ${SVG_DICE}<span class="label">${W.t('nav.random')}</span>
        </button>
        <div class="rail-divider"></div>
        <a class="rail-item${cur('/saved/')}" href="${REL}saved/" data-hb-saved-link>
          ${SVG_HEART_OUT}<span class="label">${W.t('nav.liked')}</span>
          <span class="rail-badge" data-hb-fav-count></span>
        </a>
        <a class="rail-item${cur('/visited/')}" href="${REL}visited/" data-hb-visited-link>
          ${SVG_CHECK_CIRCLE}<span class="label">${W.t('nav.been_there')}</span>
          <span class="rail-badge" data-hb-visited-count></span>
        </a>
        <div class="rail-divider"></div>
        <div class="rail-section-head"><span class="label">${W.t('nav.collections')}</span></div>
        <a class="rail-item${cur('/hidden-gems/')}" href="${REL}hidden-gems/">
          ${SVG_GEM}<span class="label">${W.t('nav.hidden_gems')}</span>
        </a>
        <a class="rail-item${cur('/famous-gems/')}" href="${REL}famous-gems/">
          ${SVG_STAR}<span class="label">${W.t('nav.famous_gems')}</span>
        </a>
        <a class="rail-item${cur('/wildcamping/')}" href="${REL}wildcamping/">
          ${SVG_TENT}<span class="label">${W.t('nav.wildcamping')}</span>
        </a>
        <a class="rail-item${cur('/regions/')}" href="${REL}regions/">
          <svg viewBox="0 0 1000 642" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path vector-effect="non-scaling-stroke" d="M574.2,2.2L577.3,9.6L573.5,10.5L570.8,9.0L554.5,13.9L550.3,26.3L539.8,35.2L542.8,41.1L539.8,45.0L548.5,50.3L552.7,50.3L554.6,53.9L555.2,51.5L559.5,53.4L566.5,52.8L566.5,47.8L569.0,49.3L569.5,46.4L574.2,44.8L578.5,47.0L582.0,44.7L583.8,44.7L584.6,46.9L589.3,49.9L587.8,55.1L583.5,55.3L585.2,52.5L584.0,50.6L581.9,53.7L582.2,58.6L583.7,62.9L577.8,68.9L574.2,67.5L576.6,63.1L570.4,58.6L564.7,56.8L562.7,61.4L555.0,63.8L551.5,67.5L553.0,72.4L557.9,71.3L559.1,73.2L546.3,77.7L537.5,75.1L535.7,78.4L521.8,76.6L515.3,70.2L515.9,65.0L511.8,63.4L509.1,64.6L507.6,62.8L502.9,63.8L500.5,65.9L498.0,60.7L494.8,61.3L490.3,66.5L486.0,69.5L482.9,69.2L481.2,72.4L474.1,72.9L472.3,79.4L469.6,81.1L465.2,78.8L459.6,81.7L454.2,83.2L449.5,81.5L441.8,81.2L439.4,85.2L432.2,84.3L429.7,80.0L431.6,77.2L425.7,70.8L419.8,71.3L417.2,73.6L414.1,72.1L410.4,71.1L409.2,76.8L405.3,81.1L396.1,84.8L388.1,86.4L382.8,89.3L377.1,87.9L375.6,84.8L372.6,82.8L370.0,79.9L370.5,79.0L373.4,80.3L376.7,78.4L379.8,78.8L380.7,76.9L381.3,78.5L382.2,76.3L381.0,75.3L380.1,72.7L378.4,72.1L381.0,68.9L383.4,67.2L380.7,68.0L378.9,70.1L372.7,68.4L366.9,74.8L363.7,74.4L363.2,71.8L360.2,70.7L359.2,75.4L355.4,74.6L353.1,76.3L353.4,78.5L344.4,84.9L342.6,85.0L340.0,87.5L341.2,90.3L343.2,90.2L344.8,88.5L347.2,89.5L347.5,91.1L345.8,94.8L344.4,93.8L341.6,94.6L340.2,92.7L340.5,94.6L342.5,96.6L343.0,100.4L337.7,105.3L334.4,105.7L326.1,100.2L323.2,105.6L327.4,106.1L331.3,108.3L328.8,111.8L325.1,112.9L324.9,114.4L322.8,117.2L319.2,120.2L311.8,121.0L304.1,118.5L298.0,119.2L295.3,120.8L292.9,120.5L284.9,125.3L282.3,119.4L274.0,120.2L268.2,117.8L272.6,103.3L275.4,102.5L274.9,101.5L267.6,103.0L259.2,98.5L255.9,101.0L251.3,101.1L247.8,103.3L244.8,101.2L235.9,98.0L227.5,101.5L228.1,108.3L230.8,111.0L231.3,114.0L229.1,116.0L224.7,116.4L222.2,120.8L217.7,120.8L217.4,129.5L212.0,130.0L211.8,134.9L205.8,139.4L204.3,146.1L205.9,146.5L208.5,145.2L214.8,145.8L226.0,144.3L231.1,142.6L233.6,140.5L238.1,141.7L238.7,142.9L241.9,144.3L241.9,147.9L244.4,149.7L242.8,152.2L243.1,152.9L240.7,155.2L238.2,154.7L232.4,156.4L234.2,158.8L232.5,163.3L229.3,165.4L225.0,164.9L224.9,166.6L218.0,167.7L220.2,174.0L219.6,179.9L221.1,181.7L218.3,184.1L218.0,185.6L215.0,187.1L214.2,188.9L204.4,195.7L203.1,200.2L196.0,205.2L200.1,207.1L190.3,216.1L173.7,225.4L175.0,229.2L173.3,230.8L170.3,230.7L165.7,234.0L166.4,235.3L163.1,238.2L168.8,243.6L163.7,248.4L161.1,248.0L154.8,252.2L152.5,258.9L145.4,262.7L142.4,262.4L135.0,266.3L121.9,270.8L120.2,268.0L111.3,278.5L106.0,283.0L112.5,294.0L112.2,308.0L108.0,314.2L107.9,319.2L105.7,320.7L106.8,324.5L111.9,328.1L110.4,332.3L106.9,336.4L98.2,340.8L96.5,343.2L97.1,344.1L92.3,346.8L92.9,348.2L90.3,349.1L84.5,353.9L73.0,359.5L70.1,362.2L69.5,364.4L57.8,374.6L35.1,395.5L45.4,406.0L43.9,408.0L44.3,408.9L42.8,411.6L41.3,410.8L36.0,417.2L32.4,426.3L27.0,431.6L27.5,435.4L29.5,437.6L29.8,438.9L27.6,442.4L25.3,447.3L25.9,447.8L32.9,449.7L34.2,452.9L36.0,454.0L35.8,452.6L43.9,460.1L46.0,459.5L46.7,461.1L48.3,463.4L46.1,466.5L45.8,468.5L44.3,469.9L41.8,472.4L41.2,473.8L39.9,476.9L38.2,479.5L37.5,480.9L37.2,484.5L37.6,484.9L36.9,486.6L36.3,486.7L33.5,489.7L33.8,491.8L35.9,493.7L35.0,494.3L37.2,496.2L38.3,500.4L34.9,504.2L33.0,504.6L30.2,502.0L26.9,503.6L25.1,502.7L21.4,506.6L18.2,504.8L14.6,506.9L11.3,510.2L9.0,509.7L9.4,512.0L6.3,511.7L4.4,514.3L4.9,515.9L3.0,517.9L9.2,521.3L9.7,522.6L8.3,526.4L7.3,525.5L6.2,528.7L3.1,534.8L3.5,536.9L1.6,538.4L1.6,539.8L5.2,538.7L7.3,536.8L7.3,535.2L9.7,534.9L14.4,535.5L17.3,536.3L18.7,538.0L20.6,535.7L21.2,536.0L22.4,532.6L27.6,533.4L30.5,532.6L31.2,532.7L32.9,535.0L38.6,535.8L40.3,536.1L42.4,534.0L43.6,534.0L45.2,532.2L52.3,527.8L52.1,523.6L54.1,522.2L56.5,519.6L59.4,517.3L62.6,514.9L64.8,515.4L64.8,514.8L65.8,515.3L67.8,513.3L72.1,512.1L75.6,509.1L79.0,502.8L78.5,500.4L79.1,498.8L77.3,499.5L75.9,498.6L75.9,496.3L73.6,499.1L73.7,499.5L71.7,500.1L70.0,501.6L68.2,500.3L68.3,499.4L65.7,496.9L64.2,493.5L63.5,492.4L63.5,490.7L66.4,488.0L65.4,484.1L59.3,481.0L66.5,465.5L84.6,451.7L104.5,447.7L125.4,434.8L161.0,435.3L191.6,443.8L187.2,456.9L188.4,459.3L185.1,463.3L181.0,464.0L180.4,466.9L184.1,475.0L186.0,474.2L187.4,478.3L189.6,478.2L193.7,483.1L193.7,484.6L197.6,488.1L199.2,487.3L201.4,491.1L199.9,493.9L199.0,499.4L195.5,502.4L193.7,506.1L191.3,507.0L191.5,510.2L187.5,515.7L189.5,523.2L185.0,529.3L184.8,532.0L186.5,537.5L188.3,537.7L190.3,539.5L195.5,538.8L198.2,540.1L208.7,541.3L205.2,550.7L206.7,556.6L204.1,559.2L203.4,564.4L206.5,567.8L208.5,566.0L212.0,564.1L214.2,560.5L216.7,560.3L216.8,563.4L218.9,564.9L219.8,564.6L223.0,571.6L227.7,579.0L232.1,581.3L235.5,588.2L233.3,590.3L235.2,594.0L239.0,595.8L238.8,601.2L240.5,606.1L244.0,609.9L245.2,614.1L248.1,616.5L249.9,619.3L252.0,622.4L253.9,625.9L258.5,625.8L261.0,622.4L265.4,620.2L267.4,623.1L272.3,626.7L274.5,625.1L274.8,621.6L278.5,616.9L282.9,616.5L286.7,615.9L287.7,617.5L294.2,606.7L301.0,607.8L301.9,610.9L306.6,608.4L309.2,610.6L315.2,614.2L319.3,609.9L321.8,609.9L328.5,603.7L332.0,602.3L335.3,602.0L334.4,597.1L340.4,593.7L344.3,594.6L349.9,594.9L349.5,588.8L351.4,585.7L358.2,585.6L359.7,590.5L368.2,590.8L373.0,590.6L375.7,589.1L380.1,595.5L386.0,595.8L386.1,603.5L390.4,605.7L393.5,604.1L395.6,600.4L401.5,602.7L407.3,608.0L411.8,604.9L419.9,606.7L422.1,607.2L423.9,604.6L422.2,601.8L422.1,598.0L423.3,597.4L423.7,593.5L424.0,589.6L427.5,588.8L431.0,582.0L447.3,582.2L451.2,577.8L453.4,576.7L453.4,571.6L458.3,566.9L455.7,557.9L458.1,548.4L467.2,547.2L474.7,545.2L475.9,539.1L483.0,537.5L483.6,528.8L486.6,523.8L484.1,517.4L480.6,508.4L477.7,507.2L474.6,501.4L468.1,497.8L472.9,492.7L477.9,486.6L481.2,484.1L486.0,486.3L496.4,483.1L499.8,474.5L508.8,469.8L508.5,465.4L510.9,463.3L513.8,464.3L519.7,459.2L519.8,453.8L518.8,452.0L514.1,451.0L517.9,444.7L521.5,445.0L530.9,435.8L534.9,436.7L547.2,432.1L552.9,438.8L550.6,442.3L551.5,446.9L553.0,448.2L552.1,452.0L554.1,454.3L552.3,456.9L553.9,465.6L552.4,467.5L552.3,475.0L547.5,478.8L545.8,484.3L544.6,484.6L550.3,496.2L547.6,500.3L552.4,502.7L554.1,507.3L558.8,508.2L563.8,510.4L567.5,511.0L569.3,518.3L572.5,520.4L575.2,523.0L577.2,529.3L578.8,529.6L582.8,531.4L580.8,535.2L585.5,539.2L585.3,541.7L592.9,541.8L596.1,545.5L597.7,546.2L599.2,545.9L601.3,548.7L607.5,549.3L609.3,545.5L613.9,542.3L617.3,548.8L621.0,549.6L625.9,550.5L628.0,549.1L638.0,558.0L638.5,562.6L636.2,564.9L634.2,564.9L633.5,567.8L631.2,573.9L627.1,574.4L622.9,583.9L631.1,584.8L635.7,586.8L644.2,595.2L647.4,594.5L647.1,602.4L650.1,608.1L652.9,609.0L654.0,616.5L656.3,623.0L657.9,623.8L653.9,627.9L651.4,635.4L660.2,632.1L664.3,635.0L668.5,633.7L669.7,638.7L677.2,638.7L679.2,630.5L682.5,620.8L687.1,617.3L690.1,613.0L688.0,613.0L686.7,609.8L682.1,606.4L679.4,604.9L675.1,604.3L674.5,600.6L673.0,598.9L674.2,597.1L673.9,594.6L668.3,590.6L669.4,586.6L673.0,587.6L672.4,585.0L676.2,583.3L674.4,574.7L672.4,570.3L674.5,564.9L686.7,560.0L689.8,553.7L686.3,543.0L696.6,537.5L700.6,531.4L705.0,529.1L705.6,526.1L710.0,526.8L713.8,523.5L712.9,518.4L715.1,514.2L718.6,512.5L718.7,507.6L722.1,506.4L724.5,506.7L725.7,495.1L727.6,491.6L732.6,486.1L733.5,481.1L736.2,476.5L735.6,469.5L732.0,465.3L731.1,458.6L732.0,447.9L724.8,442.1L725.1,437.9L731.1,434.2L732.3,422.1L751.9,418.1L751.9,423.6L760.4,431.5L764.0,422.4L771.6,418.8L770.7,446.4L773.1,452.5L771.9,459.5L779.7,465.9L789.4,482.3L793.3,484.4L802.6,486.9L809.0,489.0L818.6,485.7L826.2,487.8L830.4,479.0L828.9,477.1L829.8,471.3L833.7,468.6L840.7,473.2L854.6,465.3L862.4,463.7L868.7,459.8L874.8,464.0L876.0,461.0L879.9,459.8L882.0,463.7L889.6,469.2L886.0,478.7L889.9,480.5L889.0,488.7L902.2,494.8L903.2,503.0L899.5,508.8L905.3,511.9L910.7,508.5L923.1,506.7L928.8,499.7L924.0,486.9L913.1,475.6L914.0,466.5L919.5,464.6L918.9,459.5L925.8,456.7L925.5,447.9L917.9,443.4L909.2,447.0L898.9,438.5L901.6,429.1L899.5,417.5L901.9,413.6L898.9,407.5L908.6,398.7L909.2,396.0L912.8,392.4L912.2,387.2L914.9,386.3L930.9,380.9L937.9,382.7L942.4,377.2L947.2,385.1L943.9,391.8L944.2,398.1L949.3,396.3L953.3,399.0L956.0,404.5L962.9,404.5L965.6,406.9L968.3,402.1L976.8,406.6L982.5,404.8L990.4,410.0L995.2,404.2L997.0,384.2L988.0,376.6L979.5,377.5L974.4,360.9L978.3,354.8L981.3,350.9L978.3,345.2L987.1,338.8L983.4,326.7L988.9,322.8L993.4,306.7L994.0,290.5L998.8,280.3L985.6,274.3L980.7,267.0L971.1,262.2L964.4,265.2L960.8,273.7L960.2,283.9L943.9,282.7L940.3,301.4L912.5,309.8L908.3,304.4L901.0,302.0L893.8,295.4L877.5,287.5L861.8,282.1L865.4,263.4L863.0,256.8L860.0,252.6L846.7,251.4L826.2,244.2L812.9,240.6L808.1,243.6L803.9,240.6L803.0,240.3L802.2,241.1L800.4,241.8L798.3,243.1L797.0,243.0L794.5,243.7L793.4,244.5L792.8,244.5L792.2,243.9L791.9,241.7L791.0,240.5L790.0,240.0L788.9,239.2L787.0,239.9L783.9,240.8L783.2,241.8L780.9,242.0L780.2,241.8L779.9,242.9L778.8,241.9L778.3,242.1L777.0,244.4L776.2,243.2L776.3,242.1L775.6,242.3L775.1,242.8L775.1,243.4L774.9,243.5L773.9,239.5L778.6,236.4L783.6,232.6L784.6,227.4L781.9,214.5L780.2,212.0L778.3,207.8L777.1,201.8L778.0,196.8L780.2,192.3L780.5,189.4L781.9,186.6L784.7,181.8L786.9,175.8L786.8,173.2L794.2,162.1L802.6,154.9L807.5,144.1L816.5,140.5L819.6,135.8L814.7,126.8L814.9,115.4L806.9,113.0L803.9,109.3L802.4,112.1L794.4,101.8L794.0,98.1L791.3,87.6L784.5,88.4L769.1,69.3L727.2,48.2L708.6,49.9L705.0,46.4L699.9,47.0L693.2,43.0L675.9,40.2L661.4,47.6L647.5,51.8L643.3,49.1L641.2,41.7L637.6,40.8L638.2,36.6L640.8,36.3L640.3,37.5L642.9,37.1L642.5,34.0L637.3,33.7L636.6,31.7L631.2,31.4L631.7,29.6L627.9,27.5L628.9,25.6L627.7,23.1L626.0,24.5L626.4,26.4L623.4,26.6L619.8,29.8L619.8,32.8L625.3,34.3L626.2,36.0L628.7,37.3L626.6,37.8L625.0,43.3L610.5,37.1L612.1,30.3L608.3,27.4L607.4,24.0L609.4,20.4L613.9,19.9L608.1,14.7L603.6,16.5L602.2,16.3L600.7,7.9L594.3,3.4L592.7,9.3L589.5,16.2L586.4,9.9L586.7,3.0L576.6,2.5L574.2,2.2Z"/></svg><span class="label">${W.t('nav.all_regions')}</span>
        </a>
      </div>
      <button type="button" class="rail-theme" data-hb-theme-toggle aria-label="${W.t('a11y.toggle_theme')}">
        <span class="rail-theme-icon" data-hb-theme-icon>${SVG_MOON}</span><span class="label" data-hb-theme-label>Dark mode</span>
      </button>
      <div class="rail-lang" role="group" aria-label="${W.t('lang.label')}">
        <button type="button" class="rail-lang-btn" data-hb-lang="en">EN</button>
        <button type="button" class="rail-lang-btn" data-hb-lang="de">DE</button>
        <button type="button" class="rail-lang-btn" data-hb-lang="fr">FR</button>
      </div>
      <a class="rail-item rail-item-more${cur('/more/')}" href="${REL}more/">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        <span class="label">${W.t('nav.more')}</span>
      </a>
      <button type="button" class="rail-toggle" data-hb-rail-toggle aria-label="${W.t('a11y.toggle_nav_labels')}">
        ${SVG_CHEVRONS}<span class="label">${W.t('nav.collapse')}</span>
      </button>
    `;
    document.body.insertBefore(rail, document.body.firstChild);

    // === Theme toggle ===
    // Opt-in only. Bootstrap script in <head> reads localStorage['hb-theme']
    // and sets <html data-theme="dark"> when the user previously picked dark.
    // Default = light (no localStorage entry, no data-theme attribute).
    // The icon previews the destination: moon when in light (click → dark),
    // sun when in dark (click → light).
    //
    // Two buttons share this wiring: the rail toggle (desktop) and the
    // menu sheet row (mobile — the rail drawer is unreachable on mobile,
    // see the .rail-burger display:none rule in preview.css). Both carry
    // data-hb-theme-toggle + child data-hb-theme-icon / -label spans.
    // Menu sheet markup gets appended later (below), so we bind handlers
    // via event delegation on <body> instead of direct addEventListener.
    // Dark-by-default since 2026-05-24 · the inline bootstrap in every
    // <head> defaults to dark when localStorage is unset (or anything
    // other than 'light'). This reader must mirror that or the toggle
    // button shows the wrong icon/label for fresh visitors (we'd render
    // a moon "Dark mode" button on a page that's already in dark).
    function getTheme() {
      try { return localStorage.getItem('hb-theme') === 'light' ? 'light' : 'dark'; }
      catch (_e) { return 'dark'; }
    }
    function syncThemeBtns() {
      const t = getTheme();
      document.querySelectorAll('[data-hb-theme-toggle]').forEach(btn => {
        const iconEl = btn.querySelector('[data-hb-theme-icon]');
        const labelEl = btn.querySelector('[data-hb-theme-label]');
        if (iconEl)  iconEl.innerHTML = (t === 'dark') ? SVG_SUN : SVG_MOON;
        if (labelEl) labelEl.textContent = (t === 'dark') ? W.t('theme.light') : W.t('theme.dark');
      });
    }
    function applyTheme(t) {
      const html = document.documentElement;
      if (t === 'dark') html.setAttribute('data-theme', 'dark');
      else html.removeAttribute('data-theme');
      try { localStorage.setItem('hb-theme', t); } catch (_e) {}
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0d10' : '#ffffff');
      syncThemeBtns();
    }
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-hb-theme-toggle]');
      if (!btn) return;
      e.stopPropagation();  // don't trigger menu-sheet's [data-close] handler
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
    // Sync now (rail button is already in DOM) and again after the menu
    // sheet is appended below. The latter wins because querySelectorAll
    // picks up both buttons.
    syncThemeBtns();

    // Top-right Account FAB removed 2026-05-27. The desktop entry point
    // is now /full/more/ → Account row → /full/account/. Mobile still
    // gets a direct slot inside the menu sheet via [data-hb-account]
    // (see menu-sheet HTML below), so phone users keep their two-tap
    // path. paintAccount() iterates all remaining [data-hb-account]
    // slots so this is a pure removal · no other wiring needed.

    // Mobile bottom tab bar. Hidden above 700px via CSS. Replaces the
    // burger drawer as the primary mobile nav so people actually
    // discover Swipe / Map / Menu instead of leaving them buried in a
    // hamburger. Five slots: Home · Explore · Swipe · Map · Menu.
    // Menu is a hamburger that opens a slide-up sheet with Liked,
    // Collections, Chapters, and Account — everything that didn't earn
    // a primary slot. No count badge on the Menu icon — having saved
    // or visited spots shouldn't read as a notification to clear.
    const tabbar = document.createElement('nav');
    tabbar.className = 'app-tabbar';
    tabbar.setAttribute('aria-label', W.t('a11y.primary_nav'));
    tabbar.innerHTML = `
      <a class="tab${cur('/full/') || cur('/full/index.html')}" href="${REL}index.html">
        ${SVG_HOME}<span>${W.t('nav.home')}</span>
      </a>
      <a class="tab${cur('/browse/')}" href="${REL}browse/">
        ${SVG_GRID}<span>${W.t('nav.explore')}</span>
      </a>
      <a class="tab${cur('/swipe/')}" href="${REL}swipe/">
        ${SVG_SWIPE}<span>${W.t('nav.swipe')}</span>
      </a>
      <a class="tab${cur('/map/')}" href="${REL}map/">
        ${SVG_MAP}<span>${W.t('nav.map')}</span>
      </a>
      <button type="button" class="tab" data-hb-menu-toggle aria-label="${W.t('a11y.menu')}" aria-haspopup="dialog">
        ${SVG_BURGER}<span>${W.t('nav.menu')}</span>
      </button>
    `;
    document.body.appendChild(tabbar);

    // Mobile Menu sheet. Slides up from the bottom when the Menu tab
    // is tapped. Houses everything the tab bar couldn't fit: Liked,
    // Collections (Hidden Gems / Wildcamping), Chapters (Introduction
    // + the seven regional chapters), and the Account block (sign in
    // / username + sign-out). Re-uses the rail's icons + structure so
    // it stays in step with the desktop nav. */
    const menuSheet = document.createElement('div');
    menuSheet.className = 'app-menu-sheet';
    menuSheet.setAttribute('role', 'dialog');
    menuSheet.setAttribute('aria-modal', 'true');
    menuSheet.setAttribute('aria-label', W.t('a11y.menu'));
    menuSheet.innerHTML = `
      <div class="menu-sheet-backdrop" data-close></div>
      <div class="menu-sheet-card">
        <!-- Header strip · grabber (cosmetic) + a real Close button.
             Leon called out 2026-05-24 that the grabber's swipe-down
             affordance wasn't wired, so users tapping outside the sheet
             was the only way to dismiss · added the X button as the
             explicit close path and wired swipe-down to honour the
             grabber's promise (handlers below the markup). -->
        <div class="menu-sheet-header" data-hb-sheet-header>
          <div class="menu-sheet-grabber" aria-hidden="true"></div>
          <button type="button" class="menu-sheet-close" data-close aria-label="${W.t('a11y.close_menu')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18"/>
              <line x1="18" y1="6" x2="6" y2="18"/>
            </svg>
          </button>
        </div>
        <button type="button" class="menu-row" data-hb-random data-close>
          <span class="menu-row-icon">${SVG_DICE}</span>
          <span class="menu-row-label">${W.t('menu.surprise_me')}</span>
        </button>
        <a class="menu-row${cur('/saved/')}" href="${REL}saved/" data-hb-saved-link data-close>
          <span class="menu-row-icon">${SVG_HEART_OUT}</span>
          <span class="menu-row-label">${W.t('nav.liked')}</span>
          <span class="menu-row-badge" data-hb-fav-count></span>
        </a>
        <a class="menu-row${cur('/visited/')}" href="${REL}visited/" data-hb-visited-link data-close>
          <span class="menu-row-icon">${SVG_CHECK_CIRCLE}</span>
          <span class="menu-row-label">${W.t('nav.been_there')}</span>
          <span class="menu-row-badge" data-hb-visited-count></span>
        </a>
        <div class="menu-section-head">${W.t('nav.collections')}</div>
        <a class="menu-row${cur('/hidden-gems/')}" href="${REL}hidden-gems/" data-close>
          <span class="menu-row-icon">${SVG_GEM}</span>
          <span class="menu-row-label">${W.t('nav.hidden_gems')}</span>
        </a>
        <a class="menu-row${cur('/famous-gems/')}" href="${REL}famous-gems/" data-close>
          <span class="menu-row-icon">${SVG_STAR}</span>
          <span class="menu-row-label">${W.t('nav.famous_gems')}</span>
        </a>
        <a class="menu-row${cur('/wildcamping/')}" href="${REL}wildcamping/" data-close>
          <span class="menu-row-icon">${SVG_TENT}</span>
          <span class="menu-row-label">${W.t('nav.wildcamping')}</span>
        </a>
        <a class="menu-row${cur('/regions/')}" href="${REL}regions/" data-close>
          <span class="menu-row-icon"><svg viewBox="0 0 1000 642" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path vector-effect="non-scaling-stroke" d="M574.2,2.2L577.3,9.6L573.5,10.5L570.8,9.0L554.5,13.9L550.3,26.3L539.8,35.2L542.8,41.1L539.8,45.0L548.5,50.3L552.7,50.3L554.6,53.9L555.2,51.5L559.5,53.4L566.5,52.8L566.5,47.8L569.0,49.3L569.5,46.4L574.2,44.8L578.5,47.0L582.0,44.7L583.8,44.7L584.6,46.9L589.3,49.9L587.8,55.1L583.5,55.3L585.2,52.5L584.0,50.6L581.9,53.7L582.2,58.6L583.7,62.9L577.8,68.9L574.2,67.5L576.6,63.1L570.4,58.6L564.7,56.8L562.7,61.4L555.0,63.8L551.5,67.5L553.0,72.4L557.9,71.3L559.1,73.2L546.3,77.7L537.5,75.1L535.7,78.4L521.8,76.6L515.3,70.2L515.9,65.0L511.8,63.4L509.1,64.6L507.6,62.8L502.9,63.8L500.5,65.9L498.0,60.7L494.8,61.3L490.3,66.5L486.0,69.5L482.9,69.2L481.2,72.4L474.1,72.9L472.3,79.4L469.6,81.1L465.2,78.8L459.6,81.7L454.2,83.2L449.5,81.5L441.8,81.2L439.4,85.2L432.2,84.3L429.7,80.0L431.6,77.2L425.7,70.8L419.8,71.3L417.2,73.6L414.1,72.1L410.4,71.1L409.2,76.8L405.3,81.1L396.1,84.8L388.1,86.4L382.8,89.3L377.1,87.9L375.6,84.8L372.6,82.8L370.0,79.9L370.5,79.0L373.4,80.3L376.7,78.4L379.8,78.8L380.7,76.9L381.3,78.5L382.2,76.3L381.0,75.3L380.1,72.7L378.4,72.1L381.0,68.9L383.4,67.2L380.7,68.0L378.9,70.1L372.7,68.4L366.9,74.8L363.7,74.4L363.2,71.8L360.2,70.7L359.2,75.4L355.4,74.6L353.1,76.3L353.4,78.5L344.4,84.9L342.6,85.0L340.0,87.5L341.2,90.3L343.2,90.2L344.8,88.5L347.2,89.5L347.5,91.1L345.8,94.8L344.4,93.8L341.6,94.6L340.2,92.7L340.5,94.6L342.5,96.6L343.0,100.4L337.7,105.3L334.4,105.7L326.1,100.2L323.2,105.6L327.4,106.1L331.3,108.3L328.8,111.8L325.1,112.9L324.9,114.4L322.8,117.2L319.2,120.2L311.8,121.0L304.1,118.5L298.0,119.2L295.3,120.8L292.9,120.5L284.9,125.3L282.3,119.4L274.0,120.2L268.2,117.8L272.6,103.3L275.4,102.5L274.9,101.5L267.6,103.0L259.2,98.5L255.9,101.0L251.3,101.1L247.8,103.3L244.8,101.2L235.9,98.0L227.5,101.5L228.1,108.3L230.8,111.0L231.3,114.0L229.1,116.0L224.7,116.4L222.2,120.8L217.7,120.8L217.4,129.5L212.0,130.0L211.8,134.9L205.8,139.4L204.3,146.1L205.9,146.5L208.5,145.2L214.8,145.8L226.0,144.3L231.1,142.6L233.6,140.5L238.1,141.7L238.7,142.9L241.9,144.3L241.9,147.9L244.4,149.7L242.8,152.2L243.1,152.9L240.7,155.2L238.2,154.7L232.4,156.4L234.2,158.8L232.5,163.3L229.3,165.4L225.0,164.9L224.9,166.6L218.0,167.7L220.2,174.0L219.6,179.9L221.1,181.7L218.3,184.1L218.0,185.6L215.0,187.1L214.2,188.9L204.4,195.7L203.1,200.2L196.0,205.2L200.1,207.1L190.3,216.1L173.7,225.4L175.0,229.2L173.3,230.8L170.3,230.7L165.7,234.0L166.4,235.3L163.1,238.2L168.8,243.6L163.7,248.4L161.1,248.0L154.8,252.2L152.5,258.9L145.4,262.7L142.4,262.4L135.0,266.3L121.9,270.8L120.2,268.0L111.3,278.5L106.0,283.0L112.5,294.0L112.2,308.0L108.0,314.2L107.9,319.2L105.7,320.7L106.8,324.5L111.9,328.1L110.4,332.3L106.9,336.4L98.2,340.8L96.5,343.2L97.1,344.1L92.3,346.8L92.9,348.2L90.3,349.1L84.5,353.9L73.0,359.5L70.1,362.2L69.5,364.4L57.8,374.6L35.1,395.5L45.4,406.0L43.9,408.0L44.3,408.9L42.8,411.6L41.3,410.8L36.0,417.2L32.4,426.3L27.0,431.6L27.5,435.4L29.5,437.6L29.8,438.9L27.6,442.4L25.3,447.3L25.9,447.8L32.9,449.7L34.2,452.9L36.0,454.0L35.8,452.6L43.9,460.1L46.0,459.5L46.7,461.1L48.3,463.4L46.1,466.5L45.8,468.5L44.3,469.9L41.8,472.4L41.2,473.8L39.9,476.9L38.2,479.5L37.5,480.9L37.2,484.5L37.6,484.9L36.9,486.6L36.3,486.7L33.5,489.7L33.8,491.8L35.9,493.7L35.0,494.3L37.2,496.2L38.3,500.4L34.9,504.2L33.0,504.6L30.2,502.0L26.9,503.6L25.1,502.7L21.4,506.6L18.2,504.8L14.6,506.9L11.3,510.2L9.0,509.7L9.4,512.0L6.3,511.7L4.4,514.3L4.9,515.9L3.0,517.9L9.2,521.3L9.7,522.6L8.3,526.4L7.3,525.5L6.2,528.7L3.1,534.8L3.5,536.9L1.6,538.4L1.6,539.8L5.2,538.7L7.3,536.8L7.3,535.2L9.7,534.9L14.4,535.5L17.3,536.3L18.7,538.0L20.6,535.7L21.2,536.0L22.4,532.6L27.6,533.4L30.5,532.6L31.2,532.7L32.9,535.0L38.6,535.8L40.3,536.1L42.4,534.0L43.6,534.0L45.2,532.2L52.3,527.8L52.1,523.6L54.1,522.2L56.5,519.6L59.4,517.3L62.6,514.9L64.8,515.4L64.8,514.8L65.8,515.3L67.8,513.3L72.1,512.1L75.6,509.1L79.0,502.8L78.5,500.4L79.1,498.8L77.3,499.5L75.9,498.6L75.9,496.3L73.6,499.1L73.7,499.5L71.7,500.1L70.0,501.6L68.2,500.3L68.3,499.4L65.7,496.9L64.2,493.5L63.5,492.4L63.5,490.7L66.4,488.0L65.4,484.1L59.3,481.0L66.5,465.5L84.6,451.7L104.5,447.7L125.4,434.8L161.0,435.3L191.6,443.8L187.2,456.9L188.4,459.3L185.1,463.3L181.0,464.0L180.4,466.9L184.1,475.0L186.0,474.2L187.4,478.3L189.6,478.2L193.7,483.1L193.7,484.6L197.6,488.1L199.2,487.3L201.4,491.1L199.9,493.9L199.0,499.4L195.5,502.4L193.7,506.1L191.3,507.0L191.5,510.2L187.5,515.7L189.5,523.2L185.0,529.3L184.8,532.0L186.5,537.5L188.3,537.7L190.3,539.5L195.5,538.8L198.2,540.1L208.7,541.3L205.2,550.7L206.7,556.6L204.1,559.2L203.4,564.4L206.5,567.8L208.5,566.0L212.0,564.1L214.2,560.5L216.7,560.3L216.8,563.4L218.9,564.9L219.8,564.6L223.0,571.6L227.7,579.0L232.1,581.3L235.5,588.2L233.3,590.3L235.2,594.0L239.0,595.8L238.8,601.2L240.5,606.1L244.0,609.9L245.2,614.1L248.1,616.5L249.9,619.3L252.0,622.4L253.9,625.9L258.5,625.8L261.0,622.4L265.4,620.2L267.4,623.1L272.3,626.7L274.5,625.1L274.8,621.6L278.5,616.9L282.9,616.5L286.7,615.9L287.7,617.5L294.2,606.7L301.0,607.8L301.9,610.9L306.6,608.4L309.2,610.6L315.2,614.2L319.3,609.9L321.8,609.9L328.5,603.7L332.0,602.3L335.3,602.0L334.4,597.1L340.4,593.7L344.3,594.6L349.9,594.9L349.5,588.8L351.4,585.7L358.2,585.6L359.7,590.5L368.2,590.8L373.0,590.6L375.7,589.1L380.1,595.5L386.0,595.8L386.1,603.5L390.4,605.7L393.5,604.1L395.6,600.4L401.5,602.7L407.3,608.0L411.8,604.9L419.9,606.7L422.1,607.2L423.9,604.6L422.2,601.8L422.1,598.0L423.3,597.4L423.7,593.5L424.0,589.6L427.5,588.8L431.0,582.0L447.3,582.2L451.2,577.8L453.4,576.7L453.4,571.6L458.3,566.9L455.7,557.9L458.1,548.4L467.2,547.2L474.7,545.2L475.9,539.1L483.0,537.5L483.6,528.8L486.6,523.8L484.1,517.4L480.6,508.4L477.7,507.2L474.6,501.4L468.1,497.8L472.9,492.7L477.9,486.6L481.2,484.1L486.0,486.3L496.4,483.1L499.8,474.5L508.8,469.8L508.5,465.4L510.9,463.3L513.8,464.3L519.7,459.2L519.8,453.8L518.8,452.0L514.1,451.0L517.9,444.7L521.5,445.0L530.9,435.8L534.9,436.7L547.2,432.1L552.9,438.8L550.6,442.3L551.5,446.9L553.0,448.2L552.1,452.0L554.1,454.3L552.3,456.9L553.9,465.6L552.4,467.5L552.3,475.0L547.5,478.8L545.8,484.3L544.6,484.6L550.3,496.2L547.6,500.3L552.4,502.7L554.1,507.3L558.8,508.2L563.8,510.4L567.5,511.0L569.3,518.3L572.5,520.4L575.2,523.0L577.2,529.3L578.8,529.6L582.8,531.4L580.8,535.2L585.5,539.2L585.3,541.7L592.9,541.8L596.1,545.5L597.7,546.2L599.2,545.9L601.3,548.7L607.5,549.3L609.3,545.5L613.9,542.3L617.3,548.8L621.0,549.6L625.9,550.5L628.0,549.1L638.0,558.0L638.5,562.6L636.2,564.9L634.2,564.9L633.5,567.8L631.2,573.9L627.1,574.4L622.9,583.9L631.1,584.8L635.7,586.8L644.2,595.2L647.4,594.5L647.1,602.4L650.1,608.1L652.9,609.0L654.0,616.5L656.3,623.0L657.9,623.8L653.9,627.9L651.4,635.4L660.2,632.1L664.3,635.0L668.5,633.7L669.7,638.7L677.2,638.7L679.2,630.5L682.5,620.8L687.1,617.3L690.1,613.0L688.0,613.0L686.7,609.8L682.1,606.4L679.4,604.9L675.1,604.3L674.5,600.6L673.0,598.9L674.2,597.1L673.9,594.6L668.3,590.6L669.4,586.6L673.0,587.6L672.4,585.0L676.2,583.3L674.4,574.7L672.4,570.3L674.5,564.9L686.7,560.0L689.8,553.7L686.3,543.0L696.6,537.5L700.6,531.4L705.0,529.1L705.6,526.1L710.0,526.8L713.8,523.5L712.9,518.4L715.1,514.2L718.6,512.5L718.7,507.6L722.1,506.4L724.5,506.7L725.7,495.1L727.6,491.6L732.6,486.1L733.5,481.1L736.2,476.5L735.6,469.5L732.0,465.3L731.1,458.6L732.0,447.9L724.8,442.1L725.1,437.9L731.1,434.2L732.3,422.1L751.9,418.1L751.9,423.6L760.4,431.5L764.0,422.4L771.6,418.8L770.7,446.4L773.1,452.5L771.9,459.5L779.7,465.9L789.4,482.3L793.3,484.4L802.6,486.9L809.0,489.0L818.6,485.7L826.2,487.8L830.4,479.0L828.9,477.1L829.8,471.3L833.7,468.6L840.7,473.2L854.6,465.3L862.4,463.7L868.7,459.8L874.8,464.0L876.0,461.0L879.9,459.8L882.0,463.7L889.6,469.2L886.0,478.7L889.9,480.5L889.0,488.7L902.2,494.8L903.2,503.0L899.5,508.8L905.3,511.9L910.7,508.5L923.1,506.7L928.8,499.7L924.0,486.9L913.1,475.6L914.0,466.5L919.5,464.6L918.9,459.5L925.8,456.7L925.5,447.9L917.9,443.4L909.2,447.0L898.9,438.5L901.6,429.1L899.5,417.5L901.9,413.6L898.9,407.5L908.6,398.7L909.2,396.0L912.8,392.4L912.2,387.2L914.9,386.3L930.9,380.9L937.9,382.7L942.4,377.2L947.2,385.1L943.9,391.8L944.2,398.1L949.3,396.3L953.3,399.0L956.0,404.5L962.9,404.5L965.6,406.9L968.3,402.1L976.8,406.6L982.5,404.8L990.4,410.0L995.2,404.2L997.0,384.2L988.0,376.6L979.5,377.5L974.4,360.9L978.3,354.8L981.3,350.9L978.3,345.2L987.1,338.8L983.4,326.7L988.9,322.8L993.4,306.7L994.0,290.5L998.8,280.3L985.6,274.3L980.7,267.0L971.1,262.2L964.4,265.2L960.8,273.7L960.2,283.9L943.9,282.7L940.3,301.4L912.5,309.8L908.3,304.4L901.0,302.0L893.8,295.4L877.5,287.5L861.8,282.1L865.4,263.4L863.0,256.8L860.0,252.6L846.7,251.4L826.2,244.2L812.9,240.6L808.1,243.6L803.9,240.6L803.0,240.3L802.2,241.1L800.4,241.8L798.3,243.1L797.0,243.0L794.5,243.7L793.4,244.5L792.8,244.5L792.2,243.9L791.9,241.7L791.0,240.5L790.0,240.0L788.9,239.2L787.0,239.9L783.9,240.8L783.2,241.8L780.9,242.0L780.2,241.8L779.9,242.9L778.8,241.9L778.3,242.1L777.0,244.4L776.2,243.2L776.3,242.1L775.6,242.3L775.1,242.8L775.1,243.4L774.9,243.5L773.9,239.5L778.6,236.4L783.6,232.6L784.6,227.4L781.9,214.5L780.2,212.0L778.3,207.8L777.1,201.8L778.0,196.8L780.2,192.3L780.5,189.4L781.9,186.6L784.7,181.8L786.9,175.8L786.8,173.2L794.2,162.1L802.6,154.9L807.5,144.1L816.5,140.5L819.6,135.8L814.7,126.8L814.9,115.4L806.9,113.0L803.9,109.3L802.4,112.1L794.4,101.8L794.0,98.1L791.3,87.6L784.5,88.4L769.1,69.3L727.2,48.2L708.6,49.9L705.0,46.4L699.9,47.0L693.2,43.0L675.9,40.2L661.4,47.6L647.5,51.8L643.3,49.1L641.2,41.7L637.6,40.8L638.2,36.6L640.8,36.3L640.3,37.5L642.9,37.1L642.5,34.0L637.3,33.7L636.6,31.7L631.2,31.4L631.7,29.6L627.9,27.5L628.9,25.6L627.7,23.1L626.0,24.5L626.4,26.4L623.4,26.6L619.8,29.8L619.8,32.8L625.3,34.3L626.2,36.0L628.7,37.3L626.6,37.8L625.0,43.3L610.5,37.1L612.1,30.3L608.3,27.4L607.4,24.0L609.4,20.4L613.9,19.9L608.1,14.7L603.6,16.5L602.2,16.3L600.7,7.9L594.3,3.4L592.7,9.3L589.5,16.2L586.4,9.9L586.7,3.0L576.6,2.5L574.2,2.2Z"/></svg></span>
          <span class="menu-row-label">${W.t('nav.all_regions')}</span>
        </a>
        <div class="menu-section-head">${W.t('menu.settings')}</div>
        <button type="button" class="menu-row" data-hb-theme-toggle aria-label="${W.t('a11y.toggle_theme')}">
          <span class="menu-row-icon" data-hb-theme-icon>${SVG_MOON}</span>
          <span class="menu-row-label" data-hb-theme-label>Dark mode</span>
        </button>
        <div class="menu-row menu-row-lang">
          <span class="menu-row-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg></span>
          <span class="menu-row-label">${W.t('lang.label')}</span>
          <span class="menu-lang-seg" role="group" aria-label="${W.t('lang.label')}">
            <button type="button" class="menu-lang-btn" data-hb-lang="en">EN</button>
            <button type="button" class="menu-lang-btn" data-hb-lang="de">DE</button>
            <button type="button" class="menu-lang-btn" data-hb-lang="fr">FR</button>
          </span>
        </div>
        <a class="menu-row${cur('/more/')}" href="${REL}more/" data-close>
          <span class="menu-row-icon"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></span>
          <span class="menu-row-label">${W.t('nav.more')}</span>
        </a>
        <div class="menu-sheet-account" data-hb-account></div>
      </div>
    `;
    document.body.appendChild(menuSheet);
    // Re-sync now that the menu sheet's theme toggle is in the DOM —
    // matches the rail toggle's initial state (moon icon + Dark mode label
    // when in light, sun icon + Light mode label when in dark).
    syncThemeBtns();

    // === Language switcher ===
    // Mark the active language and wire direct selection. setLang persists
    // hb_lang + reloads, so every layer re-renders in the chosen language:
    // runtime chrome via W.t, static [data-i18n] nodes via hbI18n.apply, and
    // (Phase 2) the editorial content overlay.
    (function wireLangSwitch() {
      const cur = (W.hbI18n && W.hbI18n.lang) || 'en';
      document.querySelectorAll('[data-hb-lang]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-hb-lang') === cur);
      });
      document.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-hb-lang]');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        const lang = b.getAttribute('data-hb-lang');
        if (W.hbI18n && typeof W.hbI18n.setLang === 'function') W.hbI18n.setLang(lang);
      });
    })();

    function openMenuSheet() {
      menuSheet.classList.add('is-open');
      document.documentElement.classList.add('hb-menu-open');
    }
    function closeMenuSheet() {
      menuSheet.classList.remove('is-open');
      document.documentElement.classList.remove('hb-menu-open');
    }
    tabbar.querySelector('[data-hb-menu-toggle]').addEventListener('click', openMenuSheet);
    menuSheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeMenuSheet();
    });
    // Close on Escape so keyboard users + iPad-with-keyboard can dismiss
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuSheet.classList.contains('is-open')) closeMenuSheet();
    });

    // Swipe-down-to-close on the header strip. Honours the grabber bar's
    // implicit promise (Leon 2026-05-24: "small bar on top of the menu
    // indicates that you can swipe it down but you actually can't").
    // Tracks only the header so internal menu rows stay clickable + a
    // future scrollable menu body wouldn't fight the gesture. Drags the
    // card along during the swipe for affordance feedback; commits to
    // close at >80px or velocity >0.5 px/ms.
    const sheetCard = menuSheet.querySelector('.menu-sheet-card');
    const sheetHeader = menuSheet.querySelector('[data-hb-sheet-header]');
    let dragStart = null;
    let lastY = 0;
    let lastT = 0;
    sheetHeader.addEventListener('pointerdown', (e) => {
      // Skip when the user is actually pressing the close button.
      if (e.target.closest('[data-close]')) return;
      dragStart = { y: e.clientY, t: e.timeStamp };
      lastY = e.clientY;
      lastT = e.timeStamp;
      sheetCard.style.transition = 'none';
      try { sheetHeader.setPointerCapture(e.pointerId); } catch (_) {}
    });
    sheetHeader.addEventListener('pointermove', (e) => {
      if (!dragStart) return;
      const dy = Math.max(0, e.clientY - dragStart.y);
      sheetCard.style.transform = `translateY(${dy}px)`;
      lastY = e.clientY;
      lastT = e.timeStamp;
    });
    function endDrag(e) {
      if (!dragStart) return;
      const dy = lastY - dragStart.y;
      const dt = Math.max(1, lastT - dragStart.t);
      const velocity = dy / dt; // px/ms
      sheetCard.style.transform = '';
      sheetCard.style.transition = '';
      dragStart = null;
      if (dy > 80 || velocity > 0.5) closeMenuSheet();
    }
    sheetHeader.addEventListener('pointerup', endDrag);
    sheetHeader.addEventListener('pointercancel', endDrag);

    // Backdrop for mobile drawer
    const backdrop = document.createElement('div');
    backdrop.className = 'rail-backdrop';
    document.body.insertBefore(backdrop, document.body.firstChild);
    backdrop.addEventListener('click', closeMobileDrawer);

    // Burger button into the topbar (mobile only via CSS).
    // Two variants exist: chapter/saved/swipe/etc use .topbar; the
    // home page uses .home-topbar (search bar + heart icon row).
    // Insert the burger as the first child of whichever exists so the
    // mobile drawer is reachable everywhere — without it the rail is
    // entirely unreachable on phones.
    const topbar = document.querySelector('.topbar, .home-topbar');
    if (topbar) {
      const burger = document.createElement('button');
      burger.type = 'button';
      burger.className = 'rail-burger';
      burger.setAttribute('aria-label', W.t('a11y.open_nav'));
      burger.innerHTML = SVG_BURGER;
      burger.addEventListener('click', () => {
        rail.classList.add('is-open');
        backdrop.classList.add('is-show');
      });
      topbar.insertBefore(burger, topbar.firstChild);

      // Account entry · removed from the topbar 2026-05-26. The single
      // canonical entry is now the [data-hb-account] slot in the rail
      // between "More" and "Collapse", rendered by paintAccount(). One
      // place on every page, never in the top bar.
    }

    // Toggle expand/collapse (desktop)
    rail.querySelector('[data-hb-rail-toggle]').addEventListener('click', () => {
      const next = !rail.classList.contains('is-expanded');
      rail.classList.toggle('is-expanded', next);
      document.body.classList.toggle('rail-expanded', next);
      try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch {}
    });

    // Random — delegated globally so any `[data-hb-random]` button works
    // (rail item, the home-page "Surprise me" button, etc).
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-hb-random]');
      if (!t) return;
      e.preventDefault();
      closeMobileDrawer();
      randomJump();
    });

    // Close drawer on link clicks (mobile)
    rail.querySelectorAll('a.rail-item, .rail-brand').forEach(a => {
      a.addEventListener('click', closeMobileDrawer);
    });

    function closeMobileDrawer() {
      rail.classList.remove('is-open');
      backdrop.classList.remove('is-show');
    }

    // Account block: "Log in" pill when anonymous, username + log-out when
    // authed. Re-paints on session change (signIn/signOut, cross-tab, server
    // revocation flipping currentUser to null). Two slots: the top-right
    // FAB (desktop) and the menu sheet's bottom block (mobile). Both
    // get the same markup so behaviour is identical at every viewport.
    const accountSlots = document.querySelectorAll('[data-hb-account]');
    function paintAccount() {
      const u = session.user();
      accountSlots.forEach(slot => {
        if (u) {
          const display = u.handle || u.username;
          const initials = (display || '?').slice(0, 1).toUpperCase();
          // Username text doubles as the entry point to /full/account/.
          // Logout button stays separate so an accidental tap on the name
          // doesn't sign people out. Render the user's uploaded avatar
          // when present (auth:currentUser resolves avatarStorageId →
          // avatarUrl server-side); fall back to the initials chip.
          const avatarMarkup = u.avatarUrl
            ? `<span class="rail-user-avatar rail-user-avatar-img" aria-hidden="true"><img src="${escapeText(u.avatarUrl)}" alt="" /></span>`
            : `<span class="rail-user-avatar" aria-hidden="true">${escapeText(initials)}</span>`;
          slot.innerHTML = `
            <div class="rail-user">
              ${avatarMarkup}
              <a class="rail-user-name label" href="${REL}account/" style="color:inherit;text-decoration:none;" title="Account settings">${escapeText(display)}</a>
              <button type="button" class="rail-user-out" data-hb-signout aria-label="Log out" title="Log out">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              </button>
            </div>
          `;
          slot.querySelector('[data-hb-signout]').addEventListener('click', () => {
            closeMenuSheet();
            session.signOut();
          });
        } else {
          slot.innerHTML = `
            <button type="button" class="rail-signin" data-hb-open-signin>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              <span class="label">Log in</span>
            </button>
          `;
          slot.querySelector('[data-hb-open-signin]').addEventListener('click', () => {
            closeMobileDrawer();
            closeMenuSheet();
            openSignIn();
          });
        }
      });
    }
    paintAccount();
    session.subscribe(paintAccount);

    refreshFavCount();
    refreshVisitedCount();
  }

  // Tiny HTML escape helper used in a couple of dynamic injection sites.
  function escapeText(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Sign-in modal (lazy-mounted, single instance) ─────────────────────
  let signInOverlay = null;
  function ensureSignInOverlay() {
    if (signInOverlay) return signInOverlay;
    const o = document.createElement('div');
    o.className = 'hb-signin-overlay';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.setAttribute('aria-label', 'Log in');
    o.innerHTML = `
      <div class="hb-signin-card" data-card>
        <button type="button" class="hb-signin-close" data-close aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <h2 class="hb-signin-title">Log in</h2>
        <p class="hb-signin-sub">Saved spots and swipe history follow your account across devices.</p>
        <form class="hb-signin-form" data-form>
          <label class="hb-signin-field">
            <span>Username or email</span>
            <input type="text" name="login" autocomplete="username" required spellcheck="false" autocapitalize="none" />
          </label>
          <label class="hb-signin-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <div class="hb-signin-error" data-error hidden></div>
          <button type="submit" class="hb-signin-submit" data-submit>Log in</button>
        </form>
      </div>
    `;
    document.body.appendChild(o);
    const card     = o.querySelector('[data-card]');
    const closeBtn = o.querySelector('[data-close]');
    const form     = o.querySelector('[data-form]');
    const errorEl  = o.querySelector('[data-error]');
    const submit   = o.querySelector('[data-submit]');

    function setError(msg) {
      if (msg) { errorEl.textContent = msg; errorEl.hidden = false; }
      else { errorEl.textContent = ''; errorEl.hidden = true; }
    }
    function close() {
      o.classList.remove('is-show');
      setError(null);
      form.reset();
      submit.disabled = false;
      submit.textContent = 'Log in';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    o.addEventListener('click', (e) => { if (!card.contains(e.target)) close(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const login    = String(fd.get('login') || '').trim();
      const password = String(fd.get('password') || '');
      if (!login || !password) return;
      setError(null);
      submit.disabled = true;
      submit.textContent = 'Logging in…';
      try {
        await session.signIn(login, password);
        close();
      } catch (err) {
        setError(err && err.message ? String(err.message).replace(/^Error: /, '') : 'Log in failed');
        submit.disabled = false;
        submit.textContent = 'Log in';
      }
    });

    signInOverlay = {
      el: o,
      open() {
        o.classList.add('is-show');
        document.addEventListener('keydown', onKey);
        // Focus the login field on next frame so the show transition runs.
        requestAnimationFrame(() => {
          const inp = form.querySelector('input[name="login"]');
          if (inp) inp.focus();
        });
      },
      close,
    };
    return signInOverlay;
  }
  function openSignIn() {
    if (session.isSignedIn()) return;  // Already authed — nothing to do.
    ensureSignInOverlay().open();
  }
  // Any element with data-hb-open-signin opens the modal (e.g. the
  // standalone /full/login/ page just renders one button with this attr).
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-hb-open-signin]');
    if (t) { e.preventDefault(); openSignIn(); }
  });

  // Count favorites / visited keys whose anchor is on the preview
  // allowlist · matches what /full/saved/ + /full/visited/ actually
  // render in preview mode. Used by the rail badges so the bubble
  // number doesn't disagree with the page content. Falls back to the
  // raw count when preview mode is off. 2026-05-27 per Leon.
  function previewFilteredCount(list) {
    if (!PREVIEW_MODE) return list.length;
    let n = 0;
    for (const key of list) {
      const anchor = (key || '').split('#')[1];
      if (anchor && previewSpotAllowed(anchor)) n++;
    }
    return n;
  }

  function refreshFavCount() {
    const n = previewFilteredCount(favorites.list());
    document.querySelectorAll('[data-hb-fav-count]').forEach(el => {
      if (n > 0) {
        el.textContent = String(n);
        el.setAttribute('data-on', '1');
      } else {
        el.textContent = '';
        el.removeAttribute('data-on');
      }
    });
    // Compact dot indicator on the Liked rail item when collapsed
    const likedItem = document.querySelector('.rail-item[data-hb-saved-link]');
    if (likedItem) likedItem.classList.toggle('has-count', n > 0);
  }

  // Mirror of refreshFavCount for the "Been there" pile. Targets every
  // [data-hb-visited-count] painter (the menu sheet row's badge today;
  // future surfaces wire up automatically).
  function refreshVisitedCount() {
    const n = previewFilteredCount(visited.list());
    document.querySelectorAll('[data-hb-visited-count]').forEach(el => {
      if (n > 0) {
        el.textContent = String(n);
        el.setAttribute('data-on', '1');
      } else {
        el.textContent = '';
        el.removeAttribute('data-on');
      }
    });
  }

  // --- Random spot
  let spotsPromise = null;
  function loadSpots() {
    if (W.SPOTS && Array.isArray(W.SPOTS)) return Promise.resolve(W.SPOTS);
    if (spotsPromise) return spotsPromise;
    spotsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${REL}map/spots-data.js`;
      s.onload = () => resolve(W.SPOTS || []);
      s.onerror = () => reject(new Error('spots-data load failed'));
      document.head.appendChild(s);
    });
    return spotsPromise;
  }

  // Translate a spot.href (which is rooted at /full/map/) into something
  // relative to the page that called us. Routes through spotDetailHref so
  // every click on a spot lands on the standalone detail page rather than
  // the chapter scroll.
  function spotHrefFromHere(spot) {
    if (W.HB && typeof W.HB.spotDetailHref === 'function') {
      return W.HB.spotDetailHref(spot, REL);
    }
    let href = (spot && spot.href) || '';
    href = href.replace(/^\.\.\//, '');
    return `${REL}${href}`;
  }

  // === Random pick · fly-in animation ===
  // Build a fullscreen overlay with N filler cards swirling in from offscreen
  // edges, then collapse to a single "winner" card with Open / Re-roll / Close
  // controls. No per-frame JS -- everything's a CSS transition. Cancellable
  // via Esc, the close button, or clicking the backdrop outside the winner.
  let randomActive = false;
  function randomFly() {
    if (randomActive) return;
    randomActive = true;
    // Prefer the unified HB.spots store (Convex-backed, includes the new
    // spots that aren't in the static sidecar). Fall back to loadSpots()
    // for pages that mount social.js without spots-data.js.
    const fromStore = spots.all();
    const ready = fromStore.length
      ? Promise.resolve(fromStore)
      : loadSpots();
    ready.then(allSpots => {
      const eligible = (allSpots || []).filter(s => W.HB.hasRealImage(s));
      if (!eligible.length) { randomActive = false; return; }

      function pickWinner() { return eligible[Math.floor(Math.random() * eligible.length)]; }
      let winner = pickWinner();

      // Preload the winner's hero photo as soon as we've picked.  The shuffle
      // animation gives us ~1.75s of cover time, more than enough for the
      // 1800w derivative to land in the browser cache before showWinner()
      // builds the <img>. Without this, the winner reveal flashes through a
      // blank box while the image loads.
      function preloadWinnerImage(spot) {
        const a = W.HB.photoAttrs({
          photoId: spot.imagePhotoId, image: spot.image,
          width: 1800, prefix: REL,
        });
        if (!a.src) return;
        const img = new Image();
        if (a.srcset) img.srcset = a.srcset;
        img.src = a.src;
      }
      preloadWinnerImage(winner);

      const overlay = document.createElement('div');
      overlay.className = 'hb-random-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Random spot');
      overlay.innerHTML = `
        <button type="button" class="hb-random-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="hb-random-stage" data-stage></div>
        <div class="hb-random-winner" data-winner hidden></div>
      `;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('is-show'));

      const stage = overlay.querySelector('[data-stage]');
      const winnerEl = overlay.querySelector('[data-winner]');
      const closeBtn = overlay.querySelector('.hb-random-close');
      let timers = [];

      function cleanup() {
        timers.forEach(t => clearTimeout(t));
        timers = [];
        overlay.classList.remove('is-show');
        setTimeout(() => { overlay.remove(); randomActive = false; }, 260);
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) { if (e.key === 'Escape') cleanup(); }
      document.addEventListener('keydown', onKey);
      closeBtn.addEventListener('click', cleanup);
      overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) cleanup(); });

      function runRound() {
        stage.innerHTML = '';
        winnerEl.innerHTML = '';
        winnerEl.classList.remove('is-show');
        winnerEl.hidden = true;

        // Pool of filler cards drawn evenly across all chapters so the
        // animation feels like the whole catalog, not "more cards from the
        // current chapter".
        const fillerCount = Math.min(13, eligible.length - 1);
        const fillerSet = new Set();
        const fillerSpots = [];
        let guard = 0;
        while (fillerSpots.length < fillerCount && guard < fillerCount * 6) {
          guard++;
          const pick = eligible[Math.floor(Math.random() * eligible.length)];
          if (pick === winner) continue;
          if (fillerSet.has(pick)) continue;
          fillerSet.add(pick);
          fillerSpots.push(pick);
        }

        const cards = fillerSpots.map(s => buildCard(s, false));
        cards.forEach(c => stage.appendChild(c));

        // Frame 1: cards positioned offscreen at random angles, opacity 0.
        // We schedule the transition target on the next frame so the browser
        // commits the start position before applying the end transform.
        requestAnimationFrame(() => {
          cards.forEach((card, idx) => {
            const angle = Math.random() * Math.PI * 2;
            const r = 140 + Math.random() * 220;
            const tx = Math.cos(angle) * r;
            const ty = Math.sin(angle) * r;
            const rot = (Math.random() - 0.5) * 60;
            const sc = 0.85 + Math.random() * 0.4;
            const t1 = setTimeout(() => {
              card.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${sc.toFixed(2)})`;
              card.style.opacity = '1';
            }, idx * 35);
            timers.push(t1);
          });
        });

        // Phase 2: filler cards fly back out, then we reveal the winner.
        const flyOutT = setTimeout(() => {
          cards.forEach(card => {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.max(window.innerWidth, window.innerHeight) * 1.1;
            const tx = Math.cos(angle) * r;
            const ty = Math.sin(angle) * r;
            const rot = (Math.random() - 0.5) * 80;
            card.style.transform = `translate(${tx.toFixed(0)}px, ${ty.toFixed(0)}px) rotate(${rot.toFixed(1)}deg) scale(0.5)`;
            card.style.opacity = '0';
          });
        }, 1300);
        timers.push(flyOutT);

        const winnerT = setTimeout(() => showWinner(), 1750);
        timers.push(winnerT);
      }

      function buildCard(spot, isWinner) {
        const card = document.createElement('div');
        card.className = 'hb-random-card' + (isWinner ? ' is-winner' : '');
        const dims = (spot.imageWidth && spot.imageHeight)
          ? [spot.imageWidth, spot.imageHeight]
          : (W.HB_THUMB_DIMS || {})[spot.image];
        const dimsAttr = dims ? ` width="${dims[0]}" height="${dims[1]}"` : '';
        const a = W.HB.photoAttrs({
          photoId: spot.imagePhotoId, image: spot.image,
          width: 1000, prefix: REL, sizes: '180px',
        });
        const ss = a.srcset ? ` srcset="${a.srcset}" sizes="${a.sizes}"` : '';
        card.innerHTML = `
          <img src="${a.src}"${ss} alt=""${dimsAttr} />
          <div class="rc-name">${escapeText(spot.title || '')}</div>
        `;
        // Start position: offscreen at a random angle so the entry feels
        // like the cards rush in from the edges of the screen.
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.max(window.innerWidth, window.innerHeight) * 0.85;
        const sx = Math.cos(angle) * radius;
        const sy = Math.sin(angle) * radius;
        const sr = (Math.random() - 0.5) * 80;
        card.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) rotate(${sr.toFixed(1)}deg) scale(0.55)`;
        return card;
      }

      function showWinner() {
        const region = (W.LEGEND || []).find(c => c.number === winner.chapter);
        const regionName = region ? region.name : (winner.chapter_id || '');
        const kicker = singularKicker(winner.kicker || '');
        const dims = (winner.imageWidth && winner.imageHeight)
          ? [winner.imageWidth, winner.imageHeight]
          : (W.HB_THUMB_DIMS || {})[winner.image];
        const dimsAttr = dims ? ` width="${dims[0]}" height="${dims[1]}"` : '';
        // Winner card is rendered large (~400-500 px wide) so use the 1800
        // tier as default and let srcset cover everything else. Convex-only
        // spots have no `winner.image`, so the legacy `img/m/` path used
        // before this change would 404; the helper falls back to the
        // derivative ladder instead.
        const wAttrs = W.HB.photoAttrs({
          photoId: winner.imagePhotoId, image: winner.image,
          width: 1800, prefix: REL, sizes: '(min-width: 768px) 480px, 80vw',
        });
        const wSs = wAttrs.srcset ? ` srcset="${wAttrs.srcset}" sizes="${wAttrs.sizes}"` : '';
        // Layout: photo → title → region → buttons → kicker. Kicker moved
        // below the action buttons so it doesn't compete with the title for
        // attention; users get the title fast, decide to open or reroll, and
        // then read the kicker if they're curious. Extra padding above the
        // title keeps it from kissing the photo.
        winnerEl.innerHTML = `
          <div class="rw-card">
            <img src="${wAttrs.src}"${wSs} alt=""${dimsAttr} />
          </div>
          <div class="rw-meta">
            <h2 class="rw-title">${escapeText(winner.title)}</h2>
            <span class="rw-region">${escapeText(regionName)}</span>
          </div>
          <div class="rw-actions">
            <button type="button" class="rw-btn ghost" data-reroll>Try again</button>
            <a class="rw-btn primary" data-open>
              Open spot
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </a>
          </div>
          ${kicker ? `<p class="rw-kicker">${escapeText(kicker)}</p>` : ''}
        `;
        winnerEl.querySelector('[data-open]').setAttribute('href', spotHrefFromHere(winner));
        winnerEl.querySelector('[data-reroll]').addEventListener('click', () => {
          winner = pickWinner();
          preloadWinnerImage(winner);
          runRound();
        });
        winnerEl.hidden = false;
        requestAnimationFrame(() => winnerEl.classList.add('is-show'));
      }

      function escapeText(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

      runRound();
    });
  }

  // Backwards-compat alias: anything that called the old jump-style behaviour
  // still works, but routed through the new animation.
  function randomJump() { randomFly(); }

  // --- Submit Photo flow: 3-dots menu next to the heart on every spot card.
  // The menu is an Apple-style popover that floats via fixed positioning so
  // it can spill outside the card. Items: Submit photo · Wildcamping
  // status (when applicable) · Been there (signed-in only). The
  // Wildcamping modal opens a 3-state UI; Been there toggles visited
  // state and surfaces the spot in /full/visited/.
  const SVG_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  const SVG_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  // SVG_CHECK_CIRCLE is declared earlier (next to the rail icon set) so
  // both the rail and this kebab menu can reference the same constant.

  function escapeText(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function injectSpotMenu(slide) {
    const body = slide.querySelector('.sp-body');
    if (!body || slide.querySelector('.hb-spot-menu-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hb-spot-menu-btn';
    btn.setAttribute('aria-label', 'More actions');
    btn.innerHTML = SVG_DOTS;
    body.appendChild(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSpotMenu(slide, btn);
    });
  }

  function openSpotMenu(slide, anchor) {
    // Resolve the slide's wildCamping payload (if any) so we can decide
    // whether to add the Wildcamping-status item to the menu.
    const ch = currentChapterId();
    const spotKey = ch && slide.id ? `${ch}#${slide.id}` : null;
    const spot = spotKey ? spots.get(spotKey) : null;
    const hasWild = !!(spot && spot.wildCamping);
    // hasCredits decides whether to add the "Photo credits" menu item.
    // Multi-photo cards each carry their own credit; clicking the item
    // opens a modal listing all of them so navigating the carousel
    // doesn't desync the displayed credit.
    const hasCredits = !!(spot && spot.photos && spot.photos.some(p => p.credit));
    openMenuPanel(anchor, {
      spotKey,
      hasWild,
      hasCredits,
      onSubmit: () => openSubmitModal(slide),
      onWild:   () => hasWild && openWildCampingModal(spot),
      onCredits: () => hasCredits && openPhotoCreditsModal(spot),
    });
  }

  // Shared menu renderer used by both the detail-page (.slide-spot) and
  // chapter-card (.cl-card) kebabs. Centralises the open/close machinery
  // so adding new items happens in one place.
  //
  // The "Been there" item is signed-in-only by design: anonymous
  // visitors aren't paying customers and don't get the affordance.
  // visited.signedIn() drives the gate; the kebab silently omits the
  // item when it returns false.
  function openMenuPanel(anchor, { spotKey, hasWild, hasCredits, onSubmit, onWild, onCredits }) {
    document.querySelectorAll('.hb-spot-menu').forEach(m => m.remove());

    const visitedSignedIn = visited.signedIn();
    const isVisited = !!(spotKey && visitedSignedIn && visited.has(spotKey));

    const items = [
      `<button type="button" class="hb-spot-menu-item" data-action="submit">${SVG_UPLOAD}<span>Submit photo</span></button>`,
    ];
    if (hasWild) {
      items.push(`<button type="button" class="hb-spot-menu-item" data-action="wild">${SVG_TENT}<span>Wildcamping status</span></button>`);
    }
    if (spotKey && visitedSignedIn) {
      const label = isVisited ? 'Visited ✓ · undo' : 'Been there';
      const cls = isVisited ? 'hb-spot-menu-item is-on' : 'hb-spot-menu-item';
      items.push(`<button type="button" class="${cls}" data-action="visited">${SVG_CHECK_CIRCLE}<span>${label}</span></button>`);
    }
    if (hasCredits) {
      // Clickable item — opens a small modal listing each photo's
      // credit. Earlier I'd inlined the credit text here, but multi-
      // photo cards have one credit per photo and the kebab can't
      // know which photo the user is asking about. Modal sidesteps it.
      items.push(`<button type="button" class="hb-spot-menu-item" data-action="credits"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/><circle cx="17" cy="8.5" r="0.6" fill="currentColor"/></svg><span>Photo credits</span></button>`);
    }
    const menu = document.createElement('div');
    menu.className = 'hb-spot-menu';
    menu.innerHTML = items.join('');
    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    // Tentative right-anchored so the kebab's right edge is the
    // menu's right edge. After layout we re-measure and clamp
    // horizontally if the menu would spill off-screen.
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    requestAnimationFrame(() => {
      const menuW = menu.offsetWidth;
      const menuH = menu.offsetHeight;
      const PAD = 8;

      // Horizontal: if the menu would extend past the LEFT edge,
      // anchor by `left` instead so it opens to the right of the
      // kebab and stays inside the viewport.
      const wouldOverflowLeft = (rect.right - menuW) < PAD;
      if (wouldOverflowLeft) {
        menu.style.right = 'auto';
        menu.style.left = `${Math.min(rect.left, window.innerWidth - menuW - PAD)}px`;
      }

      // Vertical: ALWAYS open upward — the kebab in the spot
      // detail action row sits low enough that opening downward
      // disappears under iOS Safari's URL bar / the page bottom
      // chrome, and forcing up keeps the affordance predictable.
      // If there isn't enough room above (rare), clamp to the
      // viewport top instead of flipping down.
      menu.style.top = `${Math.max(PAD, rect.top - menuH - PAD)}px`;
      menu.classList.add('is-flip');
      menu.classList.add('is-show');
    });

    function close() {
      menu.classList.remove('is-show');
      setTimeout(() => menu.remove(), 160);
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    }
    function onOutside(e) { if (!menu.contains(e.target) && e.target !== anchor) close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    setTimeout(() => {
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', close, true);
    }, 0);

    menu.querySelector('[data-action="submit"]')?.addEventListener('click',  () => { close(); onSubmit?.();  });
    menu.querySelector('[data-action="wild"]')?.addEventListener('click',    () => { close(); onWild?.();    });
    menu.querySelector('[data-action="credits"]')?.addEventListener('click', () => { close(); onCredits?.(); });
    menu.querySelector('[data-action="visited"]')?.addEventListener('click', () => {
      close();
      if (spotKey) visited.toggle(spotKey);
    });
  }

  function openSubmitModal(spotInfoOrSlide) {
    // Accept either a .slide-spot DOM element (legacy detail-page caller)
    // or a plain {id, title, spotKey} bag (chapter card kebab caller).
    let id, title, spotKey;
    if (spotInfoOrSlide && spotInfoOrSlide.nodeType === 1) {
      const slide = spotInfoOrSlide;
      id = slide.id || '';
      title = slide.querySelector('.sp-title')?.textContent?.trim() || id;
      const ch = currentChapterId();
      spotKey = ch ? `${ch}#${id}` : id;
    } else {
      const info = spotInfoOrSlide || {};
      id = info.id || '';
      title = info.title || id;
      spotKey = info.spotKey || id;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'hb-modal-backdrop';
    backdrop.innerHTML = `
      <div class="hb-modal" role="dialog" aria-label="Submit a photo">
        <h2>Submit a photo</h2>
        <p class="sub">For ${escapeText(title)}</p>
        <div class="disclaimer">
          Photos are reviewed manually. We only publish photos that match the editorial style of the guide. If you found this on someone else's feed, please add their Instagram handle so we can credit them properly.
        </div>
        <label class="file-drop">
          <input type="file" accept="image/*" name="photo" />
          <span class="file-prompt">${SVG_UPLOAD}<b>Tap to choose a photo</b><br>JPG or PNG, will be resized to 2000px</span>
          <div class="file-preview">
            <img alt="Preview" />
            <button type="button" class="replace">Replace</button>
          </div>
        </label>
        <label class="field">
          <span>Photographer's Instagram (optional)</span>
          <input type="text" name="ig" placeholder="@username" autocomplete="off" />
        </label>
        <label class="field">
          <span>Anything to add (optional)</span>
          <textarea name="note" rows="2" placeholder="Where it was taken, time of year, anything useful…"></textarea>
        </label>
        <div class="status" hidden></div>
        <div class="actions">
          <button type="button" class="btn-ghost" data-cancel>Cancel</button>
          <button type="button" class="btn-primary" data-submit disabled>Submit</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-show'));

    const modal = backdrop.querySelector('.hb-modal');
    const fileInput = modal.querySelector('input[type="file"]');
    const fileDrop = modal.querySelector('.file-drop');
    const previewImg = modal.querySelector('.file-preview img');
    const igInput = modal.querySelector('input[name="ig"]');
    const noteInput = modal.querySelector('textarea[name="note"]');
    const submitBtn = modal.querySelector('[data-submit]');
    const cancelBtn = modal.querySelector('[data-cancel]');
    const replaceBtn = modal.querySelector('.replace');
    const statusEl = modal.querySelector('.status');

    let chosenDataUrl = null;

    function setStatus(text, kind) {
      if (!text) { statusEl.hidden = true; statusEl.textContent = ''; statusEl.className = 'status'; return; }
      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.className = 'status ' + (kind || 'busy');
    }

    function close() {
      backdrop.classList.remove('is-show');
      setTimeout(() => backdrop.remove(), 220);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    replaceBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });

    function handleFile(file) {
      if (!file) return;
      // Resize to max 2000px on the long edge so the JSON payload stays
      // under Vercel's serverless body-size limits.
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 2000;
          const ratio = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * ratio);
          const h = Math.round(img.height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          chosenDataUrl = canvas.toDataURL('image/jpeg', 0.86);
          previewImg.src = chosenDataUrl;
          fileDrop.classList.add('has-file');
          submitBtn.disabled = false;
          setStatus(null);
        };
        img.onerror = () => setStatus('Could not read that image.', 'err');
        img.src = reader.result;
      };
      reader.onerror = () => setStatus('Could not read the file.', 'err');
      reader.readAsDataURL(file);
    }

    submitBtn.addEventListener('click', async () => {
      if (!chosenDataUrl) return;
      submitBtn.disabled = true;
      setStatus('Sending…', 'busy');
      try {
        const res = await fetch(`${REL}../api/submit-photo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spot: spotKey,
            title,
            ig: igInput.value.trim(),
            note: noteInput.value.trim(),
            dataUrl: chosenDataUrl,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(body || `${res.status}`);
        }
        setStatus('Thanks · we\'ll review it manually and reach out if we use it.', 'ok');
        submitBtn.textContent = 'Sent';
        setTimeout(close, 2200);
      } catch (e) {
        setStatus('Could not submit. Please try again later.', 'err');
        submitBtn.disabled = false;
      }
    });
  }

  // --- Multi-image carousel on spot cards ---------------------------------
  // For each .slide-spot[id], if HB_SPOT_IMAGES has an entry for that spot
  // (>=2 photos), rebuild .sp-photo as a stack of <img class="hb-slide">,
  // dot pagination, and chevron arrows. Single-photo spots are untouched.
  // Also hides the matching slide-spread card since its photos are now part
  // of the carousel above it -- avoids showing the same images twice.
  const SVG_CHEV_LEFT  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const SVG_CHEV_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  // ── Editorial overlay ──────────────────────────────────────────────────
  // Replace the static deck / body / specs / "Open in Maps" link rendered
  // from chapter HTML with whatever lives in the DB. This means a Convex
  // edit (e.g. fixing a typo in a spec) flows to the page without a
  // rebuild. If the DB row has no editorial fields (offline or
  // pre-migration), we leave the static HTML alone -- no regression.
  // Known spec labels are UI chrome (not editorial content), so map them to
  // i18n keys. The overlay below re-tags them with data-i18n and re-localizes,
  // otherwise a Convex spec edit would reintroduce the English label.
  const SPEC_LABEL_I18N = {
    'Region': 'spec.region',
    'Access': 'spec.access',
    'Effort': 'spec.effort',
    'Best light': 'spec.best_light',
  };

  function applyEditorial(slide, chapterId) {
    const anchor = slide.id;
    if (!anchor) return;
    const key = `${chapterId}#${anchor}`;
    const spot = spots.get(key);
    if (!spot) return;

    // Track the last applied content per slide so we don't thrash the DOM
    // when Convex sends a no-op update.
    const fingerprint = JSON.stringify([spot.deck, spot.body, spot.specs, spot.maps_url]);
    if (slide.dataset.hbEditorialKey === fingerprint) return;
    slide.dataset.hbEditorialKey = fingerprint;

    // Deck (subtitle under the title)
    if (spot.deck) {
      const deckEl = slide.querySelector('.sp-deck');
      if (deckEl) deckEl.textContent = spot.deck;
    }

    // Body paragraphs (everything inside .sp-body > .body)
    if (spot.body && spot.body.length) {
      const bodyEl = slide.querySelector('.sp-body .body');
      if (bodyEl) {
        bodyEl.innerHTML = spot.body
          .map(p => `<p>${escapeText(p)}</p>`)
          .join('');
      }
    }

    // Specs grid (Region / Access / Effort / Best light, etc.)
    if (spot.specs && spot.specs.length) {
      const specsEl = slide.querySelector('.specs');
      if (specsEl) {
        specsEl.innerHTML = spot.specs
          .map(s => {
            const k = SPEC_LABEL_I18N[s.label];
            const lbl = k
              ? `<span class="lbl" data-i18n="${k}">${escapeText(s.label)}</span>`
              : `<span class="lbl">${escapeText(s.label)}</span>`;
            return `<div class="spec">${lbl}<span class="val">${escapeText(s.value)}</span></div>`;
          })
          .join('');
        // Labels are chrome; re-localize the rewritten subtree. Values stay as
        // the DB sends them (editorial content, localized in Phase 2).
        if (W.hbI18n && typeof W.hbI18n.apply === 'function') W.hbI18n.apply(specsEl);
      }
    }

    // "Open in Maps" link href -- the chapter HTML hardcodes it; if the DB
    // value is set and differs, prefer the DB.
    if (spot.maps_url) {
      const mapsLink = slide.querySelector('.sp-foot a.locked, .sp-foot a[href*="maps"]');
      if (mapsLink && mapsLink.getAttribute('href') !== spot.maps_url) {
        mapsLink.setAttribute('href', spot.maps_url);
      }
    }
  }

  // Verdict → display label + colour. Wording is deliberately advisory,
  // not authoritative — the AI verdict can be wrong about cantonal /
  // local enforcement that doesn't show up in federal layers. The
  // disclaimer in the modal reinforces this.
  const WILD_LABELS = {
    forbidden:   { label: 'Forbidden',          tone: 'danger' },
    discouraged: { label: 'Not allowed',        tone: 'warn'   },
    restricted:  { label: 'Local rules apply',  tone: 'note'   },
    tolerated:   { label: 'Likely tolerated',   tone: 'ok'     },
    unknown:     { label: 'Unknown',            tone: 'mute'   },
  };
  // The "rulebook" sources — true for every spot. Per-spot sources
  // (canton, federal protection layers) are added on top in the modal.
  const WILD_RULEBOOK = [
    'SAC — "Camping and bivouacking in the Swiss mountains" (Swiss Alpine Club, 2014)',
    'Swisstopo geo.admin.ch — federal protection inventories (BLN, hunting reserves, fens, floodplains, parks)',
  ];
  // Per-canton source attribution. Only the canton that owns a spot
  // shows up in the modal — keeps the list relevant.
  const WILD_CANTON_SOURCES = {
    'Appenzell Innerrhoden (AI)': 'Appenzell Innerrhoden Standeskommission — Alpstein wild-camping ban (2024–2025)',
    'Glarus (GL)':                'Glarus Süd municipality — Muttsee/Limmernsee/Klöntal ban (2024)',
    'Valais (VS)':                'Canton Valais hiking + tourism portals',
    'Vaud (VD)':                  'Canton Vaud + regional park (Gruyère Pays-d\'Enhaut, Jura vaudois)',
    'Ticino (TI)':                'Cantone Ticino — wild-camping cantonal ban + Maggia/Verzasca floodplain protection',
    'Bern (BE)':                  'Canton Bern hiking portals + BAFU game-reserve maps',
    'Fribourg (FR)':              'Naturpark Gantrisch + Parc Gruyère Pays-d\'Enhaut',
    'St. Gallen (SG)':            'Canton St. Gallen + UNESCO Tectonic Arena Sardona rules',
    'Grisons (GR)':               'Canton Grisons + Swiss National Park buffer zones',
    'Lucerne (LU)':               'UNESCO Biosphäre Entlebuch park rules',
    'Schwyz (SZ)':                'Canton Schwyz tourism portals',
    'Nidwalden (NW)':             'Canton Nidwalden tourism portals',
    'Uri (UR)':                   'Canton Uri tourism portals',
    'Jura (JU)':                  'Pro Natura — Etang de la Gruère raised-bog reserve',
    'France':                     'Préfecture Haute-Savoie / La Chamoniarde — Aiguilles Rouges + Mont-Blanc bivouac rules',
  };

  function openWildCampingModal(spot) {
    if (!spot || !spot.wildCamping) return;
    const wc = spot.wildCamping;
    const v = wc.verdict || 'unknown';
    const meta = WILD_LABELS[v] || WILD_LABELS.unknown;
    const reason = wc.reason || '';
    const title = spot.title || '';

    // Per-spot sources: federal protection layers from the original
    // research + the canton-specific authority. Layered on top of the
    // global rulebook so each modal only shows sources actually
    // relevant to this spot.
    const protections = Array.isArray(wc.protections) ? wc.protections : [];
    const cantonSrc = wc.canton && WILD_CANTON_SOURCES[wc.canton];
    const sources = [
      ...WILD_RULEBOOK,
      ...(cantonSrc ? [cantonSrc] : []),
    ];

    // Result HTML — built once, swapped into place after the loading
    // animation completes. Hidden initially so the user starts with the
    // "Generate AI review" call-to-action and the AI disclaimer up
    // front. The 4-second pretend-loading sequence makes the AI nature
    // explicit (and gives the disclaimer time to register).
    const resultHtml = `
      <div class="hb-wild-head">
        <span class="hb-wild-kicker">Wildcamping</span>
        <h2 class="hb-wild-title">${escapeText(title)}</h2>
        <span class="hb-wild-chip is-${meta.tone}">${escapeText(meta.label)}</span>
      </div>
      ${reason ? `<p class="hb-wild-reason">${escapeText(reason)}</p>` : ''}
      ${protections.length ? `
        <div class="hb-wild-protections">
          <span class="hb-wild-section-label">Protected zones at this spot</span>
          <ul>
            ${protections.map(p => `<li>${escapeText(p)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      <div class="hb-wild-disclaimer">
        <strong>AI-researched. Can be wrong.</strong> This verdict was assembled by automated lookup against the federal protection layers and known cantonal bans. Local enforcement varies, rules change, and tourist hotspots may be policed even when the federal map says "tolerated". Always verify locally before relying on this for an overnight.
      </div>
      <details class="hb-wild-sources">
        <summary>Sources</summary>
        <ul>
          ${sources.map(s => `<li>${escapeText(s)}</li>`).join('')}
        </ul>
      </details>
    `;

    const backdrop = document.createElement('div');
    backdrop.className = 'hb-modal-backdrop hb-wild-modal-backdrop';
    backdrop.innerHTML = `
      <div class="hb-modal hb-wild-modal is-pre" role="dialog" aria-label="Wildcamping status">
        <button type="button" class="hb-wild-close" data-close aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="hb-wild-pre">
          <span class="hb-wild-kicker">Wildcamping</span>
          <h2 class="hb-wild-title">${escapeText(title)}</h2>
          <p class="hb-wild-pre-blurb">An AI verdict on whether wild camping is allowed at this spot, drawing on federal protection inventories and known cantonal bans. Generation takes a few seconds.</p>
          <button type="button" class="hb-wild-cta" data-generate>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z"/></svg>
            <span>Generate AI review</span>
          </button>
          <p class="hb-wild-pre-disclaimer"><strong>Heads up:</strong> AI-researched. Can be wrong. Always verify locally before relying on this for an overnight.</p>
        </div>
        <div class="hb-wild-loading" hidden>
          <div class="hb-wild-spinner" aria-hidden="true"></div>
          <p class="hb-wild-loading-text" data-loading-text>Checking federal protection layers…</p>
        </div>
        <div class="hb-wild-result" hidden></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-show'));

    const modal = backdrop.querySelector('.hb-wild-modal');
    const preEl = backdrop.querySelector('.hb-wild-pre');
    const loadingEl = backdrop.querySelector('.hb-wild-loading');
    const loadingTextEl = backdrop.querySelector('[data-loading-text]');
    const resultEl = backdrop.querySelector('.hb-wild-result');

    // Loading-step copy. Each runs ~1s, totals 4s. Last step lingers
    // briefly before the reveal so the user reads "Compiling verdict"
    // rather than "Compiling verdict" → flash → result.
    const LOADING_STEPS = [
      'Checking federal protection layers…',
      'Cross-referencing cantonal bans…',
      'Reading recent enforcement reports…',
      'Compiling verdict…',
    ];

    let loadingTimers = [];
    function clearLoadingTimers() {
      loadingTimers.forEach(t => clearTimeout(t));
      loadingTimers = [];
    }

    function startGenerate() {
      modal.classList.remove('is-pre');
      modal.classList.add('is-loading');
      preEl.hidden = true;
      loadingEl.hidden = false;

      LOADING_STEPS.forEach((step, i) => {
        loadingTimers.push(setTimeout(() => {
          loadingTextEl.textContent = step;
        }, i * 1000));
      });
      loadingTimers.push(setTimeout(reveal, 4000));
    }

    function reveal() {
      modal.classList.remove('is-loading');
      modal.classList.add('is-result');
      loadingEl.hidden = true;
      resultEl.innerHTML = resultHtml;
      resultEl.hidden = false;
    }

    backdrop.querySelector('[data-generate]').addEventListener('click', startGenerate);

    function close() {
      clearLoadingTimers();
      backdrop.classList.remove('is-show');
      setTimeout(() => backdrop.remove(), 180);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-close]').addEventListener('click', close);
  }

  // ─── Photo credits modal ────────────────────────────────────────────────
  // Lists every photo on the spot with its credit. Cards with multiple
  // photos used to inline the first photo's credit in the kebab itself,
  // but that desync'd as soon as the user advanced the carousel — the
  // menu still showed photo 1's photographer while the user was looking
  // at photo 2. Pulling the credits into a dedicated modal sidesteps the
  // race entirely and matches the Wildcamping-modal pattern (one place
  // to read attribution, no per-frame coupling).
  function openPhotoCreditsModal(spot) {
    if (!spot || !spot.photos || !spot.photos.length) return;
    const photos = spot.photos;
    const title = spot.title || '';
    const itemsHtml = photos.map((p, i) => {
      const credit = p.credit ? escapeText(p.credit) : '<em>No attribution</em>';
      return `
        <li class="hb-credits-item">
          <span class="hb-credits-num">${i + 1}</span>
          <span class="hb-credits-name">${credit}</span>
        </li>
      `;
    }).join('');

    const backdrop = document.createElement('div');
    backdrop.className = 'hb-modal-backdrop hb-credits-modal-backdrop';
    backdrop.innerHTML = `
      <div class="hb-modal hb-credits-modal" role="dialog" aria-label="Photo credits">
        <button type="button" class="hb-wild-close" data-close aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="hb-credits-head">
          <span class="hb-wild-kicker">Photo credits</span>
          <h2 class="hb-wild-title">${escapeText(title)}</h2>
        </div>
        <ul class="hb-credits-list">${itemsHtml}</ul>
        <p class="hb-credits-foot">${photos.length} photo${photos.length === 1 ? '' : 's'} on this spot</p>
      </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-show'));

    function close() {
      backdrop.classList.remove('is-show');
      setTimeout(() => backdrop.remove(), 180);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-close]').addEventListener('click', close);
  }

  function injectMultiImage(slide, chapterId) {
    const anchor = slide.id;
    if (!anchor) return;
    const key = `${chapterId}#${anchor}`;
    const photos = galleries.get(key);

    // Single-photo upgrade: even when there's no carousel, swap the static
    // <img> for the derivative AND update the static .credit-pill so the
    // attribution matches the photo we actually rendered. The chapter HTML
    // bakes in a stale pill (e.g. "@katerina.trapp" for a spot whose
    // canonical primary photo is now an Unsplash one), so the credit text
    // belongs to the photo, not to the static markup.
    if (!photos) {
      const spot = spots.get(key);
      if (!spot || !spot.imagePhotoId) return;
      const photoEl = slide.querySelector('.sp-photo');
      const img = photoEl?.querySelector('img');
      if (!img) return;
      const primaryPhoto = (spot.photos || [])[0] || null;
      const credit = primaryPhoto?.credit || null;
      const renderKey = `single|${spot.imagePhotoId}|${credit || ''}`;
      if (img.dataset.hbRenderedKey === renderKey) return;
      img.dataset.hbRenderedKey = renderKey;
      const attrs = W.HB.photoAttrs({
        photoId: spot.imagePhotoId,
        width: 1800, prefix: REL,
        sizes: '(min-width: 768px) 800px, 100vw',
      });
      if (attrs.src)    img.src    = attrs.src;
      if (attrs.srcset) img.srcset = attrs.srcset;
      if (attrs.sizes)  img.sizes  = attrs.sizes;
      img.alt = spot.title || '';
      // Update or remove the static .credit-pill so it matches this photo.
      const pill = photoEl.querySelector('.credit-pill');
      if (pill) {
        if (credit) pill.textContent = `Photo · ${credit}`;
        else pill.remove();  // placeholder/xxx -> no chip per the brain rule
      } else if (credit) {
        const fresh = document.createElement('span');
        fresh.className = 'credit-pill';
        fresh.textContent = `Photo · ${credit}`;
        photoEl.appendChild(fresh);
      }
      return;
    }

    const photoEl = slide.querySelector('.sp-photo');
    if (!photoEl) return;

    // If the carousel was already built with this exact photo set, skip --
    // avoids a needless tear-down on every spurious Convex notification.
    const renderedKey = JSON.stringify(photos.map(p => (p.photoId || p.src || '') + '|' + (p.credit || '')));
    if (photoEl.dataset.hbRenderedKey === renderedKey) return;
    photoEl.dataset.hbRenderedKey = renderedKey;

    // Tear down any prior carousel (slides, dots, arrows, counter) so the
    // re-render is idempotent. The original static <img> + .credit-pill are
    // also wiped on first run.
    //
    // Aspect-ratio lock for chapter scroll cards (NOT detail pages):
    // chapter cards have their own card-level aspect (16:9) so the photo
    // column gets its height from the grid, no lock needed. On detail
    // pages we DON'T set inline aspect-ratio because the body content
    // (kicker + title + deck + paragraphs + specs + maps) drives the
    // grid row height, and a fixed photo aspect would leave empty space
    // below the photo whenever the body wraps to more lines than the
    // natural-aspect photo height accommodates. Without the inline
    // lock, grid-stretch + object-fit: cover keeps the photo filling
    // its column at any body height.
    photoEl.querySelectorAll('.hb-slide, .hb-dots, .hb-arrow, .hb-counter, .hb-credit').forEach(n => n.remove());
    const oldImg = photoEl.querySelector('img');
    const oldCredit = photoEl.querySelector('.credit-pill');
    const isDetailPage = document.body.dataset.page === 'spot-detail';
    // Detail pages now have a fixed photo aspect-ratio (612:711) in CSS,
    // so we no longer snapshot the natural-image-driven height as a
    // min-height — that was inflating portrait spots' photo columns
    // past the desired crop. Chapter scroll cards still get the
    // natural-aspect inline lock so each card sizes to its own primary
    // photo's intrinsic shape.
    if (oldImg) {
      if (!isDetailPage) {
        const nw = oldImg.naturalWidth, nh = oldImg.naturalHeight;
        if (nw > 0 && nh > 0) {
          photoEl.style.aspectRatio = `${nw} / ${nh}`;
        } else if (photos[0]?.width && photos[0]?.height) {
          photoEl.style.aspectRatio = `${photos[0].width} / ${photos[0].height}`;
        }
      }
      oldImg.remove();
    } else if (!isDetailPage && photos[0]?.width && photos[0]?.height) {
      photoEl.style.aspectRatio = `${photos[0].width} / ${photos[0].height}`;
    }
    if (oldCredit) oldCredit.remove();
    photoEl.classList.add('hb-multi');

    // Slide stack: first slide eager, the rest lazy so we don't yank
    // bandwidth for spots the user hasn't navigated to yet.
    // Sizes hint: chapter cards are full-bleed within their slide column,
    // ~700-900 px on desktop and the full viewport on mobile.
    const slideEls = photos.map((p, i) => {
      const img = document.createElement('img');
      img.className = 'hb-slide' + (i === 0 ? ' is-current' : '');
      const attrs = W.HB.photoAttrs({
        photoId: p.photoId, image: p.src,
        width: 1800, prefix: REL, sizes: '(min-width: 768px) 800px, 100vw',
      });
      if (attrs.src) img.src = attrs.src;
      if (attrs.srcset) img.srcset = attrs.srcset;
      if (attrs.sizes)  img.sizes  = attrs.sizes;
      img.alt = '';
      img.loading = i === 0 ? 'eager' : 'lazy';
      img.decoding = 'async';
      return img;
    });
    slideEls.forEach(el => photoEl.appendChild(el));

    // Counter pill (top-left): "1 / 3"
    const counter = document.createElement('span');
    counter.className = 'hb-counter';
    counter.textContent = `1 / ${photos.length}`;
    photoEl.appendChild(counter);

    // Credit pill (we re-add a fresh one so it can change with the slide)
    const credit = document.createElement('span');
    credit.className = 'credit-pill hb-credit';
    function setCredit(p) {
      credit.textContent = p.credit ? `Photo · ${p.credit}` : 'Photo · @leon.helg';
    }
    setCredit(photos[0]);
    photoEl.appendChild(credit);

    // Dots
    const dots = document.createElement('div');
    dots.className = 'hb-dots';
    dots.innerHTML = photos.map((_, i) => `<span class="${i === 0 ? 'is-on' : ''}"></span>`).join('');
    photoEl.appendChild(dots);

    // Chevron arrows
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'hb-arrow hb-arrow-prev';
    prev.setAttribute('aria-label', 'Previous photo');
    prev.innerHTML = SVG_CHEV_LEFT;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'hb-arrow hb-arrow-next';
    next.setAttribute('aria-label', 'Next photo');
    next.innerHTML = SVG_CHEV_RIGHT;
    photoEl.appendChild(prev);
    photoEl.appendChild(next);

    // Defensive runtime filter: when admin adds photos in Convex but the
    // derivative WebP hasn't shipped to disk yet, those slides 404. We
    // prune them on the img.onerror event — hide the slide + its dot,
    // drop them from `liveIndices`, fix the counter, and skip them in
    // navigation. `liveIndices` is the source of truth for navigation
    // position; `idx` always points into `photos` via slideEls. Counter
    // shows current position within the live set, not the original.
    let liveIndices = photos.map((_, i) => i);
    let idx = 0;
    function refreshCounter() {
      const pos = liveIndices.indexOf(idx);
      counter.textContent = liveIndices.length === 0
        ? '0 / 0'
        : `${pos + 1} / ${liveIndices.length}`;
    }
    function dropBrokenSlide(brokenIdx) {
      const pos = liveIndices.indexOf(brokenIdx);
      if (pos === -1) return;
      liveIndices.splice(pos, 1);
      if (slideEls[brokenIdx]) slideEls[brokenIdx].style.display = 'none';
      const dot = dots.children[brokenIdx];
      if (dot) dot.style.display = 'none';
      if (idx === brokenIdx && liveIndices.length > 0) {
        // Was viewing the broken one — jump to the nearest live slide.
        const fallback = liveIndices[Math.min(pos, liveIndices.length - 1)];
        show(fallback);
      } else {
        refreshCounter();
      }
      // Hide the arrows + dots when fewer than two slides remain — the
      // controls have nothing useful to do at that point.
      if (liveIndices.length < 2) {
        prev.style.display = 'none';
        next.style.display = 'none';
        dots.style.display = 'none';
        if (liveIndices.length === 0) counter.style.display = 'none';
      }
    }
    slideEls.forEach((img, i) => {
      img.addEventListener('error', () => dropBrokenSlide(i));
    });

    function show(target) {
      if (liveIndices.length === 0) return;
      // Resolve `target` to a live index. If target itself is live, use
      // it; otherwise nudge to the next live one in the same direction.
      let n = target;
      if (!liveIndices.includes(n)) {
        const sorted = [...liveIndices].sort((a, b) => a - b);
        n = sorted.find(i => i > target) ?? sorted[0];
      }
      if (n === idx) return;
      if (slideEls[idx]) slideEls[idx].classList.remove('is-current');
      slideEls[n].classList.add('is-current');
      if (dots.children[idx]) dots.children[idx].classList.remove('is-on');
      if (dots.children[n]) dots.children[n].classList.add('is-on');
      idx = n;
      refreshCounter();
      setCredit(photos[n]);
    }
    function advance(step) {
      if (liveIndices.length === 0) return;
      const pos = liveIndices.indexOf(idx);
      const safePos = pos < 0 ? 0 : pos;
      const nextPos = ((safePos + step) % liveIndices.length + liveIndices.length) % liveIndices.length;
      show(liveIndices[nextPos]);
    }
    prev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); advance(-1); });
    next.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); advance(+1); });

    // Touch swipe on the photo. Only triggers on horizontal travel > 40 px.
    let touchX = null, touchY = null;
    photoEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    photoEl.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchX;
      const dy = t.clientY - touchY;
      touchX = touchY = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        advance(dx < 0 ? 1 : -1);
      }
    });

    // The slide-spread card directly below this spot becomes redundant
    // once we've absorbed its photos. Hide any sibling spread whose id is
    // built from this anchor — covers both `<anchor>_spread` (fulberg)
    // and `<anchor>_<descriptor>_spread` (schrattenfluh_ridge_line_spread).
    document.querySelectorAll('.slide-spread').forEach(el => {
      if (el.id && el.id.startsWith(`${anchor}_`) && el.id.endsWith('_spread')) {
        el.style.display = 'none';
      }
    });
  }

  // When the hidden ?by= URL filter is active, prune the baked chapter
  // Reader cards (.cl-card .cl-photos) down to slides credited to one of
  // the handles. Cards with zero matching photos are hidden outright;
  // surviving cards have their non-matching <img.hb-slide> + dot pairs
  // removed, the counter + credit-pill rewritten, and (when only one
  // slide remains) demoted to single-photo by dropping .hb-multi plus
  // the arrows / dots / counter. Runs BEFORE wireBakedCarousels so the
  // carousel handlers only see the surviving slides.
  function applyByFilterToChapterCards() {
    if (!BY_HANDLES && !PREVIEW_MODE) return;
    const ch = currentChapterId();
    if (!ch) return;
    // Chapter pages ship the photo sidecar (HB_SPOT_IMAGES) but NOT the
    // SPOTS sidecar, so the spots store's byKey is empty until Convex
    // hydrates. Fall back to the photos sidecar so the filter resolves
    // credits on the first synchronous paint.
    const photosSidecar = W.HB_SPOT_IMAGES || {};
    document.querySelectorAll('.cl-card[id]').forEach(card => {
      // Preview mode · hide cards whose slug isn't on the curated list
      // before bothering with photo-credit walking. Runs in addition to
      // the BY_HANDLES per-photo filter below, so both have to pass.
      if (PREVIEW_MODE && !previewSpotAllowed(card.id)) {
        card.style.display = 'none';
        return;
      }
      const key = `${ch}#${card.id}`;
      const spot = W.HB.spots.rawGet(key);
      const allPhotos = (spot && spot.photos && spot.photos.length)
        ? spot.photos
        : (photosSidecar[key] || []);
      const matchIndices = allPhotos
        .map((p, i) => (matchesByCredit(p.credit) ? i : -1))
        .filter(i => i >= 0);
      if (matchIndices.length === 0) {
        card.style.display = 'none';
        return;
      }
      const photosEl = card.querySelector('.cl-photos');
      if (!photosEl) return;
      const slides = Array.from(photosEl.querySelectorAll('img.hb-slide'));
      const dotsEl = photosEl.querySelector('.hb-dots');
      const dotEls = dotsEl ? Array.from(dotsEl.children) : [];
      // Walk slides in original order, removing the ones whose photo
      // credit doesn't match. Pair-removes each slide with its dot so the
      // remaining indices stay aligned.
      slides.forEach((slide, i) => {
        const matches = matchesByCredit(allPhotos[i]?.credit);
        if (!matches) {
          slide.remove();
          if (dotEls[i]) dotEls[i].remove();
        }
      });
      const remainingSlides = Array.from(photosEl.querySelectorAll('img.hb-slide'));
      remainingSlides.forEach((s, i) => {
        s.classList.toggle('is-current', i === 0);
        // First slide is now the visible one; promote eager-load so it
        // paints without waiting for IntersectionObserver.
        if (i === 0) s.loading = 'eager';
      });
      const remainingDots = dotsEl ? Array.from(dotsEl.children) : [];
      remainingDots.forEach((d, i) => d.classList.toggle('is-on', i === 0));
      const counter = photosEl.querySelector('.hb-counter');
      if (counter) counter.textContent = `1 / ${remainingSlides.length}`;
      const credit = photosEl.querySelector('.credit-pill');
      if (credit) {
        const c = allPhotos[matchIndices[0]]?.credit;
        if (c) credit.textContent = `Photo · ${c}`;
      }
      // Only one surviving slide → drop the multi-image affordances so
      // the card reads as a single photo (no counter, no arrows, no dots).
      if (remainingSlides.length < 2) {
        photosEl.classList.remove('hb-multi');
        photosEl.querySelectorAll('.hb-arrow').forEach(b => b.remove());
        if (dotsEl) dotsEl.remove();
        if (counter) counter.remove();
      }
    });
  }

  // When the hidden ?by= URL filter is active, rewrite every internal
  // <a href> and [data-href] on the page so navigating from one screen
  // to the next carries the filter. Skips external schemes, hash-only
  // anchors, and links that already have the param. Runs early in boot()
  // so it lands BEFORE wireCardLinks captures data-href at wire-time.
  function rewriteInternalLinksForByFilter(root) {
    if (!BY_RAW) return;
    const r = root || document;
    r.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      const next = withBy(href);
      if (next !== href) a.setAttribute('href', next);
    });
    r.querySelectorAll('[data-href]').forEach(el => {
      const href = el.getAttribute('data-href');
      const next = withBy(href);
      if (next !== href) el.setAttribute('data-href', next);
    });
  }

  // --- Wire pre-baked chapter Reader card carousels (.cl-card .cl-photos).
  // The chapter HTML ships every photo as a stacked <img class="hb-slide">
  // plus dots + counter + chevron arrows. We just attach the click / swipe /
  // keyboard handlers — no DOM rebuild, so this works without HB_SPOT_IMAGES.
  function wireBakedCarousels(root) {
    const photos = (root || document).querySelectorAll('.cl-photos.hb-multi');
    photos.forEach((photoEl) => {
      if (photoEl.dataset.hbWired === '1') return;
      const slides  = Array.from(photoEl.querySelectorAll('.hb-slide'));
      if (slides.length < 2) return;
      photoEl.dataset.hbWired = '1';
      const dots    = photoEl.querySelector('.hb-dots');
      const dotEls  = dots ? Array.from(dots.children) : [];
      const counter = photoEl.querySelector('.hb-counter');
      const prev    = photoEl.querySelector('.hb-arrow-prev');
      const next    = photoEl.querySelector('.hb-arrow-next');
      if (dots) dots.style.pointerEvents = 'auto';
      let idx = slides.findIndex(s => s.classList.contains('is-current'));
      if (idx < 0) { idx = 0; slides[0].classList.add('is-current'); }
      function show(target) {
        const n = ((target % slides.length) + slides.length) % slides.length;
        if (n === idx) return;
        slides[idx].classList.remove('is-current');
        slides[n].classList.add('is-current');
        if (dotEls[idx]) dotEls[idx].classList.remove('is-on');
        if (dotEls[n])   dotEls[n].classList.add('is-on');
        if (counter) counter.textContent = `${n + 1} / ${slides.length}`;
        idx = n;
      }
      // Arrow / dot clicks shouldn't bubble up to the card-level click that
      // navigates to the spot detail page.
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      if (prev) prev.addEventListener('click', (e) => { stop(e); show(idx - 1); });
      if (next) next.addEventListener('click', (e) => { stop(e); show(idx + 1); });
      dotEls.forEach((d, i) => d.addEventListener('click', (e) => { stop(e); show(i); }));

      let touchX = null, touchY = null;
      photoEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
      }, { passive: true });
      photoEl.addEventListener('touchend', (e) => {
        if (touchX === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchX;
        const dy = t.clientY - touchY;
        touchX = touchY = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          show(idx + (dx < 0 ? 1 : -1));
        }
      });
    });
  }

  // Whole .cl-card is clickable (data-href). Skip clicks that originated on
  // the carousel arrows / dots / counter or on the Maps CTA so those keep
  // working without dragging the user away from the chapter page.
  function wireCardLinks(root) {
    const cards = (root || document).querySelectorAll('.cl-card[data-href]');
    cards.forEach((card) => {
      if (card.dataset.hbCardWired === '1') return;
      card.dataset.hbCardWired = '1';
      const href = card.getAttribute('data-href');
      card.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('.hb-arrow, .hb-dots, .hb-counter, .cl-maps, a, button')) return;
        location.href = href;
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          location.href = href;
        }
      });
    });
  }

  // --- Heart toggle on every .slide-spot in chapter pages.
  // Generic card-action overlay (heart, optional kebab) for any spot card
  // outside the .slide-spot detail page. Used by:
  //   - chapter scroll cards (.cl-card, always-visible per CSS)
  //   - chapter grid tiles (.ch-tile, hover-to-show)
  //   - home rows (.row-card, .up-next-card, hover-to-show)
  // The heart's visibility is governed by CSS, not JS — this just makes
  // sure the buttons exist + are wired to the favorites store.
  function attachCardActions(card, spotKey, opts) {
    opts = opts || {};
    if (!card || !spotKey) return;
    if (!card.querySelector('[data-hb-fav]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hb-fav-overlay';
      btn.setAttribute('data-hb-fav', spotKey);
      btn.setAttribute('aria-label', 'Save to favorites');
      btn.innerHTML = SVG_HEART_OUT;
      card.appendChild(btn);

      function paint() {
        const on = favorites.has(spotKey);
        btn.classList.toggle('is-on', on);
        btn.innerHTML = on ? SVG_HEART_FILL : SVG_HEART_OUT;
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Save to favorites');
      }
      paint();
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        favorites.toggle(spotKey);
        paint();
      });
      // Repaint on cross-tab / server pushes.
      favorites.subscribe(paint);
    }
    if (opts.kebab && !card.querySelector('[data-hb-kebab]')) {
      const kebab = document.createElement('button');
      kebab.type = 'button';
      kebab.className = 'hb-kebab-overlay';
      kebab.setAttribute('data-hb-kebab', spotKey);
      kebab.setAttribute('aria-label', 'More actions');
      kebab.innerHTML = SVG_DOTS;
      card.appendChild(kebab);
      kebab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCardMenu(card, kebab, { id: opts.spotId || card.id || '', title: opts.title || '', spotKey });
      });
    }
  }

  // Lightweight kebab menu for chapter cards. Same items as the .slide-spot
  // menu (Submit photo + Wildcamping status when applicable), driven by a
  // {id, title, spotKey} info bag instead of a slide DOM element so it can
  // hang off any card.
  function openCardMenu(card, anchor, info) {
    const spot = info?.spotKey ? spots.get(info.spotKey) : null;
    const hasWild = !!(spot && spot.wildCamping);
    const hasCredits = !!(spot && spot.photos && spot.photos.some(p => p.credit));
    openMenuPanel(anchor, {
      spotKey: info?.spotKey || null,
      hasWild,
      hasCredits,
      onSubmit:  () => openSubmitModal(info),
      onWild:    () => hasWild && openWildCampingModal(spot),
      onCredits: () => hasCredits && openPhotoCreditsModal(spot),
    });
  }

  // Sweep chapter pages for cards rendered by build-chapter-html.mjs and
  // attach favorites-aware overlays. Idempotent — safe to run multiple
  // times; existing buttons are reused. .cl-card uses kebab + heart
  // (always-visible via CSS); .ch-tile uses heart only (hover-to-show).
  function wireChapterCards() {
    const ch = currentChapterId();
    if (!ch) return;
    document.querySelectorAll('.cl-card[id]').forEach(card => {
      const id = card.id;
      const title = card.querySelector('.cl-title')?.textContent?.trim() || id;
      attachCardActions(card, `${ch}#${id}`, { kebab: true, spotId: id, title });
    });
    document.querySelectorAll('.ch-tile[href]').forEach(card => {
      // .ch-tile doesn't carry its spotId in an attribute — derive from
      // href ("../spot/<spotId>/").
      const href = card.getAttribute('href') || '';
      const m = href.match(/\/spot\/([^/]+)\//);
      if (!m) return;
      const id = m[1];
      const title = card.getAttribute('title') || id;
      attachCardActions(card, `${ch}#${id}`, { spotId: id, title });
    });
  }

  // The Back pill on spot/account/affiliate pages is hardcoded to its
  // chapter (or "../") so users who land directly via search or share
  // link still have a way out. But when they got here from inside the
  // app (Map → spot, Browse → spot, etc.) the user expects native back
  // behaviour. Mobile's system back arrow already does this; the
  // in-page Back was always shooting them to the chapter.
  //
  // We can't rely on document.referrer: every /full page sets
  // <meta name="referrer" content="no-referrer">. Instead, count
  // in-app navigations per tab via sessionStorage. depth > 1 means at
  // least one prior in-app page is in the back stack; hijack the click
  // and use history.back(). depth === 1 (direct entry / new tab) falls
  // through to the anchor's href, which is the chapter fallback.
  const NAV_DEPTH_KEY = 'hb:nav:depth';
  function bumpNavDepth() {
    try {
      const cur = parseInt(sessionStorage.getItem(NAV_DEPTH_KEY) || '0', 10) || 0;
      sessionStorage.setItem(NAV_DEPTH_KEY, String(cur + 1));
      return cur + 1;
    } catch { return 1; }
  }
  function wireBackButtons() {
    const depth = bumpNavDepth();
    document.querySelectorAll('a.hb-back, a.back').forEach(a => {
      a.addEventListener('click', (e) => {
        // Cmd/Ctrl/middle-click → open in new tab, leave alone.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
        if (depth > 1 && W.history.length > 1) {
          e.preventDefault();
          W.history.back();
        }
        // Otherwise let the anchor navigate to its href (the chapter
        // for spot pages, "../" for account/affiliate).
      });
    });
  }

  function injectHearts() {
    const ch = currentChapterId();
    if (!ch) return;
    const slides = document.querySelectorAll('.slide-spot[id]');
    if (!slides.length) return;

    slides.forEach(slide => {
      injectSpotMenu(slide);
      applyEditorial(slide, ch);
      injectMultiImage(slide, ch);
      if (slide.querySelector('[data-hb-fav]')) return;
      const anchor = slide.id;
      const k = keyFor(ch, anchor);
      if (!k) return;

      // Heart goes on the white text panel (top-right) -- not the photo --
      // so it never sits on top of detail content like the credit pill.
      const body = slide.querySelector('.sp-body');
      if (!body) return;

      // Three-action row on the bottom-right of the text panel (visible
      // top-right on desktop, full-width below the body on mobile via
      // CSS): heart, "Been there" tick, kebab. The kebab is already
      // injected by injectSpotMenu(); the heart + visited buttons get
      // grouped into a `.sp-actions` row so they line up neatly.
      const actions = document.createElement('div');
      actions.className = 'sp-actions';
      body.appendChild(actions);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hb-fav';
      btn.setAttribute('data-hb-fav', k);
      btn.setAttribute('aria-label', 'Save to favorites');
      btn.innerHTML = SVG_HEART_OUT;
      actions.appendChild(btn);

      function paint() {
        const on = favorites.has(k);
        btn.classList.toggle('is-on', on);
        btn.innerHTML = on ? SVG_HEART_FILL : SVG_HEART_OUT;
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Save to favorites');
      }
      paint();
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        favorites.toggle(k);
        paint();
      });

      // "Been there" button — same affordance as the heart but for the
      // visited pile. Always visible so the action row reads consistently
      // for everyone (Leon: "between the heart and the three dots").
      // Visited is server-only (no localStorage fallback like favorites
      // has), so a click while logged-out routes through openSignIn()
      // instead of being a silent no-op.
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'hb-visited';
      tick.setAttribute('data-hb-visited', k);
      tick.setAttribute('aria-label', 'Mark as visited');
      tick.innerHTML = SVG_CHECK_CIRCLE;
      actions.appendChild(tick);

      function paintVisited() {
        const on = visited.has(k);
        tick.classList.toggle('is-on', on);
        tick.setAttribute('aria-pressed', String(on));
        tick.setAttribute('aria-label', on ? 'Remove from Been there' : 'Mark as visited');
      }
      paintVisited();
      visited.subscribe(paintVisited);
      session.subscribe(paintVisited);
      tick.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!visited.signedIn()) { openSignIn(); return; }
        visited.toggle(k);
        paintVisited();
      });

      // Move the kebab into the same actions row so the three buttons
      // line up. The kebab was appended directly to `body` earlier by
      // injectSpotMenu() — relocate it once here so the order is
      // heart → visited → kebab. Idempotent on subsequent runs.
      const kebab = body.querySelector('.hb-spot-menu-btn');
      if (kebab && kebab.parentNode !== actions) {
        actions.appendChild(kebab);
      }
    });
  }

  // Cross-tab sync. Three keys we care about:
  //   - hb:fav:v1     : another tab toggled a favorite (anonymous mode)
  //   - hb:skipped:v1 : another tab swiped (anonymous mode)
  //   - hb:session:v1 : another tab signed in/out — we re-attach the stores
  W.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      favorites._onLocalStorageChanged();
      // Heart buttons + badge repaint via the favorites subscription chain.
    } else if (e.key === NO_KEY) {
      swipes._onLocalStorageChanged();
    } else if (e.key === SESSION_KEY) {
      // Token added or removed in another tab. Re-init session and the stores.
      session.init();
      favorites._reattach();
      visited._reattach();
      swipes._reattach();
    }
  });

  // --- Public API
  W.HB = W.HB || {};
  W.HB.favorites = favorites;
  W.HB.visited   = visited;
  W.HB.swipes    = swipes;
  W.HB.session   = session;
  W.HB.openSignIn = openSignIn;
  W.HB.keyFor = keyFor;
  // Pages with dynamically-rendered card lists (home, browse, etc.) call
  // this after each render to give every card its heart overlay (and
  // optionally a kebab). Idempotent.
  W.HB.attachCardActions = attachCardActions;
  W.HB.spotKey = (spot) => {
    if (!spot || !spot.chapter_id) return null;
    const anchor = (spot.href || '').split('#')[1] || '';
    if (!anchor) return null;
    return `${spot.chapter_id}#${anchor}`;
  };
  // URL of a spot's standalone detail page (full/spot/<spotId>/). Every
  // click site that lands on a single spot — Explore, Map popup, Browse,
  // Saved, Random, Swipe, Home featured/up-next/row cards — routes here
  // instead of the chapter scroll. Falls back to the legacy chapter#anchor
  // URL when the spot has no extractable id (shouldn't happen, defensive).
  W.HB.spotDetailHref = (spot, prefix) => {
    if (!spot) return '#';
    const pre = prefix == null ? REL : prefix;
    // extras_entry rows have no standalone page (they're TODO markers
    // without copy or photos), so keep them pointing at the chapter
    // scroll where they render as a small "extras" grid item.
    if (spot.kind === 'extras_entry') {
      return withBy(`${pre}${(spot.href || '').replace(/^\.\.\//, '')}`);
    }
    const anchor = (spot.href || '').split('#')[1] || '';
    if (anchor) return withBy(`${pre}spot/${anchor}/`);
    return withBy(`${pre}${(spot.href || '').replace(/^\.\.\//, '')}`);
  };
  W.HB.byActive = !!BY_HANDLES;
  W.HB.withBy = withBy;
  W.HB.matchesByCredit = matchesByCredit;
  W.HB.singularKicker = singularKicker;
  W.HB.propertiesOf = propertiesOf;
  W.HB.buildPropertyIndex = buildPropertyIndex;
  W.HB.galleries = galleries;
  W.HB.spots = spots;
  // Some spots ship with `zdk_placeholder.jpg` because we don't have a real
  // photo for them yet. They render as a near-black tile so we hide them
  // from the photo wall, the random shuffle, and the featured rotator until
  // an actual image lands (via Submit Photo or otherwise). Spots in the
  // `kind: extras_entry` bucket also have no photo on purpose -- they're
  // TODO markers exploded out of content.yaml extras wrappers.
  W.HB.hasRealImage = (spot) => {
    if (!spot) return false;
    if (spot.image === 'zdk_placeholder.jpg') return false;
    if (spot.kind === 'extras_entry') return false;
    return !!(spot.image || spot.imagePhotoId);
  };
  W.HB.rel = REL;

  // ── Photo URL helpers ─────────────────────────────────────────────────
  // The derivative ladder lives at /full/img/derivatives/<photoId>/wXXX.webp
  // for widths 160/400/1000/1800/2800. Spots seeded from the legacy sidecars
  // (or before the build-image-derivatives.mjs run) have no photoId; for
  // those, fall back to the hand-curated /full/img/{thumbs,m,}/<file> tiers.
  // Callers pass `prefix` because each page mounts /full/ at a different
  // depth (e.g. browse/ uses '../', root index uses '').
  const DERIV_WIDTHS = [160, 400, 1000, 1800, 2800];
  // The derivative folder names changed from `<chapter>_<spotId>_p<N>` to
  // just `<spotId>_p<N>` in the restructure. To keep working both before
  // and after the Convex re-seed (whichever order push lands in), strip
  // any leading chapter token so the URL still resolves to a real folder.
  const CHAPTER_PREFIXES = ['central_','valais_','fribourg_','western_','eastern_','ticino_','beyond_'];
  function stripChapterPrefix(photoId) {
    if (!photoId) return photoId;
    for (const p of CHAPTER_PREFIXES) {
      if (photoId.startsWith(p)) return photoId.slice(p.length);
    }
    return photoId;
  }
  W.HB.photoUrl = function(opts) {
    if (!opts) return null;
    const { photoId, image, width = 1000, prefix = '' } = opts;
    if (photoId) {
      const id = stripChapterPrefix(photoId);
      return `${prefix}img/derivatives/${id}/w${width}.webp`;
    }
    if (image) {
      if (width <= 200)  return `${prefix}img/thumbs/${image}`;
      if (width <= 1200) return `${prefix}img/m/${image}`;
      return `${prefix}img/${image}`;
    }
    return null;
  };
  W.HB.photoSrcset = function(opts) {
    if (!opts || !opts.photoId) return null;
    const { prefix = '' } = opts;
    const id = stripChapterPrefix(opts.photoId);
    return DERIV_WIDTHS
      .map(w => `${prefix}img/derivatives/${id}/w${w}.webp ${w}w`)
      .join(', ');
  };
  // Convenience: emit the full set of attributes a renderer needs to drop into
  // an <img> tag. Returns a {src, srcset, sizes, width, height} bundle. `sizes`
  // defaults to the generic "100vw" hint; pass an explicit value when you know
  // the layout's column width.
  W.HB.photoAttrs = function(opts) {
    if (!opts) return { src: null };
    const { photoId, image, width = 1000, prefix = '', sizes = '100vw',
            intrinsicWidth = null, intrinsicHeight = null } = opts;
    const src    = W.HB.photoUrl({ photoId, image, width, prefix });
    const srcset = W.HB.photoSrcset({ photoId, prefix });
    return { src, srcset, sizes: srcset ? sizes : null,
             width: intrinsicWidth, height: intrinsicHeight };
  };
  W.HB.loadSpots = loadSpots;
  W.HB.randomJump = randomJump;
  W.HB.refreshFavCount = refreshFavCount;
  W.HB.icons = { heartOut: SVG_HEART_OUT, heartFill: SVG_HEART_FILL };

  // --- Center the targeted .slide-spot in the viewport when arriving via
  // a #anchor (e.g. clicked from the map popup or from /full/saved/). The
  // browser's default behavior aligns the anchor to the top minus the
  // sticky topbar, which leaves the spot photo flush with the topbar instead
  // of breathing in the middle of the screen.
  function centerOnHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    const target = document.getElementById(hash);
    if (!target || !target.classList.contains('slide-spot')) return;
    // Defer past initial layout so images have intrinsic dims and the
    // section's height is final.
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // When Convex pushes a spot update, repaint both the carousel and the
  // editorial overlay for that slide. Each helper short-circuits if the
  // applied content matches what's already rendered, so spurious
  // notifications don't thrash the DOM.
  galleries.subscribe((spotKey) => {
    const ch = currentChapterId();
    if (!ch) return;
    const [chapter, anchor] = spotKey.split('#');
    if (chapter !== ch || !anchor) return;
    const slide = document.getElementById(anchor);
    if (slide && slide.classList.contains('slide-spot')) {
      applyEditorial(slide, chapter);
      injectMultiImage(slide, chapter);
    }
  });

  // --- Boot
  function boot() {
    // Preview mode body classes · CSS in preview.css reads these to
    // hide spot names on wildcamping + hidden-gems (Leon's directive
    // 2026-05-27 · those two pages show all spots in preview mode
    // but should not reveal individual spot titles in promo
    // recordings). The base 'preview-mode' class is also handy as a
    // hook for future preview-only styling tweaks.
    if (PREVIEW_MODE) {
      document.body.classList.add('preview-mode');
      const p = location.pathname || '';
      if (/\/full\/(wildcamping|hidden-gems)\//.test(p)) {
        document.body.classList.add('preview-hide-spot-names');
      }
    }
    // Wipe any inline margin set on .viewer by an earlier social.js
    // revision that pinned the viewer via JS. CSS now handles centering;
    // stale inline values would otherwise beat the CSS rule until a hard
    // reload.
    const v = document.querySelector('.viewer');
    if (v) {
      v.style.removeProperty('margin-left');
      v.style.removeProperty('margin-right');
    }
    // Order matters: session.init() reads the saved token (if any) so that
    // when favorites/swipes attach below they pick the right backend.
    session.init();
    favorites._reattach();
    visited._reattach();
    swipes._reattach();
    injectRail();
    // Propagate the hidden ?by= filter through every <a href> and
    // [data-href] on the page. Must run BEFORE wireCardLinks, which
    // captures data-href at wire-time, and AFTER injectRail so the rail
    // nav items are included.
    rewriteInternalLinksForByFilter();
    wireBackButtons();
    // Prune chapter Reader cards down to matching photos BEFORE
    // wireBakedCarousels so the carousel handlers only see surviving
    // slides. No-op on non-chapter pages.
    applyByFilterToChapterCards();
    wireBakedCarousels();
    wireCardLinks();
    injectHearts();
    wireChapterCards();
    rewriteKickersInPage();
    centerOnHash();
    // Open the Convex subscription only after the static page is wired up
    // -- the sidecars already drove the first paint, Convex adjusts later
    // if server data drifted. Only one subscription per page; pages
    // listening via HB.spots.subscribe re-render on update.
    spots.init();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // Fire again on full load -- by then images are decoded so the centering
  // math is exact even when the spot is below the fold of a long chapter.
  W.addEventListener('load', () => setTimeout(centerOnHash, 50));
  // In-page anchor changes (back/forward) also re-center.
  W.addEventListener('hashchange', centerOnHash);
  favorites.subscribe(refreshFavCount);
  visited.subscribe(refreshVisitedCount);
})();
