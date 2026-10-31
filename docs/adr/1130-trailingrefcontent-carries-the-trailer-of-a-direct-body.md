---
subjects:
  - src/application/commands/internal/fsck/types.ts
  - src/application/primitives/ref-store.ts
---
# 1130 — `trailingRefContent` carries the trailer of a direct body

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D10) · **Supersedes/Refines:** refines ADR-1121

## Context

git 2.56.0 prints `trailingRefContent: has trailing garbage: '<text>'` for a direct body such as
`<sha> garbage`, and `has trailing whitespaces or newlines` for whitespace-only trailers. The ref
resolves, so a caller cannot recover the trailer by resolving.

## Options considered

1. **`trailing?: string` on the `bad-ref` arm, present on the direct-body variant only** (designer's
   recommendation) — pros: mirrors ADR-1121's `referent?` / cons: one more optional field.
2. **No field** — cons: hides data, against ADR-249.
3. **`trailing?` plus `form`** — cons: a field whose value is already implied.

## Decision

**Ratified by the user: option 1.** A `trailingRefContent` finding on a direct body carries
`trailing` = the bytes after the oid as git prints them; its absence marks the whitespace variant.

## Consequences

- The interop rebuilds both git texts from the finding alone.
