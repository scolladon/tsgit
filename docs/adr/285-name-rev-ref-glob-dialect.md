# ADR-285: `name-rev` ref patterns use a full-refname fnmatch (`*` crosses `/`)

## Status

Accepted (at `30466f56`)

## Context

`name-rev`'s `--refs` / `--exclude` select naming sources by glob. Verified
against real git 2.54: the pattern matches the **full** refname with `*`/`?`
**crossing `/`** (git's `wildmatch` *without* `WM_PATHNAME`) — `--refs='refs/tags/*'`
matches the nested `refs/tags/rel/v1`, and `--refs='*rel*'` matches it too.

tsgit already has a glob matcher, `compileGlob` (`domain/pathspec`), used by
`describe`'s `--match` on tag **short names**. But that matcher is the pathspec
dialect: anchored, with `*` **bounded by `/`** (only `**` crosses). Reusing it
for name-rev would make `refs/tags/*` fail to match nested refs, breaking parity.

## Decision

Add a small pure `matchRefGlob` (and `buildRefFilter`) in `domain/name-rev`: a
straight fnmatch over the full refname where `*` → `.*`, `?` → `.` (both cross
`/`), anchored at both ends. A ref qualifies as a naming source iff it is not
`HEAD`, satisfies the tags-only prefix gate when `tags` is set, matches at least
one `refs` pattern (or there are none), and matches no `exclude` pattern.
`describe --contains` maps its `match`/`exclude` short-name patterns to
`refs/tags/<pat>` before handing them to this matcher (git's behaviour).

`compileGlob` is **not** extended with a "`*` crosses `/`" mode: the two dialects
are genuinely different concerns (pathspec component-matching vs ref fnmatch),
and a cross-cutting flag on the pathspec matcher would couple them for no shared
benefit.

## Consequences

### Positive

- Faithful to `git name-rev --refs`/`--exclude`; `refs/tags/*` matches nested
  refs, pinned by interop.
- The matcher is tiny, pure, and mutation-testable in isolation; property tests
  cover the total-function-over-ASCII grammar (never throws; all-`*` matches
  everything; a literal matches iff equal).

### Negative

- A second glob dialect lives in the codebase (`compileGlob` for pathspec /
  describe short names; `matchRefGlob` for name-rev full refnames). They are
  documented as distinct on purpose; the duplication is ~10 lines.

### Neutral

- `describe --contains --match` reuses `describe`'s existing patterns, prefixed to
  `refs/tags/<pat>`; behaviour for common patterns (`v*`, `rel/*`) is identical
  under both dialects — the dialects diverge only when a single `*` must span `/`.
