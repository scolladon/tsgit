---
subjects:
  - src/repository.ts
  - src/ports/context.ts
  - src/index.node.ts
  - src/adapters/node/node-file-system.ts
  - src/application/primitives/object-store.ts
---
# 915 — Alternates are read through a reader confined to each alternate's objects dir

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-2) · **Supersedes/Refines:** refines ADR-625 (object store exempt on reads), ADR-721

## Context

An alternate usually lives outside the repository (`clone --shared`, `--reference`, CI caches).
The Node adapter refuses lexical escapes from its layout roots on every read and write. git reads
an alternate wherever it points (ADR-625 §7.2). Something must grant read access outside the roots
without widening the write guard.

## Options considered

1. **One confined reader per alternate** from a generalised runtime hook (`makeWorktreeFs` → `makeConfinedFs(roots)`), plus an unconfined metadata-only probe (`lstat`/`readlink`) for the realpath walk (recommended) — pros: content reads confined to exactly each alternate's objects dir; main write guard untouched / cons: a new runtime hook.
2. **One unconfined read-only reader for all alternates** — pros: simpler / cons: no per-source confinement.
3. **Add alternate dirs to the main adapter's root set** — cons: also widens the write guard outside the repository.

## Decision

**User-ratified — option 1.** Each alternate's objects dir gets its own reader whose root set is
that directory alone. The realpath walk uses a metadata-only probe that can open no file content.
The main adapter's root set and write guard are unchanged. Because ADR-922 adopts git's freshen,
each alternate's capability also carries a **set-mtime** operation confined to the same objects dir
— the only write ever issued outside the primary, and it changes no byte of content.

## Consequences

- New read surface outside the repository: exactly the object-shaped files of the design's
  §D9 list, transitively through nested alternates (≤ git's depth). The security review signs off on it.
- A user-supplied `opts.fs` must supply the hook to reach out-of-root alternates; otherwise ADR-916 applies.
