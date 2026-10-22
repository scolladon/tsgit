---
subjects:
  - src/domain/working-tree-path.ts
  - src/application/commands/internal/resolve-pathspec.ts
---
<!-- cspell:ignore wildmatch -->
# 1044 — A pathspec body may hold a backslash on POSIX hosts, for matching only

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1034 and ADR-1006; none superseded

## Context

`validateWorkingTreePath` (`rejectInputShape` in `src/domain/working-tree-path.ts`) refuses any
input holding `\` with `PATHSPEC_OUTSIDE_REPO`, on every host, and `resolvePathspec` validates
every pathspec body through it before compiling. A `\`-holding pathspec therefore never reaches
the matcher, although git's wildmatch reads `\x` as a literal `x`: against git 2.55, `a\*b`
stages a file named `a*b` (D6), `a\?b` stages `a?b` (D17) and `a\b` stages `ab` (E2). The
refusal is a path-traversal defence: under Windows path syntax `\` is a directory separator
(ADR-1006 keys every index-write refusal on `PathPolicy.windowsPathSyntax`, `src/ports/context.ts`),
and the same validator guards `mv`, `blame` and every materialised working-tree path. The
working-tree walk's own validator, `validateWalkedEntryPath`, also refuses a `\`-named entry on
every host, so the rows that need a file *named* with a backslash (D8b `a\`, E1 `a\b` as a file)
are a different, pre-existing gap. The design phase missed the refusal; the planner found it by
calling `resolvePathspec`.

## Options considered

1. **Keep the refusal this run** (planner's recommendation) — the matcher treats `\` as
   glob-special (ADR-1034) and is unit-tested with it; D6, D8b, D17, E1 and E2 stay divergent at
   command level and are filed as a follow-up. Pros: no security-surface change in a fix PR.
   Cons: git accepts what tsgit refuses, and with the wrong error class.
2. **Accept `\` in pathspec bodies on non-Windows hosts, for matching only** — one extra part:
   the intake admits a `\`-holding body when the path policy is not Windows syntax; the body is a
   wildcard that is never used as a filesystem path. Pros: D6, D17, E2 match git on POSIX. Cons:
   the validator grows a second entry point and the review's security dimension must sign it off.
3. **Accept `\` everywhere** — on Windows `\` is a separator, so `..\` shapes need their own
   traversal handling; out of this scope.

## Decision

**User-ratified — option 2.** When the context's `PathPolicy.windowsPathSyntax` is not set,
`resolvePathspec` accepts a pathspec body that holds `\`. Such a body is a wildcard (ADR-1034) and
is used for matching only: it is never `lstat`ed as a literal, never the subject of the on-disk
escape (ADR-1036), and the symlinked-leading-path scan covers only its no-wildcard prefix — the
bytes before the first glob-special byte, git's no-wildcard prefix length. `validateWorkingTreePath` keeps
refusing `\` for every other caller and for pathspecs under Windows path syntax;
`validateWalkedEntryPath` is unchanged. The relaxed intake is the only place a `\` is admitted,
and the review phase's security dimension reviews it explicitly.

## Consequences

- D6, D17 and E2 become command-level interop rows gated to POSIX hosts; the Windows CI leg pins
  the refusal. D8b and E1 (a `\`-named working-tree entry) stay pinned follow-ups under the walk
  validator's rule.
- `PATHSPEC_OUTSIDE_REPO` is no longer raised for a valid git pathspec on POSIX.
- The plan gains one part after the `rm` part; the design doc's Part a and its rows D6/D8b/D17/E1/E2
  are revised against this record.
