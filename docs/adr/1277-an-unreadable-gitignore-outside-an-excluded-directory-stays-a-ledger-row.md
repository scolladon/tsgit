---
subjects:
  - src/application/primitives/internal/read-capped-file.ts
---
# 1277 — An unreadable .gitignore outside an excluded directory stays a ledger row

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (DC-5, Matrix E row X5, Out of scope) · **Supersedes/Refines:** applies ADR-1170

## Context

Row X5, pinned against git 2.56.1 under both `core.ignorecase` values: `ab/.gitignore` is at
mode 000 and no rule excludes `ab`. git prints
`warning: unable to access 'ab/.gitignore': Permission denied`, reads no rule from the file
and carries on. tsgit throws `PERMISSION_DENIED` from every consumer of the ignore rules.

ADR-1271 removes the throw when the directory is excluded, because the file is then never
opened. Here the file has to be read, and the refusal comes from the bounded reader, which
this change does not edit.

## Options considered

1. **Record the row in `docs/known-divergences.md` under "Corrupt, forged or unreadable
   input"** (recommended).
2. File a backlog entry, which is the one entry this run may file.
3. Fold it here: read no rule from the file and report a structured warning.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-1170: the repro needs `chmod 000`, which
is the ledger class for unreadable input, below the filing bar. Option 1.

The impact triage of this change writes the row with its proof.

Refused: option 2 schedules a row the bar keeps out of the backlog. Option 3 needs a warning
surface the ignore path does not have, which is a new public shape.

## Consequences

### Positive

- The divergence is recorded with its proof, and the backlog does not grow.

### Negative

- A repository holding an unreadable `.gitignore` in a directory no rule excludes still makes
  tsgit throw where git warns.
