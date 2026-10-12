---
subjects:
  - src/application/primitives/cat-file-batch.ts
  - src/application/commands/show.ts
  - src/application/commands/archive.ts
  - src/application/primitives/build-pack.ts
---
# 930 — Every git streaming reader follows the stream order

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-18) · **Supersedes/Refines:** refines ADR-928

## Context

Beyond `cat-file blob` and checkout, git streams blob contents in `cat-file --batch` and
`show <blob>` (both die in Pin M5b), and — for blobs above `core.bigFileThreshold` only — in
`archive` and `pack-objects`.

## Options considered

1. **`catFileBatch` and `show` now; `archive`/`packObjects` recorded as a divergence** (designer recommendation).
2. **All four now** — pros: faithful on every streaming reader.
3. **Defer all four**.

## Decision

**User-ratified — option 2.** Each reader git streams through reads through the stream order
(ADR-928) under git's own condition for that reader (always for `cat-file --batch` blob contents
and `show <blob>`; above `core.bigFileThreshold` for `archive` and `pack-objects`), so the same
corrupt-alternate faults refuse the same commands.

## Consequences

- Interop pins for all four readers against a borrower with a corrupt donor midx.
