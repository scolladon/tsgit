---
subjects:
  - src/application/commands/internal/submodule-state.ts
---
# 1068 — An invalid submodule ignore value refuses with the config enum error

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** none

## Context

`submodule.<name>.ignore` and `diff.ignoreSubmodules` take `none`, `untracked`, `dirty` or
`all`. git 2.55 dies on any other value: `fatal: bad --ignore-submodules argument: bogus`, exit
128, from `status` and `diff-files` alike (design row p5). tsgit has an error for a configuration
value outside its enum, `CONFIG_INVALID_ENUM_VALUE { key, source, value, line }`.

## Options considered

1. **Reuse `CONFIG_INVALID_ENUM_VALUE`** — the designer's recommendation. Pros: carries more than
   git's message (key, source, line); no new union member. Cons: none found.
2. **A new `SUBMODULE_IGNORE_INVALID { value }`** — one more union member for the same condition.
3. **Treat the value as `none`** — a refusal mismatch.

## Decision

**Adopted as recommended (no user judgment) — option 1.** The refusal names the key as written
(`submodule.<name>.ignore` or `diff.ignoreSubmodules`), the source file, the value and its line.

## Consequences

- The refusal happens where the ignore mode is resolved, before any child status runs.
- `update-index --refresh` does not read the key in git (p5) and tsgit's refresh paths do not
  either.
