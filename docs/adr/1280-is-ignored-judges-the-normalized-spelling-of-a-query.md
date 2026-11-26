---
subjects:
  - src/application/primitives/is-ignored.ts
---
# 1280 — isIgnored judges the normalized spelling of a query

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (What impact triage folded) · **Supersedes/Refines:** refines ADR-1279; applies DOCTRINE(D-2), DOCTRINE(D-3), DOCTRINE(D-5), DOCTRINE(D-6)

## Context

The review of ADR-1279's refusal found that a `..` segment gets past it. `isIgnored` matched
and scanned the path as typed. git does neither: `init_pathspec_item` runs every argument
through `prefix_path` (`normalize_path_copy`), dies when the result leaves the repository,
then tests the normalized path for a symbolic link, and `check-ignore` matches that normalized
path while it prints the argument as typed.

Pinned against git 2.56.1, both `core.ignorecase` values. The root `.gitignore` holds `*.log`
and `/anchored`; `link` is a symbolic link to `real/`, which holds `.gitignore`: `secret`;
`file` is a file and `sub` a directory.

| query | git | tsgit before this ruling |
|---|---|---|
| `missing/../link/secret`, `file/../link/secret` | exit 128, beyond a symbolic link | ignored, rule read through the link, `source.basedir` `missing/../link` |
| `link/../top.log` | `.gitignore:1:*.log` | refused as beyond a symbolic link (since ADR-1279) |
| `link/../secret` | not ignored | refused (since ADR-1279) |
| `sub/../anchored` | `.gitignore:2:/anchored` | ignored, `source.basedir` `sub/..` |
| `./top.log`, `sub/../top.log` | `.gitignore:1:*.log` | ignored, `source.basedir` `.` or `sub/..` |
| `../out/secret`, `sub/../../x` | exit 128, `is outside repository` | `PERMISSION_DENIED` from the adapter |
| `../x` then `link/secret` | outside repository | `PERMISSION_DENIED` |
| `link/secret` then `../x` | beyond a symbolic link | the same |
| an empty path, alone or beside any other argument | exit 128, `empty string is not a valid pathspec` | answered |
| `/top.log` (absolute, outside the work tree) | exit 128, `is outside repository` | answered as typed |
| `<work tree>/top.log` (absolute, inside it) | answered as `top.log` | answered as typed |
| `.`, `sub/..` with a root rule `/*` | not ignored | `.` ignored by `/*` |
| `.`, `sub/..` with a root rule `*/` or `**/` | not ignored | ignored when asked as a directory |
| `.`, `sub/..` with a root rule `*` | `.gitignore:1:*` | ignored by `*` |

## Options considered

1. **Parse each query as git parses the argument: refuse an empty one with `EMPTY_PATHSPEC`,
   normalize it, refuse one that climbs above the root or is absolute with
   `PATHSPEC_OUTSIDE_REPO`, scan and match the normalized path, and report the path as asked**
   (recommended).
2. Normalize for the symbolic-link scan only and keep matching the path as typed.
3. Refuse every query that is not already normalized.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the divergences are proven and
sit in the function this change edits. DOCTRINE(D-2): option 2 is a half fix, it closes
`missing/../link/secret` and leaves `link/../secret` matched as typed, which reads the rule
file behind the link. DOCTRINE(D-3): a path that climbs above the root now throws
`PATHSPEC_OUTSIDE_REPO` where an adapter refused it, or did not; the change is already marked
breaking. DOCTRINE(D-6): the changed verdicts and sources alone would not be. Option 1.

`normalizePathCopy` is git's `normalize_path_copy`: empty and `.` components drop, `..`
removes the component before it, a trailing separator stays.

An empty path refuses the whole call before any other query is looked at, as git's
`parse_pathspec` checks every argument for emptiness first.

A query that normalizes to the empty path (`.`, `sub/..`) names the work tree itself. git's
`match_pathname` needs a path beneath the rule file's directory, so a rule holding a slash
never matches it, and a directory-only rule (`*/`) needs a path git can stat as a directory,
which the empty path is not. A rule holding no slash at all is matched by basename and can
match. `matchInStackVerbose` applies that to the empty path only: a path ending at a nested rule file's directory (`a/`
against `a/.gitignore`) still matches that file's rules, as in git.

**One divergence, deliberate.** An absolute query is refused whether or not it lies inside the
work tree. git answers one that lies inside. A `FilePath` is work-tree-relative, and the
library's path rule (`validateWorkingTreePath`) refuses a leading `/` wherever it validates
one; answering needs the caller's own spelling of the work tree resolved against the real one.
Before this ruling the path was matched as typed: under a root rule `/*` it answered "not
ignored" where git ignores the path. The row is recorded in `docs/known-divergences.md`.

Refused: option 3 refuses paths git answers.

## Consequences

### Positive

- One judgement per path whatever its spelling; `source.basedir` never holds `.` or `..`.
- No spelling of a path reads a `.gitignore` through a symbolic link.

### Negative

- A query that climbs above the root changes its error from the adapter's `PERMISSION_DENIED`
  to `PATHSPEC_OUTSIDE_REPO`.
- An empty query and an absolute query, which were answered, now throw.
- An absolute query inside the work tree is refused where git answers it.
