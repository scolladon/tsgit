---
subjects:
  - src/application/commands/branch.ts
---
# 860 — `branch.create` verifies its start point is a commit

- **Status:** accepted
- **Date:** 2026-09-12
- **Design:** docs/spike/config-validation-tier.md · **Supersedes/Refines:** refines ADR-226

## Context

Surfaced incidentally while tracing which verbs reach the object store: `git branch x <tree-oid>`
refuses, because git resolves the start point through the object store and requires it to be a
commit. tsgit's `branch.create` resolves the start point as a ref and never types the target, so
it creates a branch pointing at a tree — a ref that no subsequent operation can use.

This is a refusal-surface gap, not a performance item, and it is outside the backlog entry this
change set implements. It is recorded here rather than filed silently because the prime directive
binds refusal conditions, and because the verb is already being edited.

## Options considered

1. **Fix it in this change** (chosen) — pros: the refusal matches git, and the verb then reaches
   the object store for the same reason git does, which makes its repo-settings validation
   structural instead of transcribed. Cons: widens a performance change with a correctness fix.
2. **File it as its own backlog entry** — pros: keeps this change set's scope honest, and invites
   a proper pass over what else in the branch and tag family skips type verification. Cons: leaves
   a known-wrong refusal shipping.
3. **Record it in the design and decide later** — cons: the weakest form of both.

## Decision

**Option 1.** `branch.create` resolves its start point through the object store and refuses when
it does not peel to a commit, matching git's refusal. The refusal is pinned against real git by an
interop test rather than asserted.

## Consequences

The verb gains an object-store read it did not have, which is why ADR-859 drops its transcribed
repo-settings call: it now reaches that boundary naturally.

A branch pointing at a tree can no longer be created through this surface. Any existing test that
constructed one as a fixture shortcut has to create it another way; that set is expected to be
small and is enumerated mechanically by running the unit suite.

**Explicitly not in scope, and not fixed here:** the rest of the branch and tag family was not
audited for the same gap. Lightweight `tag.create` resolves a ref and writes it without typing the
target, which git does type — that is the same shape and is left standing, recorded so the next
pass over this family has a starting point rather than a rediscovery.
