#!/bin/bash
#
# .claude/workflow-guard.sh — PreToolUse hook for Bash commands.
#
# Hard-blocks the two operations most likely to break production while we're
# in early access. Wired up via .claude/settings.json. Runs in every Claude
# Code session that opens the repo, regardless of which worktree.
#
# Reads a JSON envelope from stdin (Claude Code hook protocol):
#   { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
#
# Exit codes:
#   0  — allow the tool call (default; quiet)
#   2  — BLOCK with the message we print to stderr
#
# To bypass deliberately: tell Claude "I'm sure, skip the guard"; Claude can
# inline-disable the hook for one call by piping through `bash -c` with a
# different program name, OR you can edit .claude/settings.local.json to
# turn it off temporarily.

set -e
input=$(cat)

# Pluck the .tool_input.command field with python (no jq dependency).
command=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("command", ""))
except Exception:
    pass
')

# Empty command (e.g. heredoc shenanigans) → don't second-guess, allow.
[ -z "$command" ] && exit 0

# ── Rule 1 · No direct push to main ─────────────────────────────────────────
# Match any `git push` whose destination ref ends in `main`. Catches:
#   git push origin main
#   git push origin HEAD:main
#   git push origin feature/x:main
#   git push -f origin main
#   git push --force origin main
# Doesn't match `git push origin not-main-yet` because of the word boundary
# and the optional `:` source separator.
if printf '%s' "$command" | grep -qE 'git[[:space:]]+push.*[[:space:]:]main([[:space:]]|$)' ; then
  cat >&2 <<'EOF'
✋ workflow-guard: direct push to `main` is blocked.

Hikebeast's flow now requires every change to ride through staging first
(brain note: 04-site/dev-workflow.md). Even small text edits — they cost
nothing on a feature branch and prove the deploy is healthy.

The right path:

  git checkout -b <feature-name>
  ... edit, commit ...
  git push origin <feature-name>
  # → Vercel auto-deploys a preview that talks to staging Convex
  # → log in at the preview URL with tester1 / tester-2026-pw, verify

Only after that, ask the user to confirm a merge to main:

  git checkout main && git pull
  git merge <feature-name> && git push origin main

If the user has explicitly asked for a hot-patch to main and accepts the
risk, they can disable this guard temporarily:

  mv .claude/workflow-guard.sh .claude/workflow-guard.sh.off
  # ... do the push ...
  mv .claude/workflow-guard.sh.off .claude/workflow-guard.sh
EOF
  exit 2
fi

# ── Rule 2 · migrate-spots-to-convex.mjs requires an explicit --env ─────────
# Default behavior of the script is to read .env.local, which targets PROD
# Convex. Forcing --env makes intent explicit and keeps me from blowing
# away production data with a stale yaml.
if printf '%s' "$command" | grep -qE 'migrate-spots-to-convex\.mjs' ; then
  if ! printf '%s' "$command" | grep -qE '\-\-env[[:space:]]+[a-zA-Z]' ; then
    cat >&2 <<'EOF'
✋ workflow-guard: migrate-spots-to-convex.mjs needs an explicit --env flag.

Without --env, the script reads .env.local which is PRODUCTION Convex
(`whimsical-sparrow-336`). To prevent accidental writes, the flag is
mandatory:

  --env staging   # writes to staging Convex (unique-goose-988)
  --env local     # writes to prod   Convex (whimsical-sparrow-336)

Standard flow: --env staging first, verify on the preview deploy,
THEN --env local (for prod) only after the change is proven on staging.

Brain reference: [[04-site/dev-workflow]] · "Adding a new spot"
EOF
    exit 2
  fi
fi

# Allow everything else.
exit 0
