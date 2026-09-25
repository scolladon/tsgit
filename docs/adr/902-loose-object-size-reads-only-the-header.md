---
subjects:
  - src/application/primitives/read-object.ts
---
# 902 — A loose object's size is read from its header alone

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§4.2, D4) · **Supersedes/Refines:** none

## Context

The size gate (ADR-901) needs object sizes without inflating content. Pack entries carry
their size in the entry header; a loose object needs its zlib stream inflated only up to the
NUL after `<type> <size>`.

## Options considered

1. **Header-only route inside `readObjectMetadata`** (prefix read, streaming inflate to the
   NUL, full-read fallback) — *recommended by the design.*
2. A private helper in the rename primitive.
3. Keep the full inflate.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** One size primitive, which also
benefits other metadata readers (e.g. tag peeling).

## Consequences

- Hostile-case memory 305 → 122 MB and time 118 → 36 ms against option 3.
