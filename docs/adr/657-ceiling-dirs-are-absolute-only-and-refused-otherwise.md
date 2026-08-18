# 657 — `ceilingDirs` entries are absolute-only and refused otherwise

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D5)

## Context

`GIT_CEILING_DIRECTORIES` is a colon-joined env string; git silently ignores
non-absolute entries and supports a `:`-prefix empty entry that disables symlink
resolution. tsgit's `ceilingDirs` is a typed array argument on an API with no
environment. The walk-bounding semantics themselves (longest strict ancestor of the
resolved cwd; the ceiling itself never examined; equality a no-op) are pinned and
faithful regardless of this choice.

## Options considered

1. **`ReadonlyArray<string>`, absolute-only, refuse non-absolute entries with
   `INVALID_OPTION`; entries realpath'd on node, lexical elsewhere (design
   recommendation)** — pros: a refusal at `validateOptions` is strictly more
   informative than a silently dead argument; cannot break a caller supplying faithful
   input / cons: an API-level divergence from git's silent-ignore.
2. **Silently ignore non-absolute entries, as git does** — byte-faithful only because
   git is parsing a string it cannot validate; a typed array can.
3. **Accept a colon-joined string with the `:`-prefix toggle** — imports env-string
   parsing artefacts into an argument API.

## Decision

**Option 1 — ratified by the user.** The strictness applies to argument validation
only; every pinned walk behaviour matches git.
