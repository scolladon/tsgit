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

## Options considered

1. **Parse each query as git parses the argument: normalize it, refuse one that climbs above
   the root with `PATHSPEC_OUTSIDE_REPO`, scan and match the normalized path, and report the
   path as asked** (recommended).
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
removes the component before it, a trailing separator stays. A query that normalizes to the
empty path is judged as that path and is not ignored by the rules pinned here.

Refused: option 3 refuses paths git answers.

Not decided here: an absolute query path. No row pins it.

## Consequences

### Positive

- One judgement per path whatever its spelling; `source.basedir` never holds `.` or `..`.
- No spelling of a path reads a `.gitignore` through a symbolic link.

### Negative

- A query that climbs above the root changes its error from the adapter's `PERMISSION_DENIED`
  to `PATHSPEC_OUTSIDE_REPO`.
