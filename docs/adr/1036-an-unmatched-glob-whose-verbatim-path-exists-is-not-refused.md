---
subjects:
  - src/application/commands/add.ts
---
# 1036 — An unmatched glob whose verbatim path exists on disk is not refused

> **Superseded by [ADR-1045](1045-an-unseen-literal-naming-an-unignored-path-on-disk-is-not-refused.md)**
> for the escape's scope: an unseen literal whose path exists on disk and is not ignored is no
> longer refused either (an empty directory, pinned against git 2.55). The wildcard escape and the
> ignored-literal follow-up are carried forward.

- **Status:** superseded by ADR-1045
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1035; none superseded

## Context

git's `add` skips the `did not match` refusal for an unseen pathspec when `file_exists(path)`
holds for the pathspec's verbatim spelling. With a file literally named `nomatch*` that an ignore
rule hides, `git add 'nomatch*'` exits 0 and stages nothing (B11). For a literal the same escape
feeds the "paths are ignored by one of your .gitignore files" advice (exit 1, B3l/B3m), which is
out of this scope.

## Options considered

1. **Globs only** (designer's recommendation) — an unseen wildcard entry whose verbatim body
   `lstat`s is dropped from the refusal. Literals keep today's refusal.
2. **Globs and literals** — an ignored existing literal stops refusing, with no ignored-path report:
   one divergence traded for another until the advice exists.
3. **Not replicated** — B11 refuses where git does not.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** The escape applies to wildcard entries
only; the ignored-literal advice is a pinned follow-up.

## Consequences

- One `lstat` per unseen wildcard entry, on the refusal path only.
- B3l/B3m stay pinned in the design for the follow-up that adds the ignored-path report.
