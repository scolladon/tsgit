---
subjects:
  - src/application/primitives/apply-changeset.ts
---
# 975 — A skipped lossy write is silent

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-973

## Context

Under ADR-973 a lossy entry is never written. macOS git exits non-zero on the same commands (reset --hard 128, checkout -- 255) yet `switch` exits 0; Linux git exits 0 and writes the raw name (design §D13).

## Options considered

1. **Succeed**; status reports the entries deleted (recommended).
2. **Succeed and return a structured list** of absent paths on every command result.
3. **Throw** after writing the rest, as macOS git does.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** The state is already exposed as data by status.

## Consequences

- No new public result field; one can be added later.
- No half-applied refusal tied to one platform's filesystem.
