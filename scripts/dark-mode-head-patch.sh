#!/usr/bin/env bash
# Idempotent one-shot that wires the opt-in-only dark mode into every
# webapp page. Replaces the prior auto-detect setup (paired media-aware
# theme-color metas + color-scheme meta + auto-defaulting bootstrap)
# with a simpler single-meta + dark-only bootstrap.
#
# The bootstrap script runs synchronously in <head> before preview.css
# loads. Default = light (script no-ops unless localStorage has dark).
#
# Safe to re-run on the post-Commit-7 state; the regex matches the
# 4-line auto-detect block exactly and won't double-patch.
#
# Usage:  bash scripts/dark-mode-head-patch.sh
set -euo pipefail

cd "$(dirname "$0")/.."

FILES=$(find full -name 'index.html' -type f)
COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

echo "Patching $COUNT files…"

# Match the 4-line auto-detect head block (paired theme-color metas +
# color-scheme meta + auto-defaulting bootstrap) and replace with the
# opt-in version (single theme-color + dark-only bootstrap). JS uses
# single quotes so the inner attribute selector keeps clean double
# quotes without HTML-attribute escape headaches.
perl -i -0pe '
  s{<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" />\n<meta name="theme-color" content="#0b0d10" media="\(prefers-color-scheme: dark\)" />\n<meta name="color-scheme" content="light dark" />\n<script>\(function\(\)\{try\{var t=localStorage\.getItem\("hb-theme"\)\|\|"auto";document\.documentElement\.setAttribute\("data-theme",t\);\}catch\(e\)\{\}\}\)\(\);</script>}{<meta name="theme-color" content="#ffffff" />\n<script>(function(){try{if(localStorage.getItem(\x27hb-theme\x27)===\x27dark\x27){document.documentElement.setAttribute(\x27data-theme\x27,\x27dark\x27);var m=document.querySelector(\x27meta[name="theme-color"]\x27);if(m)m.setAttribute(\x27content\x27,\x27#0b0d10\x27);}}catch(e){}})();</script>}g
' $FILES

echo "Done."
