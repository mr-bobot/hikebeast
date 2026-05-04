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
  function currentChapterId() {
    const m = location.pathname.match(/\/full\/([^/]+)\/?/);
    if (!m) return null;
    const seg = m[1];
    const known = new Set(['intro', 'central', 'valais', 'fribourg', 'western', 'eastern', 'ticino', 'beyond']);
    return known.has(seg) ? seg : null;
  }

  // --- Storage layer
  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }
  function write(set) {
    try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch {}
  }

  const subs = new Set();
  function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

  const favorites = {
    has(key) { return read().has(key); },
    list() { return [...read()]; },
    count() { return read().size; },
    toggle(key) {
      const s = read();
      if (s.has(key)) s.delete(key); else s.add(key);
      write(s);
      notify();
      return s.has(key);
    },
    set(key, on) {
      const s = read();
      if (on) s.add(key); else s.delete(key);
      write(s);
      notify();
    },
    clear() { write(new Set()); notify(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };

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
  const SVG_DICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="12" cy="12" r="1"/></svg>';
  // Two-card stack: signals "swipe through one at a time"
  const SVG_SWIPE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="13" height="16" rx="2" transform="rotate(8 12 12)"/><rect x="3" y="5" width="13" height="16" rx="2" transform="rotate(-8 12 12)"/></svg>';
  const SVG_MAP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';

  // --- Inject the left-side app rail. Replaces the older topbar pills.
  // Items: Home (brand site) · Overview · Browse · Map · Swipe · Random · Liked.
  // Collapsed by default at 64px wide; toggle expands to 220px showing labels.
  // Mobile: hidden by default, opens as a drawer via the topbar burger button.
  const RAIL_KEY = 'hb:rail:v1';

  // Icons separate from the topbar set so we can size them independently.
  const SVG_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></svg>';
  const SVG_OVERVIEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  const SVG_CHEVRONS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>';
  const SVG_BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';

  function injectRail() {
    if (document.querySelector('.app-rail')) return;
    document.body.classList.add('has-rail');

    // Restore expanded state from previous session.
    let expanded = false;
    try { expanded = localStorage.getItem(RAIL_KEY) === '1'; } catch {}
    if (expanded) document.body.classList.add('rail-expanded');

    const rail = document.createElement('aside');
    rail.className = 'app-rail' + (expanded ? ' is-expanded' : '');
    rail.setAttribute('aria-label', 'Primary navigation');

    const here = location.pathname.replace(/index\.html$/, '');
    const cur = (suffix) => here.endsWith(suffix) ? ' is-current' : '';

    rail.innerHTML = `
      <a class="rail-brand" href="${REL}index.html" title="Hidden Gems home">
        <img src="${REL}../images/avatar.jpg" alt="" />
        <span class="label">Hidden Gems</span>
      </a>
      <div class="rail-divider"></div>
      <a class="rail-item${cur('/full/') || cur('/full/index.html')}" href="${REL}index.html">
        ${SVG_OVERVIEW}<span class="label">Overview</span>
      </a>
      <a class="rail-item${cur('/browse/')}" href="${REL}browse/">
        ${SVG_GRID}<span class="label">Browse</span>
      </a>
      <a class="rail-item${cur('/map/')}" href="${REL}map/">
        ${SVG_MAP}<span class="label">Map</span>
      </a>
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
      <a class="rail-item" href="${REL}../index.html" title="Hikebeast.ch">
        ${SVG_HOME}<span class="label">Home</span>
      </a>
      <button type="button" class="rail-toggle" data-hb-rail-toggle aria-label="Toggle navigation labels">
        ${SVG_CHEVRONS}<span class="label">Collapse</span>
      </button>
    `;
    document.body.insertBefore(rail, document.body.firstChild);

    // Backdrop for mobile drawer
    const backdrop = document.createElement('div');
    backdrop.className = 'rail-backdrop';
    document.body.insertBefore(backdrop, document.body.firstChild);
    backdrop.addEventListener('click', closeMobileDrawer);

    // Burger button into the topbar (mobile only via CSS)
    const topbar = document.querySelector('.topbar');
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

    // Random
    rail.querySelector('[data-hb-random]').addEventListener('click', () => {
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

    refreshFavCount();
  }

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
  // relative to the page that called us.
  function spotHrefFromHere(spot) {
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
    loadSpots().then(spots => {
      const eligible = (spots || []).filter(s => !!s.image);
      if (!eligible.length) { randomActive = false; return; }

      function pickWinner() { return eligible[Math.floor(Math.random() * eligible.length)]; }
      let winner = pickWinner();

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
        const dims = (W.HB_THUMB_DIMS || {})[spot.image];
        const dimsAttr = dims ? ` width="${dims[0]}" height="${dims[1]}"` : '';
        card.innerHTML = `
          <img src="${REL}img/m/${spot.image}" alt=""${dimsAttr} />
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
        const dims = (W.HB_THUMB_DIMS || {})[winner.image];
        const dimsAttr = dims ? ` width="${dims[0]}" height="${dims[1]}"` : '';
        winnerEl.innerHTML = `
          <div class="rw-card">
            <img src="${REL}img/m/${winner.image}" alt=""${dimsAttr} />
          </div>
          <div class="rw-meta">
            ${kicker ? `<p class="rw-kicker">${escapeText(kicker)}</p>` : ''}
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
        `;
        winnerEl.querySelector('[data-open]').setAttribute('href', spotHrefFromHere(winner));
        winnerEl.querySelector('[data-reroll]').addEventListener('click', () => {
          winner = pickWinner();
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
  // it can spill outside the card. Currently has one item: "Submit photo",
  // which opens a modal and POSTs the image (resized client-side) to the
  // /api/submit-photo endpoint. Photos are reviewed manually before going live.
  const SVG_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  const SVG_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

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
    // Only one menu open at a time
    document.querySelectorAll('.hb-spot-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'hb-spot-menu';
    menu.innerHTML = `
      <button type="button" class="hb-spot-menu-item" data-action="submit">${SVG_UPLOAD}<span>Submit photo</span></button>
    `;
    document.body.appendChild(menu);

    // Position below the anchor, right-aligned to it.
    const rect = anchor.getBoundingClientRect();
    const desiredTop = rect.bottom + 8;
    const desiredRight = window.innerWidth - rect.right;
    menu.style.top = `${desiredTop}px`;
    menu.style.right = `${desiredRight}px`;
    requestAnimationFrame(() => menu.classList.add('is-show'));

    function close() {
      menu.classList.remove('is-show');
      setTimeout(() => menu.remove(), 160);
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    }
    function onOutside(e) {
      if (!menu.contains(e.target) && e.target !== anchor) close();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    setTimeout(() => {
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', close, true);
    }, 0);

    menu.querySelector('[data-action="submit"]').addEventListener('click', () => {
      close();
      openSubmitModal(slide);
    });
  }

  function openSubmitModal(slide) {
    const id = slide.id || '';
    const title = slide.querySelector('.sp-title')?.textContent?.trim() || id;
    const ch = currentChapterId();
    const spotKey = ch ? `${ch}#${id}` : id;

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

  // --- Heart toggle on every .slide-spot in chapter pages.
  function injectHearts() {
    const ch = currentChapterId();
    if (!ch) return;
    const slides = document.querySelectorAll('.slide-spot[id]');
    if (!slides.length) return;

    slides.forEach(slide => {
      injectSpotMenu(slide);
      if (slide.querySelector('[data-hb-fav]')) return;
      const anchor = slide.id;
      const k = keyFor(ch, anchor);
      if (!k) return;

      // Heart goes on the white text panel (top-right) -- not the photo --
      // so it never sits on top of detail content like the credit pill.
      const body = slide.querySelector('.sp-body');
      if (!body) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hb-fav';
      btn.setAttribute('data-hb-fav', k);
      btn.setAttribute('aria-label', 'Save to favorites');
      btn.innerHTML = SVG_HEART_OUT;
      body.appendChild(btn);

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
    });
  }

  // Cross-tab sync: another tab toggled a favorite -> repaint.
  W.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      // Repaint heart buttons + nav badge.
      document.querySelectorAll('[data-hb-fav]').forEach(btn => {
        const k = btn.getAttribute('data-hb-fav');
        const on = favorites.has(k);
        btn.classList.toggle('is-on', on);
        btn.innerHTML = on ? SVG_HEART_FILL : SVG_HEART_OUT;
      });
      refreshFavCount();
    }
  });

  // --- Public API
  W.HB = W.HB || {};
  W.HB.favorites = favorites;
  W.HB.keyFor = keyFor;
  W.HB.spotKey = (spot) => {
    if (!spot || !spot.chapter_id) return null;
    const anchor = (spot.href || '').split('#')[1] || '';
    if (!anchor) return null;
    return `${spot.chapter_id}#${anchor}`;
  };
  W.HB.singularKicker = singularKicker;
  W.HB.propertiesOf = propertiesOf;
  W.HB.buildPropertyIndex = buildPropertyIndex;
  W.HB.rel = REL;
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

  // --- Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectRail(); injectHearts(); rewriteKickersInPage(); centerOnHash(); });
  } else {
    injectRail();
    injectHearts();
    rewriteKickersInPage();
    centerOnHash();
  }
  // Fire again on full load -- by then images are decoded so the centering
  // math is exact even when the spot is below the fold of a long chapter.
  W.addEventListener('load', () => setTimeout(centerOnHash, 50));
  // In-page anchor changes (back/forward) also re-center.
  W.addEventListener('hashchange', centerOnHash);
  favorites.subscribe(refreshFavCount);
})();
