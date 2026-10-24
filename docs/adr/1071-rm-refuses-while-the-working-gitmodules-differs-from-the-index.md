---
subjects:
  - src/domain/submodule/error.ts
  - src/application/commands/rm.ts
---
# 1071 — `rm` refuses while the working `.gitmodules` differs from the index

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-1066

## Context

Removing a submodule edits `.gitmodules` (ADR-1066), so git 2.55 first checks that the working
`.gitmodules` matches the index (`is_staging_gitmodules_ok`). When it differs by content, `rm sub`,
`rm --cached sub` and `rm -f sub` all die before touching anything:
`fatal: please stage your changes to .gitmodules or stash them to proceed`, exit 128 (design
rows CO31–CO33, each run three times). A staged edit, a rewrite with the same bytes and a
deleted working `.gitmodules` all proceed (CO34–CO36). The design had not pinned this; the
planner raised it as a choice, and the orchestrator pinned it before implementation. tsgit has no
error for the condition.

## Options considered

1. **A new code-only member `GITMODULES_NOT_STAGED`** — the planner's recommendation once git's
   refusal was confirmed. Pros: names git's condition; the message carries no path, so the member
   carries no field (precedent `NOTHING_TO_COMMIT`). Cons: one union member, the exhaustiveness
   switches, the barrel-surface test, the documented error table.
2. **Reuse `RM_LOCAL_MODIFICATIONS { paths: ['.gitmodules'] }`** — a different refusal (exit 1,
   `-f` overrides it) for a condition `-f` does not override.
3. **Stop at implementation and ask** — the pin is in; nothing is left to ask.

## Decision

**Adopted as recommended (no user judgment) — option 1.** Before `rm` removes a gitlink entry
or drops it from the index, and under `--cached` and `--force` alike, a stage-0 `.gitmodules` entry whose
working file exists and compares `modified` refuses with `GITMODULES_NOT_STAGED`. An absent
working file, a stat-only drift and a mode-only change proceed, as git's content comparison does.
The member lands under `fix:` with the rest of the change, by the user's ruling in ADR-1064.

## Consequences

- The member joins ADR-1069's in the same part, so the public surface changes once.
- The `.gitmodules` section removal of ADR-1066 therefore always starts from a file that matches
  the index.
