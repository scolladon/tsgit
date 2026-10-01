---
subjects:
  - src/application/primitives/internal/write-working-tree-file.ts
---
# 932 — The refused streamed write creates the empty file on refusal

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-20) · **Supersedes/Refines:** refines ADR-931

## Context

git creates the output file before opening the blob stream; tsgit's writers locate the blob
first. ADR-931 requires git's empty file after a refused streamed write.

## Options considered

1. **Create first** — git's literal order; one extra `write` + `chmod` on every streamed file of every checkout.
2. **Create on refusal: locate first; on a locate refusal create the empty file (with the mode) and rethrow** (recommended).
3. **Lazy source + a new `writeStream` port contract** — changes three adapters for one caller.

## Decision

**Adopted-as-recommended (no user judgment) — option 2.** Options 1 and 2 leave the same end
state and report the same first error in every single-fault case; they differ only in when the
empty file appears, which no observer can see after the command returns. The double fault
"path not creatable + locate refused" reports the create error, with the refusal as `cause`.

## Consequences

- No cost on the success path of any checkout.
