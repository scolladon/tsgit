# 624 — The rev-index serializer lives beside its parser

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-1) · **Refines:** ADR-140, ADR-603

## Context

Writing `pack-<sha>.rev` needs a domain serializer. Three homes were considered: append
to `src/domain/storage/rev-index.ts` (the parser's file), a new `rev-index-writer.ts`,
or `pack-writer.ts` beside the idx serializer.

## Decision

The serializer joins the parser in `src/domain/storage/rev-index.ts`. ADR-140 allows one
`@writes` block per file and one format per block — `rev-index.ts` is exactly one format
and stays small, and co-locating parse + serialize makes the round-trip property a
single-module subject (`midx.ts` is the precedent). `pack-writer.ts` is blocked outright:
it already declares the `packfile` surface with a different faithfulness kind.

## Consequences

`serializePackRevIndex` becomes a public export of `src/domain/storage/index.ts`, so the
pre-push gate requires a regenerated `reports/api.json` in the same change. The
round-trip property test extends the existing `rev-index.properties.test.ts` rather than
opening a new file.
