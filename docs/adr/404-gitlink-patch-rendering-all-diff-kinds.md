# 404 — gitlink patch rendering spans all diff kinds (add / delete / modify / type-change)

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/gitlink-type-change-patch.md · **Refines:** ADR-226 (git-faithfulness) · **Relates:** ADR-403 (synthesis mechanism), ADR-402 (type-change patch render)
- **Decision class:** user-ratified

## Context

The brief named gitlink **type-change** patch rendering only. But `materialiseOne`
calls `readBlob` on every arm, so the commit-oid throw (ADR-403) is hit not just by a
file/symlink↔gitlink type-change, but equally by: a gitlink↔gitlink **modify** (a
submodule pointer bump, `160000 a → 160000 b`, rendered by git as a single
`index a..b 160000` block), a pure gitlink **add** (a submodule first appears,
`new file mode 160000` + `+Subproject commit <oid>`), and a pure gitlink **delete** (a
submodule removed). A submodule add is the most common submodule diff of all; a pointer
bump the next. The synthesis fix of ADR-403 is per-side and therefore identical across
all four kinds. Limiting scope to type-change would ship a primitive that still crashes
on the most common submodule diffs.

## Options considered

1. **All gitlink diff kinds in scope** (user's choice) — synthesize for any gitlink-mode
   side across add / delete / modify / type-change; one uniform per-side primitive fix.
   pros: no `materialiseOne` arm throws on any gitlink entry; covers the common
   add/bump cases; git's bytes for add/delete are already the single blocks of the
   pinned type-change two-block form. cons: scope beyond the literal brief.
2. **Type-change + modify only** — fix the four type-change directions and the
   gitlink↔gitlink modify; leave add/delete throwing as a follow-up. cons: ships a
   primitive that crashes on introducing a submodule (the most common case).
3. **Type-change only** (literal brief) — leave modify and add/delete throwing. cons:
   smallest diff but most incomplete; the consumer with submodules hits the gap first.

## Decision

Gitlink patch rendering covers **all four diff kinds** — add, delete, modify, and
type-change. `materialiseOne` synthesizes `Subproject commit <oid>\n` for any
gitlink-mode side regardless of change kind; the domain serializer renders the result
through its existing per-kind block path (two-block delete+add for a type-change, a
single block for add / delete / modify). Each kind is pinned against live git and
guarded by a unit test.

## Consequences

- The synthesis is change-kind-agnostic: a per-side gitlink check on each arm of
  `materialiseOne`, not a per-kind special case — the simplest and most uniform shape.
- No `materialiseOne` arm throws on a gitlink entry; tsgit renders every submodule diff
  a real repo produces (introduce, bump, remove, type-change) faithfully.
- The interop and unit suites gain add and delete arms alongside type-change and modify;
  the structural `T`/`M`/`A`/`D` pins from ADR-399 remain unchanged regression guards.
- **Design deviation:** the design doc scoped type-change (+modify); this widening to
  add/delete triggers a design revision against ADRs 403–404 before planning.
- Out of scope unchanged: verbose `--submodule=log` rendering, abbrev knobs, submodule
  porcelain (ADR-402 / design §Out of scope).
