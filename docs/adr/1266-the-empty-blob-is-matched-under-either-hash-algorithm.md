---
subjects:
  - src/domain/objects/object-id.ts
  - src/application/primitives/internal/is-entry-stat-clean.ts
---
# 1266 — The empty blob is matched under either hash algorithm

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (DC-B) · **Supersedes/Refines:** serves ADR-1263

## Context

The branch of ADR-1263 asks whether an entry's object id is the empty blob. git compares it with
the empty blob of the repository's hash algorithm. The compare is synchronous and holds no
`HashConfig`.

## Options considered

1. **`isEmptyBlobOid(id)`: the id equals the SHA-1 or the SHA-256 empty-blob constant**
   (recommended).
2. Carry the repository's `HashConfig` into the compare and use `emptyBlobOid(config)`.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off: an id has its algorithm's length,
so it can equal one constant only, and the two options answer the same on every repository.
Option 1.

Refused: option 2 adds a second policy to every holder of ADR-1265 for the same answer.

## Consequences

### Positive

- The test is pure and synchronous.

### Negative

- A third hash algorithm adds a constant here.
