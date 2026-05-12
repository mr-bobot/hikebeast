#!/usr/bin/env bash
# Mechanical one-shot patch that wires dark mode into every webapp page.
# Replaces the lone <meta name="theme-color" content="#ffffff" /> tag with:
#   - paired media-aware theme-color metas (light/dark) for iOS status bar
#   - <meta name="color-scheme" content="light dark"> for native form controls
#   - inline blocking bootstrap script that reads localStorage['hb-theme']
#     and sets <html data-theme="..."> before preview.css loads
#
# Safe to re-run: idempotent because the new replacement string no longer
# contains the old "content=\"#ffffff\" />" exact suffix.
#
# Usage:  bash scripts/dark-mode-head-patch.sh
set -euo pipefail

cd "$(dirname "$0")/.."

FILES=$(find full -name 'index.html' -type f)
COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

echo "Patching $COUNT files…"

perl -i -pe '
  s{<meta name="theme-color" content="#ffffff" />}{<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />\n<meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)" />\n<meta name="color-scheme" content="light dark" />\n<script>(function(){try{var t=localStorage.getItem("hb-theme")||"auto";document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>}
' $FILES

echo "Done."
