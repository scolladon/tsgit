---
subjects:
  - src/application/primitives/materialize-tree.ts
  - src/application/commands/reset.ts
  - src/application/commands/checkout.ts
  - src/application/commands/stash.ts
  - src/application/primitives/internal/reset-worktree.ts
---
# 1087 — `forceRewriteAll` keeps its name and rewrites only stale entries

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC1, F3) · **Supersedes/Refines:** refines ADR-023, ADR-226

## Context

ADR-023 assumed git's `reset --hard` rewrites every path. The design-time matrix (Appendix A) shows otherwise.
git's `oneway_merge` skips an entry whose work-tree stat is up to date (`ie_match_stat`). It rewrites only a stale
entry. tsgit's `upgradeNoopsToUpdates` rewrites every `noop`. The public `MaterializeTreeOpts.forceRewriteAll` names
the old behaviour.

## Options considered

1. **Keep `forceRewriteAll`, redefine it to git's stale-only rule.** Non-breaking. TSDoc states the new rule.
2. **Rename it to `rewriteStale`.** `api.json` changes, which needs a major release.
3. **Add `rewriteStale` beside `forceRewriteAll`.** Keeps an unfaithful rewrite-all mode that no caller uses.

## Decision

**Ratified by the user: option 1.** The release order keeps majors for the 7.0.0 cut. For every shape the flag
already got right, the work-tree content does not change. Only clean entries are no longer rewritten, which also
matches git.

## Consequences

- The option name says "all". Its TSDoc says "every entry whose work-tree stat is not up to date", and that rule binds.
- `MaterializeTreeResult.written` counts rewrites only.
- `api.json` is unchanged. The change ships as a `fix`.
