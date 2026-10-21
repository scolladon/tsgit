---
subjects:
  - src/application/commands/internal/gc-pipeline.ts
  - src/application/commands/maintenance.ts
---
# 1030 — gc emits no rendered `corrupt loose object` line

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (D4) · **Supersedes/Refines:** applies ADR-249

## Context

git prints two lines for the refusal: `error: corrupt loose object '<oid>'` from the reader and
`fatal: loose object <oid> (stored in <path>) is corrupt` from the caller that dies. Both depend
only on the object id and the objects directory. tsgit's `maintenance` already returns the
refusal as structured data in `tasksFailed`.

## Options considered

1. **Emit nothing; the interop test rebuilds both lines from `data.id`** (recommended) — pros:
   ADR-249's rule; no logger traffic for a reader fault / cons: none found.
2. **gc logs the `error:` line through `ctx.logger.error({ id })`** — cons: gc-only logging of a
   fault the reader raises; a rendered string from the library.
3. **The buffered reader logs it at every refusal site** — cons: changes log output for every
   ADR-907 consumer, outside the brief.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** gc neither logs nor returns a rendered
line. The refusal travels as `tasksFailed[{ task: 'gc', code: 'LOOSE_OBJECT_CORRUPT', data: { id } }]`
(ADR-1029); a consumer renders git's lines from `id` and the objects directory.

## Consequences

The interop rows reconstruct `error: corrupt loose object '<id>'` and `fatal: loose object <id>
(stored in .git/objects/<id[0..2]>/<id[2..]>) is corrupt` from the structured data and compare
them to git's stderr byte for byte.
