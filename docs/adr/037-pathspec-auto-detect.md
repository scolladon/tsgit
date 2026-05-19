# ADR-037: Pathspec strings are classified as glob vs literal by content

## Status

Accepted (at `49a147e`)

## Context

§14.2 extends `repo.add`, `repo.rm`, and
`repo.checkout({ paths })` to accept globs alongside literal paths.
Two viable disambiguation strategies:

1. **Auto-detect by content**: any pattern containing `*`, `?`, or `[`
   is a glob; everything else is a literal. Matches Git's pathspec
   behaviour out of the box.
2. **Explicit prefix**: require `glob:src/**` for globs, treat
   un-prefixed strings as literal. Unambiguous but verbose.

The trade-off is between Git fidelity and parsing precision. Option 1
makes a literal path containing `*` impossible to address without
escaping; Git users live with this and have a `:(literal)` magic
prefix to escape when needed (deferred — see §14.2 design §1).

Option 2 would force every existing `repo.add(['file.ts'])` call site
to keep working but a new pathspec call would need `repo.add(['glob:*.ts'])`.
A user mental model would have to track "tsgit pathspec is not
git pathspec".

## Decision

Auto-detect by content. A pattern is a glob iff it contains `*`, `?`,
or `[`. Otherwise it is a literal path treated as a directory prefix
(matches the exact path AND anything under it — Git's `git add src`
behaviour).

The detection is performed in `compilePathspec` via a small
`containsGlob` helper. Patterns starting with `!` are stripped of
the negation marker before detection.

## Consequences

### Positive

- Backward compatible: every existing `repo.add(['a.txt'])`,
  `repo.rm(['file'])`, `repo.checkout({ paths: ['x'] })` call site
  works unchanged because none of those literals contain glob
  metacharacters.
- Familiar to anyone with `git` muscle memory.
- One fewer concept in the public API surface (no prefix vocabulary).

### Negative

- A literal path containing `*`, `?`, or `[` cannot be expressed
  without an escape mechanism. v1 does not provide one;
  consumers needing this can use the underlying `walkWorkingTree` /
  `readIndex` primitives directly. Git's `:(literal)` prefix is the
  natural extension point in a future ADR.

### Neutral

- The `containsGlob` heuristic is independent of `validateWorkingTreePath`
  (which rejects `..` etc. for both literals and globs alike). So a
  hostile pattern like `*..` is still rejected at validation time.
