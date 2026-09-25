---
subjects:
  - src/domain/diff/rename-detect.ts
  - src/application/primitives/detect-similarity-renames.ts
---
# 900 — Copy-aware exact pairing and rename/copy labelling live in a pure domain module

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§2.5, §4.5, D2) · **Supersedes/Refines:** refines ADR-893

## Context

Under `-C`, git's `find_identical_files` keeps used sources eligible and labels the
result by counting uses per source: every use but the last becomes a copy. The domain exact
pass has no copy notion; the primitive owns the copy machinery.

## Options considered

1. **New pure domain module (`rename-pairing`), `detectRenames` becomes its `-M` wrapper;
   the primitive keeps I/O and matrix scoring** — *recommended by the design.*
2. Primitive-only, re-implementing `find_identical_files` for copies.
3. Public `detectRenames(diff, { copies })`.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** One byte-free transcription of
`find_identical_files` and of git's use-count labelling (ADR-366's domain purity), no
duplicate, no public surface change.

## Consequences

- `-C` / `-C -C` fan-out matches git (`C Foo→Bar ; R Foo→Baz`).
