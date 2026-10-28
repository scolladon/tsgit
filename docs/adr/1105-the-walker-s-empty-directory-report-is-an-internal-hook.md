---
subjects:
  - src/application/primitives/walk-working-tree.ts
---
# 1105 — The walker's empty-directory report is an internal hook

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC8, P10) · **Supersedes/Refines:** refines ADR-1102

## Context

ADR-1102 needs the untracked walk to report the empty, non-ignored directories a `stash push -u` removes. The
public `walkWorkingTree` yields entries only; an empty directory is never an entry. The stash is the only caller
that wants the report; `status` and `add` must not see it.

## Options considered

1. **Public: a new `WalkWorkingTreeOptions` field** (e.g. an `onEmptyDirectory` callback) — pros: follows the
   `isNestedRepository` option precedent / cons: publishes an option no consumer asked for; additive `api.json`.
2. **Internal: the same hook on a non-barrelled entry point that the public `walkWorkingTree` wraps with the hook
   unset** (designer's recommendation) — pros: the public surface is unchanged; no per-entry cost for `status`;
   promotable later without a break / cons: one more internal export of the walker module.
3. **A second, stash-local walk listing empty directories** — pros: no walker change / cons: duplicates the ignore,
   `.git`, embedded-repository and depth rules and pays a second full-tree `readdir`.

## Decision

**Adopted as recommended (no user judgment): option 2.** The walker reports an entered directory whose `readdir`
is empty through an internal hook on a non-barrelled entry point; the public `walkWorkingTree` wraps it with the
hook unset. The report is not counted against `maxEntries`. The stash's untracked listing is the first caller.

## Consequences

- No public surface change; `reports/api.json` is unchanged by this part.
- A later consumer need can promote the hook to a public option without a break.
