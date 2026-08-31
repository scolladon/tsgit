---
subjects:
  - src/domain/objects/tree-entry-bytes.ts
  - src/domain/objects/tree.ts
  - src/domain/fsck/validate-tree.ts
  - src/application/primitives/internal/flatten-raw.ts
  - src/application/primitives/internal/resolve-tree-path.ts
---
# 750 — Entry-name byte faults are one classifier the consumers map

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D3) · **Supersedes/Refines:** none

## Context

The four sites need the same byte-level question answered but want different answers
back: three parse paths throw, `fsck` collects findings, and `fsck` further needs to
tell a `.` fault from a `..` fault from an embedded-separator fault so it can pick a
message id and a severity. A shared boolean cannot express that distinction, and a
shared thrower cannot serve `fsck` at all.

## Options considered

1. **A classifier returning a fault kind or `undefined`; each consumer maps it to a throw or a finding** (designer's recommendation) — pros: byte semantics in one place, refusal *policy* stays with each consumer / cons: one more domain module.
2. **Two exports — a thrower for the parse sites, a boolean for fsck** — cons: the boolean loses the fault kind, so fsck keeps its own copy and there are two implementations again.
3. **No shared module; fix each site in place** — cons: exactly what the codebase already did, and the reason this item exists.

## Decision

**Adopted as recommended (no user judgment) — aligns with ADR-748's single-implementation
rule.** A new domain module classifies a name's byte span into a fault kind or reports
none. Each consumer owns the policy: the parse paths translate a fault into their
existing error, `fsck` translates it into a message id and severity. The classifier
knows bytes and nothing about errors, findings or severities.

## Re-derivation after ADR-752 and ADR-753

This decision was taken before the duplicate and name-shape refusals were ruled. Both
were then dropped from the parse layer, which removed most of this classifier's
consumers: after ADR-752 and ADR-753, the name-shape fault set and the byte key each
have exactly **one** consumer left — `fsck` — and only the octal-digit scan has three.
A shared module whose main export serves a single caller does not earn its keep.

The module therefore ships smaller than this decision first described: it exports the
octal-digit scan (genuinely shared by the parse sites and the cursor) and the byte key
(shared by fsck's duplicate and sort passes). Deciding what a fault *means* moves into
`fsck`, which is now its only consumer. The principle this decision records is
unchanged — byte semantics live in one place, refusal policy lives with each consumer —
but the honest partition after the later rulings puts less in the shared module and more
in `fsck`.

## Consequences

The classifier is deliberately a helper the consumers call, not a check inside
`TreeCursor` — putting it in the cursor's own unconditional scan was tried before and
regressed the raw merge-join against real git. That boundary is unchanged.
