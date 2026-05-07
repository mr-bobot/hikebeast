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
  const KEY = 'hb:fav:v1';
  const NO_KEY = 'hb:skipped:v1';
  const SESSION_KEY = 'hb:session:v1';
  const W = window;

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
      const photos = (row.photos || []).slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(p => ({
          src:     p.staticPath || null,
          photoId: p.photoId    || null,
          credit:  p.credit     || null,
          width:   p.width      || null,
          height:  p.height     || null,
        }))
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
        if (spotKey && dbBySpotKey.has(spotKey)) return dbBySpotKey.get(spotKey);
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

    return {
      all() { return arr; },
      get(spotKey) { return byKey.get(spotKey) || null; },
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
  const SVG_CHEVRONS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>';
  const SVG_BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';

  // Chapter list, mirrored from the home page covers. Chapter `id` matches
  // the URL segment under /full/<id>/. Introduction sits at the top of the
  // section as a special "front matter" entry, visually separated from the
  // seven regional chapters by a divider.
  // Cover paths point at the build-image-derivatives output. Intro thumb
  // is a JPG copied by build-static-assets from assets/front_matter/.
  const RAIL_INTRO_CHAPTER = { id: 'intro', label: 'Introduction', cover: 'front_matter/page_05.jpg' };
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
    rail.setAttribute('aria-label', 'Primary navigation');

    const here = location.pathname.replace(/index\.html$/, '');
    const cur = (suffix) => here.endsWith(suffix) ? ' is-current' : '';
    const curCh = currentChapterId();

    const renderChapter = (ch) => `
      <a class="rail-chapter${curCh === ch.id ? ' is-current' : ''}" href="${REL}${ch.id}/" title="${ch.label}">
        <span class="rail-chapter-thumb"><img src="${REL}img/${ch.cover}" alt="" /></span>
        <span class="label">${ch.label}</span>
      </a>
    `;
    const introItem = renderChapter(RAIL_INTRO_CHAPTER);
    const chapterItems = RAIL_CHAPTERS.map(renderChapter).join('');

    rail.innerHTML = `
      <a class="rail-brand" href="${REL}index.html" title="Gems of Switzerland home">
        <img src="${REL}../images/avatar.jpg" alt="" />
        <span class="label">Gems of Switzerland</span>
      </a>
      <div class="rail-scroll">
        <a class="rail-item${cur('/full/') || cur('/full/index.html')}" href="${REL}index.html">
          ${SVG_HOME}<span class="label">Home</span>
        </a>
        <a class="rail-item${cur('/browse/')}" href="${REL}browse/">
          ${SVG_GRID}<span class="label">Explore</span>
        </a>
        <a class="rail-item${cur('/map/')}" href="${REL}map/">
          ${SVG_MAP}<span class="label">Map</span>
        </a>
        <div class="rail-divider"></div>
        <a class="rail-item${cur('/swipe/')}" href="${REL}swipe/">
          ${SVG_SWIPE}<span class="label">Swipe</span>
        </a>
        <button type="button" class="rail-item" data-hb-random>
          ${SVG_DICE}<span class="label">Random</span>
        </button>
        <a class="rail-item${cur('/saved/')}" href="${REL}saved/" data-hb-saved-link>
          ${SVG_HEART_OUT}<span class="label">Liked</span>
          <span class="rail-badge" data-hb-fav-count></span>
        </a>
        <div class="rail-divider"></div>
        <div class="rail-section-head"><span class="label">Collections</span></div>
        <a class="rail-item${cur('/hidden-gems/')}" href="${REL}hidden-gems/">
          ${SVG_GEM}<span class="label">Hidden Gems</span>
        </a>
        <a class="rail-item${cur('/wildcamping/')}" href="${REL}wildcamping/">
          ${SVG_TENT}<span class="label">Wildcamping</span>
        </a>
        <div class="rail-divider"></div>
        <div class="rail-section-head"><span class="label">Chapters</span></div>
        ${introItem}
        <div class="rail-divider rail-divider-tight"></div>
        ${chapterItems}
      </div>
      <button type="button" class="rail-toggle" data-hb-rail-toggle aria-label="Toggle navigation labels">
        ${SVG_CHEVRONS}<span class="label">Collapse</span>
      </button>
    `;
    document.body.insertBefore(rail, document.body.firstChild);

    // Account FAB lives top-right of the viewport, regardless of page,
    // so it's reachable without scrolling the rail. paintAccount() below
    // targets the [data-hb-account] slot on this fab.
    const accountFab = document.createElement('div');
    accountFab.className = 'hb-account-fab';
    accountFab.dataset.hbAccount = '';
    document.body.appendChild(accountFab);

    // Mobile bottom tab bar. Hidden above 700px via CSS. Replaces the
    // burger drawer as the primary mobile nav so people actually
    // discover Swipe / Map / Menu instead of leaving them buried in a
    // hamburger. Five slots: Home · Explore · Swipe · Map · Menu.
    // Menu is a hamburger that opens a slide-up sheet with Liked,
    // Collections, Chapters, and Account — everything that didn't earn
    // a primary slot. The fav-count badge sits on the Menu icon so
    // users see they have saved spots without opening the sheet.
    const tabbar = document.createElement('nav');
    tabbar.className = 'app-tabbar';
    tabbar.setAttribute('aria-label', 'Primary navigation');
    tabbar.innerHTML = `
      <a class="tab${cur('/full/') || cur('/full/index.html')}" href="${REL}index.html">
        ${SVG_HOME}<span>Home</span>
      </a>
      <a class="tab${cur('/browse/')}" href="${REL}browse/">
        ${SVG_GRID}<span>Explore</span>
      </a>
      <a class="tab${cur('/swipe/')}" href="${REL}swipe/">
        ${SVG_SWIPE}<span>Swipe</span>
      </a>
      <a class="tab${cur('/map/')}" href="${REL}map/">
        ${SVG_MAP}<span>Map</span>
      </a>
      <button type="button" class="tab" data-hb-menu-toggle aria-label="Menu" aria-haspopup="dialog">
        ${SVG_BURGER}<span>Menu</span>
        <span class="tab-badge" data-hb-fav-count></span>
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
    menuSheet.setAttribute('aria-label', 'Menu');
    menuSheet.innerHTML = `
      <div class="menu-sheet-backdrop" data-close></div>
      <div class="menu-sheet-card">
        <div class="menu-sheet-grabber" aria-hidden="true"></div>
        <a class="menu-row${cur('/saved/')}" href="${REL}saved/" data-hb-saved-link data-close>
          <span class="menu-row-icon">${SVG_HEART_OUT}</span>
          <span class="menu-row-label">Liked</span>
          <span class="menu-row-badge" data-hb-fav-count></span>
        </a>
        <a class="menu-row${cur('/visited/')}" href="${REL}visited/" data-hb-visited-link data-close hidden>
          <span class="menu-row-icon">${SVG_CHECK_CIRCLE}</span>
          <span class="menu-row-label">Been there</span>
          <span class="menu-row-badge" data-hb-visited-count></span>
        </a>
        <button type="button" class="menu-row" data-hb-random data-close>
          <span class="menu-row-icon">${SVG_DICE}</span>
          <span class="menu-row-label">Surprise me</span>
        </button>
        <div class="menu-section-head">Collections</div>
        <a class="menu-row${cur('/hidden-gems/')}" href="${REL}hidden-gems/" data-close>
          <span class="menu-row-icon">${SVG_GEM}</span>
          <span class="menu-row-label">Hidden Gems</span>
        </a>
        <a class="menu-row${cur('/wildcamping/')}" href="${REL}wildcamping/" data-close>
          <span class="menu-row-icon">${SVG_TENT}</span>
          <span class="menu-row-label">Wildcamping</span>
        </a>
        <div class="menu-section-head">Chapters</div>
        <a class="menu-row${curCh === 'intro' ? ' is-current' : ''}" href="${REL}intro/" data-close>
          <span class="menu-row-thumb"><img src="${REL}img/${RAIL_INTRO_CHAPTER.cover}" alt="" /></span>
          <span class="menu-row-label">${RAIL_INTRO_CHAPTER.label}</span>
        </a>
        ${RAIL_CHAPTERS.map(ch => `
          <a class="menu-row${curCh === ch.id ? ' is-current' : ''}" href="${REL}${ch.id}/" data-close>
            <span class="menu-row-thumb"><img src="${REL}img/${ch.cover}" alt="" /></span>
            <span class="menu-row-label">${ch.label}</span>
          </a>
        `).join('')}
        <div class="menu-sheet-account" data-hb-account></div>
      </div>
    `;
    document.body.appendChild(menuSheet);

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
      burger.setAttribute('aria-label', 'Open navigation');
      burger.innerHTML = SVG_BURGER;
      burger.addEventListener('click', () => {
        rail.classList.add('is-open');
        backdrop.classList.add('is-show');
      });
      topbar.insertBefore(burger, topbar.firstChild);
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
          slot.innerHTML = `
            <div class="rail-user">
              <span class="rail-user-avatar" aria-hidden="true">${escapeText(initials)}</span>
              <span class="rail-user-name label">${escapeText(display)}</span>
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

    // Visited row visibility: hide when signed out (paid feature),
    // show when signed in. Re-runs on sign-in/sign-out via the
    // visited façade's subscribe (signedIn flips during _reattach).
    function paintVisitedRow() {
      document.querySelectorAll('[data-hb-visited-link]').forEach(el => {
        if (visited.signedIn()) el.hidden = false;
        else                    el.hidden = true;
      });
    }
    paintVisitedRow();
    visited.subscribe(paintVisitedRow);
    session.subscribe(paintVisitedRow);

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

  function refreshFavCount() {
    const n = favorites.count();
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
    const n = visited.count();
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
  // Tick mark in a circle for the "Been there" / "Visited" toggle.
  const SVG_CHECK_CIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 16 10"/></svg>';

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
    // Photo credit is taken from the currently-displayed photo (in case
    // the carousel has advanced) or the spot's primary photo as a
    // fallback. We pass it through so the kebab can show "Photo by …".
    const carousel = slide.querySelector('.sp-photo .hb-slide.is-current img');
    const photoIdx = parseInt(carousel?.dataset?.idx || '0', 10) || 0;
    const credit = (spot && spot.photos && spot.photos[photoIdx]?.credit)
      || (spot && spot.photos && spot.photos[0]?.credit)
      || null;
    openMenuPanel(anchor, {
      spotKey,
      hasWild,
      credit,
      onSubmit: () => openSubmitModal(slide),
      onWild:   () => hasWild && openWildCampingModal(spot),
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
  function openMenuPanel(anchor, { spotKey, hasWild, credit, onSubmit, onWild }) {
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
    if (credit) {
      // Photo credit is informational — non-clickable item with the
      // photographer's handle / name. We resolve known handles to
      // "@handle" via the same renderCredit logic the build script
      // uses, but the menu item just displays whatever the data has.
      items.push(`<button type="button" class="hb-spot-menu-item is-info" data-action="credit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/><circle cx="17" cy="8.5" r="0.6" fill="currentColor"/></svg><span>Photo · ${escapeText(credit)}</span></button>`);
    }
    const menu = document.createElement('div');
    menu.className = 'hb-spot-menu';
    menu.innerHTML = items.join('');
    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    menu.style.right = `${window.innerWidth - rect.right}px`;
    // Decide whether the menu opens DOWN (default) or UP. On mobile
    // Safari the bottom of the viewport is eaten by the URL bar +
    // search field; a downward-opening menu near the bottom of the
    // page disappears behind that chrome. Measure once after the
    // menu is in the DOM (so we know its height), then flip if there
    // isn't enough room below.
    requestAnimationFrame(() => {
      const menuH = menu.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const GAP = 8;
      if (spaceBelow < menuH + 24 && spaceAbove > spaceBelow) {
        // Open upward
        menu.style.top = `${Math.max(8, rect.top - menuH - GAP)}px`;
        menu.classList.add('is-flip');
      } else {
        menu.style.top = `${rect.bottom + GAP}px`;
      }
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

    menu.querySelector('[data-action="submit"]')?.addEventListener('click', () => { close(); onSubmit?.(); });
    menu.querySelector('[data-action="wild"]')?.addEventListener('click',   () => { close(); onWild?.();   });
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
          .map(s => `<div class="spec"><span class="lbl">${escapeText(s.label)}</span><span class="val">${escapeText(s.value)}</span></div>`)
          .join('');
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
    // Snapshot the original <img>'s natural aspect ratio BEFORE removing
    // it so we can lock that aspect on the container. Without this, the
    // photo column loses its intrinsic-size source when the absolute-
    // positioned slides take over, and grid-stretch collapses the column
    // to the body's natural height — visible as a "card resizes weirdly
    // after load" flash. With the aspect locked, the column stays the
    // same height before and after the carousel inits.
    photoEl.querySelectorAll('.hb-slide, .hb-dots, .hb-arrow, .hb-counter, .hb-credit').forEach(n => n.remove());
    const oldImg = photoEl.querySelector('img');
    const oldCredit = photoEl.querySelector('.credit-pill');
    if (oldImg) {
      const nw = oldImg.naturalWidth, nh = oldImg.naturalHeight;
      if (nw > 0 && nh > 0) {
        photoEl.style.aspectRatio = `${nw} / ${nh}`;
      } else if (photos[0]?.width && photos[0]?.height) {
        photoEl.style.aspectRatio = `${photos[0].width} / ${photos[0].height}`;
      }
      oldImg.remove();
    } else if (photos[0]?.width && photos[0]?.height) {
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

    let idx = 0;
    function show(target) {
      const n = ((target % photos.length) + photos.length) % photos.length;
      if (n === idx) return;
      slideEls[idx].classList.remove('is-current');
      slideEls[n].classList.add('is-current');
      dots.children[idx].classList.remove('is-on');
      dots.children[n].classList.add('is-on');
      counter.textContent = `${n + 1} / ${photos.length}`;
      setCredit(photos[n]);
      idx = n;
    }
    prev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(idx - 1); });
    next.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(idx + 1); });

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
        show(idx + (dx < 0 ? 1 : -1));
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
    // Pull the credit off the currently-displayed carousel slide if
    // any, otherwise fall back to the primary photo's credit.
    const carouselImg = card.querySelector('.cl-photos .hb-slide.is-current img, .cl-photos > img');
    const photoIdx = parseInt(carouselImg?.dataset?.idx || '0', 10) || 0;
    const credit = (spot && spot.photos && spot.photos[photoIdx]?.credit)
      || (spot && spot.photos && spot.photos[0]?.credit)
      || null;
    openMenuPanel(anchor, {
      spotKey: info?.spotKey || null,
      hasWild,
      credit,
      onSubmit: () => openSubmitModal(info),
      onWild:   () => hasWild && openWildCampingModal(spot),
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
      // visited pile. Always rendered so the layout stays stable; the
      // signed-in gate hides it via [hidden] when no session attached
      // and flips back on sign-in. Tick filled when on.
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'hb-visited';
      tick.setAttribute('data-hb-visited', k);
      tick.setAttribute('aria-label', 'Mark as visited');
      tick.innerHTML = SVG_CHECK_CIRCLE;
      tick.hidden = !visited.signedIn();
      actions.appendChild(tick);

      function paintVisited() {
        tick.hidden = !visited.signedIn();
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
        if (!visited.signedIn()) return;
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
      return `${pre}${(spot.href || '').replace(/^\.\.\//, '')}`;
    }
    const anchor = (spot.href || '').split('#')[1] || '';
    if (anchor) return `${pre}spot/${anchor}/`;
    return `${pre}${(spot.href || '').replace(/^\.\.\//, '')}`;
  };
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
