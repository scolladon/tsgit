# 690 — `git refs migrate` is not a tsgit surface

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-7) · **Refines:** ADR-680

## Context

git ships `git refs migrate` to convert a repository between the files and reftable backends.
With ADR-680 implementing reftable completely, the question is whether tsgit exposes an
equivalent.

## Options considered

1. **No** (design recommendation) — tsgit reads and writes both backends but does not convert
   between them.
2. **Read-side only** — recognise a half-migrated repository and refuse or report it.
3. **Implement migration** — pros: full parity / cons: a destructive whole-repository rewrite,
   which is a category tsgit does not otherwise offer.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

No migration command. tsgit operates whichever backend a repository already declares.

## Consequences

- tsgit offers no destructive whole-repository rewrite, consistent with having no `gc`, `prune`
  or `repack` — the same reason `preciousObjects` is honoured by construction (ADR-685).
- Callers needing to convert use `git refs migrate`; the docs page says so rather than leaving
  the absence unexplained.
- A repository mid-migration is a corrupt-stack case and falls to ADR-688's tiering, so option 2
  is already covered without a dedicated surface.
