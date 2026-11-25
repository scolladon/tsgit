---
subjects:
  - src/domain/pathspec/compile-glob.ts
  - src/application/primitives/is-ignored.ts
---
# 1257 — A verdict-only faithfulness fix ships without a breaking mark

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-G, §8) · **Supersedes/Refines:** refines DOCTRINE(D-3)

## Context

The change alters verdicts on existing repositories: sets and escapes in `.gitignore`,
`.gitattributes` and sparse rules, case folding of ignore and attribute patterns under
`core.ignorecase`, dropped negative attribute lines, and the value of
`IsIgnoredMatchSource.pattern`. No signature or type changes and no method starts throwing, so
D-3's trigger is not met. The pathspec dialect change shipped as a plain `fix(pathspec)`.

## Options considered

1. **`fix(ignore): …`** (recommended).
2. `fix(ignore)!: …`.

## Decision

**User-ratified — option 1.** A faithfulness fix that changes only what a command returns or
matches is a plain fix. The breaking mark stays for a returning public method that starts
throwing and for a signature or type change.

## Consequences

### Positive

- The changelog's breaking section lists only changes a consumer must adapt code to.

### Negative

- A consumer relying on the old verdicts learns of the change from the fix entry alone.
