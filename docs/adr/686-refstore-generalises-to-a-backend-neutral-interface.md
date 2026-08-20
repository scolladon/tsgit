# 686 — `RefStore` generalises to a backend-neutral interface

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-2) · **Refines:** ADR-680

## Context

`RefStore` (`src/application/primitives/ref-store.ts`) is the natural seam for a second ref
backend, but four of its six methods leak the files model: `writeLoose`, `removeLoose`,
`isLoose`, `readLooseRaw`, plus `getPackedRefs`. A reftable backend has no "loose" anything.

## Options considered

1. **A narrowed backend-neutral interface**, with the files-specific methods pushed behind it
   (design recommendation) — pros: one seam, hexagonal, every caller speaks in refs not files /
   cons: every current caller of a files-specific method must be re-expressed.
2. **Two interfaces with a discriminated union** — pros: no caller rewriting / cons: pushes the
   backend discriminant to every call site, which is the coupling the seam exists to remove.
3. **A port in `src/ports/`** — pros: matches the adapter boundary / cons: ref storage is an
   application concern over the FS port, not a platform capability; it would invert the
   dependency rule.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`RefStore` narrows to backend-neutral verbs (resolve, write, delete, enumerate, reflog access);
the files backend keeps its loose/packed specifics as private implementation. `getRefStore(ctx)`
and its per-`Context` `WeakMap` cache are unchanged in shape.

## Consequences

- Callers to re-express: `enumerate-refs.ts`, `resolve-ref.ts`, `update-ref.ts`,
  `record-ref-update.ts`, `reflog-store.ts`, `reflog-identity.ts`, `resolve-notes-ref.ts`,
  `resolve-oid-prefix.ts`, `stash-ref.ts`, `path-layout.ts`, `fetch.ts`, and
  `fsck/refs-verify.ts`. Each must be checked for a files assumption, not just recompiled.
- `fsck`'s ref verification needs a backend-neutral notion of ref integrity; under ADR-688 the
  reftable backend supplies its own.
- The narrowed interface is what makes ADR-680's write side expressible without a second
  parallel call graph.
