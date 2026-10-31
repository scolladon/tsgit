---
subjects:
  - src/application/primitives/ref-store.ts
  - test/integration/ref-listing-interop.test.ts
phases: [review]
kind: anti-pattern
trigger: a review fix that adds a refusal "to be safe" beside the faithful fix
evidence:
  - docs/adr/1137-the-ref-walk-skips-an-unreadable-refs-root-as-git-does.md
  - test/integration/ref-listing-interop.test.ts:552
source: { run: fsck-broken-ref-chain-unreadable, phase: review, date: 2026-10-31 }
status: active
supersedes: []
last-verified: 2026-10-31
---
# 025 — A defence-in-depth refusal is pinned against git on every shape it reaches

## Context

A cycle-1 security finding (an explicit `gitDir` with `refs/` at mode 000 let gc prune what git
keeps) got two fixes: git's searchability check on the explicit route, and "for safety" a rethrow
whenever the walk could not read a `refs` root. The second refusal was pinned only on the shape that
motivated it. Cycle-2 code and security reviewers found it broke two shapes git handles: a linked
worktree's own `refs` root (git lists through it) and `refs/` at mode 0300 (git's gc runs and
prunes). Undoing it took a user decision and an ADR.

## Lesson

A refusal is behaviour. Added beside a faithful fix, it changes every route that reaches it, not
only the one under review, and it diverges from git wherever git carries on.

## How to apply

Before committing an extra refusal, list every shape that reaches the guarded line (each opening
route, each worktree kind, each permission mode) and pin git on each in a throwaway.
Keep the refusal only where git also refuses; elsewhere, rely on the faithful fix alone.
If a route git refuses still reaches the guard, fix that route instead of the guard.

## Evidence

- `docs/adr/1137-the-ref-walk-skips-an-unreadable-refs-root-as-git-does.md` — the reversal and its
  pins.
- `test/integration/ref-listing-interop.test.ts:552` — the linked-worktree own-root rows (000, 0300)
  the extra refusal broke.
