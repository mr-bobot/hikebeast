#!/usr/bin/env python3
"""Generate the /full/ webapp from spots.yaml + preface.yaml.

Reads source content from the Hiking Influencer Claude project, copies +
resizes images, and writes home + intro + 7 chapter pages under
/preview/'s style. Re-uses preview.css + preview.js verbatim.
"""
import yaml, shutil, subprocess, html
from pathlib import Path

SRC = Path('/Users/lost/Documents/Claude/Projects/Hiking Influencer/output')
DEST = Path('/Users/lost/Documents/Development/Hikebeast/full')
PREVIEW = Path('/Users/lost/Documents/Development/Hikebeast/preview')
DEST_IMG = DEST / 'img'

CHAPTER_SLUG = {
    '01': 'central',
    '02': 'valais',
    '03': 'fribourg',
    '04': 'western',
    '05': 'eastern',
    '06': 'ticino',
    '07': 'beyond',
}
SLUG_NAMES = {  # short labels for sidebar
    'intro':   'Intro',
    'central': 'Central',
    'valais':  'Valais',
    'fribourg':'Fribourg',
    'western': 'Western',
    'eastern': 'Eastern',
    'ticino':  'Ticino',
    'beyond':  'Beyond',
}
WHOP = 'https://whop.com/gorped/hidden-gems-switzerland-e8/'

# ───────────────────────── load source ─────────────────────────
data = yaml.safe_load((SRC / 'content/spots.yaml').read_text())
preface = yaml.safe_load((SRC / 'content/preface.yaml').read_text())
chapters = data['chapters']
spots_all = data['spots']

# Group spots by chapter, in canonical order from spots_grid; drop dupes.
chapter_spots = {}
for ch in chapters:
    by_title = {}
    for s in spots_all:
        if s.get('chapter') == ch['number'] and s['title'] not in by_title:
            by_title[s['title']] = s
    ordered = []
    for t in ch['spots_grid']:
        if t in by_title:
            ordered.append(by_title[t])
    chapter_spots[ch['number']] = ordered

# ───────────────────────── images ─────────────────────────
DEST_IMG.mkdir(parents=True, exist_ok=True)
img_refs = []
img_name = {}  # source rel path → dest filename
basename_seen = {}  # detect collisions

def queue(src_rel):
    src = SRC / 'assets' / src_rel
    if not src.exists():
        return None
    base = Path(src_rel).name
    if base in basename_seen and basename_seen[base] != src_rel:
        base = src_rel.replace('/', '-')
    basename_seen[base] = src_rel
    img_name[src_rel] = base
    img_refs.append((src, DEST_IMG / base))
    return base

# Chapter covers
for ch in chapters:
    queue(ch['cover_image'])
# Spot images
for ch_num, spots in chapter_spots.items():
    for s in spots:
        if 'image' in s: queue(s['image'])
# Preface images
for p in preface['preface_pages']:
    if 'image' in p: queue(p['image'])
# Top-six tile images (referenced inside top_six_grid spots field)
for p in preface['preface_pages']:
    if p['kind'] == 'top_six_grid':
        for s in p.get('spots', []):
            if 'image' in s: queue(s['image'])

print(f'Queueing {len(img_refs)} images')
copied = 0
for src, dest in img_refs:
    if not dest.exists():
        shutil.copy(src, dest)
        copied += 1
print(f'Copied {copied} new images, {len(img_refs)-copied} already present')

# Resize all (idempotent — sips is no-op when already small)
print('Resizing...')
for img in DEST_IMG.glob('*.jpg'):
    subprocess.run(
        ['sips', '-Z', '1800', '-s', 'format', 'jpeg',
         '-s', 'formatOptions', '78', str(img), '--out', str(img)],
        capture_output=True)
print(f'Done. {len(list(DEST_IMG.glob("*.jpg")))} images in {DEST_IMG}')

# ───────────────────────── shared CSS/JS ─────────────────────────
shutil.copy(PREVIEW / 'preview.css', DEST / 'preview.css')
shutil.copy(PREVIEW / 'preview.js', DEST / 'preview.js')

# ───────────────────────── HTML helpers ─────────────────────────
def esc(s):
    if s is None: return ''
    return html.escape(str(s), quote=True)

def img_src_for(src_rel, depth=2):
    """Resolve to e.g. ../img/foo.jpg from a chapter subpage."""
    name = img_name.get(src_rel)
    if not name: return ''
    return ('../' * (depth-1)) + 'img/' + name

LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
HOME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/></svg>'
PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'

def render_sidebar(current_slug):
    items = []
    items.append(f'  <a class="sb-home" href="../index.html" title="Home">{HOME_SVG}</a>')
    # Intro thumb
    intro_img = img_src_for('cover_pages/hidden_gems_cover.jpg', 2)
    cur = ' is-current' if current_slug == 'intro' else ''
    items.append(f'  <a class="sb-thumb{cur}" href="../intro/index.html" title="Front matter">'
                 f'<img src="{intro_img}" alt="" /><span class="lbl">Intro</span></a>')
    # 7 chapters
    for ch in chapters:
        slug = CHAPTER_SLUG[ch['number']]
        cur = ' is-current' if current_slug == slug else ''
        thumb = img_src_for(ch['cover_image'], 2)
        items.append(f'  <a class="sb-thumb{cur}" href="../{slug}/index.html" title="{esc(ch["region"])}">'
                     f'<img src="{thumb}" alt="" /><span class="lbl">{esc(SLUG_NAMES[slug])}</span></a>')
    return '<aside class="sidebar" aria-label="Chapters">\n' + '\n'.join(items) + '\n</aside>'

def render_topbar(label, total):
    return f'''<div class="topbar">
  <a class="brand" href="../index.html">
    <img src="../../images/avatar.jpg" alt="" />
    <span>Hidden Gems · {esc(label)}</span>
  </a>
  <span class="crumb"><b id="crumbCur">1</b> / <span id="crumbTotal">{total}</span></span>
  <div class="topbar-right">
    <a class="pill" href="../index.html">All chapters</a>
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
def render_chapter_cover(ch, depth=2):
    img = img_src_for(ch['cover_image'], depth)
    return f'''<section class="slide slide-cover" id="cover">
  <img class="cv-img" src="{img}" alt="" />
  <div class="cv-content">
    <p class="cv-kicker">Chapter {esc(ch["number"])} · Region</p>
    <h1>{esc(ch["region"])}</h1>
    <p class="cv-deck">{esc(ch["intro"])}</p>
  </div>
</section>'''

def render_spot(s, depth=2):
    img = img_src_for(s['image'], depth) if 'image' in s else ''
    body_html = '\n          '.join(f'<p>{esc(p)}</p>' for p in s.get('body', []))
    specs_html = '\n          '.join(
        f'<div class="spec"><span class="lbl">{esc(spec["label"])}</span><span class="val">{esc(spec["value"])}</span></div>'
        for spec in s.get('specs', []))
    maps_url = s.get('maps_url', '')
    credit = s.get('photo_credit', '')
    foot_left = (
        f'<a class="locked" href="{esc(maps_url)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:500;">'
        f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        f'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>'
        f'Open in Maps</a>'
    ) if maps_url else ''
    foot_right = f'<span class="credit">Photo · {esc(credit)}</span>' if credit else ''
    slug = ''.join(c if c.isalnum() else '-' for c in s['title'].lower()).strip('-')
    while '--' in slug: slug = slug.replace('--', '-')
    return f'''<section class="slide slide-spot" id="{slug}">
  <div class="sp-photo"><img src="{img}" alt="{esc(s["title"])}" /></div>
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
      {foot_right}
    </div>
  </div>
</section>'''

def render_preface_page(p, depth=2):
    """Dispatches by `kind`."""
    kind = p['kind']
    if kind == 'cover':
        img = img_src_for(p['image'], depth) if 'image' in p else ''
        return f'''<section class="slide slide-cover" id="cover">
  <img class="cv-img" src="{img}" alt="" />
  <div class="cv-content">
    <p class="cv-kicker">A Switzerland Field Guide</p>
    <h1>{esc(p["title"])}</h1>
    <p class="cv-deck">{esc(p.get("subtitle", ""))}</p>
    <div class="cv-author"><img src="../../images/avatar.jpg" alt="" /><span>By Leon Helg · Hikebeast</span></div>
  </div>
</section>'''
    if kind == 'ethos':
        img = img_src_for(p['image'], depth) if 'image' in p else ''
        body_html = '\n          '.join(f'<p>{esc(b)}</p>' for b in p.get('body', []))
        photo_block = f'<div class="pf-photo"><img src="{img}" alt="" /></div>' if img else ''
        no_photo = '' if img else ' no-photo'
        return f'''<section class="slide slide-preface{no_photo}">
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
    if kind == 'four_col':
        cells = '\n        '.join(
            f'<div class="plan-cell"><span class="num">{esc(c["number"])}</span>'
            f'<div><h3>{esc(c["heading"])}</h3><p>{esc(c["text"])}</p></div></div>'
            for c in p.get('columns', []))
        return f'''<section class="slide slide-preface no-photo">
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
    if kind == 'top_six_grid':
        is_hidden = 'hidden' in p['title'].lower()
        cls = 'grid-six blurred' if is_hidden else 'grid-six'
        tiles = '\n          '.join(
            f'<div class="gem"><img src="{img_src_for(s["image"], depth)}" alt="" />'
            f'<div class="gem-name">{esc("█" * len(s["name"]) if is_hidden else s["name"])}</div></div>'
            for s in p.get('spots', []))
        overlay = ''
        if is_hidden:
            overlay = f'''<div class="blurred-overlay">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <p>The full guide reveals all six.</p>
            <a href="{WHOP}" target="_blank" rel="noopener">Unlock</a>
          </div>'''
        return f'''<section class="slide slide-preface no-photo">
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
    if kind == 'map_summary':
        items = []
        for r in p.get('regions', []):
            color_arr = r.get('color', [0.5, 0.5, 0.5])
            r_rgb = ','.join(str(int(c * 255)) for c in color_arr)
            items.append(
                f'<div class="ms-item">'
                f'<span class="ms-bar" style="background:rgb({r_rgb});"></span>'
                f'<div class="ms-text"><b>{esc(r["number"])} · {esc(r["name"])}</b>'
                f'<span>{esc(r.get("description",""))}</span></div></div>')
        items_html = '\n          '.join(items)
        return f'''<section class="slide slide-preface no-photo">
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
    return f'<!-- unsupported kind: {kind} -->'

# ───────────────────────── page renderers ─────────────────────────
def render_chapter_page(ch):
    slug = CHAPTER_SLUG[ch['number']]
    spots = chapter_spots[ch['number']]
    slides = [render_chapter_cover(ch, 2)]
    for s in spots:
        slides.append(render_spot(s, 2))
    slide_count = len(slides)
    label = ch['region']
    page = page_head(label)
    page += render_topbar(label, slide_count)
    page += '\n\n<div class="app">\n\n  '
    page += render_sidebar(slug)
    page += '\n\n  <div class="viewer" id="viewer">\n\n    '
    page += '\n\n    '.join(slides)
    page += '\n\n  </div>\n</div>\n\n<script src="../preview.js"></script>\n</body>\n</html>\n'
    out = DEST / slug / 'index.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)

def render_intro_page():
    pages = preface['preface_pages']
    slides = [render_preface_page(p, 2) for p in pages]
    slide_count = len(slides)
    label = 'Front matter'
    page = page_head(label)
    page += render_topbar(label, slide_count)
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
    # Front matter card
    cards.append(f'''<a class="cc" href="intro/index.html">
        <div class="cc-photo">
          <span class="cc-num">Front matter</span>
          <img src="img/{img_name.get("preface_pages/page_05.jpg", "page_05.jpg")}" alt="Front matter" />
        </div>
        <div class="cc-body">
          <div class="cc-name">Before you go</div>
          <div class="cc-meta">Cover · Camping · Map · Top 6</div>
        </div>
      </a>''')
    for ch in chapters:
        slug = CHAPTER_SLUG[ch['number']]
        spots = chapter_spots[ch['number']]
        thumb = 'img/' + img_name.get(ch['cover_image'], '')
        cards.append(f'''<a class="cc" href="{slug}/index.html">
        <div class="cc-photo">
          <span class="cc-num">Chapter {esc(ch["number"])}</span>
          <img src="{thumb}" alt="{esc(ch["region"])}" />
        </div>
        <div class="cc-body">
          <div class="cc-name">{esc(ch["region"])}</div>
          <div class="cc-meta">{len(spots)} spots</div>
        </div>
      </a>''')
    cards_html = '\n\n      '.join(cards)
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
  <div class="topbar-right"></div>
</div>

<main class="home-main">

  <header class="home-hero">
    <p class="kicker">Swiss Hidden Gems</p>
    <h1>Read it page by page.</h1>
    <p class="lead">{sum(len(chapter_spots[c["number"]]) for c in chapters)} spots across {len(chapters)} regions. Pick a chapter.</p>
  </header>

  <section>
    <div class="section-head">
      <h2>Chapters</h2>
      <span class="meta">{len(chapters) + 1} sections · all open</span>
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

# ───────────────────────── go ─────────────────────────
print('Generating home...')
render_home()
print('Generating intro...')
render_intro_page()
for ch in chapters:
    slug = CHAPTER_SLUG[ch['number']]
    n = len(chapter_spots[ch['number']])
    print(f'Generating {slug} ({n} spots)...')
    render_chapter_page(ch)

print()
print(f'Done. /full/ has:')
print(f'  index.html')
print(f'  intro/index.html ({len(preface["preface_pages"])} cards)')
for ch in chapters:
    slug = CHAPTER_SLUG[ch['number']]
    n = len(chapter_spots[ch['number']])
    print(f'  {slug}/index.html ({n + 1} cards including chapter cover)')
