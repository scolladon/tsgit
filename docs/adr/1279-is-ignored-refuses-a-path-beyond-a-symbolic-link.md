---
subjects:
  - src/application/primitives/is-ignored.ts
---
# 1279 — isIgnored refuses a path beyond a symbolic link

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (What impact triage folded) · **Supersedes/Refines:** applies DOCTRINE(D-5) and DOCTRINE(D-3); refines ADR-163

## Context

The security review of this change probed `isIgnored` with a path whose leading directory is a
symbolic link, and impact triage verified it against git 2.56.1 under both `core.ignorecase`
values, on this branch and on main:

| `link` is a symbolic link to a directory holding `.gitignore`: `secret` | git | tsgit |
|---|---|---|
| `check-ignore -v -- link/secret`, with or without `--no-index` | exit 128, `fatal: pathspec 'link/secret' is beyond a symbolic link` | ignored, `source` read through the link |
| the same with the link pointing inside the repository | exit 128, the same message | ignored |

`builtin/check-ignore.c` parses its arguments with `PATHSPEC_SYMLINK_LEADING_PATH`, and
`pathspec.c` dies on the first argument for which `has_symlink_leading_path` holds: a leading
component that is a symbolic link, whatever it points at. The last component may be a link.
Every argument is parsed before any is matched.

`add`, `stash` and `mv` already refuse such a path with `PATHSPEC_BEYOND_SYMLINK`. `isIgnored`
did not. The refusal belongs to `isIgnored` alone: the walk and the overwrite pre-flights ask
git's `is_excluded`, which has no such check, and handle a symlinked leading directory in their
own way.

The divergence predates this change. Its place is the function this change rewrote.

## Options considered

1. **Refuse: before any query is matched, test every query's leading directories and throw
   `PATHSPEC_BEYOND_SYMLINK` for the first one beyond a symbolic link, in query order**
   (recommended).
2. Schedule it as a backlog entry.
3. Answer "not ignored" for such a path.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the divergence is proven and
sits in a function this change edits. DOCTRINE(D-3): a call that returned now throws, so the
change is marked breaking. Option 1.

The check uses the leading-path scanner `add` uses, so a link is judged by its shape, not by
where it points, and a prefix the file system cannot name is not a link. An empty query list
still returns an empty list without touching the file system.

Refused: option 2 parks a pinned refusal mismatch in an edited function, which D-5 rules out.
Option 3 invents an answer git never gives.

## Consequences

### Positive

- `isIgnored` no longer reads rule files through a symbolic link and reports them as the
  repository's own.

### Negative

- A caller that asked about a path beneath a symlinked directory now gets
  `PATHSPEC_BEYOND_SYMLINK` instead of a verdict: breaking.
- One `lstat` per distinct leading directory of the queried paths.
