---
subjects:
  - .size-limit.json
---
# 1043 — The browser-bundle cap is raised by the measured delta after the dead-mode offset

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** none

## Context

The browser bundle measures 342 kB against a 342.1 kB cap in `.size-limit.json`, and
`compile-glob.ts` is in it. ADR-1033 adds the verbatim rule, the glob-special test, two fast paths,
a bytes export and the refusal helpers; ADR-1041 removes `compileGlob`'s non-gitignore mode. The
designer estimates a net +150 to +300 B gzip after the offset; nothing can be measured before the
code exists. Precedent: #293 and #309 raised a cap by the measured delta inside the PR that
spent it. `resolve-pathspec.ts` still caps patterns at four `**` tokens for a RegExp reason that
ADR-077 removed; git has no such cap.

## Options considered

1. **Offset first, then raise by the measured delta** (designer's recommendation) — remove the dead
   mode, measure on `rm -rf dist .wireit` + a clean build, raise the cap by the measured gzip delta
   in this PR if still red. Keeps the `**` budget.
2. **Option 1 plus dropping the `**` budget** — faithful (git accepts what tsgit refuses with
   `INVALID_OPTION`) but a behaviour change outside the brief's scope.
3. **Hold the PR at the cap** — stop and escalate on any positive delta.

## Decision

**User-ratified — option 1.** The `**`-count and 256-byte budgets stay. If `check:size` is red
after the offset, the browser cap is raised by exactly the measured delta, recorded in the PR.

## Consequences

- A measurement step after the implementation commits, before review.
- Dropping the `**` budget is a separate, faithful follow-up when a user asks for it.
