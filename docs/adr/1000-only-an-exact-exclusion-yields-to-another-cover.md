---
subjects:
  - src/application/commands/add.ts
  - src/domain/pathspec
---
# 1000 — Only an exact exclusion yields to another cover of an unmerged path

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** refines ADR-998

## Context

ADR-998 says a positive pathspec covering an unmerged path stages it "whatever the exclusions say".
Pinned on git 2.55 (design §D1.5), git's leak is narrower: `add . ':!f.txt'` stages an unmerged
`f.txt`, but `add . ':!*.txt'` and `add . ':!f*'` keep its three stages, and `add f ':!f'` stages nothing.

## Options considered

1. Follow the pinned rule: an unmerged path is selected when the pathspec matches it, or when it
   holds two or more entries and the pathspec matches it after dropping the literal elements whose
   body is exactly that path (recommended).
2. ADR-998 as worded: any covering positive stages the path; 8 pinned rows diverge from git.
3. Fix only the directory/file rows, contradicting ADR-998.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, aligned with ADR-226: it is git's observed
behaviour, which ADR-998 set out to match; option 2 would resolve conflicts git leaves in place.
ADR-998's intent stands; its wording is bounded by this rule.

## Consequences

- Glob and leading-directory exclusions shield an unmerged path, as in git.
