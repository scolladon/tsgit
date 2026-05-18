# ADR-028: MERGE_MSG does not include a "Conflicts:" trailer

## Status

Accepted (at `3ca03a7a1820ee89b2b3e4bc3e902fb2c098b4e8`)

## Context

Canonical `git` writes `.git/MERGE_MSG` with two sections:

```
<commit message line>

# Conflicts:
# 	<path-1>
# 	<path-2>
```

The "Conflicts:" trailer is a commented block (prefixed with `# `)
that the commit-message editor surfaces to the user as a reminder of
which paths required resolution. The block is stripped when the
commit message is parsed (lines starting with `#` are comments).

Question: does tsgit's `.git/MERGE_MSG` need the same trailer?

## Decision

No. `MERGE_MSG` contains ONLY the merge message draft (the same
string we'd commit on a clean merge). No "Conflicts:" trailer.

## Consequences

### Positive

- **The unmerged index entries already encode the same
  information.** The user can `git status` (or `repo.status()`) to
  see which paths are unmerged. The trailer is redundant.
- **No surprise content when the user commits.** Canonical git
  strips comments before committing, but the user has to TRUST
  the strip. With no trailer, what the user sees in MERGE_MSG is
  exactly what gets committed.
- **Simpler implementation.** We don't need a comment-stripping
  pass in commit's message handler. (The current commit path
  doesn't strip comments at all — adding the trailer would force
  us to add comment-stripping, or to surface unstripped comments
  in committed messages.)

### Negative

- **Divergence from canonical git's UX.** A user accustomed to
  seeing the "Conflicts:" trailer in `git commit -e` won't see
  it here. They'll see only the merge message. Mitigation:
  `repo.status()` surfaces unmerged paths, which is the proper
  programmatic surface.
- **Tooling that scrapes MERGE_MSG for conflict paths breaks.**
  Such tooling is rare; the index is the canonical source.

### Neutral

- Forward-compatible with adding the trailer later. If a strong
  use case emerges (e.g., a tsgit CLI that mirrors `git merge`),
  we can append the trailer behind an option.
- Matches the "store what's truly authoritative, derive the rest"
  principle the project follows elsewhere (e.g., walk-commits
  doesn't cache derived data either).

## Alternatives considered

- **Append the canonical trailer.** Rejected for v1.x. Adds
  comment-stripping work for unclear value; the user has
  `status` for the path list.
- **Append a NON-commented trailer.** Rejected — would land in
  the committed message verbatim. Polluting commit text is worse
  than the canonical trailer's hidden-by-comment trick.
- **Make the trailer opt-in via `MergeOptions.includeConflictsInMsg`.**
  Deferred. If the demand materialises, add the flag; until then
  the simpler implementation wins.
