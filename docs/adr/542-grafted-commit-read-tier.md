# 542 — Shallow masking is a grafted commit-read tier, not a walk filter

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** refines 226 (faithfulness), 275/261 (shared walk core)

## Context

`.git/shallow` marks graft-boundary commits whose recorded parents are absent from the
repository. Canonical git applies the shallow set at commit-*parse* time
(`parse_commit_buffer`), so every parent list git reports — traversal, `%P`,
`--max-parents`, diff-against-parent, blame boundary flags, replay base trees — is
already masked; only raw-object surfaces (`cat-file`) see the true `parent` header.
tsgit's walk primitives accept a dead `shallow` option no caller passes, and every other
parent-reading site expands true parents and throws `OBJECT_NOT_FOUND`.

## Options considered

1. **Walk primitives only** — mask inside `walkCommits`/`commitDateWalk`. Pros: smallest
   diff / cons: leaves pins A13, A23/A24, A27, A35/A36 divergent (`revParse('HEAD~2')`
   returns a phantom oid, `blame`/`show`/replay still broken).
2. **Grafted commit-read tier** (designer's recommendation) — apply the graft in
   `readCommit`, the commit-graph reader gate, `history-rewrite.readCommitData`, and the
   direct `readObject` parent sites; `readObject`/`catFile` stay raw. Pros: git's own
   layering, fixes every pinned surface / cons: ~7 mechanical call-site redirects.
3. **Graft inside `readObject`** — pros: one choke point / cons: breaks pins A8/A9
   (`cat-file` must report true parents) and the graft-is-traversal-only invariant.

## Decision

Adopted-as-recommended (no user judgment): **option 2**. Masking lives in a grafted
commit-read tier — a pure `domain/commit/graft.ts` applied by `readCommit`,
`readCommitData`, and the direct parent-reading sites. `readObject` and `catFile` always
return raw object content.

## Consequences

Every traversal and every reported `parents` array is masked with no per-command logic;
`catFile` remains the negative control proving object content is untouched. Commits us
to routing any future parent-reading site through the grafted tier. The shape
deliberately accommodates `info/grafts` / `git replace` later (same parse-time model),
though neither is implemented here.
