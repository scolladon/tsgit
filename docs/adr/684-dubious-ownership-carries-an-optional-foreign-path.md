# 684 — `DUBIOUS_OWNERSHIP` carries an optional `foreignPath`

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate DN-2) · **Refines:** ADR-674, ADR-676

## Context

Two ratified decisions combine into a diagnostic gap. ADR-676 checks the **set**
`{gitDir, commonDir, repository path}`, while ADR-674 names the single repository path git names.
So a refusal will routinely name a directory the caller **owns** — repository path owned, `gitDir`
alien — telling them nothing about which path actually failed.

## Options considered

1. **Keep `{ path }`** — pros: exactly git's payload / cons: the caller cannot act on it.
2. **Add an optional `foreignPath` alongside `path`** — pros: additive; interop reconstruction
   still reads `path` alone, so faithfulness is untouched / cons: one more field.
3. **Repoint `path` at the failing directory** — pros: most informative / cons: breaks the
   measured refusal text, which names the repository path.

## Decision

**Option 2 — adopted as recommended (no user judgment).**

`DUBIOUS_OWNERSHIP { path, foreignPath? }`. `path` stays the repository path git names, so the
interop test reconstructs git's exact bytes from `path` alone. `foreignPath` names which member
of ADR-676's checked set actually failed, when it differs from `path`.

## Consequences

- Interop-neutral: reconstruction never reads `foreignPath`, so no measured row changes.
- It closes a gap created by the combination of two ratified decisions rather than by either one,
  which is why it did not surface until the revision.
- When several checked paths are foreign, `foreignPath` names the first in the deduplicated
  check order; the docs row states that so it is not mistaken for a set.
