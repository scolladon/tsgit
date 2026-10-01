---
subjects:
  - src/application/commands/fsck.ts
  - src/application/commands/internal/fsck
supersedes:
  - adr: "412"
    scope: "the out-of-scope bullet excluding alternate object stores from fsck"
---
# 919 — fsck audits every object source

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-6, DC-7) · **Supersedes/Refines:** supersedes ADR-412 (alternates out-of-scope bullet only)

## Context

ADR-412 excluded alternate object stores from fsck because tsgit had none. Live git 2.55.0 evidence
(design Pins F2–F4c, M4): a borrower's `git fsck` reports a donor's unreachable objects as
`dangling` (also under `--connectivity-only`), a corrupt donor loose object (exit 1), a corrupt
unreachable donor pack (exit 4), a reachable corrupt donor object (exit 128) and a corrupt donor
midx (exit 128). `builtin/fsck.c` runs `fsck_source` over every source.

## Options considered

1. **Full parity over every source** — universe, content validation, dangling/unreachable, pack/rev/midx/bitmap passes (recommended).
2. **Alternates count for connectivity only** — cons: diverges on F2–F4c.
3. **Primary only** — cons: diverges everywhere.

## Decision

**Adopted-as-recommended (no user judgment) — option 1, decided by live evidence.** Amended in a
new ADR rather than in place, following the ADR-721 → ADR-541 pattern.

Superseded from ADR-412: the out-of-scope bullet "alternate object stores (tsgit has no alternates)".

Carried forward from ADR-412: everything else — the full refs-verify pass, the full msg-id
catalogue, the remaining out-of-scope items (`--lost-found` write side, gitlink descent).

## Consequences

- Pack-class findings across sources carry their objects dir (ADR-920).
- `docs/design/fsck.md` scope lines are updated with the implementation.
