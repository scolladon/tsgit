# 533 — Discovery hard-stops on an unusable `.git` file

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-226 (git-faithfulness)

## Context

The discovery walk must decide what to do when it meets a `.git` **file** it cannot use
(malformed content, no path, dangling target). Canonical git's measured behaviour (design
§1g) is asymmetric: an unusable `.git` *file* is fatal even with a valid repository one
level up, while an invalid `.git` *directory* is skipped and the walk continues. Today's
tsgit skips the file — which is exactly the bug that silently opens the superproject from
a submodule working directory.

## Options considered

1. **Hard stop with a structured error, never walk up** (recommended) — pros: byte-pinned to git; kills the silent-wrong-repo failure / cons: none.
2. **Skip and continue the walk** — pros: status quo / cons: the measured divergence; silently opens an enclosing repo.
3. **Hard stop only on a dangling target, skip on a format error** — pros: none over 1 / cons: splits one git rule into two.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: a `.git` file is a commitment —
malformed format, missing path, or a dangling/non-git target each fail discovery with a
structured `TsgitError`; the walk never falls back to an enclosing repository.

## Consequences

`find-layout`'s existing "skips the file" test inverts to "resolves the pointer".
Submodule working directories now open the submodule or fail loudly — never the
superproject. Refusal conditions are co-pinned against git exit 128 in interop tests.
