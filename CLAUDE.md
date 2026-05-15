@/Users/lost/Documents/Brain/00 Projects/Hikebeast/README.md
@/Users/lost/Documents/Brain/00 Projects/Hikebeast/04-site/dev-workflow.md

This repo is part of the Hikebeast brand. Before any non-trivial task, read the brain README and the dev-workflow runbook imported above, and pull whatever's relevant.

Keep the brain current: when facts change (new routes, products, integrations), update the relevant overview note. When the user mentions a new task, append it to `00 TODO.md`.

Capture drive-by ideas: any suggestion you make that the user does not act on, append it to `IDEAS.md` before the session ends. Otherwise it gets lost.

Log substantive tasks: after a feature ships, a decision is made, or a real debugging round ends, append a 2 to 4 line entry to `99-archive/session-log.md` (date · topic · key outputs · what's still open). Append-only, never edit past entries.

## Workflow rules (enforced by `.claude/workflow-guard.sh`)

The site has real testers in production now. These rules are **enforced as a hook** on every Bash command, not just guidance. The guard lives at `.claude/workflow-guard.sh` and runs as a `PreToolUse` hook configured in `.claude/settings.json`.

1. **Never push directly to `main`.** Always `git checkout -b <feature>` first, push the feature branch, verify on the auto-deployed Vercel preview URL, then ask the user to merge. The guard hard-blocks any `git push` whose destination ref is `main`.
2. **`migrate-spots-to-convex.mjs` must be run with an explicit `--env` flag.** No flag = production. Always run `--env staging` first, verify on the preview, only then run `--env local` (which writes to prod). The guard hard-blocks the no-flag invocation.
3. **Convex schema changes go to staging first, prod second.** Use `CONVEX_DEPLOYMENT=dev:unique-goose-988 convex dev --once` to push to staging, verify on the preview, then `CONVEX_DEPLOYMENT=dev:whimsical-sparrow-336 convex dev --once` for prod. (Not hook-enforced today — be deliberate.)
4. **Never add a new lambda under `/api/`.** Vercel Hobby plan caps deployments at 12 Serverless Functions and we're at exactly 12. Extend an existing endpoint with a request-shape discriminator instead. (Not hook-enforced — be aware.)
5. **The two Convex deployments are different projects.** Production is `whimsical-sparrow-336` (real testers). Staging is `unique-goose-988` (sandbox testers). The Convex CLI silently ignores `--url`; use `--deployment <name>` (no `dev:` prefix) on `convex run`, or `CONVEX_DEPLOYMENT=dev:<name>` env var on `convex dev`.
6. **Tracking-pipeline parity is enforced by the build.** When you change a field that a landing page sends to an `/api/` endpoint, you MUST (a) destructure it server-side in the matching `api/<path>.js`, (b) forward it to whatever downstream consumer needs it (Sheet payload, Stripe metadata, ManyChat tag, etc.), and (c) verify the column / receiver field exists. `scripts/lint-tracking-pipeline.mjs` runs as step 0 of `build-all.mjs` and fails the Vercel build if a page sends a field the receiving API never references. Added 2026-05-15 after the utm_source/medium/campaign silent-drop bug — three fields were passed end-to-end by all eight landing-page variants but neither `api/visit.js` nor `api/checkout/webhook.js` extracted them, so UTM attribution silently broke for months.

If a rule blocks you and the user has explicitly approved a one-time exception (e.g. a hot-patch to main during an outage), disable the guard temporarily:

```bash
mv .claude/workflow-guard.sh .claude/workflow-guard.sh.off
# do the action
mv .claude/workflow-guard.sh.off .claude/workflow-guard.sh
```

Re-enable immediately after — the guard is the safety net, not a curiosity.
