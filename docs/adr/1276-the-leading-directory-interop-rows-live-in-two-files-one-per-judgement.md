---
subjects:
  - test/integration/is-ignored-leading-directory-interop.test.ts
  - test/integration/ignored-leading-directory-occupant-interop.test.ts
---
# 1276 — The leading-directory interop rows live in two files, one per judgement

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (DC-4, Test strategy) · **Supersedes/Refines:** serves ADR-1271 and ADR-1274

## Context

The pinned rows compare two things with git: the per-path primitive against
`git check-ignore -v --no-index` (Matrices A and E), and the overwrite pre-flights against the
commands themselves (Matrices B, C, D and F). Existing interop files already call `isIgnored`
and `checkout`, but each proves another surface: the glob dialect, and the displacement of an
occupant.

## Options considered

1. **Two new files: `is-ignored-leading-directory-interop.test.ts` for the `check-ignore`
   rows, and `ignored-leading-directory-occupant-interop.test.ts` with one `describe.each`
   per command** (recommended).
2. Append the rows to `glob-double-star-interop.test.ts` and
   `checkout-occupant-displacement-interop.test.ts`.
3. One file for every row.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off: the options differ in where the
rows sit, not in what they prove. Option 1.

Every row runs under both `core.ignorecase` values, set explicitly. The row that needs a file
at mode 000 goes under `test/integration/posix-only/`.

Refused: option 2 puts rows under a `@proves` surface they do not test. Option 3 mixes two
surfaces in one file.

## Consequences

### Positive

- Each file names one judgement in its `@proves` block.

### Negative

- Two more interop files spawn `git`.
