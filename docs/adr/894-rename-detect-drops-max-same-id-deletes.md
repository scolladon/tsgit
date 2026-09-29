---
subjects:
  - src/domain/diff/rename-detect.ts
---
# 894 — `RenameDetectOptions.maxSameIdDeletes` is removed; the exact-pass cap is git's fixed 100

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§4.2, D2) · **Supersedes/Refines:** none

## Context

`maxSameIdDeletes` pruned any id group larger than N (default 100) out of exact pairing — a
DoS bound. Under ADR-893 that meaning contradicts git, which pairs such groups (rows
#15–#17). git hard-codes the bound instead: `find_identical_files` examines at most 100
candidates per destination, and the result depends on it (row #16: a basename match sitting
102nd is never seen). No caller in `src/` sets the option; the next release is already a major.

## Options considered

1. **Keep the name, redefine it as the per-add examined-candidate cap** — *recommended by the
   design*; a silent semantic change for callers who set it.
2. **Keep the prune semantics** — keeps a known divergence.
3. **Remove the option; the cap becomes an internal constant** — breaking.

## Decision

**Option 3 — ratified by the user** ("the next release is already a major"). The option leaves
the public `RenameDetectOptions` type. The pass keeps a private constant of 100 examined
candidates per add, equal to git's, because the cap is observable (row #16) and bounds the scan.

## Consequences

- Breaking change for any caller passing `maxSameIdDeletes` — named in the changelog.
- The bound is no longer tunable; it can only differ from git by editing the constant.
