#!/usr/bin/env python3
"""Generate the /full/ webapp from the Hidden Gems rebuild content.yaml.

Reads:
  ~/Documents/Claude/Projects/Hiking Influencer/rebuild/content.yaml
  ~/Documents/Claude/Projects/Hiking Influencer/rebuild/credits.yaml
  ~/Documents/Claude/Projects/Hiking Influencer/rebuild/images/...

Writes the home, intro, 7 chapter pages, and the map under /full/.
Images are copied + resized to /full/img/. Re-uses preview.css/.js verbatim.
"""
import yaml, shutil, subprocess, html, json, re
from pathlib import Path

REBUILD = Path('/Users/lost/Documents/Claude/Projects/Hiking Influencer/rebuild')
IMAGES_SRC = REBUILD / 'images'
DEST = Path('/Users/lost/Documents/Development/Hikebeast/full')
PREVIEW = Path('/Users/lost/Documents/Development/Hikebeast/preview')
DEST_IMG = DEST / 'img'

content = yaml.safe_load((REBUILD / 'content.yaml').read_text())
credits = yaml.safe_load((REBUILD / 'credits.yaml').read_text())

CHAPTERS = content['chapters']
SPOTS_ALL = content['spots']
FRONT_MATTER = content['front_matter']
COVER = content['cover']
AUTHOR = content['author']

# Slug → human label for sidebar
SLUG_LABEL = {
    'intro':    'Intro',
    'central':  'Central',
    'valais':   'Valais',
    'fribourg': 'Fribourg',
    'western':  'Western',
    'eastern':  'Eastern',
    'ticino':   'Ticino',
    'beyond':   'Beyond',
}

# Override which photo each chapter uses on the home page card.
# Value is a content.yaml-relative image path; '__custom__' keeps a file
# already present at /full/img/<slug>-thumb.jpg.
CHAPTER_THUMB = {
    'central':  'spots/central/tannhorn.jpg',
    'valais':   'spots/valais/ig_zermatt_matterhorn.jpg',
    'fribourg': None,
    'western':  'spots/leman/cap_au_moine.jpg',
    'eastern':  '__custom__',
    'ticino':   None,
    'beyond':   'spots/beyond/les_cheserys.jpg',
}

WHOP = 'https://whop.com/gorped/hidden-gems-switzerland-e8/'

# ───────────────────────── group spots by chapter ─────────────────────────
# YAML order is canonical now -- spots: is one flat list in order. Just
# split by chapter and keep order.
chapter_spots = {ch['id']: [] for ch in CHAPTERS}
for s in SPOTS_ALL:
    if s.get('chapter') in chapter_spots:
        chapter_spots[s['chapter']].append(s)

# ───────────────────────── credits resolver ─────────────────────────
PHOTOGRAPHERS = credits.get('photographers', {})
EXTERNAL = credits.get('external', {})

def credit_text(key):
    """Returns the rendered credit string or '' to suppress the pill."""
    if not key or key in ('xxx', 'placeholder'):
        return ''
    if key in PHOTOGRAPHERS:
        return f'@{key}'
    if key in EXTERNAL:
        e = EXTERNAL[key]
        src = e.get('source', '')
        name = e.get('name', '')
        return f'{src} / {name}' if src and name else (src or name)
    return ''

# ───────────────────────── image queueing ─────────────────────────
DEST_IMG.mkdir(parents=True, exist_ok=True)
img_refs = []         # list of (src_abs, dest_abs)
img_name = {}         # rel path under images/ → dest filename
basename_seen = {}

def queue(rel_path):
    if not rel_path:
        return None
    src = IMAGES_SRC / rel_path
    if not src.exists():
        return None
    base = Path(rel_path).name
    if base in basename_seen and basename_seen[base] != rel_path:
        # collision -- prefix with parent folder name
        base = rel_path.replace('/', '-')
    basename_seen[base] = rel_path
    img_name[rel_path] = base
    img_refs.append((src, DEST_IMG / base))
    return base

# Cover
queue(COVER.get('image'))
# Chapter covers
for ch in CHAPTERS:
    queue(ch.get('cover_image'))
# Spot images
for s in SPOTS_ALL:
    if s.get('image'):
        queue(s['image'])
    if s.get('kind') == 'spread':
        for p in s.get('images', []):
            queue(p.get('src'))
# Front matter images
for fm in FRONT_MATTER:
    if fm.get('image'):
        queue(fm['image'])
    if fm['kind'] == 'top_six':
        for t in fm.get('tiles', []):
            queue(t.get('image'))

print(f'Queued {len(img_refs)} images')
copied = 0
for src, dst in img_refs:
    if not dst.exists():
        shutil.copy(src, dst)
        copied += 1
print(f'Copied {copied} new images, {len(img_refs)-copied} already present')

# Resize all (idempotent)
for img in DEST_IMG.glob('*.jpg'):
    subprocess.run(
        ['sips', '-Z', '1800', '-s', 'format', 'jpeg',
         '-s', 'formatOptions', '78', str(img), '--out', str(img)],
        capture_output=True)
print(f'{len(list(DEST_IMG.glob("*.jpg")))} JPEGs in {DEST_IMG}')

# Tiny thumbnails for the map markers -- 160px @ q60 keeps each ~5-7 KB
# so 127 markers won't trash mobile decode performance.
THUMBS_DIR = DEST_IMG / 'thumbs'
THUMBS_DIR.mkdir(exist_ok=True)
made = 0
for img in DEST_IMG.glob('*.jpg'):
    if img.parent != DEST_IMG: continue
    thumb = THUMBS_DIR / img.name
    if not thumb.exists() or thumb.stat().st_mtime < img.stat().st_mtime:
        shutil.copy(img, thumb)
        subprocess.run(
            ['sips', '-Z', '160', '-s', 'format', 'jpeg',
             '-s', 'formatOptions', '60', str(thumb), '--out', str(thumb)],
            capture_output=True)
        made += 1
print(f'{made} new map thumbnails written to {THUMBS_DIR}')

# Copy shared CSS / JS
shutil.copy(PREVIEW / 'preview.css', DEST / 'preview.css')
shutil.copy(PREVIEW / 'preview.js', DEST / 'preview.js')

# ───────────────────────── HTML helpers ─────────────────────────
def esc(s):
    if s is None: return ''
    return html.escape(str(s), quote=True)

def img_url(rel_path, depth=2):
    if not rel_path or rel_path not in img_name:
        return ''
    return ('../' * (depth - 1)) + 'img/' + img_name[rel_path]

def slugify(s):
    out = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return out

LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
HOME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></svg>'
PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>'

def render_sidebar(current_slug):
    items = []
    items.append(f'  <a class="sb-home" href="../index.html" title="Home">{HOME_SVG}</a>')
    # Intro thumb
    intro_src = 'front_matter/page_05.jpg' if 'front_matter/page_05.jpg' in img_name else 'cover/hidden_gems_cover.jpg'
    cur = ' is-current' if current_slug == 'intro' else ''
    items.append(f'  <a class="sb-thumb{cur}" href="../intro/index.html" title="Front matter">'
                 f'<img src="{img_url(intro_src, 2)}" alt="" /><span class="lbl">Intro</span></a>')
    for ch in CHAPTERS:
        cur = ' is-current' if current_slug == ch['id'] else ''
        thumb = img_url(ch['cover_image'], 2)
        items.append(f'  <a class="sb-thumb{cur}" href="../{ch["id"]}/index.html" title="{esc(ch["name"])}">'
                     f'<img src="{thumb}" alt="" /><span class="lbl">{esc(SLUG_LABEL[ch["id"]])}</span></a>')
    return '<aside class="sidebar" aria-label="Chapters">\n' + '\n'.join(items) + '\n</aside>'

def render_topbar(label, total):
    return f'''<div class="topbar">
  <a class="brand" href="../index.html">
    <img src="../../images/avatar.jpg" alt="" />
    <span>Hidden Gems · {esc(label)}</span>
  </a>
  <span class="crumb"><b id="crumbCur">1</b> / <span id="crumbTotal">{total}</span></span>
  <div class="topbar-right">
    <a class="pill" href="../index.html">Overview</a>
  </div>
</div>'''

def page_head(title):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>{esc(title)} · Hidden Gems · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../../images/favicon.jpg" />
<link rel="stylesheet" href="../preview.css" />
</head>
<body>
'''

# ───────────────────────── slide renderers ─────────────────────────
def render_chapter_cover(ch):
    img = img_url(ch['cover_image'], 2)
    return f'''<section class="slide slide-cover" id="cover">
  <img class="cv-img" src="{img}" alt="" />
  <div class="cv-content">
    <p class="cv-kicker">Region</p>
    <h1>{esc(ch["name"])}</h1>
    <p class="cv-deck">{esc(ch["intro"])}</p>
  </div>
</section>'''

def render_spot(s):
    img = img_url(s.get('image', ''), 2)
    body_html = '\n          '.join(f'<p>{esc(p)}</p>' for p in s.get('body', []))
    specs = []
    if s.get('region'):     specs.append(('Region',     s['region']))
    if s.get('access'):     specs.append(('Access',     s['access']))
    if s.get('effort'):     specs.append(('Effort',     s['effort']))
    if s.get('best_light'): specs.append(('Best light', s['best_light']))
    specs_html = '\n          '.join(
        f'<div class="spec"><span class="lbl">{esc(lbl)}</span><span class="val">{esc(val)}</span></div>'
        for lbl, val in specs)
    maps_url = s.get('maps_url', '')
    cred = credit_text(s.get('image_credit', ''))
    foot_left = (
        f'<a class="locked" href="{esc(maps_url)}" target="_blank" rel="noopener" '
        f'style="color:var(--accent);font-weight:500;">{PIN_SVG}Open in Maps</a>'
    ) if maps_url else ''
    credit_pill = f'<span class="credit-pill">Photo · {esc(cred)}</span>' if cred else ''
    spot_id = s.get('id') or slugify(s['title'])
    return f'''<section class="slide slide-spot" id="{spot_id}">
  <div class="sp-photo">
    <img src="{img}" alt="{esc(s["title"])}" />
    {credit_pill}
  </div>
  <div class="sp-body">
    <p class="sp-kicker">{esc(s.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(s["title"])}</h2>
    <p class="sp-deck">{esc(s.get("deck", ""))}</p>
    <div class="body">
          {body_html}
    </div>
    <div class="specs">
          {specs_html}
    </div>
    <div class="sp-foot">
      {foot_left}
    </div>
  </div>
</section>'''

def render_spread(s):
    spot_id = s.get('id') or (slugify(s['title']) + '-spread')
    cells = []
    for p in s.get('images', []):
        url = img_url(p.get('src', ''), 2)
        cred = credit_text(p.get('credit', ''))
        pill = f'<span class="credit-pill">Photo · {esc(cred)}</span>' if cred else ''
        cells.append(f'<div class="sp-photo"><img src="{url}" alt="" />{pill}</div>')
    return f'<section class="slide slide-spread" id="{spot_id}">\n  ' + '\n  '.join(cells) + '\n</section>'

def render_extras(s):
    cells = '\n        '.join(
        f'<div class="plan-cell"><span class="num">·</span>'
        f'<div><h3>{esc(c["heading"])}</h3><p>{esc(c.get("text",""))}</p></div></div>'
        for c in s.get('entries', []))
    spot_id = s.get('id') or slugify(s['title'])
    return f'''<section class="slide slide-preface no-photo" id="{spot_id}">
  <div class="pf-body">
    <p class="sp-kicker">{esc(s.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(s["title"])}</h2>
    <p class="sp-deck">{esc(s.get("deck", ""))}</p>
  </div>
  <div class="pf-extras">
    <div class="plan-grid">
        {cells}
    </div>
  </div>
</section>'''

def render_card(s):
    kind = s.get('kind', 'spot')
    if kind == 'spread': return render_spread(s)
    if kind == 'extras': return render_extras(s)
    return render_spot(s)

# ───────────────────────── front matter renderers ─────────────────────────
def render_intro_cover():
    img = img_url(COVER.get('image', ''), 2)
    avatar = '../../images/avatar.jpg'
    return f'''<section class="slide slide-cover" id="cover">
  <img class="cv-img" src="{img}" alt="" />
  <div class="cv-content">
    <p class="cv-kicker">A Switzerland Field Guide</p>
    <h1>{esc(COVER.get("title", "Hidden Gems"))}</h1>
    <p class="cv-deck">{esc(COVER.get("subtitle", ""))}</p>
    <div class="cv-author">
      <img src="{avatar}" alt="" /><span>By {esc(AUTHOR.get("name", "Leon Helg"))} · Hikebeast</span>
    </div>
  </div>
</section>'''

def render_ethos(p):
    img = img_url(p.get('image', ''), 2)
    cred = credit_text(p.get('image_credit', ''))
    pill = f'<span class="credit-pill">Photo · {esc(cred)}</span>' if cred else ''
    body_html = '\n          '.join(f'<p>{esc(b)}</p>' for b in p.get('body', []))
    photo_block = f'<div class="pf-photo"><img src="{img}" alt="" />{pill}</div>' if img else ''
    no_photo = '' if img else ' no-photo'
    return f'''<section class="slide slide-preface{no_photo}" id="{p.get("id","")}">
  {photo_block}
  <div class="pf-body">
    <p class="sp-kicker">{esc(p.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(p["title"])}</h2>
    <p class="sp-deck">{esc(p.get("deck", ""))}</p>
    <div class="body">
          {body_html}
    </div>
  </div>
</section>'''

def render_four_col(p):
    cells = '\n        '.join(
        f'<div class="plan-cell"><span class="num">{esc(c["number"])}</span>'
        f'<div><h3>{esc(c["heading"])}</h3><p>{esc(c.get("text",""))}</p></div></div>'
        for c in p.get('columns', []))
    return f'''<section class="slide slide-preface no-photo" id="{p.get("id","")}">
  <div class="pf-body">
    <p class="sp-kicker">{esc(p.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(p["title"])}</h2>
    <p class="sp-deck">{esc(p.get("deck", ""))}</p>
  </div>
  <div class="pf-extras">
    <div class="plan-grid">
        {cells}
    </div>
  </div>
</section>'''

def render_top_six(p):
    is_hidden = 'hidden' in p['title'].lower()
    cls = 'grid-six blurred' if is_hidden else 'grid-six'
    tiles = '\n          '.join(
        f'<div class="gem"><img src="{img_url(t["image"], 2)}" alt="" />'
        f'<div class="gem-name">{esc("█" * len(t["name"]) if is_hidden else t["name"])}</div></div>'
        for t in p.get('tiles', []))
    overlay = ''
    if is_hidden:
        overlay = f'''<div class="blurred-overlay">
            {LOCK_SVG}
            <p>The full guide reveals all six.</p>
            <a href="{WHOP}" target="_blank" rel="noopener">Unlock</a>
          </div>'''
    return f'''<section class="slide slide-preface no-photo" id="{p.get("id","")}">
  <div class="pf-body">
    <p class="sp-kicker">{esc(p.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(p["title"])}</h2>
    <p class="sp-deck">{esc(p.get("deck", ""))}</p>
  </div>
  <div class="pf-extras" style="flex-direction: column; gap: 10px;">
    <div class="{cls}">
          {tiles}
        </div>
        {overlay}
  </div>
</section>'''

def render_map_summary(p):
    chapters_by_id = {c['id']: c for c in CHAPTERS}
    items = []
    for ch_id in p.get('region_order', []):
        ch = chapters_by_id.get(ch_id)
        if not ch: continue
        rgb = ','.join(str(int(c * 255)) for c in ch['color'])
        items.append(
            f'<div class="ms-item">'
            f'<span class="ms-bar" style="background:rgb({rgb});"></span>'
            f'<div class="ms-text"><b>{esc(ch["name"])}</b>'
            f'<span>{esc(ch.get("description",""))}</span></div></div>')
    items_html = '\n          '.join(items)
    return f'''<section class="slide slide-preface no-photo" id="{p.get("id","")}">
  <div class="pf-body">
    <p class="sp-kicker">{esc(p.get("kicker", ""))}</p>
    <h2 class="sp-title">{esc(p["title"])}</h2>
    <p class="sp-deck">{esc(p.get("deck", ""))}</p>
  </div>
  <div class="pf-extras">
    <div class="ms-list">
          {items_html}
    </div>
  </div>
</section>'''

def render_front_matter(p):
    k = p['kind']
    if k == 'ethos':       return render_ethos(p)
    if k == 'four_col':    return render_four_col(p)
    if k == 'top_six':     return render_top_six(p)
    if k == 'map_summary': return render_map_summary(p)
    return f'<!-- unsupported front matter: {k} -->'

# ───────────────────────── page renderers ─────────────────────────
def render_chapter_page(ch):
    spots = chapter_spots[ch['id']]
    slides = [render_chapter_cover(ch)] + [render_card(s) for s in spots]
    page = page_head(ch['name'])
    page += render_topbar(ch['name'], len(slides))
    page += '\n\n<div class="app">\n\n  '
    page += render_sidebar(ch['id'])
    page += '\n\n  <div class="viewer" id="viewer">\n\n    '
    page += '\n\n    '.join(slides)
    page += '\n\n  </div>\n</div>\n\n<script src="../preview.js"></script>\n</body>\n</html>\n'
    out = DEST / ch['id'] / 'index.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)

def render_intro_page():
    slides = [render_intro_cover()] + [render_front_matter(p) for p in FRONT_MATTER]
    page = page_head('Front matter')
    page += render_topbar('Front matter', len(slides))
    page += '\n\n<div class="app">\n\n  '
    page += render_sidebar('intro')
    page += '\n\n  <div class="viewer" id="viewer">\n\n    '
    page += '\n\n    '.join(slides)
    page += '\n\n  </div>\n</div>\n\n<script src="../preview.js"></script>\n</body>\n</html>\n'
    out = DEST / 'intro' / 'index.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)

def render_home():
    cards = []
    intro_thumb = img_url('front_matter/page_05.jpg', 1) or img_url('cover/hidden_gems_cover.jpg', 1)
    cards.append(f'''<a class="cc" href="intro/index.html">
        <div class="cc-photo">
          <span class="cc-num">Front matter</span>
          <img src="{intro_thumb}" alt="Front matter" />
        </div>
        <div class="cc-body">
          <div class="cc-name">Before you go</div>
          <div class="cc-meta">Cover · Camping · Map · Top 6</div>
        </div>
      </a>''')
    for ch in CHAPTERS:
        spots = chapter_spots[ch['id']]
        thumb_override = CHAPTER_THUMB.get(ch['id'])
        if thumb_override == '__custom__':
            thumb = f'img/{ch["id"]}-thumb.jpg'
        elif thumb_override and thumb_override in img_name:
            thumb = 'img/' + img_name[thumb_override]
        else:
            thumb = 'img/' + img_name.get(ch['cover_image'], '')
        n_spots = sum(1 for s in spots if s.get('kind', 'spot') == 'spot')
        cards.append(f'''<a class="cc" href="{ch["id"]}/index.html">
        <div class="cc-photo">
          <img src="{thumb}" alt="{esc(ch["name"])}" />
        </div>
        <div class="cc-body">
          <div class="cc-name">{esc(ch["name"])}</div>
          <div class="cc-meta">{n_spots} spots</div>
        </div>
      </a>''')
    cards_html = '\n\n      '.join(cards)
    total_spots = sum(1 for s in SPOTS_ALL if s.get('kind', 'spot') == 'spot')
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>Swiss Hidden Gems · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../images/favicon.jpg" />
<link rel="stylesheet" href="preview.css" />
</head>
<body>

<div class="topbar">
  <a class="brand" href="../">
    <img src="../images/avatar.jpg" alt="" />
    <span>Hikebeast · Hidden Gems</span>
  </a>
  <span class="crumb">Full edition</span>
  <div class="topbar-right">
    <a class="pill" href="map/index.html">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
      <span class="label-sm">Map view</span>
    </a>
  </div>
</div>

<main class="home-main">

  <header class="home-hero">
    <p class="kicker">Swiss Hidden Gems</p>
    <h1>Read it page by page.</h1>
    <p class="lead">{total_spots} spots across {len(CHAPTERS)} regions. Pick a chapter.</p>
  </header>

  <section>
    <div class="section-head">
      <h2>Chapters</h2>
      <span class="meta">{len(CHAPTERS) + 1} sections · all open</span>
    </div>
    <div class="chapter-cards">

      {cards_html}

    </div>
  </section>

</main>

<footer class="legal">
  <a href="../imprint.html">Imprint</a><span class="sep">·</span>
  <a href="../privacy.html">Privacy</a><span class="sep">·</span>
  © Hikebeast
</footer>

</body>
</html>
'''
    (DEST / 'index.html').write_text(page)

# ───────────────────────── map page ─────────────────────────
def render_map_page():
    region_color = {ch['id']: ','.join(str(int(c * 255)) for c in ch['color']) for ch in CHAPTERS}
    region_color_by_num = {ch['number']: region_color[ch['id']] for ch in CHAPTERS}

    items = []
    for s in SPOTS_ALL:
        kind = s.get('kind', 'spot')
        gps = s.get('gps') or {}
        lat = gps.get('lat')
        lng = gps.get('lng')
        if kind == 'spot' and lat is not None and lng is not None:
            ch_id = s.get('chapter')
            ch = next((c for c in CHAPTERS if c['id'] == ch_id), None)
            if not ch: continue
            spot_id = s.get('id') or slugify(s['title'])
            items.append({
                'title': s['title'],
                'kicker': s.get('kicker', ''),
                'chapter': ch['number'],
                'chapter_id': ch['id'],
                'lat': lat,
                'lon': lng,
                'image': img_name.get(s.get('image', ''), '') if s.get('image') else '',
                'href': f'../{ch["id"]}/index.html#{spot_id}',
                'color': region_color[ch['id']],
                'maps_url': s.get('maps_url', ''),
            })
        elif kind == 'extras':
            # Each entry inside has its own gps — render as individual markers
            ch_id = s.get('chapter')
            ch = next((c for c in CHAPTERS if c['id'] == ch_id), None)
            if not ch: continue
            for e in s.get('entries', []):
                eg = e.get('gps') or {}
                if eg.get('lat') is None or eg.get('lng') is None: continue
                items.append({
                    'title': e['heading'],
                    'kicker': 'EXTRAS',
                    'chapter': ch['number'],
                    'chapter_id': ch['id'],
                    'lat': eg['lat'],
                    'lon': eg['lng'],
                    'image': '',
                    'href': f'../{ch["id"]}/index.html#{s.get("id","")}',
                    'color': region_color[ch['id']],
                    'maps_url': e.get('maps_url', ''),
                })

    legend = [
        {'number': ch['number'], 'name': ch['name'], 'color': region_color[ch['id']]}
        for ch in CHAPTERS
    ]

    map_dir = DEST / 'map'
    map_dir.mkdir(parents=True, exist_ok=True)
    geojson_path = map_dir / 'switzerland.geojson'
    if geojson_path.exists():
        geojson_data = json.loads(geojson_path.read_text())
    else:
        geojson_data = {'type': 'FeatureCollection', 'features': []}
    (map_dir / 'spots-data.js').write_text(
        f'window.SPOTS = {json.dumps(items, ensure_ascii=False)};\n'
        f'window.LEGEND = {json.dumps(legend, ensure_ascii=False)};\n'
        f'window.SWITZERLAND_GEOJSON = {json.dumps(geojson_data, ensure_ascii=False)};\n'
    )

    page = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>Map · Hidden Gems · Hikebeast</title>
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" type="image/jpeg" href="../../images/favicon.jpg" />
<link rel="apple-touch-icon" href="../../images/favicon.jpg" />
<link rel="stylesheet" href="../preview.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
<style>
  body { background: #ffffff; }
  .map-shell { height: calc(100dvh - var(--topbar-h)); position: relative; }
  #map { height: 100%; width: 100%; background: #ffffff; }
  .leaflet-container { font-family: inherit; background: #ffffff; outline: 0; }
  .leaflet-interactive { outline: 0 !important; }

  .spot-marker { background: transparent; border: 0; }
  .spot-marker .thumb {
    display: block;
    width: 42px; height: 52px;
    border-radius: 8px;
    background-size: cover;
    background-position: center;
    background-color: #888;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.10), 0 3px 8px rgba(0,0,0,0.20);
    transition: transform 200ms ease, box-shadow 200ms ease;
    cursor: pointer;
    transform: translateZ(0);
    will-change: transform;
  }
  .spot-marker:hover { z-index: 1000 !important; }
  .spot-marker:hover .thumb {
    transform: scale(1.4) translateZ(0);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.10), 0 10px 24px rgba(0,0,0,0.30);
  }
  /* Touch devices: no hover-scale, no transition (causes jitter on tap). */
  @media (hover: none) {
    .spot-marker .thumb { transition: none; }
    .spot-marker:hover .thumb { transform: translateZ(0); }
  }

  .leaflet-popup-content-wrapper {
    border-radius: 18px;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 20px 50px rgba(0,0,0,0.20), 0 4px 12px rgba(0,0,0,0.08);
  }
  .leaflet-popup-content { margin: 0; width: 240px !important; }
  .leaflet-popup-tip { background: #fff; }
  .spot-popup img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
  .spot-popup .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 4px; }
  .spot-popup .kicker { font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0; }
  .spot-popup h3 { margin: 2px 0 0; font-family: "SF Pro Display", -apple-system, system-ui, sans-serif; font-size: 18px; letter-spacing: -0.02em; line-height: 1.15; font-weight: 600; color: var(--fg); }
  .spot-popup .meta { font-size: 11px; color: var(--muted); margin: 4px 0 0; }
  .spot-popup a.read { margin-top: 10px; display: inline-flex; align-items: center; justify-content: center; height: 36px; border-radius: 999px; background: var(--fg); color: #fff; font-size: 13px; font-weight: 500; text-decoration: none; }

  .spot-tip {
    background: rgba(255,255,255,0.96) !important;
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    border: 1px solid var(--hairline) !important;
    border-radius: 12px !important;
    box-shadow: 0 8px 24px rgba(0,0,0,0.14) !important;
    padding: 8px 12px !important;
    color: var(--fg) !important;
    font-size: 12.5px !important; font-weight: 500 !important; letter-spacing: -0.005em !important;
    white-space: nowrap;
  }
  .leaflet-tooltip-top.spot-tip:before { display: none; }

  .legend {
    position: absolute; bottom: 18px; left: 18px; z-index: 500;
    background: rgba(255,255,255,0.94);
    -webkit-backdrop-filter: saturate(180%) blur(14px); backdrop-filter: saturate(180%) blur(14px);
    border: 1px solid var(--hairline); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.10);
    display: flex; flex-direction: column; gap: 8px; max-width: 240px;
  }
  .legend h4 { margin: 0 0 6px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .legend-item {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; cursor: pointer; user-select: none; color: var(--fg); line-height: 1.2;
    padding: 6px 0; background: transparent; border: 0; text-align: left; font-family: inherit;
    transition: opacity 120ms ease;
  }
  .legend-item.is-off { opacity: 0.30; }
  .legend-item .swatch { flex-shrink: 0; width: 14px; height: 14px; border-radius: 999px; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.08); }

  .counter {
    position: absolute; top: 18px; right: 18px; z-index: 500;
    background: rgba(255,255,255,0.94);
    -webkit-backdrop-filter: saturate(180%) blur(14px); backdrop-filter: saturate(180%) blur(14px);
    border: 1px solid var(--hairline); border-radius: 999px;
    padding: 8px 14px; font-size: 12px; font-weight: 600; letter-spacing: -0.005em; color: var(--fg);
    box-shadow: 0 4px 14px rgba(0,0,0,0.06);
  }
  .counter b { color: var(--accent); font-weight: 700; }

  /* Toggle button -- only shown on mobile */
  .legend-toggle { display: none; }

  /* Mobile: collapse legend behind a toggle, shrink counter */
  @media (max-width: 700px) {
    .legend { padding: 4px 6px; gap: 0; max-width: none; }
    .legend > h4 { display: none; }
    .legend > .legend-item { display: none; }
    .legend-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: transparent;
      border: 0;
      color: var(--fg);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      letter-spacing: -0.005em;
    }
    .legend-toggle svg { width: 14px; height: 14px; color: var(--muted); }
    .legend.is-open { padding: 8px 10px; gap: 4px; max-width: 200px; }
    .legend.is-open > h4 { display: block; padding-top: 4px; font-size: 9px; }
    .legend.is-open > .legend-item { display: flex; font-size: 12px; padding: 3px 0; gap: 8px; }
    .legend.is-open > .legend-item .swatch { width: 12px; height: 12px; }
    .counter { padding: 6px 10px; font-size: 11px; }
    .spot-marker .thumb { width: 32px; height: 40px; border-width: 1.5px; }
  }
</style>
</head>
<body>

<div class="topbar">
  <a class="brand" href="../index.html">
    <img src="../../images/avatar.jpg" alt="" />
    <span>Hidden Gems · Map</span>
  </a>
  <span class="crumb">Map view</span>
  <div class="topbar-right">
    <a class="pill" href="../index.html">Overview</a>
  </div>
</div>

<div class="map-shell">
  <div id="map"></div>
  <div class="counter"><b id="visible">0</b>&nbsp;visible spots</div>
  <aside class="legend" id="legend">
    <button class="legend-toggle" id="legendToggle" aria-expanded="false" aria-label="Show chapter filter">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      <span>Filter</span>
    </button>
    <h4>Chapters · click to isolate</h4>
  </aside>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script src="spots-data.js"></script>
<script>
  // preferCanvas + smaller-touch-handler: Canvas vector renderer is
  // dramatically faster than SVG/DOM for many markers, esp. on mobile.
  const isMobile = window.matchMedia('(max-width: 700px)').matches;
  const map = L.map('map', {
    zoomControl: true, attributionControl: false,
    minZoom: 7, maxZoom: 13,
    preferCanvas: true,
    tap: false,           // skip Leaflet's tap-delay on touch devices
  }).setView([46.82, 8.22], 8);

  const SPOTS = window.SPOTS || [];
  const LEGEND = window.LEGEND || [];
  const GEOJSON = window.SWITZERLAND_GEOJSON;

  const CANTON_CHAPTER = {
    'Bern': '01', 'Luzern': '01', 'Uri': '01', 'Schwyz': '01',
    'Obwalden': '01', 'Nidwalden': '01', 'Zug': '01', 'Aargau': '01',
    'Valais': '02',
    'Fribourg': '03',
    'Vaud': '04', 'Genève': '04', 'Neuchâtel': '04', 'Jura': '04',
    'Solothurn': '04', 'Basel-Landschaft': '04', 'Basel-Stadt': '04',
    'Glarus': '05', 'Graubünden': '05', 'St. Gallen': '05',
    'Appenzell Ausserrhoden': '05', 'Appenzell Innerrhoden': '05',
    'Schaffhausen': '05', 'Thurgau': '05', 'Zürich': '05',
    'Ticino': '06',
  };
  const REGION_COLOR_BY_CH = {};
  LEGEND.forEach(c => { REGION_COLOR_BY_CH[c.number] = c.color; });

  if (GEOJSON && GEOJSON.features && GEOJSON.features.length) {
    L.geoJSON(GEOJSON, {
      style: function (feature) {
        const ch = CANTON_CHAPTER[feature.properties.name];
        const rgb = ch ? REGION_COLOR_BY_CH[ch] : '224,224,228';
        return {
          color: '#ffffff', weight: 1.2,
          fillColor: 'rgb(' + rgb + ')',
          fillOpacity: 0.55, lineJoin: 'round',
        };
      },
      interactive: false,
    }).addTo(map);
  }

  const layers = new Map();
  LEGEND.forEach(c => layers.set(c.number, L.layerGroup().addTo(map)));

  function esc(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  SPOTS.forEach(s => {
    // Markers use the tiny thumbnails (160px @ q60, ~5-7 KB each); the
    // popup keeps the full-size image from /full/img/.
    const thumbUrl = s.image ? '../img/thumbs/' + s.image : '';
    const styleAttr = thumbUrl
      ? "background-image: url('" + thumbUrl + "'); background-color: rgb(" + s.color + ");"
      : "background-color: rgb(" + s.color + ");";
    const iconSize = isMobile ? [36, 44] : [46, 56];
    const icon = L.divIcon({
      className: 'spot-marker',
      html: '<span class="thumb" style="' + styleAttr + '"></span>',
      iconSize, iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
    });
    const m = L.marker([s.lat, s.lon], { icon });
    if (!isMobile) {
      m.bindTooltip(esc(s.title), { className: 'spot-tip', direction: 'top', offset: [0, -22], opacity: 1 });
    }
    m.bindPopup(`
        <div class="spot-popup">
          ${s.image ? '<img src="../img/' + s.image + '" alt="" />' : ''}
          <div class="body">
            <p class="kicker">${esc(s.kicker || '')}</p>
            <h3>${esc(s.title)}</h3>
            <p class="meta">${esc(s.chapter_id.charAt(0).toUpperCase() + s.chapter_id.slice(1))} Switzerland</p>
            <a class="read" href="${s.href}">Read</a>
          </div>
        </div>
    `, { maxWidth: 240, minWidth: 240 });
    const grp = layers.get(s.chapter);
    if (grp) grp.addLayer(m);
  });

  const visEl = document.getElementById('visible');
  function updateCount() {
    let n = 0;
    layers.forEach(g => { if (map.hasLayer(g)) n += g.getLayers().length; });
    visEl.textContent = n;
  }
  updateCount();

  // Legend behavior: clicking a chapter isolates it (deselects all others).
  // Clicking the same chapter again -- when it is the only one active --
  // toggles back to all-selected. On mobile, the whole legend is collapsed
  // until the user taps the Filter toggle.
  const legend = document.getElementById('legend');
  const legendToggle = document.getElementById('legendToggle');
  if (legendToggle) {
    legendToggle.addEventListener('click', () => {
      const isOpen = legend.classList.toggle('is-open');
      legendToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }
  const items = [];
  function applyState() {
    items.forEach(({ num, el, grp }) => {
      const on = activeChapters.has(num);
      if (on && !map.hasLayer(grp)) grp.addTo(map);
      if (!on && map.hasLayer(grp)) map.removeLayer(grp);
      el.classList.toggle('is-off', !on);
    });
    updateCount();
  }
  const allChapters = new Set(LEGEND.map(c => c.number));
  let activeChapters = new Set(allChapters);  // start with all on

  LEGEND.forEach(c => {
    const item = document.createElement('button');
    item.className = 'legend-item';
    item.innerHTML = '<span class="swatch" style="background: rgb(' + c.color + ');"></span>'
      + '<span>' + esc(c.name) + '</span>';
    const grp = layers.get(c.number);
    items.push({ num: c.number, el: item, grp });
    item.addEventListener('click', () => {
      const isSolo = activeChapters.size === 1 && activeChapters.has(c.number);
      if (isSolo) {
        activeChapters = new Set(allChapters);   // restore all
      } else {
        activeChapters = new Set([c.number]);    // isolate this chapter
      }
      applyState();
    });
    legend.appendChild(item);
  });
</script>
</body>
</html>
'''
    (map_dir / 'index.html').write_text(page)
    print(f'Map page generated with {len(items)} mapped spots')

# ───────────────────────── go ─────────────────────────
print('Generating home...')
render_home()
print('Generating intro...')
render_intro_page()
for ch in CHAPTERS:
    n = len(chapter_spots[ch['id']])
    print(f'Generating {ch["id"]} ({n} cards)...')
    render_chapter_page(ch)
print()
print('Generating map page...')
render_map_page()
