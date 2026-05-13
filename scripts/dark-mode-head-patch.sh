#!/usr/bin/env bash
# Idempotent one-shot that wires the opt-in-only dark mode into every
# webapp page. Handles two starting states:
#
#   (A) The prior auto-detect setup (paired media-aware theme-color
#       metas + color-scheme meta + auto-defaulting bootstrap). Strips
#       all four lines, leaves the single theme-color + new bootstrap.
#
#   (B) The pristine state from build-spot-pages.mjs (just the bare
#       <meta name="theme-color" content="#ffffff" />, no script).
#       Adds the bootstrap right after it.
#
# Both passes are no-ops on pages already in the post-patch state.
# Re-run after any spot-pages rebuild that drops the bootstrap.
#
# Usage:  bash scripts/dark-mode-head-patch.sh
set -euo pipefail

cd "$(dirname "$0")/.."

FILES=$(find full -name 'index.html' -type f)
COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

echo "Patching $COUNT files…"

# Pass A: collapse the prior 4-line auto-detect block to the
# single-meta + opt-in bootstrap. JS uses single quotes so the inner
# attribute selector keeps clean double quotes without HTML escape
# headaches.
perl -i -0pe '
  s{<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" />\n<meta name="theme-color" content="#0b0d10" media="\(prefers-color-scheme: dark\)" />\n<meta name="color-scheme" content="light dark" />\n<script>\(function\(\)\{try\{var t=localStorage\.getItem\("hb-theme"\)\|\|"auto";document\.documentElement\.setAttribute\("data-theme",t\);\}catch\(e\)\{\}\}\)\(\);</script>}{<meta name="theme-color" content="#ffffff" />\n<script>(function(){try{if(localStorage.getItem(\x27hb-theme\x27)===\x27dark\x27){document.documentElement.setAttribute(\x27data-theme\x27,\x27dark\x27);var m=document.querySelector(\x27meta[name="theme-color"]\x27);if(m)m.setAttribute(\x27content\x27,\x27#0b0d10\x27);}}catch(e){}})();</script>}g
' $FILES

# Pass B: pristine pages (theme-color meta but no bootstrap script on
# the next line). Insert the bootstrap. The negative lookahead skips
# pages already patched. -0pe = slurp whole file so the next-line
# check works.
perl -i -0pe '
  s{<meta name="theme-color" content="#ffffff" />\n(?!<script>\(function\(\)\{try\{if\(localStorage)}{<meta name="theme-color" content="#ffffff" />\n<script>(function(){try{if(localStorage.getItem(\x27hb-theme\x27)===\x27dark\x27){document.documentElement.setAttribute(\x27data-theme\x27,\x27dark\x27);var m=document.querySelector(\x27meta[name="theme-color"]\x27);if(m)m.setAttribute(\x27content\x27,\x27#0b0d10\x27);}}catch(e){}})();</script>\n}g
' $FILES

echo "Done."
