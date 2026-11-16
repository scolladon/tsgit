---
subjects:
  - src/application/primitives/config-scoped-read.ts
  - src/application/primitives/read-sparse-config.ts
phases: [implementation, review]
kind: gotcha
trigger: a change adds a second reader of a config key an existing reader already resolves
evidence:
  - src/application/primitives/config-scoped-read.ts
  - test/unit/application/primitives/config-scoped-read.test.ts
source: { run: sparse-checkout-worktree-config, phase: implementation, date: 2026-11-14 }
status: active
supersedes: []
last-verified: 2026-11-16
---
# 039 — A new reader of a repeated config key takes the entry git takes

## Context

The sparse reader resolved `extensions.worktreeConfig` from its last entry, as git's config read
does. The existing `isWorktreeScopeActive` returned on the first entry. With
`worktreeConfig = false` followed by `worktreeConfig = true`, the new reader said "on", then the
scoped read it called re-checked with the old predicate, said "off" and threw
`CONFIG_SCOPE_NOT_AVAILABLE` on every `status` and `checkout`. git treats the extension as on.

## Lesson

Two readers of one key are one contract. When they disagree on which occurrence wins, the
disagreement only shows on a file that repeats the key, so no single-entry fixture finds it,
and the failure lands in whichever reader runs second.

## How to apply

Before adding a reader of a config key, find every existing reader of the same key.
Give each a row with the key repeated, `false` then `true` and `true` then `false`, pinned against git (last wins).
Fix a disagreeing old reader in the same change; its new caller is what makes the old bug reachable.

## Evidence

`src/application/primitives/config-scoped-read.ts` (`isWorktreeScopeActive`) takes the last
entry; the two "is overridden by a later worktreeConfig" rows in
`test/unit/application/primitives/config-scoped-read.test.ts` turn red on a first-wins predicate.
