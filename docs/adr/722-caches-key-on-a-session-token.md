---
subjects:
  - src/ports/context.ts
  - src/application/primitives/read-object.ts
  - src/application/primitives/config-read.ts
  - src/application/primitives/config-scoped-read.ts
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal/loose-oid-cache.ts
  - src/application/primitives/internal/shallow-set.ts
  - src/application/primitives/internal/read-commit-graph.ts
  - src/application/commands/fsck.ts
---
# 722 — Caches key on a session token

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-10) · **Supersedes/Refines:** none

## Context

Nine `WeakMap` caches key on `Context` object identity, and every spread-derivation
silently drops all of them — the documented "write via a spread Context, read via the
original → intermittent OBJECT_NOT_FOUND" bug family. Two in-tree workarounds
(`adoptPackRegistry`; the reftable stack keying on `ctx.deltaCache`) prove the axis is
wrong. The `deltaCache` anchor is already overloaded: fsck swaps it to isolate the object
cache and accidentally gets a fresh reftable cache too.

## Options considered

1. **Frozen `ctx.session` token + `deriveContext(ctx, changes)` helper; caches key on the token; fsck keeps the session and isolates only `deltaCache`** (recommended, chosen).
2. **Same token, fsck takes a fresh session** — cons: the audit re-parses packed-refs/config it could share; redundancy, not safety.
3. **Formalise the `deltaCache` anchor** — cons: works by accident; the anchor already carries a second meaning.

## Decision

**User-ratified.** Contexts carry a frozen `session` token created at construction; all
nine identity-keyed caches re-key onto it. `deriveContext(ctx, changes)` is the only
derivation path and documents which dimensions force a fresh token: gitDir/commonDir, the
fs root set, and the hash algorithm. Same-repository derivations (fsck's cache swap,
clone's and bundle-verify's hash adoption) keep the token and therefore keep their
caches. fsck's isolation narrows, deliberately, to `deltaCache` alone — it now shares
ref/config/graph caches with the opening Context; this is a stated behaviour change to a
verification command, chosen because re-reading the same `packed-refs` is redundant work,
not safer work. `adoptPackRegistry` becomes unnecessary and is removed.

## Consequences

Cache identity is explicit and reviewable; the spread-derivation bug family is closed
structurally. Symmetry is proved in both directions per derivation site (write-derived /
read-original and the reverse). `listWorktrees` stops paying N+1 ref stores per listing.
