# 610 — A reverse-index refusal carries a closed `check` discriminant

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-8) · **Refines:** ADR-599, ADR-575

## Context

A `.rev` refusal needs an error code. Reusing the pack-index code is an active hazard:
`isSkippableIdxFault` allow-lists it at the scan layer, so a `.rev` refusal would be
laundered into "skip this pack" and could remove an otherwise healthy pack from the
generation. Separately, git's load-family refusals split into distinct causes with distinct
messages — notably `is too small` below `12 + 2·digestLength` versus `is corrupt` at or
above it, pinned one byte apart (design Pin H rows R7d/R7c).

## Options considered

1. **A dedicated code with a closed `check` union** (designer's recommendation) —
   `'size' | 'signature' | 'version' | 'hash-id'`; makes the finding mapping exhaustive at
   the type level / `check` becomes a public compatibility commitment.
2. **A dedicated code with `reason` only** — smaller surface / puts a distinction that is
   git *data* into a bare string.
3. **Reuse the pack-index code** — no new surface / the laundering hazard above.

## Decision

Option 1. A dedicated `.rev` error code carrying a closed `check` discriminant, ADR-599's
shape. The size arm's two outcomes are distinguished by reason within `check: 'size'`,
because git's two messages are distinct and the boundary between them is pinned data.

Per ADR-575, the read-path degradation arm (ADR-604) allow-lists this code **positively** —
an explicit list of codes that degrade, with everything else rethrown — never an
`if (isFatal) throw`, which would silently swallow a future member.

A test asserts that neither scan-layer skip predicate returns `true` for this code at **any**
`check` value; the hazard is closed by assertion, not by inspection.

## Consequences

`check`'s members are public surface in `reports/api.json` and adding one later is a
surface change. Refusals at parse time are distinct from verification verdicts: an
out-of-range stored body value is **not** a parse refusal but a `fsck` body mismatch
(ADR-608), because git compares it like any other value.
